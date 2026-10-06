"""Root update owner: durable admission, shared CLI lock and independent workers."""
import fcntl
import json
import os
import re
from pathlib import Path
import socket
import stat
import tempfile
import threading
import time
from types import SimpleNamespace
from installer_host import Host,InstallError
from installer_progress import Progress
from installer_config import installed_state,read_configuration
from installer_compatibility import STABLE,compatible,version_parts
from installer_release import release_notes
from installer_upgrade_cli import selected_target,public_operation
from installer_upgrade_core import UpgradeCore,ACTIVE
from installer_upgrade_host import UpgradeHost
from installer_executor_protocol import SOCKET,ControlError
from installer_executor_server import ControlServer
from installer_executor_install import executor_package,executor_pointer,EXECUTOR,activate_executor


class UpgradeExecutor:
    def __init__(self,host_factory=Host,selector=selected_target,port_factory=UpgradeHost):
        self.host_factory=host_factory;self.selector=selector;self.port_factory=port_factory
        self.mutex=threading.Lock()
        self.loaded_pointer=executor_pointer(host_factory())

    def host(self,persist=False):
        host=self.host_factory();host.progress=Progress(host.root,persist=persist)
        values=read_configuration(host)
        host.progress.protect(*(value for key,value in values.items() if key.endswith(('_KEY','_SECRET'))))
        return host

    def status(self,operation=None):
        host=self.host();port=self.port_factory(host);job=port.operation(operation)
        if operation and job is None:raise ControlError(404,'Unknown update operation')
        state=installed_state(host)
        running=None
        try:
            source=port.source();port.verify_source(source,'/readyz' if source['manifest'].get('schema')==2 else '/login',readiness=False)
            running=state['version']
        except (InstallError,OSError,ValueError,KeyError):pass
        events=[]
        if job and isinstance(job.get('diagnostic'),str) and re.fullmatch(r'[0-9]{8}T[0-9]{6}-[a-f0-9]{8}\.jsonl',job['diagnostic']):
            file=host.path('/var/log/dsh-phalanx')/job['diagnostic']
            if file.is_file() and not file.is_symlink():
                with file.open('rb') as stream:
                    stream.seek(max(0,file.stat().st_size-32768));lines=stream.read().decode(errors='replace').splitlines()
                for line in lines[-30:]:
                    try:
                        row=json.loads(line);events.append({key:host.progress.safe(row[key]) for key in ('phase','status','message') if isinstance(row.get(key),str)})
                    except ValueError:continue
        return {'currentVersion':state['version'] if state else None,'runningVersion':running,'operation':public_operation(job),'events':events}

    def check(self):
        host=self.host();port=self.port_factory(host)
        result={'checkedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
        try:
            source=port.source()
            with tempfile.TemporaryDirectory(prefix='dsh-phalanx-check-') as directory:
                target=self.selector(host,SimpleNamespace(version='latest',bundle_dir=None),Path(directory))
            if not STABLE.fullmatch(target['version']):raise InstallError('Only a completed formal release can be selected')
            result.update(version=target['version'],manifestSha256=target['manifestSha256'],releaseNotes=release_notes(host,target['version']))
            if version_parts(target['manifest']['targetVersion'])<=version_parts(source['manifest']['targetVersion']):
                result['status']='current'
            else:
                try:compatible(source['manifest'],target['manifest'],port.schema(source));result['status']='available'
                except InstallError as error:result.update(status='incompatible',reason=host.progress.safe(str(error)))
        except Exception as error:result.update(status='failed',reason=host.progress.safe(str(error)))
        return {'check':result,**self.status()}

    def lock(self,host):
        if not self.mutex.acquire(blocking=False):raise ControlError(409,'Another update or recovery is running')
        file=None
        try:
            path=host.mkdir('/run/lock',mode=None)/'dsh-phalanx-install.lock'
            file=os.fdopen(os.open(path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600),'w')
            fcntl.flock(file,fcntl.LOCK_EX|fcntl.LOCK_NB)
            return file
        except BlockingIOError:
            if file:file.close()
            self.mutex.release();raise ControlError(409,'Another installer is running') from None
        except BaseException:
            if file:file.close()
            self.mutex.release();raise

    def finish(self,host,file,work):
        try:
            with host.progress.stage('System update'):work()
        except Exception as error:host.progress.emit('failed',str(error))
        finally:
            file.close();self.mutex.release()
        # An immutable bank may have changed at commit or verified restoration.
        # Finish and release the shared lock before systemd replaces this process.
        if executor_pointer(host)!=self.loaded_pointer:activate_executor(host,restart=True)

    def launch(self,host,file,work):
        worker=threading.Thread(target=self.finish,args=(host,file,work),daemon=False)
        worker.start()

    def handle(self,value):
        action=value['action'];operation=value.get('operation')
        if action=='status':return self.status(operation)
        if action=='check':return self.check()
        host=self.host(persist=True);port=self.port_factory(host);core=UpgradeCore(port)
        # Repeated accepted requests query their durable identity, even while
        # the worker holds the lock. They never queue a second transaction.
        existing=port.operation(operation)
        if self.mutex.locked() and existing and ((action=='prepare' and existing['target']['version']==value['version'] and existing['target']['manifestSha256']==value['manifestSha256']) or (action in ('apply','recover') and existing['id']==operation)):
            return {'operation':public_operation(existing)}
        file=self.lock(host)
        handed=False
        try:
            if action=='prepare':
                with tempfile.TemporaryDirectory(prefix='dsh-phalanx-selection-') as directory:
                    target=self.selector(host,SimpleNamespace(version=value['version'],bundle_dir=None),Path(directory))
                if target['version']!=value['version'] or target['manifestSha256']!=value['manifestSha256']:
                    raise ControlError(409,'Selected release metadata changed; check again')
                if not STABLE.fullmatch(target['version']):raise ControlError(400,'A formal release is required')
                job=core.begin_prepare(target)
                if job['phase']=='preparing':
                    job['diagnostic']=host.progress.log.name if host.progress.log else None;port.save(job)
                    self.launch(host,file,lambda:core.finish_prepare(job['id']));handed=True
            else:
                job=port.operation(operation)
                if job is None:raise ControlError(404,'Unknown update operation')
                if action=='apply':
                    if not STABLE.fullmatch(job['target']['version']):raise ControlError(400,'Web application requires a formal release')
                    if job['phase']=='prepared':
                        job['diagnostic']=host.progress.log.name if host.progress.log else None;port.save(job)
                    job=core.submit_apply(job['id'])
                    if job['phase']=='stopping':self.launch(host,file,lambda:core.finish_apply(job['id']));handed=True
                elif action=='recover':
                    if job['phase'] in ACTIVE:self.launch(host,file,lambda:core.recover(job['id']));handed=True
            return {'operation':public_operation(job)}
        except InstallError as error:raise ControlError(409,host.progress.safe(str(error))) from None
        finally:
            if not handed:file.close();self.mutex.release()

    def recover_at_start(self):
        host=self.host(persist=True)
        # Boot recovery waits for an already running CLI. Requests use NB locks.
        self.mutex.acquire()
        path=host.mkdir('/run/lock',mode=None)/'dsh-phalanx-install.lock'
        file=os.fdopen(os.open(path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600),'w')
        fcntl.flock(file,fcntl.LOCK_EX)
        self.finish(host,file,lambda:UpgradeCore(self.port_factory(host)).recover() if self.port_factory(host).operation() and self.port_factory(host).operation()['phase'] in ACTIVE else None)


def main():
    host=Host()
    if host.uid!=0 or host.system!='Linux':raise InstallError('The update executor requires its root Linux service')
    executor_package(Path(__file__).resolve().parent)
    account=host.run(['getent','passwd','dsh-phalanx']).stdout.strip().split(':')
    if len(account)!=7 or account[5]!='/var/lib/dsh-phalanx' or account[6]!='/usr/sbin/nologin' or int(account[2])==0:
        raise InstallError('Invalid managed service identity')
    uid,gid=int(account[2]),int(account[3]);directory=Path(SOCKET).parent
    info=directory.lstat()
    if directory.is_symlink() or info.st_uid!=0 or info.st_gid!=gid or info.st_mode & 0o027:raise InstallError('Invalid update runtime directory')
    path=Path(SOCKET)
    if path.exists() or path.is_symlink():
        info=path.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid!=0:raise InstallError('Invalid update control socket')
        with socket.socket(socket.AF_UNIX) as probe:
            try:probe.connect(SOCKET)
            except ConnectionRefusedError:path.unlink()
            else:raise InstallError('Another update executor is listening')
    service=UpgradeExecutor();server=ControlServer(SOCKET,service,uid);os.chown(SOCKET,0,gid)
    threading.Thread(target=service.recover_at_start,daemon=False).start()
    try:server.serve_forever()
    finally:server.server_close()
