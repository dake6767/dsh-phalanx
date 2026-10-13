"""Shared release transaction owner. All external effects go through its port."""
from installer_host import InstallError  # embedded-host

TERMINAL = ('succeeded','restored','prepare-failed','apply-failed','recovery-failed')
ACTIVE = ('preparing','stopping','backing-up','backed-up','switching','validating','restoring','committed','restoration-committed','recovery-failed')


class UpgradeCore:
    def __init__(self,port):self.port=port

    def save(self,job,phase):
        job['phase']=phase
        self.port.save(job)
        return job

    def status(self,operation=None):
        return self.port.operation(operation)

    def begin_prepare(self,target):
        existing=self.port.operation()
        if existing and existing['phase'] in ACTIVE:
            raise InstallError('Another upgrade needs completion or recovery before preparing a target')
        if existing and existing['phase']=='prepared' and existing['target']==target:return existing
        job=self.port.begin(target)
        return self.save(job,'preparing')

    def prepare(self,target):
        job=self.begin_prepare(target)
        return self.finish_prepare(job['id']) if job['phase']=='preparing' else job

    def finish_prepare(self,operation):
        job=self.port.operation(operation)
        if job is None or job['phase']!='preparing':raise InstallError('Unknown active preparation')
        try:
            self.port.preflight(job)
            job['prepared']=self.port.prepare(job)
            self.port.preflight(job)
            return self.save(job,'prepared')
        except Exception as error:
            job['failure']=self.port.safe(str(error))
            return self.save(job,'prepare-failed')

    def apply(self,operation):
        job=self.submit_apply(operation)
        return self.finish_apply(job['id']) if job['phase']=='stopping' else job

    def submit_apply(self,operation):
        job=self.port.operation(operation)
        if job is None:raise InstallError('Unknown upgrade operation')
        if job['phase'] in TERMINAL:return job
        if job['phase']!='prepared':raise InstallError('Interrupted upgrade requires recover before another apply')
        try:
            self.port.preflight(job)
        except Exception as error:
            job['failure']=self.port.safe(str(error))
            return self.save(job,'apply-failed')
        try:
            self.save(job,'stopping')
            self.port.gate(True)
            return job
        except Exception as error:
            job['failure']=self.port.safe(str(error));self.port.save(job)
            return self.recover(job['id'])

    def finish_apply(self,operation):
        job=self.port.operation(operation)
        if job is None or job['phase']!='stopping':raise InstallError('Unknown active application')
        try:
            self.port.stop(job)
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
            job['failure']=self.port.safe(str(error))
            # Persist the original failure before trying recovery. State and
            # verified backup identity, never error text, decide restoration.
            self.port.save(job)
            return self.recover(job['id'])
        return self.after_success(job)

    def after_success(self,job):
        if job['target'].get('manifest',{}).get('compatibility',{}).get('protocol')==3:
            return self.cleanup(job['id'])
        return job

    def cleanup(self,operation=None):
        return self.finish_cleanup(self.begin_cleanup(operation)['id'])

    def begin_cleanup(self,operation=None):
        job=self.port.operation(operation)
        if job is None or job['id']!=self.port.operation()['id']:raise InstallError('Cleanup requires the current operation')
        if job['phase'] not in ('succeeded','restored','prepared','prepare-failed','apply-failed'):raise InstallError('Finish or recover the update before cleanup')
        job['cleanup']={**job.get('cleanup',{}),'status':'running','reclaimedBytes':job.get('cleanup',{}).get('reclaimedBytes',0),'items':job.get('cleanup',{}).get('items',[])}
        self.port.save(job)
        return job

    def finish_cleanup(self,operation):
        job=self.port.operation(operation)
        if job is None or job.get('cleanup',{}).get('status')!='running':raise InstallError('Unknown active cleanup')
        try:self.port.cleanup(job)
        except Exception as error:
            previous=job.get('cleanup',{})
            job['cleanup']={**previous,'status':'failed','reclaimedBytes':previous.get('reclaimedBytes',0),'items':previous.get('items',[]),'failure':self.port.safe(str(error))}
        self.port.save(job)
        return job

    def recover(self,operation=None):
        before=self.port.operation(operation)
        job=self._recover(operation)
        if job['phase'] not in ACTIVE and before.get('cleanup',{}).get('status')=='running':return self.cleanup(job['id'])
        if job['phase']=='succeeded' and before['phase'] in ACTIVE:return self.after_success(job)
        return job

    def _recover(self,operation=None):
        job=self.port.operation(operation)
        if job is None:raise InstallError('Unknown upgrade operation')
        if job['phase'] in ('succeeded','restored','prepare-failed','apply-failed','prepared'):return job
        if job['phase']=='preparing':
            job['failure']='Preparation interrupted; no running release was changed. Download again.'
            return self.save(job,'prepare-failed')
        job.setdefault('failure','Upgrade interrupted before its result was recorded')
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
            job['recoveryFailure']=self.port.safe(str(error))
            try:self.port.stop(job)
            except Exception as stop_error:job['stopFailure']=self.port.safe(str(stop_error))
            job['instruction']=('Recovery and service shutdown failed; admission is unverified. Stop the managed service and inspect diagnostics.' if job.get('stopFailure') else 'Keep maintenance closed.')+' Run sudo bash install.sh --upgrade recover --output json; inspect the diagnostic log before resuming work.'
            return self.save(job,'recovery-failed')
