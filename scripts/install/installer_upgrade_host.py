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
import tempfile
import fcntl  # Local process mutex only; platform facts use the source database adapters.
import uuid
import shutil
from types import SimpleNamespace
from installer_progress import previous_downtime  # embedded-progress
from installer_host import InstallError, entry_url,install_failure  # embedded-host
from installer_config import effective_user_data_root, platform_facts, executor_facts, read_configuration, installed_state, validate_storage, environment_text  # embedded-config
from installer_release import release_channel, installed_channel, asset_names, acquire, digest, supply_image, stage_platform, verify_image, select_release  # embedded-release
from installer_compatibility import compatible, upgrade_outcome, plugin_readiness_budget, require_upgrade_source, validate_contract, version_parts, STABLE, CANDIDATE, supports_capacity  # embedded-compatibility
from installer_upgrade_gate import LinuxAdmissionGate, MaintenanceUnit, ListenerPinUnit, maintenance_token, process_started, maintenance_pages, protected_json, MARK, protected_ports  # embedded-upgrade-gate
from installer_executor_install import install_executor,installed_executor,executor_package,ensure_executor_identity,EXECUTOR,EXECUTOR_UNIT  # embedded-executor-install
from installer_upgrade_backup import PlatformBackup, UpgradeDatabaseBackup, rebuildable_paths, sync_directory  # embedded-upgrade-backup
from installer_storage import UpgradeStorage  # embedded-storage
from installer_cleanup import UpgradeCleanup  # embedded-cleanup

UPGRADE_ROOT='/var/lib/dsh-phalanx-updater'
MAINTENANCE='/etc/dsh-phalanx/maintenance'
CONFIG='/etc/dsh-phalanx/environment'
STATE='/etc/dsh-phalanx/install-state.json'
MANIFEST='/etc/dsh-phalanx/installed-manifest.json'
CURRENT='/opt/dsh-phalanx/current'
UNIT='/var/lib/dsh-phalanx/.config/systemd/user/dsh-phalanx.service'


def plugin_startup_timeout(host,values,manifest):
    target=manifest['targetVersion']+'/'+manifest['dshRevision']
    try:library=platform_facts(host,values,'plugin-budget-rows')
    except ValueError as error:raise InstallError('Invalid plugin library for startup budget') from error
    return 90 if library is None else plugin_readiness_budget(library,target)


def source_schema_names(source):
    return [row['name'] for row in source['manifest']['compatibility']['schemas']] if version_parts(source['manifest']['targetVersion'])>=(0,1,27) else ['dsh_phalanx']


def operation_id(value):
    if not isinstance(value,str) or str(uuid.UUID(value))!=value:raise InstallError('Invalid upgrade operation identity',code='operation.invalid')
    return value




