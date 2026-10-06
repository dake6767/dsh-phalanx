"""Protected upgrade journal and Linux service/container transaction adapter."""
import copy
import hashlib
import ipaddress
import json
import os
import re
import urllib.parse
from contextlib import contextmanager
from pathlib import Path
import sqlite3
import tempfile
import uuid
import shutil
from types import SimpleNamespace
from installer_host import InstallError, entry_url  # embedded-host
from installer_config import read_configuration, installed_state, validate_storage, environment_text  # embedded-config
from installer_release import ASSETS, acquire, digest, supply_image, stage_platform, verify_image  # embedded-release
from installer_compatibility import compatible  # embedded-compatibility
from installer_upgrade_gate import LinuxAdmissionGate, MARK  # embedded-upgrade-gate
from installer_upgrade_backup import PlatformBackup, sync_directory  # embedded-upgrade-backup

UPGRADE_ROOT='/var/lib/dsh-phalanx-updater'
MAINTENANCE='/etc/dsh-phalanx/maintenance'
CONFIG='/etc/dsh-phalanx/environment'
STATE='/etc/dsh-phalanx/install-state.json'
MANIFEST='/etc/dsh-phalanx/installed-manifest.json'
CURRENT='/opt/dsh-phalanx/current'
UNIT='/var/lib/dsh-phalanx/.config/systemd/user/dsh-phalanx.service'


def operation_id(value):
    if not isinstance(value,str) or str(uuid.UUID(value))!=value:raise InstallError('Invalid upgrade operation identity')
    return value




