"""Shared release transaction owner. All external effects go through its port."""
from installer_host import InstallError  # embedded-host
from installer_progress import update_phase_code,update_error_code,update_time_point,update_seconds  # embedded-progress
from installer_compatibility import supports_capacity  # embedded-compatibility

TERMINAL = ('succeeded','restored','prepare-failed','apply-failed','recovery-failed')
ACTIVE = ('preparing','stopping','backing-up','backed-up','switching','validating','restoring','committed','restoration-committed','recovery-failed')


class UpgradeCore:
    def __init__(self,port):self.port=port

    def save(self,job,phase):
        point=self.port.time_point() if hasattr(self.port,'time_point') else update_time_point()
        timing=job.setdefault('timing',{'phaseSeconds':{}})
        if timing.get('phase')!=phase:
            previous=timing.get('phase')
            if previous and isinstance(timing.get('started'),dict):
                timing['phaseSeconds'][previous]=round(timing['phaseSeconds'].get(previous,0)+update_seconds(timing['started'],timing.get('phaseEnded',point)),3)
            timing.update(phase=phase,started=point);timing.pop('phaseEnded',None)
        if phase in TERMINAL:timing.setdefault('phaseEnded',point)
        if phase=='stopping':timing.setdefault('downtimeStarted',point)
        if phase in ('committed','restoration-committed') and 'downtimeStarted' in timing:timing.setdefault('downtimeEnded',point)
        job['phase']=phase;job['phaseCode']=update_phase_code(phase)
        self.port.save(job)
        return job

    def failure(self,job,error):
        job.update(failure=self.port.safe(str(error)),failurePhase=job['phase'],errorCode=update_error_code(error))

    def status(self,operation=None):
        return self.port.operation(operation)

    def begin_prepare(self,target):
        existing=self.port.operation()
        if existing and existing['phase'] in ACTIVE:
            raise InstallError('Another upgrade needs completion or recovery before preparing a target',code='operation.conflict')
        if existing and existing['phase']=='prepared' and existing['target']==target:return existing
        job=self.port.begin(target)
        return self.save(job,'preparing')

    def prepare(self,target):
        job=self.begin_prepare(target)
        return self.finish_prepare(job['id']) if job['phase']=='preparing' else job

    def finish_prepare(self,operation):
        job=self.port.operation(operation)
        if job is None or job['phase']!='preparing':raise InstallError('Unknown active preparation',code='operation.invalid')
        try:
            self.port.preflight(job)
            job['prepared']=self.port.prepare(job)
            self.port.preflight(job)
            return self.save(job,'prepared')
        except Exception as error:
            self.failure(job,error)
            return self.save(job,'prepare-failed')

    def apply(self,operation):
        job=self.submit_apply(operation)
        return self.finish_apply(job['id']) if job['phase']=='stopping' else job

    def submit_apply(self,operation):
        job=self.port.operation(operation)
        if job is None:raise InstallError('Unknown upgrade operation',code='operation.invalid')
        if job['phase'] in TERMINAL:return job
        if job['phase']!='prepared':raise InstallError('Interrupted upgrade requires recover before another apply',code='operation.invalid')
        try:
            self.port.preflight(job)
        except Exception as error:
            self.failure(job,error)
            return self.save(job,'apply-failed')
        try:
            self.save(job,'stopping')
            self.port.gate(True)
            return job
        except Exception as error:
            self.failure(job,error);self.port.save(job)
            return self.recover(job['id'])

    def finish_apply(self,operation):
        job=self.port.operation(operation)
        if job is None or job['phase']!='stopping':raise InstallError('Unknown active application',code='operation.invalid')
        try:
            self.port.stop(job)
            job['backupLifecycle']=2
            self.save(job,'backing-up')
            job['backup']=self.port.backup(job)
            self.save(job,'backed-up')
            self.save(job,'switching')
            self.port.switch(job)
            self.save(job,'validating')
            self.port.verify(job)
            self.port.commit(job)
            job['committed']=True
            self.save(job,'committed')
            self.port.gate(False)
            self.save(job,'succeeded')
        except Exception as error:
            self.failure(job,error)
            # Persist the original failure before trying recovery. State and
            # verified backup identity, never error text, decide restoration.
            self.port.save(job)
            return self.recover(job['id'])
        return self.after_success(job)

    def after_success(self,job):
        if supports_capacity(job['target'].get('manifest',{})):
            return self.cleanup(job['id'],discard_backup=job.get('backupLifecycle')==2 or job.get('backup',{}).get('schema')==2)
        return job

    def cleanup(self,operation=None,*,discard_backup=False):
        return self.finish_cleanup(self.begin_cleanup(operation,discard_backup=discard_backup)['id'])

    def begin_cleanup(self,operation=None,*,discard_backup=False):
        job=self.port.operation(operation)
        if job is None or job['id']!=self.port.operation()['id']:raise InstallError('Cleanup requires the current operation',code='operation.invalid')
        if job['phase'] not in ('succeeded','restored','prepared','prepare-failed','apply-failed'):raise InstallError('Finish or recover the update before cleanup',code='operation.invalid')
        if discard_backup and job['phase'] not in ('succeeded','restored'):raise InstallError('An unfinished update still needs its backup',code='operation.invalid')
        previous=job.get('cleanup',{})
        job['cleanup']={**previous,'status':'running','discardBackup':discard_backup or previous.get('discardBackup',False),'reclaimedBytes':previous.get('reclaimedBytes',0),'items':previous.get('items',[])}
        self.port.save(job)
        return job

    def finish_cleanup(self,operation):
        job=self.port.operation(operation)
        if job is None or job.get('cleanup',{}).get('status')!='running':raise InstallError('Unknown active cleanup',code='operation.invalid')
        try:self.port.cleanup(job)
        except Exception as error:
            previous=job.get('cleanup',{})
            job['cleanup']={**previous,'status':'failed','reclaimedBytes':previous.get('reclaimedBytes',0),'items':previous.get('items',[]),'failure':self.port.safe(str(error)),'errorCode':update_error_code(error,'cleanup.failed')}
        self.port.save(job)
        return job

    def recover(self,operation=None):
        before=self.port.operation(operation)
        job=self._recover(operation)
        if job['phase'] not in ACTIVE and before.get('cleanup',{}).get('status')=='running':return self.cleanup(job['id'])
        if job['phase'] in ('succeeded','restored') and (before['phase'] in ACTIVE or ((job.get('backupLifecycle')==2 or job.get('backup',{}).get('schema')==2) and not job.get('cleanup',{}).get('discardBackup'))):return self.after_success(job)
        return job

    def _recover(self,operation=None):
        job=self.port.operation(operation)
        if job is None:raise InstallError('Unknown upgrade operation',code='operation.invalid')
        if job['phase'] in ('succeeded','restored','prepare-failed','apply-failed','prepared'):return job
        if job['phase']=='preparing':
            job.update(failure='Preparation interrupted; no running release was changed. Download again.',failurePhase=job['phase'],errorCode='operation.interrupted')
            return self.save(job,'prepare-failed')
        job.setdefault('failure','Upgrade interrupted before its result was recorded')
        job.setdefault('failurePhase',job['phase']);job.setdefault('errorCode','operation.interrupted')
        try:
            self.port.gate(True)
            if job.get('restorationCommitted'):
                # Old-version writes may already have resumed. Start, never recopy.
                self.port.start(job)
                self.port.verify(job,old=True)
                self.port.gate(False)
                job.pop('instruction',None)
                return self.save(job,'restored')
            if job.get('committed'):
                # Writes may already have reopened. Never roll them back.
                self.port.start(job)
                self.port.verify(job)
                self.port.gate(False)
                job.pop('instruction',None)
                return self.save(job,'succeeded')
            self.save(job,'restoring')
            self.port.stop(job)
            if job.get('backup') is not None:self.port.restore(job)
            else:self.port.restart_old(job)
            self.port.verify(job,old=True)
            job['restorationCommitted']=True
            self.save(job,'restoration-committed')
            self.port.gate(False)
            job.pop('instruction',None)
            return self.save(job,'restored')
        except Exception as error:
            job['recoveryFailure']=self.port.safe(str(error));job['recoveryErrorCode']=update_error_code(error,'recovery.failed')
            try:self.port.stop(job)
            except Exception as stop_error:job['stopFailure']=self.port.safe(str(stop_error));job['stopErrorCode']=update_error_code(stop_error,'service.stop-failed')
            job['instruction']=('Recovery and service shutdown failed; admission is unverified. Stop the managed service and inspect diagnostics.' if job.get('stopFailure') else 'Keep maintenance closed.')+' Run sudo bash install.sh --upgrade recover --output json; inspect the diagnostic log before resuming work.'
            return self.save(job,'recovery-failed')