class UpgradeHost:
    def __init__(self,host,bundle=None,*,dev_release_base_url=None):
        self.host=host; self.bundle=bundle; self.dev_release_base_url=dev_release_base_url
        self.development_rebuild=bool(getattr(host,'development_arm64',False) and bundle is not None)
        self.root=host.mkdir(UPGRADE_ROOT,0o700)
        self.admission=LinuxAdmissionGate()

    def time_point(self):return self.host.time_point()

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
        if self.host.progress:
            cleanup=job.get('cleanup',{});phase='update.cleanup' if cleanup.get('status') in ('running','failed') else job.get('phaseCode','unknown')
            error=cleanup.get('errorCode') if phase=='update.cleanup' else job.get('recoveryErrorCode') if job['phase']=='recovery-failed' else job.get('errorCode')
            self.host.tell('Upgrade '+job['id']+': '+job['phase'],phaseCode=phase,**({'errorCode':error} if error else {}))
        else:self.host.tell('Upgrade '+job['id']+': '+job['phase'])

    def check_fresh_install(self,target):
        # A sound formal receipt can authorize refusal, never an upgrade.
        manifest=target['manifest'];validate_contract(manifest)
        value=manifest.get('compatibility',{})
        if value.get('freshInstallThrough') is None and value.get('upgradeFloor') is None:return
        state=installed_state(self.host)
        if not isinstance(state,dict):return
        version=state.get('version');candidate=state.get('candidate')
        if (not isinstance(version,str) or not STABLE.fullmatch(version) or
                not isinstance(candidate,str) or not CANDIDATE.fullmatch(candidate) or
                state.get('serviceUser')!='dsh-phalanx' or
                not all(isinstance(state.get(key),str) and re.fullmatch(pattern,state[key])
                        for key,pattern in [('commit','[a-f0-9]{40}'),('platformSha256','[a-f0-9]{64}'),('imageDigest','sha256:[a-f0-9]{64}')])):
            return
        require_upgrade_source({'targetVersion':version[1:]},manifest)

    def import_legacy_manifest(self):
        path=self.host.path(MANIFEST)
        if path.exists() or path.is_symlink():return
        state=installed_state(self.host)
        if state is None or state['version']!='v0.1.1':
            raise InstallError('Installed release manifest is missing; only formal 0.1.1 has a supported legacy import')
        self.host.tell('Verifying the original formal 0.1.1 release metadata before upgrade.')
        with tempfile.TemporaryDirectory(prefix='legacy-source-') as temporary:
            args=SimpleNamespace(version=state['version'],bundle_dir=None)
            _,manifest,_=select_release(self.host,args,Path(temporary))
        if manifest.get('schema')!=1 or manifest.get('targetVersion')!='0.1.1':
            raise InstallError('Legacy source release contract is inconsistent')
        source=self.source(manifest)
        self.verify_source(source)
        self.host.atomic(MANIFEST,json.dumps(manifest)+'\n')
        sync_directory(self.host.path('/etc/dsh-phalanx'))

    def source(self,manifest=None):
        state=installed_state(self.host)
        if state is None:raise InstallError('A successful managed installation is required',code='release.identity-mismatch')
        if manifest is None:manifest=json.loads(self.host.path(MANIFEST).read_text())
        if state['candidate']!=manifest['tag'] or state['version'] not in (manifest['tag'],'v'+manifest['targetVersion']) or state['commit']!=manifest['commit'] or state['imageDigest']!=manifest['image']['digest'] or state['platformSha256']!=manifest['files'][asset_names(manifest)[0]]:
            raise InstallError('Installed release manifest and receipt disagree',code='release.identity-mismatch')
        values=read_configuration(self.host)
        account=self.host.run(['getent','passwd','dsh-phalanx']).stdout.strip().split(':')
        if len(account)!=7 or account[5]!='/var/lib/dsh-phalanx' or account[6]!='/usr/sbin/nologin' or int(account[2])==0:
            raise InstallError('Managed service identity is incompatible',code='release.identity-mismatch')
        current=self.host.path(CURRENT)
        if not current.is_symlink():raise InstallError('Current release must be a managed symbolic link',code='release.identity-mismatch')
        target=current.resolve()
        if target.parent!=self.host.path('/opt/dsh-phalanx/releases') or (target/'.artifact-sha256').read_text()!=state['platformSha256']:
            raise InstallError('Running release path or artifact identity is inconsistent',code='release.identity-mismatch')
        return {'receipt':state,'manifest':manifest,'channel':installed_channel(state),'values':values,'target':str(target),'uid':int(account[2]),'gid':int(account[3])}

    def begin(self,target):
        source=self.source();previous=previous_downtime(self.operation(),self.time_point())
        return {'id':str(uuid.uuid4()),'phase':'preparing','target':copy.deepcopy(target),'source':source,'diagnostic':self.host.progress.log.name if self.host.progress and self.host.progress.log else None,
                **({'previousDowntimeSeconds':previous} if previous is not None else {})}

    def schema(self,source):
        try:
            version=version_parts(source['manifest']['targetVersion'])
            # Historical targets can still use the old pre-PostgreSQL source contract.
            if version<(0,1,26):
                values=source['values'];config=values.get('DSH_PHALANX_DATABASE_CONFIG_FILE','/var/lib/dsh-phalanx/keys/database.json')
                result=self.host.user(source['uid'],['timeout','--signal=TERM','--kill-after=5s','20s',str(Path(source['target'])/'start'),'database-wait',
                    '--config-file',str(self.host.path(config)),'--data-root',str(self.host.path(values['DSH_PHALANX_DATA_ROOT']))],check=False)
                info=json.loads(result.stdout) if result.returncode==0 else None
                if not isinstance(info,dict) or info.get('state')!='connected' or type(info.get('schemaVersion')) is not int or not 0<=info['schemaVersion']<=2**53-1:raise ValueError('Invalid database status')
                return info['schemaVersion']
            registered=version>=(0,1,27)
            names=source_schema_names(source)
            info=executor_facts(self.host,source['values'],'schemas',source=source['target'],schemas=names)
            return self.schema_result(source,info)
        except (OSError,ValueError,KeyError,TypeError,InstallError):
            raise InstallError('Platform database status is unavailable. Check the selected database connection and master-key file before retrying the update.',code='database.unavailable') from None

    def schema_result(self,source,info):
        registered=version_parts(source['manifest']['targetVersion'])>=(0,1,27)
        names=source_schema_names(source)
        rows=info.get('schemas') if isinstance(info,dict) else None
        if not isinstance(rows,list) or not rows or [row.get('name') for row in rows if isinstance(row,dict)]!=names:raise ValueError('Invalid registered schema status')
        versions={}
        for row in rows:
            if (not isinstance(row,dict) or not isinstance(row.get('name'),str) or not re.fullmatch('[a-z_][a-z0-9_]{0,62}',row['name']) or
                    row['name'] in versions or type(row.get('version')) is not int or not 0<=row['version']<=2**53-1):raise ValueError('Invalid registered schema status')
            versions[row['name']]=row['version']
        # The predecessor predates the registry and has exactly the platform core.
        return versions if registered else versions['dsh_phalanx']

    def check_facts(self,source):
        names=source_schema_names(source)
        return executor_facts(self.host,source['values'],'check',source=source['target'],schemas=names)

    def sampled_schema(self,source,sampled,facts):
        try:current=self.source()
        except (InstallError,OSError,ValueError,KeyError,TypeError):
            raise InstallError('The installed source changed; check releases again') from None
        if current!=source:raise InstallError('The installed source changed; check releases again')
        try:
            identity=facts.get('identity') if isinstance(facts,dict) else None
            config=self.host.path(source['values'].get('DSH_PHALANX_DATABASE_CONFIG_FILE','/var/lib/dsh-phalanx/keys/database.json'))
            valid=(source==sampled and isinstance(identity,list) and len(identity)==2 and isinstance(identity[0],dict) and identity[0].get('path')==str(config) and
                   all(isinstance(row,dict) and self.host.file_identity(row['path'])==row for row in identity))
        except (OSError,ValueError,KeyError,TypeError,InstallError):valid=False
        if not valid:return self.schema(source)
        try:return self.schema_result(source,{'schemas':facts.get('schemas')})
        except (ValueError,KeyError,TypeError):
            raise InstallError('Platform database status is unavailable. Check the selected database connection and master-key file before retrying the update.',code='database.unavailable') from None

    def check_compatibility(self,source,target):
        require_upgrade_source(source['manifest'],target['manifest'])
        rehearsal=bool(getattr(self.host,'image_reuse_rehearsal',False))
        if rehearsal and (source['receipt']['version']!=source['manifest']['tag'] or target['version']!=target['manifest']['tag']):
            raise InstallError('Image reuse rehearsal requires explicit candidate versions, never formal releases')
        compatible(source['manifest'],target['manifest'],self.schema(source),development_rebuild=self.development_rebuild,image_reuse_rehearsal=rehearsal,source_channel=source.get('channel'),target_channel=target.get('channel',release_channel(target['version'])))

    def compatibility_outcome(self,source,target,schemas=None):
        route=upgrade_outcome(source['manifest'],target['manifest'],None,inspect_schema=False,source_channel=source.get('channel'),target_channel=target.get('channel',release_channel(target['version'])))
        if route['outcomeCode'] not in ('update.available','update.channel-switch'):return route
        return upgrade_outcome(source['manifest'],target['manifest'],self.schema(source) if schemas is None else schemas,source_channel=source.get('channel'),target_channel=target.get('channel',release_channel(target['version'])))

    def preflight(self,job):
        source=self.source()
        if source!=job['source']:raise InstallError('Installed source changed after this target was selected; download again')
        self.check_compatibility(source,job['target'])
        validate_storage(self.host,source['values'])
        if self.host.path(MAINTENANCE).exists():raise InstallError('Maintenance is already closed; recover the previous operation first')
        values=source['values']; data=self.host.path(values['DSH_PHALANX_DATA_ROOT'])
        users=self.host.path(effective_user_data_root(values) if version_parts(source['manifest']['targetVersion']) >= version_parts('0.1.26') else values.get('DSH_PHALANX_USER_DATA_ROOT',values['DSH_PHALANX_DATA_ROOT']+'/users'))
        if data.is_symlink() or not data.is_dir():raise InstallError('Invalid platform data root')
        if users.is_relative_to(data) and users!=data/'users':raise InstallError('Upgrade supports only reserved users or a separate user data root')
        self.verify_source(source)
        self.data_layout(job)
        UpgradeDatabaseBackup(self,job).inspect()
        if supports_capacity(job['target']['manifest']):
            if job['phase']=='preparing' and not job.get('cleanupBeforeDownload'):
                self.cleanup(job);job['cleanupBeforeDownload']=True;self.save(job)
            UpgradeStorage(self.host).check(job,self.path(job),self.bundle,carriers=self.carriers(job).values())
            self.save(job)
        UpgradeDatabaseBackup(self,job).prepare()
        if 'prepared' in job:
            self.admission.preflight(self.ports(source))
            prepared=job['prepared']; target=Path(prepared['target'])
            if (target/'.artifact-sha256').read_text()!=job['target']['manifest']['files'][asset_names(job['target']['manifest'])[0]]:
                raise InstallError('Prepared platform identity changed')
            supply_image(self.host,source['uid'],self.path(job),job['target']['manifest'],False)

    def cleanup(self,job):
        source=self.source();self.verify_source(source)
        return UpgradeCleanup(self.host,self.root).run(source,job,lambda:self.save(job))

    def ports(self,source):return protected_ports(source['values'])

    def prepare(self,job):
        missing=[package for command,package in [('nft','nftables'),('git','git')] if shutil.which(command) is None]
        if missing:
            self.host.run(['apt-get','-o','DPkg::Lock::Timeout=600','update'])
            self.host.run(['apt-get','-o','DPkg::Lock::Timeout=600','install','-y','--no-install-recommends',*missing])
        self.admission.preflight(self.ports(job['source']))
        self.admission.install(self.host,job['source']['uid'])
        def fixed(directory,manifest,version):
            if version!=job['target']['version'] or manifest!=job['target']['manifest'] or digest(directory/'manifest.json')!=job['target']['manifestSha256']:
                raise InstallError('Selected release metadata changed; target was not downloaded')
            self.check_compatibility(job['source'],job['target'])
        with tempfile.TemporaryDirectory(prefix='download-',dir=self.path(job)) as temporary:
            channel=installed_channel(job['target'])
            source=self.dev_release_base_url or (channel['baseUrl'] if channel['kind']=='candidate' and self.bundle is None else None)
            args=SimpleNamespace(version=job['target']['version'],bundle_dir=self.bundle,dev_release_base_url=source)
            directory,manifest=acquire(self.host,args,Path(temporary),fixed)
            target=stage_platform(self.host,directory,manifest)
            command=supply_image(self.host,job['source']['uid'],directory,manifest,self.bundle is not None)
        engine=install_executor(self.host,job['source']['uid'],job['source']['gid'],self.host.path(target),manifest['commit'],initial_only=True,activate=True)
        return {'target':str(self.host.path(target)),'command':command,'manifestSha256':job['target']['manifestSha256'],'executor':executor_package(self.host.path(target)/'updater',manifest['commit']),'currentExecutor':engine}

    @install_failure('admission.failed')
    def close_admission(self,source):self.admission.close(self.ports(source))

    @install_failure('admission.failed')
    def gate(self,closed):
        if closed:
            job=self.operation(); ports=self.ports(job['source'])
            self.host.atomic(MAINTENANCE,json.dumps({'schema':1,'ports':ports})+'\n',0o644)
            try:self.close_admission(job['source'])
            except Exception:
                # A legacy binary has no application marker support. Stop its
                # exact managed service if the independent fence is unavailable.
                self.stop(job)
                raise
        else:
            job=self.operation()
            if job is not None and any(key in job for key in ('maintenancePage','maintenanceListener')):
                self.close_admission(job['source']);self.stop_maintenance(job)
            self.admission.open()
            self.host.path(MAINTENANCE).unlink(missing_ok=True)
        sync_directory(self.host.path('/etc/dsh-phalanx'))

    def stop_maintenance(self,job):
        changed=False
        for kind,key in ((ListenerPinUnit,'maintenanceListener'),(MaintenanceUnit,'maintenancePage')):
            kind(self.host,job).stop()
            if key in job:job.pop(key);changed=True
        if changed:self.save(job)

    @install_failure('service.stop-failed')
    def stop(self,job):
        page=MaintenanceUnit(self.host,job) if 'action' not in job else None
        try:
            self.close_admission(job['source'])
            if page is not None:self.stop_maintenance(job)
        except Exception:
            # A failed fence must still stop a legacy platform without marker support.
            self.host.user(job['source']['uid'],['systemctl','--user','stop','dsh-phalanx.service'])
            raise
        if 'database' in job:
            # A killed executor can leave a tool container outside its systemd cgroup.
            # Stop only this protected transaction's tools before starting/retrying recovery.
            owner=hashlib.sha256(str(self.path(job)/'backup'/'database').encode()).hexdigest()
            command=['podman','ps','--all','--filter','label=dsh.phalanx.upgrade-archive-owner='+owner,'--format','json']
            for row in json.loads(self.host.run(command).stdout):
                identity=row.get('Id',row.get('ID'))
                if (row.get('Labels',{}).get('dsh.phalanx.upgrade-archive-owner')!=owner or
                        not isinstance(identity,str) or not re.fullmatch('[a-f0-9]{12,64}',identity)):
                    raise InstallError('Database archive tool ownership is inconsistent')
                self.host.run(['podman','rm','--force','--ignore','--time','0',identity])
            if json.loads(self.host.run(command).stdout):raise InstallError('Transaction database archive tools remain; recovery refused')
            directory=self.path(job)/'backup'/'database'
            if directory.exists():
                if directory.is_symlink() or not directory.is_dir() or directory.stat().st_uid!=os.geteuid() or directory.stat().st_mode&0o777!=0o700:
                    raise InstallError('Invalid protected database archive directory')
                for path in directory.iterdir():
                    if not re.fullmatch(r'\.database-tool-[a-f0-9-]{36}',path.name):continue
                    if path.is_symlink() or not path.is_dir() or path.stat().st_uid!=os.geteuid() or path.stat().st_mode&0o777!=0o700:
                        raise InstallError('Invalid private PostgreSQL tool directory')
                    for child in path.iterdir():
                        if child.name not in ('pgpass','ca.pem','before.sql','after.sql','restore.sh','restore.sql','restore.list') or child.is_symlink() or not child.is_file() or child.stat().st_uid!=os.geteuid():
                            raise InstallError('Unexpected file in private PostgreSQL tool directory')
                    shutil.rmtree(path)
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
        if page is not None:
            intent=page.intent()
            if job.get('maintenancePage') is not None and job['maintenancePage']!=intent:
                raise InstallError('Installed maintenance page identity changed during the operation')
            if intent is not None:
                job['maintenancePage']=intent;self.save(job)
                group=page.start();self.admission.show_page(self.ports(source),group,intent['token'])

    def carriers(self,job):
        result={'configuration':self.host.path(CONFIG),'receipt':self.host.path(STATE),'manifest':self.host.path(MANIFEST),'unit':self.host.path(UNIT),
                'keys':self.host.path('/var/lib/dsh-phalanx/keys'),'databaseUnit':self.host.path('/var/lib/dsh-phalanx/.config/systemd/user/dsh-phalanx-postgres.service')}
        if 'executor' in job.get('prepared',{}):
            result.update(executorPointer=self.host.path(EXECUTOR),executorUnit=self.host.path(EXECUTOR_UNIT),
                          admissionProgram=self.host.path('/opt/dsh-phalanx/maintenance/gate.py'),
                          admissionUnit=self.host.path('/etc/systemd/system/dsh-phalanx-maintenance.service'),
                          admissionOrder=self.host.path('/etc/systemd/system/user@'+str(job['source']['uid'])+'.service.d/dsh-phalanx-maintenance.conf'))
        master=job.get('database',{}).get('facts',{}).get('masterKeyPath')
        config=job['source']['values'].get('DSH_PHALANX_DATABASE_CONFIG_FILE')
        for key,path in [('databaseMaster',master),('databaseConfiguration',str(self.host.path(config)) if config else None)]:
            if path and not Path(path).resolve().is_relative_to(result['keys'].resolve()):result[key]=Path(path).resolve()
        return result

    def data_layout(self,job):
        if 'dataLayout' not in job:
            source=job['source'];paths=[]
            if version_parts(source['manifest']['targetVersion'])>=(0,1,26):
                target=Path(source['target'])
                program="import {pathToFileURL} from 'node:url'; const {dataRootLayout}=await import(pathToFileURL(process.argv[1]+'/dist/domain/data-root-layout.js')); console.log(JSON.stringify(dataRootLayout))"
                output=self.host.run([str(target/'node/bin/node'),'--input-type=module','-e',program,str(target)])
                try:
                    layout=json.loads(output.stdout)
                    for kind in ('artifacts','projections','runtime'):
                        if not isinstance(layout.get(kind),list):raise ValueError('Missing data layout category')
                        paths.extend(layout[kind])
                except (ValueError,AttributeError):raise InstallError('The installed platform data layout is unavailable') from None
            job['dataLayout']=list(rebuildable_paths(paths))
        return rebuildable_paths(job['dataLayout'])

    def backup_owner(self,job):
        return PlatformBackup(self.host.path(job['source']['values']['DSH_PHALANX_DATA_ROOT']),self.path(job)/'backup',self.carriers(job),rebuildable=self.data_layout(job))

    @contextmanager
    def quiescent(self,job):
        data=self.host.path(job['source']['values']['DSH_PHALANX_DATA_ROOT']); lock=data/'platform.lock'
        if lock.is_symlink():raise InstallError('Platform writer lock cannot be a symbolic link')
        # The platform holds an exclusive flock on this file while it runs (adapters/platform-lock.ts).
        # Never create it: a root-owned file would stop the service account from opening its own lock.
        try:descriptor=os.open(lock,os.O_RDONLY|os.O_NOFOLLOW)
        except FileNotFoundError:
            yield; return  # No platform has started here, so none can hold the lock.
        with open(descriptor,'rb') as file:
            try:fcntl.flock(file,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:raise InstallError('The platform still holds its writer lock; stop it before backing up') from None
            yield

    def backup(self,job):
        with self.quiescent(job):
            receipt=self.backup_owner(job).create()
            self.start_database(job)
            database=UpgradeDatabaseBackup(self,job).create()
            if database is not None:receipt['database']=database
        if 'executor' in job.get('prepared',{}):receipt['executor']=installed_executor(self.host)
        return receipt

    @install_failure('database.unavailable')
    def start_database(self,job):
        if job.get('database',{}).get('facts',{}).get('selection')=='builtin':
            uid=job['source']['uid']
            self.host.user(uid,['systemctl','--user','daemon-reload'])
            self.host.user(uid,['systemctl','--user','reset-failed','dsh-phalanx-postgres.service'])
            self.host.user(uid,['systemctl','--user','start','dsh-phalanx-postgres.service'])

    def link(self,target):
        replacement=self.host.path(CURRENT+'.next'); replacement.unlink(missing_ok=True); replacement.symlink_to(target)
        os.replace(replacement,self.host.path(CURRENT)); sync_directory(self.host.path('/opt/dsh-phalanx'))

    @install_failure('service.start-failed')
    def start(self,job):
        self.close_admission(job['source'])
        if 'action' not in job:self.stop_maintenance(job)
        uid=job['source']['uid']; self.host.user(uid,['systemctl','--user','daemon-reload'])
        self.host.user(uid,['systemctl','--user','enable','--now','dsh-phalanx.service'])

    def switch(self,job):
        values=copy.deepcopy(job['source']['values']); manifest=job['target']['manifest']; command=job['prepared']['command']
        values.update(DSH_PHALANX_CONTAINER_IMAGE=manifest['image']['reference'],DSH_PHALANX_RUNTIME_COMMAND=command[0],
                      DSH_PHALANX_RUNTIME_ARGS_JSON=json.dumps(command[1:],separators=(',',':')),
                      DSH_PHALANX_MAINTENANCE_FILE=MAINTENANCE)
        self.host.atomic(CONFIG,environment_text(values),0o640)
        self.host.run(['chown','0:'+str(job['source']['gid']),str(self.host.path(CONFIG))])
        with self.host.path(CONFIG).open('rb') as file:os.fsync(file.fileno())
        self.link(job['prepared']['target']); self.start(job)

    def listener_identity(self,source,pid):
        target=Path(source['target'])
        if not pid or self.host.path('/proc/'+str(pid)+'/cwd').resolve()!=target or self.host.path('/proc/'+str(pid)+'/exe').resolve()!=target/'node/bin/node':
            raise InstallError('Managed listener process does not execute the selected packaged release',code='release.identity-mismatch')
        if (target/'.artifact-sha256').read_text()!=source['manifest']['files'][asset_names(source['manifest'])[0]] or json.loads((target/'build-info.json').read_text())['commit']!=source['manifest']['commit']:
            raise InstallError('Selected platform source identity does not match the healthy process',code='release.identity-mismatch')

    def show_platform_page(self,source,pid,job):
        self.listener_identity(source,pid)
        values=read_configuration(self.host)
        if values.get('DSH_PHALANX_MAINTENANCE_FILE')!=MAINTENANCE or any(values.get(key)!=source['values'].get(key) for key in ('DSH_PHALANX_HOST','DSH_PHALANX_PORT','DSH_PHALANX_PUBLIC_ORIGIN')):
            raise InstallError('Managed maintenance configuration differs from the verified source')
        marker=protected_json(self.host.path(MAINTENANCE));ports=self.ports(source)
        if marker.get('schema')!=1 or marker.get('ports')!=ports:raise InstallError('Managed maintenance admission differs from the verified source')
        uid=source['uid'];group=self.host.user(uid,['systemctl','--user','show','dsh-phalanx.service','--property=ControlGroup','--value']).stdout.strip()
        prefix='/user.slice/user-'+str(uid)+'.slice/user@'+str(uid)+'.service/'
        if not group.startswith(prefix) or not group.endswith('/dsh-phalanx.service') or '0::'+group not in self.host.path('/proc/'+str(pid)+'/cgroup').read_text().splitlines():
            raise InstallError('Managed listener cgroup differs from its service owner')
        descriptor=self.host.listener_file(pid,int(values['DSH_PHALANX_PORT']),ipaddress.ip_address(values['DSH_PHALANX_HOST']))
        if descriptor is None:raise InstallError('The verified platform listener disappeared before pinning')
        listener={**descriptor,'pid':pid,'started':process_started(self.host.path('/proc/'+str(pid)+'/stat')),'cgroup':group,
                  'address':values['DSH_PHALANX_HOST'],'port':int(values['DSH_PHALANX_PORT']),'uid':uid,
                  'executable':str(Path(source['target'])/'node/bin/node'),'directory':source['target']}
        existing=job.get('maintenanceListener')
        if existing is not None and existing.get('listener')!=listener:raise InstallError('The pinned platform listener changed during validation')
        pin=ListenerPinUnit(self.host,job)
        if existing is None:
            job['maintenanceListener']={'unit':pin.unit,'listener':listener,'token':maintenance_token(job,'maintenanceListener')};self.save(job)
        pin.start();self.admission.show_page(ports,group,job['maintenanceListener']['token'])

    def verify_source(self,source,ready_path='/login',*,readiness=True,maintenance_job=None):
        verify_image(self.host,source['uid'],source['manifest'])
        values=source['values'];uid=source['uid'];port=int(values['DSH_PHALANX_PORT'])
        closed=self.host.path(MAINTENANCE).exists();options={'socket_mark':MARK} if closed else {}
        if readiness and closed and maintenance_job is not None and maintenance_pages(source['target']) is not None:
            options['on_listener']=lambda pid:self.show_platform_page(source,pid,maintenance_job)
        if readiness:self.host.ready(uid,port,values['DSH_PHALANX_HOST'],values['DSH_PHALANX_PUBLIC_ORIGIN'],path=ready_path,timeout=plugin_startup_timeout(self.host,values,source['manifest']),**options)
        address=ipaddress.ip_address(urllib.parse.urlparse(entry_url(port,values['DSH_PHALANX_HOST'])).hostname)
        self.listener_identity(source,self.host.listener_pid(uid,port,address))

    def verify(self,job,old=False):
        if old:source=job['source']
        else:source={**job['source'],'target':job['prepared']['target'],'manifest':job['target']['manifest']}
        path='/readyz' if source['manifest'].get('schema')==2 else '/login'
        self.verify_source(source,path,maintenance_job=job)
        expected=(job.get('backup',{}).get('executor') or job.get('prepared',{}).get('currentExecutor')) if old else job.get('prepared',{}).get('executor') if job.get('committed') else None
        if expected:
            ensure_executor_identity(self.host,source['uid'],source['gid'],expected,[(job['source']['target'],job['source']['manifest']['commit']),(job['prepared']['target'],job['target']['manifest']['commit'])])
        if not old:
            recorded=self.schema(source);contract=source['manifest']['compatibility']
            if 'schemas' in contract:
                actual=recorded if isinstance(recorded,dict) else {'dsh_phalanx':recorded}
                expected={row['name']:row['target'] for row in contract['schemas']}
                matches=actual==expected
            else:
                matches=(recorded.get('dsh_phalanx') if isinstance(recorded,dict) else recorded)==contract['accounts']['target']
            if not matches:raise InstallError('Target database schemas do not match their declared identity')

    def restore(self,job):
        with self.quiescent(job):
            database=UpgradeDatabaseBackup(self,job)
            database.verify(job['backup'].get('database'))
            self.backup_owner(job).restore(job['backup'])
            self.host.run(['systemctl','daemon-reload'])
            self.link(job['source']['target'])
            self.start_database(job)
            database.restore(job['backup'].get('database'))
        self.start(job)

    @install_failure('service.start-failed')
    def restart_old(self,job):
        if self.host.path(CURRENT).resolve()!=Path(job['source']['target']):raise InstallError('No verified backup exists for the changed current release')
        self.start(job)

    def commit(self,job):
        if 'executor' in job.get('prepared',{}):install_executor(self.host,job['source']['uid'],job['source']['gid'],job['prepared']['target'],job['target']['manifest']['commit'])
        manifest=job['target']['manifest']; receipt={**job['source']['receipt'],'version':job['target']['version'],'channel':job['target'].get('channel',release_channel(job['target']['version'])),'candidate':manifest['tag'],
            'commit':manifest['commit'],'platformSha256':manifest['files'][asset_names(manifest)[0]],'imageDigest':manifest['image']['digest'],'changed':True}
        self.host.atomic(STATE,json.dumps(receipt)+'\n'); self.host.atomic(MANIFEST,json.dumps(manifest)+'\n')
        sync_directory(self.host.path('/etc/dsh-phalanx'))
