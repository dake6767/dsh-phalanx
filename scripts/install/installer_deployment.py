"""Observe and control one verified deployment, keeping partial observations explicit."""
from contextlib import contextmanager
import fcntl
import hashlib
import ipaddress
import urllib.parse
import json
import os
from pathlib import Path
import re
from installer_host import InstallError, entry_url, origin_authority  # embedded-host
from installer_config import default_storage_root, unit_argument, uninstall_record  # embedded-config
from installer_operations import JOURNAL, read_owned, read_platform_operation  # embedded-operations
from installer_upgrade_gate import MaintenanceUnit, ListenerPinUnit, AdmissionGateError  # embedded-upgrade-gate
from installer_upgrade_host import installed_source, UPGRADE_ROOT, MAINTENANCE, STATE, CONFIG, UNIT, operation_id, read_upgrade_operation  # embedded-upgrade-host

PLATFORM='dsh-phalanx.service'
DATABASE='dsh-phalanx-postgres.service'
UPDATER='dsh-phalanx-updater.service'
FENCE='dsh-phalanx-maintenance.service'
DEPLOYMENT_TERMINAL=('succeeded','restored','prepare-failed','apply-failed')


@contextmanager
def deployment_lease(host):
    path=host.mkdir('/run/lock',mode=None)/'dsh-phalanx-install.lock'
    descriptor=os.open(path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    with os.fdopen(descriptor,'r+') as lock:
        try:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
        else:
            yield True


class Deployment:
    def __init__(self,host):
        self.host=host

    def journal_root(self):
        root=self.host.path(UPGRADE_ROOT)
        if root.exists() or root.is_symlink():
            if root.is_symlink() or not root.is_dir() or root.stat().st_uid!=os.geteuid() or root.stat().st_mode&0o777!=0o700:
                raise InstallError('Invalid protected upgrade journal directory')
        return root

    def pending(self):
        self.journal_root()
        marker=self.host.path(MAINTENANCE)
        pending=[]
        if marker.exists() or marker.is_symlink():
            if marker.is_symlink() or not marker.is_file():raise InstallError('Invalid maintenance marker')
            pending.append({'kind':'maintenance','phase':'recovery-required'})
        value=read_platform_operation(self.host)
        if value and value['phase'] not in ('succeeded','restored'):
            pending.append({'kind':value['action'],'phase':value['phase'],'id':value['id']})
        value=read_upgrade_operation(self.host)
        if value and (value['phase'] not in DEPLOYMENT_TERMINAL or value.get('cleanup',{}).get('status') in ('running','failed')):
            pending.append({'kind':'update','phase':value['phase'],'id':value['id']})
        return pending

    def task_count(self,group,*,active):
        if not group:
            if active:raise InstallError('Active service has no observable control group')
            return 0
        if not group.startswith('/') or '..' in Path(group).parts or '\0' in group:
            raise InstallError('Invalid service control group')
        root=self.host.path('/sys/fs/cgroup'+group)
        if not root.exists():
            if active:raise InstallError('Active service control group is unavailable')
            return 0
        if root.is_symlink() or not root.is_dir():raise InstallError('Invalid service control group')
        identities=set()
        for file in [root/'cgroup.procs',*root.glob('**/cgroup.procs')]:
            if file.is_symlink():raise InstallError('Invalid control group process observation')
            for pid in file.read_text().split():
                if not pid.isdecimal() or int(pid)<1:raise InstallError('Invalid control group process identity')
                identities.add(int(pid))
        return len(identities)

    def service(self,name,unit,source,*,system=False,idle=False):
        arguments=['systemctl',*([] if system else ['--user']),'show',unit,'--property=LoadState,ActiveState,SubState,MainPID,ControlPID,ControlGroup,UnitFileState']
        response=self.host.run(arguments,check=False) if system else self.host.user(source['uid'],arguments,check=False)
        values=dict(line.split('=',1) for line in response.stdout.splitlines() if '=' in line)
        if response.returncode!=0 or values.get('LoadState')!='loaded':
            raise InstallError('Cannot observe managed '+name+' service')
        state=values.get('ActiveState')
        if state not in ('active','inactive','failed','activating','deactivating','reloading'):
            raise InstallError('Unknown managed '+name+' service state')
        for key in ('MainPID','ControlPID'):
            if not values.get(key,'').isdecimal():raise InstallError('Incomplete managed service process facts')
        if values.get('ControlGroup') and Path(values['ControlGroup']).name!=unit:raise InstallError('Service control group differs from its unit')
        quiescent_fence=idle and state=='active' and values.get('SubState')=='exited' and values['MainPID']=='0' and values['ControlPID']=='0'
        tasks=self.task_count(values.get('ControlGroup',''),active=state not in ('inactive','failed') and not quiescent_fence)
        running=state=='active' and tasks>0
        projection='running' if running else 'idle' if idle and state=='active' and tasks==0 and values.get('SubState')=='exited' else 'stopped' if state=='inactive' and tasks==0 else 'residual'
        return {'name':name,'state':projection,'unit':unit,'scope':'system' if system else 'user','activeState':state,'subState':values.get('SubState'),'tasks':tasks,'mainPid':int(values['MainPID']),'autostart':values.get('UnitFileState','unknown')}

    def member_containers(self,source):
        owner=hashlib.sha256(str(Path(source['values']['DSH_PHALANX_DATA_ROOT']).resolve()).encode()).hexdigest()
        response=self.host.user(source['uid'],['podman','ps','--all','--filter','label=dsh-phalanx.community=1','--filter','label=dsh-phalanx.community-root='+owner,'--format','json'])
        rows=json.loads(response.stdout)
        if not isinstance(rows,list):raise InstallError('Invalid member container observation')
        for row in rows:
            if not isinstance(row,dict) or not isinstance(row.get('Labels'),dict):raise InstallError('Invalid member container observation')
            labels=row['Labels']
            identity=row.get('Id',row.get('ID'))
            if labels.get('dsh-phalanx.community')!='1' or labels.get('dsh-phalanx.community-root')!=owner or not isinstance(identity,str) or not re.fullmatch('[a-f0-9]{12,64}',identity):
                raise InstallError('Member container ownership is inconsistent')
            if row.get('State') not in ('running','paused','stopping','created','configured','exited','stopped'):
                raise InstallError('Unknown member container state')
        return rows

    def database_selection(self,source):
        configured=source['values'].get('DSH_PHALANX_DATABASE_CONFIG_FILE')
        if not configured:return None
        path=self.host.path(configured)
        owner=path.stat().st_uid
        if owner not in (os.geteuid(),source['uid']):raise InstallError('Database configuration owner is inconsistent')
        value=json.loads(read_owned(path,owner))
        if not isinstance(value,dict) or value.get('selection') not in (None,'builtin','external'):raise InstallError('Unknown selected database configuration')
        return value.get('selection')

    def builtin_containers(self,source):
        response=self.host.user(source['uid'],['podman','ps','--all','--filter','label=dsh.phalanx.database=builtin','--filter','name=dsh-phalanx-postgres','--format','json'])
        rows=json.loads(response.stdout)
        if not isinstance(rows,list):raise InstallError('Invalid built-in database container observation')
        expected=self.host.path(default_storage_root(source['values']['DSH_PHALANX_DATA_ROOT'])+'/postgres').resolve()
        owned=[]
        for row in rows:
            if not isinstance(row,dict):raise InstallError('Invalid built-in database container observation')
            identity=row.get('Id',row.get('ID'))
            if not isinstance(identity,str) or not re.fullmatch('[a-f0-9]{12,64}',identity):raise InstallError('Invalid built-in database container identity')
            details=json.loads(self.host.user(source['uid'],['podman','inspect',identity]).stdout)
            if not isinstance(details,list) or len(details)!=1:raise InstallError('Cannot inspect built-in database ownership')
            detail=details[0]
            if not isinstance(detail,dict) or not isinstance(detail.get('Config'),dict) or not isinstance(detail['Config'].get('Labels'),dict) or not isinstance(detail.get('Mounts'),list) or any(not isinstance(mount,dict) for mount in detail['Mounts']):raise InstallError('Invalid built-in database ownership observation')
            if detail.get('Name','').lstrip('/')!='dsh-phalanx-postgres':continue
            labels=detail.get('Config',{}).get('Labels',{})
            mounts=[mount for mount in detail.get('Mounts',[]) if mount.get('Destination')=='/var/lib/postgresql/data']
            if labels.get('dsh.phalanx.database')!='builtin' or len(mounts)!=1 or mounts[0].get('Type')!='bind' or Path(mounts[0].get('Source','')).resolve()!=expected:
                raise InstallError('Built-in database container ownership differs from this deployment')
            if row.get('State') not in ('running','paused','stopping','created','configured','exited','stopped'):raise InstallError('Unknown built-in database container state')
            owned.append(row)
        return owned

    def upgrade_jobs(self,source):
        root=self.journal_root()
        if not root.exists():return []
        jobs=[]
        for directory in root.iterdir():
            if not re.fullmatch('[a-f0-9-]{36}',directory.name):continue
            operation_id(directory.name)
            if directory.is_symlink() or not directory.is_dir():raise InstallError('Invalid upgrade journal ownership')
            path=directory/'operation.json'
            if not path.exists():continue
            job=read_upgrade_operation(self.host,directory.name)
            if job.get('id')!=directory.name:raise InstallError('Upgrade journal identity differs from its directory')
            saved=job.get('source',{}).get('values',{}).get('DSH_PHALANX_DATA_ROOT')
            if saved and Path(saved).resolve()==Path(source['values']['DSH_PHALANX_DATA_ROOT']).resolve():jobs.append(job)
        return jobs

    def maintenance_workers(self,source):
        response=self.host.run(['systemctl','list-units','--all','--plain','--no-legend','--no-pager','dsh-phalanx-upgrade-*.service'])
        jobs={job['id']:job for job in self.upgrade_jobs(source)}
        units=[]
        for line in response.stdout.splitlines():
            name=line.split()[0]
            match=re.fullmatch(r'dsh-phalanx-upgrade-(page|listener)-([a-f0-9-]{36})\.service',name)
            if not match or match[2] not in jobs:raise InstallError('Cannot verify independent maintenance unit ownership')
            kind=MaintenanceUnit if match[1]=='page' else ListenerPinUnit
            worker=kind(self.host,jobs[match[2]])
            facts=worker.facts()
            if facts is not None:
                worker.verify(facts)
                units.append((worker,facts))
        return units

    def archive_containers(self,source):
        jobs=self.upgrade_jobs(source)
        owners={hashlib.sha256(str(self.host.path(UPGRADE_ROOT+'/'+job['id']+'/backup/database')).encode()).hexdigest() for job in jobs if 'database' in job}
        if not owners:return []
        result=self.host.run(['podman','ps','--all','--filter','label=dsh.phalanx.upgrade-archive-owner','--format','json'])
        rows=json.loads(result.stdout)
        if not isinstance(rows,list):raise InstallError('Invalid database tool container observation')
        owned=[]
        for row in rows:
            if not isinstance(row,dict) or not isinstance(row.get('Labels'),dict):raise InstallError('Invalid database tool container observation')
            owner=row['Labels'].get('dsh.phalanx.upgrade-archive-owner')
            if owner not in owners:continue
            identity=row.get('Id',row.get('ID'))
            if not isinstance(identity,str) or not re.fullmatch('[a-f0-9]{12,64}',identity):raise InstallError('Invalid owned database tool container identity')
            if row.get('State') not in ('running','paused','stopping','created','configured','exited','stopped'):raise InstallError('Unknown database tool container state')
            owned.append(row)
        return owned

    def inspect(self):
        result={'state':'not-installed','components':[],'errors':[],'operations':[]}
        try:
            removal=uninstall_record(self.host)
        except (OSError,ValueError) as error:
            return {**result,'state':'query-failed','errors':[{'component':'installation','reason':str(error)}]}
        if removal and removal['phase']!='retained':
            return {**result,'state':'maintenance','operations':[{'kind':'uninstall','phase':removal['phase']}]}
        state=self.host.path(STATE)
        if not state.exists() and not state.is_symlink():
            if removal and not self.host.path(UNIT).exists():return result
            if any(self.host.path(path).exists() or self.host.path(path).is_symlink() for path in (CONFIG,UNIT)):
                result.update(state='partial',errors=[{'component':'installation','reason':'Incomplete installation; preserve configuration and retry installation'}])
            return result
        try:
            source=installed_source(self.host)
            result['version']=source['receipt']['version']
        except (OSError,ValueError,KeyError,TypeError,InstallError,AdmissionGateError) as error:
            result.update(state='query-failed',errors=[{'component':'installation','reason':str(error)}])
            return result
        def collect(name,read):
            try:result['components'].append(read())
            except (OSError,ValueError,KeyError,TypeError,InstallError,AdmissionGateError) as error:
                result['components'].append({'name':name,'state':'unknown'})
                result['errors'].append({'component':name,'reason':str(error)})
        for name,unit,system,idle in (('platform',PLATFORM,False,False),('updater',UPDATER,True,False),('maintenance-fence',FENCE,True,True)):
            collect(name,lambda name=name,unit=unit,system=system,idle=idle:self.service(name,unit,source,system=system,idle=idle))
        database=self.host.path('/var/lib/dsh-phalanx/.config/systemd/user/'+DATABASE)
        if database.exists():collect('builtin-database',lambda:self.service('builtin-database',DATABASE,source))
        try:result['databaseSelection']=self.database_selection(source)
        except (OSError,ValueError,KeyError,TypeError,InstallError) as error:
            result['databaseSelection']='unknown'
            result['errors'].append({'component':'builtin-database','reason':str(error)})
        def database_containers():
            rows=self.builtin_containers(source)
            active=sum(row['State'] in ('running','paused','stopping') for row in rows)
            return {'name':'builtin-database-containers','state':'running' if active else 'stopped','running':active}
        collect('builtin-database-containers',database_containers)
        def members():
            rows=self.member_containers(source)
            running=sum(row['State'] in ('running','paused','stopping') for row in rows)
            return {'name':'members','state':'running' if running else 'stopped','running':running,'total':len(rows)}
        collect('members',members)
        def maintenance():
            rows=self.maintenance_workers(source)
            active=sum(int(facts['MainPID'])>0 or facts.get('NFileDescriptorStore')!='0' for _,facts in rows)
            return {'name':'maintenance-workers','state':'running' if active else 'stopped','running':active}
        def archives():
            rows=self.archive_containers(source)
            active=sum(row['State'] in ('running','paused','stopping') for row in rows)
            return {'name':'upgrade-tools','state':'running' if active else 'stopped','running':active}
        collect('maintenance-workers',maintenance)
        collect('upgrade-tools',archives)
        try:result['operations']=self.pending()
        except (OSError,ValueError,KeyError,TypeError,InstallError,AdmissionGateError) as error:result['errors'].append({'component':'maintenance','reason':str(error)})
        platform=next(row for row in result['components'] if row['name']=='platform')
        if platform['state']=='running' and not result['operations']:
            try:
                values=source['values'];port=int(values['DSH_PHALANX_PORT']);entry=entry_url(port,values['DSH_PHALANX_HOST'])
                address=ipaddress.ip_address(urllib.parse.urlsplit(entry).hostname)
                if not self.host.pid_owns_listener(platform['mainPid'],port,address):raise InstallError('Managed platform process does not own the configured listener')
                initialization=result.get('databaseSelection') is None
                self.host.request(entry+('/login' if initialization else '/readyz'),authority=origin_authority(values['DSH_PHALANX_PUBLIC_ORIGIN']),max_bytes=65536,timeout=5)
                platform['initializationRequired']=initialization
                platform['ready']=True
            except (OSError,ValueError,KeyError,TypeError,InstallError) as error:
                platform['ready']=False
                result['errors'].append({'component':'platform','reason':str(error)})
        states={row['name']:row['state'] for row in result['components']}
        required=[row['state'] for row in result['components'] if row['name'] not in ('members','maintenance-fence','maintenance-workers','upgrade-tools','builtin-database-containers') and not (row['name']=='builtin-database' and result.get('databaseSelection')=='external')]
        database_consistent=(states.get('builtin-database')=='running')==(states['builtin-database-containers']=='running')
        if result['errors']:result['state']='query-failed'
        elif result['operations']:result['state']='maintenance'
        elif required and all(state=='running' for state in required) and states['maintenance-fence'] in ('idle','stopped') and states['maintenance-workers']=='stopped' and states['upgrade-tools']=='stopped' and database_consistent:result['state']='running'
        elif all(state in ('stopped','idle') for state in states.values()):result['state']='stopped'
        else:result['state']='partial'
        return result

    def verify_service_files(self,source):
        files=[(UNIT,('EnvironmentFile='+CONFIG,'ExecStart=/opt/dsh-phalanx/current/start','WorkingDirectory=/var/lib/dsh-phalanx')),
               ('/etc/systemd/system/'+UPDATER,('ExecStart=/usr/bin/python3 -B /opt/dsh-phalanx/updater/updater.py','KillMode=control-group'))]
        database='/var/lib/dsh-phalanx/.config/systemd/user/'+DATABASE
        if self.host.path(database).exists():
            files.append((database,('--name','dsh-phalanx-postgres','dsh.phalanx.database=builtin','PartOf=dsh-phalanx.service',unit_argument(str(self.host.path(default_storage_root(source['values']['DSH_PHALANX_DATA_ROOT'])+'/postgres'))+':/var/lib/postgresql/data'))))
        for name,required in files:
            path=self.host.path(name)
            if path.is_symlink() or not path.is_file() or path.stat().st_mode&0o022:
                raise InstallError('Managed service file ownership cannot be verified: '+name)
            if path.stat().st_uid not in (os.geteuid(),source['uid']) or name.startswith('/etc/systemd/') and path.stat().st_uid!=os.geteuid():raise InstallError('Managed service file owner differs: '+name)
            text=path.read_text()
            if any(fragment not in text for fragment in required):raise InstallError('Managed service definition differs: '+name)

    def change(self,action,*,confirmed=True):
        with deployment_lease(self.host) as acquired:
            if acquired:
                return self.change_locked(action,confirmed=confirmed)
            result={**self.inspect(),'steps':[],'changed':False,'conflict':True}
            result['errors'].append({'component':'operation','reason':'Another installation or maintenance operation owns the deployment lock'})
            return result

    def change_locked(self,action,*,confirmed=True):
        result={'steps':[],'changed':False}
        before=self.inspect()
        result.update(before)
        if any(operation['kind']=='uninstall' for operation in before.get('operations', [])):
            result['conflict']=True
            result['errors'].append({'component':'operation','reason':'Complete the recorded uninstall before changing services'})
            return result
        if before['state']=='not-installed':
            if action=='start':result['errors'].append({'component':'installation','reason':'Install the deployment before starting it'})
            return result
        try:
            pending=self.pending()
            if pending:
                result.update(state='maintenance',operations=pending,conflict=True)
                result['errors'].append({'component':'operation','reason':'Complete or recover the existing maintenance operation first'})
                return result
            source=installed_source(self.host)
            self.verify_service_files(source)
            self.builtin_containers(source)
        except (OSError,ValueError,KeyError,TypeError,InstallError,AdmissionGateError) as error:
            result['errors'].append({'component':'installation','reason':str(error)})
            return result
        goal='stopped' if action=='stop' else 'running'
        if before['state']==goal and not before['errors']:return result
        if action=='stop' and not confirmed:
            result['confirmationRequired']=True
            result['errors'].append({'component':'confirmation','reason':'stop interrupts tasks; pass --yes to explicitly accept interruption'})
            return result
        states={row['name']:row for row in before['components']}
        def step(name,operation,call):
            row={'component':name,'action':operation}
            try:
                call();row['status']='completed'
            except (OSError,ValueError,KeyError,TypeError,InstallError,AdmissionGateError) as error:
                row.update(status='failed',reason=str(error))
            result['steps'].append(row)
        def service(name,unit,*,system=False):
            row=states.get(name)
            if not row or row['state']=='unknown':return
            target=('stopped','idle') if action=='stop' else ('running','idle') if name=='maintenance-fence' else ('running',)
            if row['state'] in target:return
            arguments=['systemctl',*([] if system else ['--user']),action,unit]
            step(name,action,lambda:self.host.run(arguments) if system else self.host.user(source['uid'],arguments))
        if action=='stop':service('updater',UPDATER,system=True)
        try:
            for worker,_ in self.maintenance_workers(source):step('maintenance:'+worker.unit,'stop',worker.stop)
            for row in self.archive_containers(source):
                identity=row.get('Id',row.get('ID'))
                step('upgrade-tool:'+identity,'stop',lambda identity=identity:self.host.run(['podman','rm','--force','--ignore','--time','0',identity]))
        except (OSError,ValueError,KeyError,TypeError,InstallError,AdmissionGateError) as error:
            result['steps'].append({'component':'maintenance-workers','action':'stop','status':'failed','reason':str(error)})
        if action=='stop':
            service('platform',PLATFORM)
            try:
                for row in self.member_containers(source):
                    identity=row.get('Id',row.get('ID'))
                    step('member:'+identity,'stop',lambda identity=identity:self.host.user(source['uid'],['podman','rm','--force','--ignore','--time','0',identity]))
            except (OSError,ValueError,KeyError,TypeError,InstallError,AdmissionGateError) as error:
                result['steps'].append({'component':'members','action':'stop','status':'failed','reason':str(error)})
            service('builtin-database',DATABASE)
            try:
                for row in self.builtin_containers(source):
                    identity=row.get('Id',row.get('ID'))
                    step('builtin-database:'+identity,'stop',lambda identity=identity:self.host.user(source['uid'],['podman','rm','--force','--ignore','--time','0',identity]))
            except (OSError,ValueError,KeyError,TypeError,InstallError) as error:
                result['steps'].append({'component':'builtin-database','action':'stop','status':'failed','reason':str(error)})
        else:
            service('maintenance-fence',FENCE,system=True)
            if before.get('databaseSelection')!='external':service('builtin-database',DATABASE)
            service('platform',PLATFORM)
            service('updater',UPDATER,system=True)
            if any(row['component']=='platform' and row['status']=='completed' for row in result['steps']):
                step('platform','readiness',lambda:self.host.ready(source['uid'],int(source['values']['DSH_PHALANX_PORT']),source['values']['DSH_PHALANX_HOST'],source['values']['DSH_PHALANX_PUBLIC_ORIGIN']))
        observed=self.inspect()
        result.update(observed)
        result['changed']=any(row['status']=='completed' and row['action']!='readiness' for row in result['steps'])
        for row in result['steps']:
            if row['status']=='failed':result['errors'].append({'component':row['component'],'reason':row['reason']})
        goal='stopped' if action=='stop' else 'running'
        if result['state']!=goal:result['errors'].append({'component':'deployment','reason':'Some managed components have not reached '+goal+'; inspect component results and retry'})
        return result
