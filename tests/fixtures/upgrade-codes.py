"""Stable update facts through the shared transaction and its public projection."""
import contextlib,io,json,runpy,tempfile,unittest
from pathlib import Path
from installer_contract_support import installer
from installer_upgrade_core import UpgradeCore
from installer_upgrade_cli import public_operation
TransactionPort=runpy.run_path(str(Path(__file__).with_name('upgrade-core.py')))['TransactionPort']

class UpdateFacts(unittest.TestCase):
 def port(self):
  port=TransactionPort();port.old['manifest']={'targetVersion':'0.1.26'}
  def cleanup(job):job['cleanup']={'status':'succeeded','reclaimedBytes':0,'items':[]}
  port.cleanup=cleanup;return port
 def target(self):
  return {'version':'v0.1.27','commit':'b'*40,'manifest':{'targetVersion':'0.1.27','commit':'b'*40,'platform':'linux/amd64',
   'compatibility':json.loads((Path(__file__).parents[2]/'release-policy.json').read_text())['compatibility'],
   'files':{'dsh-phalanx-linux-amd64.tar.gz':'c'*64},'image':{'digest':'sha256:'+'d'*64}}}
 def test_prepared_and_completed_operations_expose_stable_phase_codes(self):
  core=UpgradeCore(self.port());prepared=core.prepare(self.target())
  self.assertEqual(public_operation(prepared)['phaseCode'],'update.prepared')
  result=core.apply(prepared['id'])
  self.assertEqual(public_operation(result)['phaseCode'],'update.succeeded')

 def test_restoration_preserves_original_failure_and_its_own_error_separately(self):
  port=self.port();original=port.verify
  def verify(job,old=False):
   if not old:raise installer.InstallError('The target rejected an opaque test operation',code='migration.failed')
   raise installer.InstallError('The previous version could not use its restored database',code='database.restore-failed')
  port.verify=verify;core=UpgradeCore(port);prepared=core.prepare(self.target());result=public_operation(core.apply(prepared['id']))
  self.assertEqual(result['phaseCode'],'update.recovery-failed')
  self.assertEqual(result['failurePhase'],'validating')
  self.assertEqual(result['errorCode'],'migration.failed')
  self.assertEqual(result['recoveryErrorCode'],'database.restore-failed')
  self.assertEqual(result['failure'],'The target rejected an opaque test operation')
  self.assertEqual(result['recoveryFailure'],'The previous version could not use its restored database')
  port=self.port()
  def opaque(job,old=False):raise installer.InstallError('Opaque adapter failure')
  port.verify=opaque;core=UpgradeCore(port);prepared=core.prepare(self.target());result=public_operation(core.apply(prepared['id']))
  self.assertEqual(result['errorCode'],'unknown')
  self.assertEqual(result['recoveryErrorCode'],'recovery.failed')


 def test_timing_survives_a_new_core_and_ends_at_commit_before_reopening(self):
  port=self.port();tick=[100.0]
  port.time_point=lambda:{'wall':1000+tick[0],'mono':tick[0],'boot':'fixture-boot'}
  def delay(name,seconds):
   original=getattr(port,name)
   def effect(*args,**kwargs):
    value=original(*args,**kwargs);tick[0]+=seconds;return value
   setattr(port,name,effect)
  for name,seconds in [('prepare',3),('stop',2),('backup',4),('switch',3),('verify',5),('commit',1)]:delay(name,seconds)
  original_gate=port.gate
  def gate(closed):
   original_gate(closed)
   if not closed:tick[0]+=2
  port.gate=gate;prepared=UpgradeCore(port).prepare(self.target());tick[0]+=10
  result=public_operation(UpgradeCore(port).apply(prepared['id']),port.time_point())
  self.assertEqual(result['timing']['downtimeSeconds'],15)
  self.assertFalse(result['timing']['downtimeActive'])
  self.assertEqual(result['timing']['phaseSeconds']['preparing'],3)
  self.assertEqual(result['timing']['phaseSeconds']['prepared'],10)
  self.assertEqual(result['timing']['phaseSeconds']['stopping'],2)
  self.assertEqual(result['timing']['phaseSeconds']['backing-up'],4)
  self.assertEqual(result['timing']['phaseSeconds']['validating'],6)
  self.assertEqual(result['timing']['phaseSeconds']['committed'],2)

 def test_interrupted_recovery_counts_time_across_a_changed_kernel_boot(self):
  port=self.port();point={'wall':1000,'mono':100,'boot':'before-reboot'};port.time_point=lambda:dict(point)
  core=UpgradeCore(port);prepared=core.prepare(self.target());core.submit_apply(prepared['id'])
  point.update(wall=1060,mono=1,boot='after-reboot')
  result=public_operation(UpgradeCore(port).recover(prepared['id']),port.time_point())
  self.assertEqual(result['phaseCode'],'update.restored')
  self.assertEqual(result['timing']['downtimeSeconds'],60)
  self.assertFalse(result['timing']['downtimeActive'])
  self.assertEqual(result['errorCode'],'operation.interrupted')
  self.assertEqual(result['failurePhase'],'stopping')

 def test_unknown_error_keeps_original_text_and_only_an_owned_diagnostic_path(self):
  for code in ('unknown','future.vendor-failure'):
   with self.subTest(code=code):
    port=self.port();begin=port.begin
    def with_log(target):return {**begin(target),'diagnostic':'20261030T120000-1234abcd.jsonl'}
    def verify(job,old=False):
     if not old:raise installer.InstallError('Opaque future error remains available to the operator',code=code)
     port.running='old'
    port.begin=with_log;port.verify=verify;core=UpgradeCore(port);prepared=core.prepare(self.target());job=core.apply(prepared['id']);result=public_operation(job)
    self.assertEqual(result['errorCode'],code)
    self.assertEqual(result['failure'],'Opaque future error remains available to the operator')
    self.assertEqual(result['diagnosticLog'],'/var/log/dsh-phalanx/20261030T120000-1234abcd.jsonl')
    job['diagnostic']='../../etc/passwd';self.assertNotIn('diagnosticLog',public_operation(job))

 def test_structured_progress_codes_keep_the_existing_human_output(self):
  with tempfile.TemporaryDirectory() as directory,contextlib.redirect_stderr(output:=io.StringIO()):
   report=installer.Progress(Path(directory));events=[];report.subscribe(events.append)
   with report.stage('Preflight',phase_code='install.preflight'):
    report.emit('failed','The selected database did not answer',errorCode='database.unavailable')
   self.assertEqual(events[0]['phaseCode'],'install.preflight')
   self.assertEqual(events[1]['errorCode'],'database.unavailable')
   self.assertIn('[Preflight] failed · The selected database did not answer',output.getvalue())
   self.assertNotIn('database.unavailable',output.getvalue())
   self.assertEqual(json.loads(report.log.read_text().splitlines()[1])['errorCode'],'database.unavailable')

if __name__=='__main__':unittest.main()