class UpgradeHost:
    def __init__(self,host,bundle=None):
        self.host=host; self.bundle=bundle
        self.root=host.mkdir(UPGRADE_ROOT,0o700)
        self.admission=LinuxAdmissionGate()

    def safe(self,message):return self.host.progress.safe(message) if self.host.progress else 'Upgrade failed; inspect restricted diagnostics'

    def path(self,job):return self.root/operation_id(job['id'])

    def operation(self,operation=None):
        pointer=self.root/'current'
        if operation is None:
            if not pointer.exists():return None
            operation=pointer.read_text().strip()
        path=self.root/operation_id(operation)/'operation.json'
        if path.is_symlink():raise InstallError('Upgrade journal cannot be a symbolic link')
        return json.loads(path.read_text()) if path.exists() else None

    def save(self,job):
        directory=self.path(job); directory.mkdir(mode=0o700,exist_ok=True)
        self.host.atomic(str(directory.relative_to(self.host.root))+'/operation.json',json.dumps(job)+'\n')
        sync_directory(directory)
        self.host.atomic(UPGRADE_ROOT+'/current',job['id']+'\n'); sync_directory(self.root)
        self.host.tell('Upgrade '+job['id']+': '+job['phase'])

    def source(self):
        state=installed_state(self.host)
        if state is None:raise InstallError('A successful managed installation is required')
        manifest=json.loads(self.host.path(MANIFEST).read_text())
        if state['commit']!=manifest['commit'] or state['imageDigest']!=manifest['image']['digest'] or state['platformSha256']!=manifest['files'][ASSETS[0]]:
            raise InstallError('Installed release manifest and receipt disagree')
        values=read_configuration(self.host)
        account=self.host.run(['getent','passwd','dsh-phalanx']).stdout.strip().split(':')
        if len(account)!=7 or account[5]!='/var/lib/dsh-phalanx' or account[6]!='/usr/sbin/nologin' or int(account[2])==0:
            raise InstallError('Managed service identity is incompatible')
        current=self.host.path(CURRENT)
        if not current.is_symlink():raise InstallError('Current release must be a managed symbolic link')
        target=current.resolve()
        if target.parent!=self.host.path('/opt/dsh-phalanx/releases') or (target/'.artifact-sha256').read_text()!=state['platformSha256']:
            raise InstallError('Running release path or artifact identity is inconsistent')
        return {'receipt':state,'manifest':manifest,'values':values,'target':str(target),'uid':int(account[2]),'gid':int(account[3])}

    def begin(self,target):
        source=self.source()
        return {'id':str(uuid.uuid4()),'phase':'preparing','target':copy.deepcopy(target),'source':source}

    def schema(self,source):
        path=self.host.path(source['values']['DSH_PHALANX_DATA_ROOT'])/'community-accounts.db'
        if path.is_symlink() or not path.is_file():raise InstallError('Account database must be an existing regular carrier')
        with sqlite3.connect(path.as_uri()+'?mode=ro',uri=True) as connection:return connection.execute('PRAGMA user_version').fetchone()[0]

    def preflight(self,job):
        source=self.source()
        if source!=job['source']:raise InstallError('Installed source changed after this target was selected; download again')
        compatible(source['manifest'],job['target']['manifest'],self.schema(source))
        validate_storage(self.host,source['values'])
        if self.host.path(MAINTENANCE).exists():raise InstallError('Maintenance is already closed; recover the previous operation first')
        values=source['values']; data=self.host.path(values['DSH_PHALANX_DATA_ROOT'])
        users=self.host.path(values.get('DSH_PHALANX_USER_DATA_ROOT',values['DSH_PHALANX_DATA_ROOT']+'/users'))
        if data.is_symlink() or not data.is_dir():raise InstallError('Invalid platform data root')
        if users.is_relative_to(data) and users!=data/'users':raise InstallError('Upgrade supports only reserved users or a separate user data root')
        self.verify_source(source)
        if 'prepared' in job:
            self.admission.preflight(self.ports(source))
            prepared=job['prepared']; target=Path(prepared['target'])
            if (target/'.artifact-sha256').read_text()!=job['target']['manifest']['files'][ASSETS[0]]:
                raise InstallError('Prepared platform identity changed')
            supply_image(self.host,source['uid'],self.path(job),job['target']['manifest'],False)

    def ports(self,source):return [{'address':source['values']['DSH_PHALANX_HOST'],'port':int(source['values']['DSH_PHALANX_PORT'])},{'address':'127.0.0.1','port':int(source['values'].get('DSH_PHALANX_CONTAINER_GATEWAY_PORT','3081'))}]

    def prepare(self,job):
        if shutil.which('nft') is None:
            self.host.run(['apt-get','-o','DPkg::Lock::Timeout=600','update'])
            self.host.run(['apt-get','-o','DPkg::Lock::Timeout=600','install','-y','--no-install-recommends','nftables'])
        self.admission.preflight(self.ports(job['source']))
        self.admission.install(self.host,job['source']['uid'])
        def fixed(directory,manifest,version):
            if version!=job['target']['version'] or manifest!=job['target']['manifest'] or digest(directory/'manifest.json')!=job['target']['manifestSha256']:
                raise InstallError('Selected release metadata changed; target was not downloaded')
            compatible(job['source']['manifest'],manifest,self.schema(job['source']))
        with tempfile.TemporaryDirectory(prefix='download-',dir=self.path(job)) as temporary:
            args=SimpleNamespace(version=job['target']['version'],bundle_dir=self.bundle)
            directory,manifest=acquire(self.host,args,Path(temporary),fixed)
            target=stage_platform(self.host,directory,manifest)
            command=supply_image(self.host,job['source']['uid'],directory,manifest,self.bundle is not None)
        return {'target':str(self.host.path(target)),'command':command,'manifestSha256':job['target']['manifestSha256']}

    def gate(self,closed):
        if closed:
            job=self.operation(); ports=self.ports(job['source'])
            self.host.atomic(MAINTENANCE,json.dumps({'schema':1,'ports':ports})+'\n',0o644)
            try:self.admission.close(ports)
            except Exception:
                # A legacy binary has no application marker support. Stop its
                # exact managed service if the independent fence is unavailable.
                self.stop(job)
                raise
        else:
            self.admission.open()
            self.host.path(MAINTENANCE).unlink(missing_ok=True)
        sync_directory(self.host.path('/etc/dsh-phalanx'))

    def stop(self,job):
        source=job['source']; uid=source['uid']
        self.host.user(uid,['systemctl','--user','stop','dsh-phalanx.service'])
        ownership=hashlib.sha256(str(Path(source['values']['DSH_PHALANX_DATA_ROOT']).resolve()).encode()).hexdigest()
        filters=['--filter','label=dsh-phalanx.community=1','--filter','label=dsh-phalanx.community-root='+ownership]
        command=['podman','ps','--all',*filters,'--format','json']
        rows=json.loads(self.host.user(uid,command).stdout)
        for row in rows:
            labels=row.get('Labels',{})
            if labels.get('dsh-phalanx.community')!='1' or labels.get('dsh-phalanx.community-root')!=ownership:
                raise InstallError('Owned container listing has inconsistent labels')
            identity=row.get('Id',row.get('ID'))
            if not isinstance(identity,str) or not re.fullmatch('[a-f0-9]{12,64}',identity):raise InstallError('Invalid owned container identity')
            self.host.user(uid,['podman','rm','--force','--ignore','--time','0',identity])
        if json.loads(self.host.user(uid,command).stdout):raise InstallError('Owned user instances remain; backup and switch refused')

    def carriers(self):
        return {'configuration':self.host.path(CONFIG),'receipt':self.host.path(STATE),'manifest':self.host.path(MANIFEST),'unit':self.host.path(UNIT)}

    def backup_owner(self,job):
        return PlatformBackup(self.host.path(job['source']['values']['DSH_PHALANX_DATA_ROOT']),self.path(job)/'backup',self.carriers())

    @contextmanager
    def quiescent(self,job):
        data=self.host.path(job['source']['values']['DSH_PHALANX_DATA_ROOT']); lock=data/'platform-lock.db'
        if lock.is_symlink():raise InstallError('Platform writer lock cannot be a symbolic link')
        with sqlite3.connect(lock,timeout=0) as connection:
            connection.execute('BEGIN EXCLUSIVE')
            try:yield
            finally:connection.rollback()

    def backup(self,job):
        with self.quiescent(job):return self.backup_owner(job).create()

    def link(self,target):
        replacement=self.host.path(CURRENT+'.next'); replacement.unlink(missing_ok=True); replacement.symlink_to(target)
        os.replace(replacement,self.host.path(CURRENT)); sync_directory(self.host.path('/opt/dsh-phalanx'))

    def start(self,job):
        uid=job['source']['uid']; self.host.user(uid,['systemctl','--user','daemon-reload'])
        self.host.user(uid,['systemctl','--user','enable','--now','dsh-phalanx.service'])

    def switch(self,job):
        self.backup_owner(job).verify(job['backup'])
        values=copy.deepcopy(job['source']['values']); manifest=job['target']['manifest']; command=job['prepared']['command']
        values.update(DSH_PHALANX_CONTAINER_IMAGE=manifest['image']['reference'],DSH_PHALANX_RUNTIME_COMMAND=command[0],
                      DSH_PHALANX_RUNTIME_ARGS_JSON=json.dumps(command[1:],separators=(',',':')),
                      DSH_PHALANX_MAINTENANCE_FILE=MAINTENANCE)
        self.host.atomic(CONFIG,environment_text(values),0o640)
        self.host.run(['chown','0:'+str(job['source']['gid']),str(self.host.path(CONFIG))])
        with self.host.path(CONFIG).open('rb') as file:os.fsync(file.fileno())
        self.link(job['prepared']['target']); self.start(job)

    def verify_source(self,source,ready_path='/login'):
        verify_image(self.host,source['uid'],source['manifest'])
        values=source['values']; uid=source['uid']; port=int(values['DSH_PHALANX_PORT'])
        self.host.ready(uid,port,values['DSH_PHALANX_HOST'],values['DSH_PHALANX_PUBLIC_ORIGIN'],path=ready_path,**({'socket_mark':MARK} if self.host.path(MAINTENANCE).exists() else {}))
        address=ipaddress.ip_address(urllib.parse.urlparse(entry_url(port,values['DSH_PHALANX_HOST'])).hostname)
        pid=self.host.listener_pid(uid,port,address); target=Path(source['target'])
        if not pid or self.host.path('/proc/'+str(pid)+'/cwd').resolve()!=target or self.host.path('/proc/'+str(pid)+'/exe').resolve()!=target/'node/bin/node':
            raise InstallError('Managed listener process does not execute the selected packaged release')
        if (target/'.artifact-sha256').read_text()!=source['manifest']['files'][ASSETS[0]] or json.loads((target/'build-info.json').read_text())['commit']!=source['manifest']['commit']:
            raise InstallError('Selected platform source identity does not match the healthy process')

    def verify(self,job,old=False):
        if old:source=job['source']
        else:source={**job['source'],'target':job['prepared']['target'],'manifest':job['target']['manifest']}
        path='/readyz' if source['manifest'].get('schema')==2 else '/login'
        self.verify_source(source,path)
        if not old and self.schema(source)!=source['manifest']['compatibility']['accounts']['target']:
            raise InstallError('Target account database schema does not match its declared identity')

    def restore(self,job):
        with self.quiescent(job):self.backup_owner(job).restore(job['backup'])
        self.link(job['source']['target']); self.start(job)

    def restart_old(self,job):
        if self.host.path(CURRENT).resolve()!=Path(job['source']['target']):raise InstallError('No verified backup exists for the changed current release')
        self.start(job)

    def commit(self,job):
        manifest=job['target']['manifest']; receipt={**job['source']['receipt'],'version':job['target']['version'],'candidate':manifest['tag'],
            'commit':manifest['commit'],'platformSha256':manifest['files'][ASSETS[0]],'imageDigest':manifest['image']['digest'],'changed':True}
        self.host.atomic(STATE,json.dumps(receipt)+'\n'); self.host.atomic(MANIFEST,json.dumps(manifest)+'\n')
        sync_directory(self.host.path('/etc/dsh-phalanx'))
