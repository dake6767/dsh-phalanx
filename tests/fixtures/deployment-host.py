"""Root-only lifecycle acceptance guardian for a verified, unused validation deployment.

The test account gets fixed commands, never a shell. A stopped-state snapshot
includes the local PostgreSQL files and matching keys. Unknown/initialized roots
are refused; a failed restoration retains its protected snapshot outside TMPDIR.
"""
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import socketserver
import stat
import struct
import subprocess
import sys
import threading
import uuid

# The installed executor inventory is immutable; importing it must not publish bytecode.
sys.dont_write_bytecode=True

TEST='tests/installed-deployment-lifecycle.e2e.ts'
HOME=Path('/var/lib/dsh-phalanx')
PRIVATE=Path('/var/lib/dsh-phalanx-validation-lifecycle')


def require_validation_storage(source):
    values=source['values']
    if values.get('DSH_PHALANX_DATA_ROOT')!=str(HOME/'data') or values.get('DSH_PHALANX_USER_DATA_ROOT') not in (None,'',str(HOME/'data.durable/users')) or values.get('DSH_PHALANX_USER_DATA_MOUNT'):
        raise ValueError('Only the default isolated validation storage is supported')


def require_unused_baseline(source,status):
    require_validation_storage(source)
    if not source['values'].get('DSH_PHALANX_DATABASE_CONFIG_FILE') or status.get('databaseSelection') is not None:
        raise ValueError('An unselected validation database is required')
    if status.get('state') not in ('running','stopped') or status.get('errors') or status.get('operations'):
        raise ValueError('The validation baseline is not observable and idle')
    components={row['name']:row for row in status['components']}
    if components.get('members',{}).get('total')!=0 or components.get('maintenance-workers',{}).get('running')!=0 or components.get('upgrade-tools',{}).get('running')!=0:
        raise ValueError('Refusing a baseline with member or maintenance workloads')


