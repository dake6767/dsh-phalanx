"""Root update owner: durable admission, shared CLI lock and independent workers."""
import fcntl
import atexit
import signal
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
from installer_progress import Progress,previous_downtime,update_diagnostic_path,update_error_code
from installer_config import installed_state,read_configuration
from installer_config import configured_download_sources,resolve_download_sources,download_source_choice
from installer_compatibility import STABLE, CANDIDATE, version_parts
from installer_release import release_versions
from installer_upgrade_cli import selected_target,public_operation,check_releases
from installer_upgrade_core import UpgradeCore,ACTIVE
from installer_upgrade_host import UpgradeHost
from installer_executor_protocol import SOCKET,ControlError
from installer_executor_server import ControlServer
from installer_operations import PlatformOperations
from installer_executor_install import executor_package,executor_pointer,EXECUTOR,activate_executor


class UpgradeExecutor:
    def __init__(self,host_factory=Host,selector=selected_target,port_factory=UpgradeHost,version_lister=release_versions):
        self.host_factory=host_factory;self.selector=selector;self.port_factory=port_factory
        self.version_lister=version_lister
        self.mutex=threading.Lock();self.image_lock=threading.Lock();self.images=None;self.image_uid=None;self.closed=False
        atexit.register(self.close)
        self.loaded_pointer=executor_pointer(host_factory())

    def inspect_image(self,host,uid,reference):
        with self.image_lock:
            if self.closed:raise InstallError('The update executor is stopping')
            try:
                if self.images is not None and self.image_uid!=uid:self.images.close();self.images=None
                if self.images is None:self.images=host.open_image_inspector(uid);self.image_uid=uid
                return self.images.inspect(reference)
            except BaseException:
                if self.images:self.images.close();self.images=None
                raise

    def close(self):
        with self.image_lock:
            self.closed=True
            if self.images:self.images.close();self.images=None

    def host(self,persist=False,*,download_sources=True):
        host=self.host_factory();host.image_inspector=self.inspect_image;host.progress=Progress(host.root,persist=persist)
        host.configure_proxy()
        values=read_configuration(host)
        # The updater runs beside the live platform, so an administrator's saved choice is authoritative here.
        host.download_sources=resolve_download_sources(configured_download_sources(host,values,platform_running=download_sources))
        host.progress.protect(*(value for key,value in values.items() if key.endswith(('_KEY','_SECRET'))))
        return host

    def status(self,operation=None):
        host=self.host(download_sources=False);port=self.port_factory(host)
        return self.status_projection(host,port,operation)

    def status_projection(self,host,port,operation=None):
        job=port.operation(operation)
        if operation and job is None:raise ControlError(404,'Unknown update operation')
        state=installed_state(host)
        running=None
        try:
            source=port.source();port.verify_source(source,'/readyz' if source['manifest'].get('schema')==2 else '/login',readiness=False)
            running=state['version']
        except (InstallError,OSError,ValueError,KeyError):pass
        events=[];diagnostic=update_diagnostic_path(job.get('diagnostic')) if job else None
        if diagnostic:
            file=host.path(diagnostic)
            if file.is_file() and not file.is_symlink():
                with file.open('rb') as stream:
                    stream.seek(max(0,file.stat().st_size-32768));lines=stream.read().decode(errors='replace').splitlines()
                for line in lines[-30:]:
                    try:
                        row=json.loads(line)
                        event={key:host.progress.safe(row[key]) for key in ('phase','phaseCode','errorCode','status','message','action') if isinstance(row.get(key),str)}
                        event.update({key:row[key] for key in ('bytes','total') if type(row.get(key)) is int and 0<=row[key]<=9007199254740991})
                        event.update({key:row[key] for key in ('elapsed','phaseElapsed') if type(row.get(key)) in (int,float) and 0<=row[key]<=9007199254740991})
                        events.append(event)
                    except ValueError:continue
        point=port.time_point() if hasattr(port,'time_point') else None;previous=previous_downtime(job,point)
        return {'currentVersion':state['version'] if state else None,'runningVersion':running,'operation':public_operation(job,point),'events':events,
                **({'previousDowntimeSeconds':previous} if previous is not None else {})}

    def check(self):
        host=self.host(download_sources=False);port=self.port_factory(host);reader=None
        try:
            source=port.source();modern=version_parts(source['manifest']['targetVersion'])>=(0,1,26)
        except (InstallError,OSError,ValueError,KeyError,TypeError):source=None;modern=False
        if modern:
            try:facts=port.check_facts(source)
            except (InstallError,OSError,ValueError,KeyError,TypeError):facts=None
            host.download_sources=resolve_download_sources(download_source_choice(source['values'],saved=facts))
            reader=lambda current:port.sampled_schema(current,source,facts)
        else:
            host.download_sources=resolve_download_sources(configured_download_sources(host,read_configuration(host),platform_running=True))
        return {'check':check_releases(host,port,self.selector,self.version_lister,schema_reader=reader),**self.status_projection(host,port)}

    def lock(self,host):
        if not self.mutex.acquire(blocking=False):raise ControlError(409,'Another update or recovery is running')
        file=None
        try:
            path=host.mkdir('/run/lock',mode=None)/'dsh-phalanx-install.lock'
            file=os.fdopen(os.open(path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600),'w')
            fcntl.flock(file,fcntl.LOCK_EX|fcntl.LOCK_NB)
            host.install_lock_fd=file.fileno()
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
        except Exception as error:host.progress.emit('failed',str(error),errorCode=update_error_code(error))
        finally:
            file.close();self.mutex.release()
        # An immutable bank may have changed at commit or verified restoration.
        # Finish and release the shared lock before systemd replaces this process.
        if executor_pointer(host)!=self.loaded_pointer:activate_executor(host,restart=True)

    def launch(self,host,file,work):
        worker=threading.Thread(target=self.finish,args=(host,file,work),daemon=False)
        worker.start()

    def require_release(self,source,version):
        if STABLE.fullmatch(version):return
        if version.startswith('run-') and CANDIDATE.fullmatch(version) and source.get('channel',{}).get('kind')=='candidate':return
        raise ControlError(400,'The deployment channel does not allow this release')

    def handle(self,value):
        action=value['action'];operation=value.get('operation')
        if action=='status':return self.status(operation)
        if action=='check':return self.check()
        host=self.host(persist=True);port=self.port_factory(host);core=UpgradeCore(port)
        operations=PlatformOperations(host,port)
        if action=='maintenance-status':return {'operation':operations.status(operation)}
        if action in ('master-key-rotate','master-key-reset','database-switch','maintenance-recover'):
            file=self.lock(host);handed=False
            try:
                job=operations.begin(action,value.get('target')) if action in ('master-key-rotate','master-key-reset','database-switch') else operations.status()
                if not job:raise ControlError(404,'No platform operation to recover')
                if job['phase'] not in ('succeeded','restored'):
                    self.launch(host,file,lambda:operations.run(job['id']));handed=True
                return {'operation':job}
            except InstallError as error:raise ControlError(409,host.progress.safe(str(error)),update_error_code(error)) from None
            finally:
                if not handed:file.close();self.mutex.release()
        pending=operations.status()
        if pending and pending['phase'] not in ('succeeded','restored'):raise ControlError(409,'Recover the pending platform operation first')
        # Repeated accepted requests query their durable identity, even while
        # the worker holds the lock. They never queue a second transaction.
        existing=port.operation(operation)
        if self.mutex.locked() and existing and ((action=='prepare' and existing['target']['version']==value['version'] and existing['target']['manifestSha256']==value['manifestSha256']) or (action in ('apply','recover') and existing['id']==operation) or (action=='cleanup' and existing['id']==operation and existing.get('cleanup',{}).get('status')=='running')):
            return {'operation':public_operation(existing,port.time_point() if hasattr(port,'time_point') else None)}
        file=self.lock(host)
        handed=False
        try:
            if action=='prepare':
                with tempfile.TemporaryDirectory(prefix='dsh-phalanx-selection-') as directory:
                    target=self.selector(host,SimpleNamespace(version=value['version'],bundle_dir=None),Path(directory))
                if target['version']!=value['version'] or target['manifestSha256']!=value['manifestSha256']:
                    raise ControlError(409,'Selected release metadata changed; check again','operation.invalid')
                if not STABLE.fullmatch(target['version']):self.require_release(port.source(),target['version'])
                port.check_fresh_install(target)
                job=core.begin_prepare(target)
                if job['phase']=='preparing':
                    job['diagnostic']=host.progress.log.name if host.progress.log else None;port.save(job)
                    self.launch(host,file,lambda:core.finish_prepare(job['id']));handed=True
            else:
                job=port.operation(operation)
                if job is None:raise ControlError(404,'Unknown update operation')
                if action=='apply':
                    self.require_release(job['source'],job['target']['version'])
                    if job['phase']=='prepared':
                        job['diagnostic']=host.progress.log.name if host.progress.log else None;port.save(job)
                    job=core.submit_apply(job['id'])
                    if job['phase']=='stopping':self.launch(host,file,lambda:core.finish_apply(job['id']));handed=True
                elif action=='cleanup':
                    job=core.begin_cleanup(job['id'])
                    self.launch(host,file,lambda:core.finish_cleanup(job['id']));handed=True
                elif action=='recover':
                    if job['phase'] in ACTIVE:self.launch(host,file,lambda:core.recover(job['id']));handed=True
            return {'operation':public_operation(job,port.time_point() if hasattr(port,'time_point') else None)}
        except InstallError as error:raise ControlError(409,host.progress.safe(str(error)),update_error_code(error)) from None
        finally:
            if not handed:file.close();self.mutex.release()

    def recover_at_start(self):
        host=self.host(persist=True)
        # Boot recovery waits for an already running CLI. Requests use NB locks.
        self.mutex.acquire()
        path=host.mkdir('/run/lock',mode=None)/'dsh-phalanx-install.lock'
        file=os.fdopen(os.open(path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600),'w')
        fcntl.flock(file,fcntl.LOCK_EX)
        host.install_lock_fd=file.fileno()
        def recover():
            port=self.port_factory(host);operations=PlatformOperations(host,port)
            pending=operations.status()
            if pending and pending['phase'] not in ('succeeded','restored'):operations.recover();return
            job=port.operation()
            if job and (job['phase'] in ACTIVE or job.get('cleanup',{}).get('status')=='running'):UpgradeCore(port).recover()
        self.finish(host,file,recover)


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
    def stop(*_):raise SystemExit(0)
    signal.signal(signal.SIGTERM,stop)
    try:server.serve_forever()
    finally:server.server_close();service.close()
