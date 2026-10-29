"""Fixed managed platform operations; root alone owns admission and acknowledgement."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import uuid
from installer_host import InstallError
from installer_upgrade_gate import protected_ports

JOURNAL='/var/lib/dsh-phalanx-updater/maintenance-operation.json'
MARKER='/etc/dsh-phalanx/maintenance'


def read_owned(path,uid,mode=0o600):
    descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        info=os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=uid or stat.S_IMODE(info.st_mode)!=mode or info.st_size>262144:
            raise InstallError('Invalid protected maintenance carrier')
        with os.fdopen(os.dup(descriptor),'r') as stream:return stream.read()
    finally:os.close(descriptor)


class PlatformOperations:
    def __init__(self,host,port):
        self.host=host;self.port=port;root=host.mkdir('/var/lib/dsh-phalanx-updater',0o700)
        if root.stat().st_uid!=os.geteuid():raise InstallError('Invalid platform operation directory owner')

    def load(self):
        path=self.host.path(JOURNAL)
        if not path.exists() and not path.is_symlink():return None
        job=json.loads(read_owned(path,os.geteuid()))
        if job.get('schema')!=1 or job.get('action') not in ('master-key-rotate','master-key-reset','database-switch') or str(uuid.UUID(job['id']))!=job['id'] or job.get('phase') not in ('prepared','working','data-complete','validating','opening','succeeded','restored'):
            raise InstallError('Unknown protected platform operation')
        return job

    def save(self,job):self.host.atomic(JOURNAL,json.dumps(job)+'\n')

    def status(self,operation=None):
        job=self.load()
        if operation and (not job or job['id']!=operation):raise InstallError('Unknown platform operation')
        return {key:job[key] for key in ('id','action','phase','fingerprint') if key in job} if job else None

    def begin(self,action,target=None):
        if action not in ('master-key-rotate','master-key-reset','database-switch'):raise InstallError('Unsupported managed platform operation')
        previous=self.load()
        if previous and previous['phase'] not in ('succeeded','restored'):raise InstallError('Recover the pending platform operation first')
        upgrade=self.port.operation()
        if upgrade and upgrade['phase'] not in ('succeeded','restored','prepare-failed','apply-failed'):
            raise InstallError('An update must finish before platform maintenance')
        if self.host.path(MARKER).exists() or self.host.path(MARKER).is_symlink():raise InstallError('Maintenance is already closed')
        source=self.port.source();values=source['values']
        config=values.get('DSH_PHALANX_DATABASE_CONFIG_FILE')
        if not config:raise InstallError('A selected PostgreSQL deployment is required')
        original=read_owned(self.host.path(config),source['uid']);saved=json.loads(original)
        deployment=saved.get('deploymentId')
        if not isinstance(deployment,str) or not deployment:raise InstallError('The selected deployment identity is missing')
        self.port.admission.preflight(protected_ports(values))
        identity=str(uuid.uuid4());marker=json.dumps({'schema':1,'ports':protected_ports(values),'operation':identity,'operationKind':action,'deploymentId':deployment})+'\n'
        job={'schema':1,'id':identity,'action':action,'phase':'prepared','source':source,'deploymentId':deployment,'configFile':config,'marker':marker}
        if action=='database-switch':
            if target not in ('builtin','external'):raise InstallError('Select builtin or external')
            job.update(target=target,originalConfigurationSha256=hashlib.sha256(original.encode()).hexdigest(),fingerprint=saved.get('registry',{}).get('masterFingerprint'))
            checked=self.worker(job,'database-switch-check')
            if checked.get('checked') is not True or checked.get('deploymentId')!=deployment or checked.get('fingerprint')!=job['fingerprint'] or checked.get('selection')!=target:
                raise InstallError('The target preflight does not match this deployment')
        self.save(job);return self.status(identity)

    def marker(self,job):
        path=self.host.path(MARKER)
        if path.exists() or path.is_symlink():
            if read_owned(path,os.geteuid(),0o644)!=job['marker']:raise InstallError('Maintenance marker ownership changed')
        elif job['phase'] in ('prepared','opening'):
            self.host.atomic(MARKER,job['marker'],0o644)
        else:raise InstallError('The managed maintenance marker disappeared')
        self.port.admission.close(json.loads(job['marker'])['ports'])

    def worker(self,job,command=None):
        source=job['source'];values=source['values'];command=command or job['action']
        arguments=[str(Path(source['target'])/'start'),command,'--config-file',str(self.host.path(job['configFile'])),
                   '--data-root',str(self.host.path(values['DSH_PHALANX_DATA_ROOT']))]
        if command!='database-switch-check':
            arguments+=['--maintenance-file',str(self.host.path(MARKER)),'--offline','--managed-operation',job['id']]
        if command in ('database-switch','database-switch-check'):
            arguments+=['--target',job['target']]
            if job['target']=='external':arguments+=['--connection-file',str(self.host.path(job['configFile']).parent/'database-target.json')]
        if command=='master-key-reset':arguments+=['--recovery-file',str(self.host.path(job['configFile']).parent/'secret-recovery.json'),'--confirmation','RESET ALL PLATFORM SECRETS']
        result=self.host.user(source['uid'],arguments)
        try:return json.loads(result.stdout)
        except ValueError:raise InstallError('The platform operation did not return a completion fact') from None

    def configuration(self,job):
        raw=read_owned(self.host.path(job['configFile']),job['source']['uid'])
        return json.loads(raw),hashlib.sha256(raw.encode()).hexdigest()

    def completed(self,job,completion):
        statuses=('switched','rolled-back') if job['action']=='database-switch' else ('reset','recovered') if job['action']=='master-key-reset' else ('rotated','recovered')
        if completion.get('operation')!=job['id'] or completion.get('deploymentId')!=job['deploymentId'] or completion.get('status') not in statuses or not re.fullmatch('sha256:[a-f0-9]{64}',completion.get('fingerprint','')):
            raise InstallError('The platform operation completion does not match its owner')
        selected,digest=self.configuration(job)
        if selected.get('deploymentId')!=job['deploymentId'] or selected.get('registry',{}).get('masterFingerprint')!=completion['fingerprint']:
            raise InstallError('The configuration does not match the completed operation')
        if job['action']=='database-switch':
            restored=completion['status']=='rolled-back'
            if completion['fingerprint']!=job['fingerprint'] or selected.get('selection')!=completion.get('selection') or (digest!=job['originalConfigurationSha256'] if restored else selected.get('selection')!=job['target']):
                raise InstallError('The database selection does not match the completed operation')
            job['restored']=restored;job['configurationSha256']=digest
        job.update(phase='data-complete',fingerprint=completion['fingerprint']);self.save(job)

    def stop_for_worker(self,job):
        self.port.stop(job)
        # PartOf stops built-in PG with the platform. Start PG alone under closed admission.
        self.host.user(job['source']['uid'],['systemctl','--user','reset-failed','dsh-phalanx-postgres.service'])
        self.host.user(job['source']['uid'],['systemctl','--user','start','dsh-phalanx-postgres.service'])

    def start(self,job):
        # These are deliberate restarts under the maintenance lock, not a crash loop.
        self.host.user(job['source']['uid'],['systemctl','--user','reset-failed','dsh-phalanx.service','dsh-phalanx-postgres.service'])
        self.port.start(job)

    def restore_database(self,job):
        self.stop_for_worker(job)
        self.completed(job,self.worker(job,'database-switch-rollback'))

    def verify_configuration(self,job):
        selected,digest=self.configuration(job)
        if digest!=job['configurationSha256'] or selected.get('deploymentId')!=job['deploymentId'] or selected.get('registry',{}).get('masterFingerprint')!=job['fingerprint']:
            raise InstallError('The committed database configuration changed; keep maintenance closed')

    def run(self,operation):
        job=self.load()
        if not job or job['id']!=operation:raise InstallError('Unknown platform operation')
        if job['phase'] in ('succeeded','restored'):return self.status(operation)
        if self.port.source()!=job['source']:raise InstallError('Installed deployment changed during platform maintenance')
        database=job['action']=='database-switch'
        self.marker(job)
        if database and job['phase'] in ('working','data-complete','validating'):
            self.restore_database(job)
        if job['phase']=='opening':
            if database:self.verify_configuration(job)
            else:self.start(job);self.port.verify_source(job['source'],'/readyz')
        if job['phase'] in ('prepared','working'):
            job['phase']='working';self.save(job)
            self.stop_for_worker(job)
            try:self.completed(job,self.worker(job))
            except Exception:
                if not database:raise
                self.restore_database(job)
        if job['phase'] in ('data-complete','validating'):
            if not database:self.acknowledge_data(job)
            else:self.verify_configuration(job)
            job['phase']='validating';self.save(job)
            try:
                self.start(job);self.port.verify_source(job['source'],'/readyz')
            except Exception:
                if not database or job.get('restored'):raise
                self.restore_database(job)
                self.start(job);self.port.verify_source(job['source'],'/readyz')
            # This durable decision commits a healthy selection. If save is uncertain,
            # recover from the on-disk phase; never roll back using in-memory state.
            job['phase']='opening';self.save(job)
        if database:
            self.verify_configuration(job)
            self.acknowledge_data(job)
            self.start(job);self.port.verify_source(job['source'],'/readyz')
        self.marker(job)
        self.host.path(MARKER).unlink();self.host.sync_directory(self.host.path('/etc/dsh-phalanx'))
        self.port.admission.open()
        job['phase']='restored' if job.get('restored') else 'succeeded';self.save(job)
        return self.status(operation)

    def acknowledge_data(self,job):
        database=job['action']=='database-switch'
        path=self.host.path(job['configFile']).parent/('platform-database-operation.json' if database else 'platform-key-operation.json')
        selected=json.loads(read_owned(self.host.path(job['configFile']),job['source']['uid']))
        if selected.get('deploymentId')!=job['deploymentId'] or selected.get('registry',{}).get('masterFingerprint')!=job['fingerprint']:
            raise InstallError('The selected configuration does not match the completion fact')
        if not path.exists():return  # Root may have acknowledged it before a restart.
        value=json.loads(read_owned(path,job['source']['uid']))
        if value.get('managedOperation')!=job['id'] or value.get('deploymentId')!=job['deploymentId'] or value.get('phase') not in (('committed','rolled-back') if database else ('prepared',)) or value.get('kind')!=('database-switch' if database else 'reset' if job['action']=='master-key-reset' else 'rotate') or value.get('marker')!=job['marker']:
            raise InstallError('The product journal does not match the completed root operation')
        if database:
            self.stop_for_worker(job)
            self.worker(job,'database-switch-finalize')
        else:path.unlink();self.host.sync_directory(path.parent)

    def recover(self):
        job=self.load()
        if job and job['phase'] not in ('succeeded','restored'):return self.run(job['id'])
        return self.status()