class DeploymentFixture:
    def __init__(self,source,commit,ipc,result,uid,gid):
        if os.geteuid()!=0 or sys.platform!='linux' or not re.fullmatch('[a-f0-9]{40}',commit):raise ValueError('A root Linux validation owner and exact commit are required')
        self.commit=commit;self.uid=uid;self.gid=gid;self.result=Path(result)
        inventory=json.loads((Path(source)/'scripts/validation/t2-selection.json').read_text())
        self.port=20000+inventory['regular'].index(TEST)*20
        self.ipc=Path(ipc);self.ipc.mkdir(mode=0o750);os.chown(self.ipc,0,gid)
        self.token=secrets.token_hex(32);self.socket=self.ipc/'control.sock'
        self.capability=self.ipc/'control.json'
        self.product=None;self.host=None;self.private=None;self.snapshot=None;self.receipt=None;self.private_identity=None
        self.initial=None;self.source=None;self.active=False;self.touched=False;self.lease=None;self.marker=None;self.orphan=None
        self.member_home=None;self.history=[];self.cleanup_errors=[];self.closing=False;self.phase='idle'
        owner=self
        class Handler(socketserver.BaseRequestHandler):
            def handle(handler):
                peer=struct.unpack('3i',handler.request.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]
                if peer!=owner.uid:return
                handler.request.settimeout(1);buffer=b'';count=0
                try:
                    while not owner.closing:
                        try:block=handler.request.recv(16384)
                        except socket.timeout:continue
                        if not block:break
                        buffer+=block
                        if len(buffer)>32768:raise ValueError('Bounded lifecycle request exceeded')
                        while b'\n' in buffer:
                            raw,buffer=buffer.split(b'\n',1);count+=1
                            if count>512:raise ValueError('Lifecycle request limit exceeded')
                            request=json.loads(raw)
                            if not isinstance(request,dict) or not isinstance(request.get('token'),str) or not hmac.compare_digest(request['token'],owner.token):raise ValueError('Invalid lifecycle capability')
                            try:response={'ok':True,'result':owner.handle(request.get('action'))}
                            except Exception as error:
                                owner.history.append({'phase':owner.phase,'errorType':type(error).__name__})
                                response={'ok':False,'errorType':type(error).__name__,'phase':owner.phase}
                            handler.request.sendall(json.dumps(response).encode()+b'\n')
                finally:
                    try:owner.restore()
                    except Exception as error:owner.cleanup_errors.append(type(error).__name__)
        self.server=socketserver.UnixStreamServer(str(self.socket),Handler)
        os.chown(self.socket,uid,gid);self.socket.chmod(0o600)
        self.capability.write_text(json.dumps({'socket':str(self.socket),'token':self.token}));os.chown(self.capability,uid,gid);self.capability.chmod(0o600)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()

    def command(self,args,*,environment=None,timeout=180):
        process=subprocess.Popen([str(value) for value in args],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True,env=environment)
        try:out,error=process.communicate(timeout=timeout)
        except BaseException:
            if process.poll() is None:
                os.killpg(process.pid,signal.SIGTERM)
                try:process.wait(timeout=15)
                except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=15)
            raise
        if len(out)>1048576 or len(error)>1048576:raise ValueError('Bounded lifecycle command output exceeded')
        return subprocess.CompletedProcess(args,process.returncode,out,error)

    def user(self,args):
        environment=self.host.user_environment(self.source['uid'])
        return self.command(['runuser','-u','dsh-phalanx','--','env','-i',*[key+'='+value for key,value in environment.items()],*args])

    def global_command(self,action,fault=None):
        environment=dict(os.environ)
        if fault:
            if not self.private:raise ValueError('A prepared fixture is required for fault injection')
            binary=self.private/'bin';binary.mkdir(exist_ok=True,mode=0o700)
            script=binary/'systemctl'
            script.write_text('#!/bin/sh\ncase "$DSH_LIFECYCLE_OS_FAULT:$1:$2" in query:show:dsh-phalanx-updater.service|stop:stop:dsh-phalanx-updater.service) exit 42;; esac\nexec /usr/bin/systemctl "$@"\n')
            script.chmod(0o700);environment.update(PATH=str(binary)+':'+os.environ['PATH'],DSH_LIFECYCLE_OS_FAULT=fault)
        result=self.command(['/usr/local/bin/dsh-phalanx',action,'--language','en','--output','json',*(['--yes'] if action=='stop' else [])],environment=environment)
        data=json.loads(result.stdout)
        self.history.append({'action':action,'exitCode':result.returncode,'stderrSha256':hashlib.sha256(result.stderr.encode()).hexdigest()})
        return {'exitCode':result.returncode,'result':data}

    def load_product(self):
        target=Path('/opt/dsh-phalanx/current').resolve()
        build=json.loads((target/'build-info.json').read_text())
        if build.get('commit')!=self.commit:raise ValueError('Validation package identity differs')
        updater=Path('/opt/dsh-phalanx/updater').resolve()
        if updater.parent!=Path('/opt/dsh-phalanx/updaters') or updater.stat().st_uid!=0:raise ValueError('Unknown executor bank')
        sys.path.insert(0,str(updater))
        from installer_host import Host
        from installer_deployment import Deployment
        from installer_executor_install import executor_package
        from installer_upgrade_host import installed_source
        from installer_upgrade_backup import PlatformBackup
        executor_package(updater,self.commit)
        self.host=Host();self.product=Deployment(self.host);self.source=installed_source(self.host);self.backup_type=PlatformBackup
        if self.source['uid']!=self.uid or self.source['gid']!=self.gid:raise ValueError('Validation service identity differs')

    def owned_containers(self):
        owner=hashlib.sha256(str(HOME/'data').encode()).hexdigest()
        response=self.user(['podman','ps','--all','--filter','label=dsh-phalanx.community=1','--filter','label=dsh-phalanx.community-root='+owner,'--format','json'])
        if response.returncode:raise ValueError('Member audit is unavailable')
        rows=json.loads(response.stdout)
        for row in rows:
            if row.get('Labels',{}).get('dsh-phalanx.community-root')!=owner or row.get('Labels',{}).get('dsh-phalanx.community')!='1' or not re.fullmatch('[a-f0-9]{12,64}',row.get('Id',row.get('ID',''))):raise ValueError('Invalid member audit ownership')
        database=self.user(['podman','ps','--all','--filter','name=dsh-phalanx-postgres','--filter','label=dsh.phalanx.database=builtin','--format','json'])
        if database.returncode:raise ValueError('Database audit is unavailable')
        for row in json.loads(database.stdout):
            identity=row.get('Id',row.get('ID',''))
            if not re.fullmatch('[a-f0-9]{12,64}',identity):raise ValueError('Invalid database audit identity')
            detail=self.user(['podman','inspect',identity])
            if detail.returncode:raise ValueError('Database audit ownership is unavailable')
            values=json.loads(detail.stdout)
            if len(values)!=1:raise ValueError('Ambiguous database container')
            value=values[0]
            if value.get('Name','').lstrip('/')!='dsh-phalanx-postgres':continue
            mounts=[mount for mount in value.get('Mounts',[]) if mount.get('Destination')=='/var/lib/postgresql/data']
            if value.get('Config',{}).get('Labels',{}).get('dsh.phalanx.database')!='builtin' or len(mounts)!=1 or mounts[0].get('Type')!='bind' or Path(mounts[0].get('Source','')).resolve()!=(HOME/'data.durable/postgres').resolve():raise ValueError('Foreign database container conflict')
            rows.append(row)
        return rows

    def audit(self):
        for unit,system in (('dsh-phalanx-updater.service',True),('dsh-phalanx-maintenance.service',True),('dsh-phalanx.service',False),('dsh-phalanx-postgres.service',False)):
            args=['systemctl',*([] if system else ['--user']),'show',unit,'--property=LoadState,ActiveState,SubState,MainPID,ControlPID,ControlGroup']
            result=self.command(args) if system else self.user(args)
            facts=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
            idle=unit=='dsh-phalanx-maintenance.service' and facts.get('ActiveState')=='active' and facts.get('SubState')=='exited'
            if result.returncode or facts.get('LoadState')!='loaded' or (facts.get('ActiveState') not in ('inactive','failed') and not idle) or facts.get('MainPID')!='0' or facts.get('ControlPID')!='0':raise ValueError('A managed service has not stopped')
            group=facts.get('ControlGroup','')
            if group:
                if not group.startswith('/') or '..' in Path(group).parts or Path(group).name!=unit:raise ValueError('Unknown audited control group')
                path=Path('/sys/fs/cgroup'+group)
                if path.exists() and any(file.read_text().strip() for file in path.glob('**/cgroup.procs')):raise ValueError('Managed service tasks remain')
        if any(row.get('State') not in ('created','configured','exited','stopped') for row in self.owned_containers()):raise ValueError('Managed container tasks remain')
        if self.orphan:
            facts=self.orphan.facts()
            if facts is not None and (facts.get('MainPID')!='0' or facts.get('NFileDescriptorStore')!='0'):raise ValueError('Maintenance task or descriptor remains')
        return {'stopped':True,'serviceTasks':0,'memberTasks':0,'maintenanceDescriptors':0}

    def installation_lease(self):
        descriptor=os.open('/run/lock/dsh-phalanx-install.lock',os.O_RDWR|os.O_NOFOLLOW)
        file=os.fdopen(descriptor,'r+')
        try:
            info=os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o600:raise ValueError('Unknown installation lease ownership')
            fcntl.flock(file,fcntl.LOCK_EX|fcntl.LOCK_NB)
            return file
        except BaseException:file.close();raise

    def remove_private(self):
        if not self.private:return
        info=self.private.lstat()
        if self.private.is_symlink() or self.private.parent!=PRIVATE or info.st_uid!=0 or (info.st_dev,info.st_ino)!=self.private_identity:raise ValueError('Snapshot cleanup ownership changed')
        shutil.rmtree(self.private)
        self.private=None;self.snapshot=None;self.receipt=None;self.private_identity=None

    def release_lease(self):
        if self.lease:self.lease.close();self.lease=None

    def prepare(self):
        if self.active or self.touched or self.private:raise ValueError('A lifecycle scene must be restored before preparing another')
        self.phase='baseline-guard';self.load_product()
        initial=self.global_command('status')
        require_unused_baseline(self.source,initial['result'])
        if any(row.get('Labels',{}).get('dsh-phalanx.community')=='1' for row in self.owned_containers()):raise ValueError('The baseline already has member containers')
        values=self.source['values']
        self.initial=initial['result']
        if PRIVATE.exists():
            if PRIVATE.is_symlink() or not PRIVATE.is_dir() or PRIVATE.stat().st_uid!=0 or PRIVATE.stat().st_mode&0o777!=0o700:raise ValueError('Unknown lifecycle snapshot root')
        else:PRIVATE.mkdir(mode=0o700)
        self.private=PRIVATE/uuid.uuid4().hex;self.private.mkdir(mode=0o700)
        self.private_identity=(self.private.stat().st_dev,self.private.stat().st_ino)
        self.phase='baseline-snapshot'
        (self.private/'OWNER.json').write_text(json.dumps({'schema':1,'source':self.commit,'phase':'reserved','initialState':self.initial['state']}));(self.private/'OWNER.json').chmod(0o600)
        roles={'configuration':Path('/etc/dsh-phalanx'),'platform':HOME/'data','durable':HOME/'data.durable','keys':HOME/'keys','journals':Path('/var/lib/dsh-phalanx-updater'),
               'platformUnit':HOME/'.config/systemd/user/dsh-phalanx.service','databaseUnit':HOME/'.config/systemd/user/dsh-phalanx-postgres.service',
               'platformAutostart':HOME/'.config/systemd/user/default.target.wants/dsh-phalanx.service',
               'updaterUnit':Path('/etc/systemd/system/dsh-phalanx-updater.service'),'updaterAutostart':Path('/etc/systemd/system/multi-user.target.wants/dsh-phalanx-updater.service')}
        for name,path in roles.items():
            if name not in ('platformAutostart','updaterAutostart') and (path.is_symlink() or path.is_mount()):raise ValueError('Unknown validation snapshot boundary')
        for line in Path('/proc/self/mountinfo').read_text().splitlines():
            mounted=Path(re.sub(r'\\([0-7]{3})',lambda value:chr(int(value[1],8)),line.split()[4]))
            if any(mounted.is_relative_to(path) for name,path in roles.items() if name not in ('platformAutostart','updaterAutostart')):raise ValueError('Unexpected nested validation mount')
        self.unit_hashes={}
        for path in (HOME/'.config/systemd/user/dsh-phalanx.service',HOME/'.config/systemd/user/dsh-phalanx-postgres.service',Path('/etc/systemd/system/dsh-phalanx-updater.service'),Path('/etc/systemd/system/dsh-phalanx-maintenance.service')):
            info=path.lstat()
            if path.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_uid not in (0,self.uid) or info.st_mode&0o022:raise ValueError('Unknown validation service definition')
            self.unit_hashes[str(path)]=hashlib.sha256(path.read_bytes()).hexdigest()
        if values.get('DSH_PHALANX_PREVIEW_PORT') or values.get('DSH_PHALANX_PREVIEW_ORIGIN'):raise ValueError('Configured preview listeners are outside this fixture')
        self.touched=True
        self.phase='baseline-stop';stopped=self.global_command('stop')
        if stopped['exitCode'] or stopped['result']['state']!='stopped':raise ValueError('The actual deployment stop failed')
        self.audit()
        empty=self.private/'empty';empty.mkdir(mode=0o700)
        self.snapshot=self.backup_type(empty,self.private/'snapshot',roles)
        with self.installation_lease() as lease:
            self.receipt=self.snapshot.create();self.snapshot.verify(self.receipt)
            receipt_text=json.dumps(self.receipt,sort_keys=True)
            self.receipt_sha=hashlib.sha256(receipt_text.encode()).hexdigest()
            (self.private/'receipt.json').write_text(receipt_text);(self.private/'receipt.json').chmod(0o600)
            (self.private/'OWNER.json').write_text(json.dumps({'schema':1,'source':self.commit,'receiptSha256':self.receipt_sha,'initialState':self.initial['state'],'roles':{name:str(path) for name,path in roles.items()}}));(self.private/'OWNER.json').chmod(0o600)
            from installer_config import environment_text
            values={**values,'DSH_PHALANX_HOST':'127.0.0.1','DSH_PHALANX_PORT':str(self.port),'DSH_PHALANX_CONTAINER_GATEWAY_PORT':str(self.port+1),'DSH_PHALANX_PUBLIC_ORIGIN':'http://127.0.0.1:'+str(self.port),'DSH_PHALANX_HOST_PUBLIC_ADDRESSES':''}
            self.host.atomic('/etc/dsh-phalanx/environment',environment_text(values),0o640);os.chown('/etc/dsh-phalanx/environment',0,self.gid)
            self.active=True
        self.phase='scene-start';result=self.global_command('start')
        if result['exitCode']:raise ValueError('The actual deployment start failed')
        return {'origin':values['DSH_PHALANX_PUBLIC_ORIGIN'],'dataRoot':str(HOME/'data'),'userDataRoot':str(HOME/'data.durable/users'),'source':self.commit,'receiptSha256':self.receipt_sha,'autostart':self.autostart(self.initial)}

    @staticmethod
    def autostart(status):return {row['name']:row['autostart'] for row in status['components'] if 'autostart' in row}

    def clear_marker(self):
        if self.marker is None:return
        path=Path('/etc/dsh-phalanx/maintenance')
        if path.is_symlink() or not path.is_file() or path.read_bytes()!=self.marker:raise ValueError('The validation maintenance marker changed ownership')
        path.unlink();self.marker=None

    def handle(self,action):
        self.phase=action if isinstance(action,str) else 'invalid-request'
        if action=='prepare':
            self.member_home=None
            return self.prepare()
        if action=='restore':return self.restore()
        if not self.active:raise ValueError('An active, owned lifecycle scene is required')
        if action in ('start','stop','status'):return self.global_command(action)
        if action=='query-failed-status':return self.global_command('status',fault='query')
        if action=='partial-stop':return self.global_command('stop',fault='stop')
        if action=='hold-lock':
            if self.lease:raise ValueError('A fixture lease is already held')
            self.lease=self.installation_lease()
            return {'held':True}
        if action=='release-lock':self.release_lease();return {'released':True}
        if action=='maintenance':
            path=Path('/etc/dsh-phalanx/maintenance')
            if path.exists() or path.is_symlink():raise ValueError('An existing maintenance owner must be retained')
            from installer_upgrade_gate import protected_ports
            from installer_upgrade_host import installed_source
            self.marker=json.dumps({'schema':1,'validationOwner':self.private.name,'operation':str(uuid.uuid4()),'ports':protected_ports(installed_source(self.host)['values'])}).encode()
            descriptor=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
            with os.fdopen(descriptor,'wb') as file:file.write(self.marker)
            return {'created':True}
        if action=='clear-maintenance':self.clear_marker();return {'cleared':True}
        if action=='detach-platform':
            result=self.user(['systemctl','--user','stop','dsh-phalanx.service'])
            if result.returncode:raise ValueError('The controlled detach failed')
            return {'detached':True}
        if action=='orphan-maintenance':
            from installer_upgrade_host import UpgradeHost, installed_source
            from installer_upgrade_gate import MaintenanceUnit
            current=installed_source(self.host)
            job={'id':str(uuid.uuid4()),'phase':'succeeded','source':current,'target':{'version':current['receipt']['version'],'manifest':current['manifest']}}
            worker=MaintenanceUnit(self.host,job);job['maintenancePage']=worker.intent()
            UpgradeHost(self.host).save(job);worker.start();self.orphan=worker
            return {'created':True}
        if action=='audit-stopped':return self.audit()
        if action=='member-counts':
            counts={'resident':0,'ondemand':0,'disabled':0}
            for row in self.owned_containers():
                username=row.get('Labels',{}).get('dsh-phalanx.user')
                if username in counts and row.get('State') in ('running','paused','stopping'):counts[username]+=1
            return counts
        if action=='heartbeat':
            if self.member_home is None:
                carriers=[row for row in self.owned_containers() if row.get('Labels',{}).get('dsh-phalanx.user')=='resident']
                if len(carriers)!=1:raise ValueError('Resident carrier mapping is unavailable')
                detail=self.user(['podman','inspect',carriers[0].get('Id',carriers[0].get('ID'))])
                if detail.returncode:raise ValueError('Resident mount is unavailable')
                mounts=[row for row in json.loads(detail.stdout)[0]['Mounts'] if row.get('Destination')=='/dsh-phalanx/home' and row.get('Type')=='bind']
                if len(mounts)!=1:raise ValueError('Resident mount is ambiguous')
                self.member_home=Path(mounts[0]['Source'])
                if not self.member_home.is_relative_to(HOME/'data.durable/users'):raise ValueError('Foreign resident mount')
            path=self.member_home/'Documents/deepseek-harness/default-workspace/lifecycle-heartbeat.log'
            for item in (path,*path.parents):
                if item.is_symlink():raise ValueError('Unexpected member file link')
                if item==HOME:break
            if not path.is_file():return {'bytes':0}
            if path.stat().st_size>1048576:raise ValueError('Bounded member heartbeat exceeded')
            return {'bytes':path.stat().st_size}
        raise ValueError('Unsupported lifecycle fixture action')

    def stop_for_restore(self):
        self.release_lease();self.clear_marker()
        self.load_product();require_validation_storage(self.source)
        for name,digest in self.unit_hashes.items():
            path=Path(name)
            if path.is_symlink() or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=digest:raise ValueError('A service definition changed; preserve the protected baseline')
        stopped=self.global_command('stop')
        if stopped['exitCode']:
            # Never bypass an active or unknown maintenance owner to perform cleanup.
            with self.installation_lease():
                if self.product.pending():raise ValueError('Maintenance owns the deployment; protected snapshot retained')
                failures=[]
                def attempt(call):
                    try:
                        result=call()
                        if isinstance(result,subprocess.CompletedProcess) and result.returncode:raise ValueError('Owned cleanup command failed')
                    except Exception as error:failures.append(type(error).__name__)
                if self.orphan:attempt(self.orphan.stop)
                attempt(lambda:self.command(['systemctl','stop','dsh-phalanx-updater.service']))
                attempt(lambda:self.user(['systemctl','--user','stop','dsh-phalanx.service']))
                attempt(lambda:self.user(['systemctl','--user','stop','dsh-phalanx-postgres.service']))
                try:
                    for row in self.owned_containers():attempt(lambda row=row:self.user(['podman','rm','--force','--ignore','--time','0',row.get('Id',row.get('ID'))]))
                except Exception as error:failures.append(type(error).__name__)
                attempt(self.audit)
                if failures:raise ValueError('Owned cleanup is incomplete; protected snapshot retained')
        self.audit()

    def restore(self):
        self.release_lease()
        if not self.touched:
            self.remove_private()
            return {'restored':True,'unused':True}
        self.stop_for_restore()
        if self.receipt is not None:
            with self.installation_lease() as lease:
                self.snapshot.restore(self.receipt)
            self.command(['systemctl','daemon-reload']);self.user(['systemctl','--user','daemon-reload'])
        if self.initial['state']=='running':
            started=self.global_command('start')
            if started['exitCode']:raise ValueError('The original validation deployment did not resume')
        observed=self.global_command('status')
        if observed['exitCode'] or observed['result']['state']!=self.initial['state'] or self.autostart(observed['result'])!=self.autostart(self.initial):raise ValueError('Original service state or autostart policy was not restored')
        restored={'restored':True,'source':self.commit,'initialState':self.initial['state'],'autostartPreserved':True,'receiptSha256':getattr(self,'receipt_sha',None)}
        self.history.append(restored);self.active=False;self.touched=False;self.orphan=None
        self.remove_private()
        return restored

    def close(self):
        self.closing=True
        self.server.shutdown();self.server.server_close();self.thread.join()
        try:self.restore()
        except Exception as error:self.cleanup_errors.append(type(error).__name__)
        (self.result/'deployment-lifecycle-guardian.json').write_text(json.dumps({'source':self.commit,'restored':not self.touched,'errors':self.cleanup_errors,'history':self.history})+'\n')
        if self.cleanup_errors or self.touched:raise RuntimeError('Deployment lifecycle cleanup incomplete; protected snapshot retained')
