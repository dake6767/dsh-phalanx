"""Public installation/upgrade commands and the shared transaction port."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import copy
import sqlite3
import runpy
from unittest.mock import patch
import unittest
from installer_contract_support import installer, InstallationMachine

CONTRACT = {'protocol':1,'source':{'min':'0.1.1','maxExclusive':'0.2.0'},
            'accounts':{'sourceMin':4,'sourceMax':4,'target':4},'environmentEpoch':1}
POLICY = {'ticket':6,'checks':['ci','linux','cleanInstall','upgrade','review']}

class TransactionPort:
    def __init__(self):
        self.records={}; self.selected=None; self.events=[]; self.running='old'; self.db='original'; self.gated=False
        self.old={'version':'0.1.2','commit':'a'*40}; self.fail_new=False; self.fail_restore=False
    def operation(self,operation=None):return copy.deepcopy(self.records.get(operation or self.selected))
    def begin(self,target):return {'id':'11111111-1111-4111-8111-111111111111','target':target,'source':copy.deepcopy(self.old),'phase':'preparing'}
    def save(self,job):self.selected=job['id']; self.records[job['id']]=copy.deepcopy(job); self.events.append(job['phase'])
    def preflight(self,job):self.events.append('preflight')
    def prepare(self,job):return {'target':'fixed-new','manifestSha256':'c'*64}
    def gate(self,closed):self.gated=closed; self.events.append('closed' if closed else 'open')
    def stop(self,job):self.running=None; self.events.append('stopped')
    def backup(self,job):return {'database':self.db,'verified':True}
    def switch(self,job):self.running='new'; self.db='migrated'; self.events.append('new-started')
    def verify(self,job,old=False):
        if (old and self.fail_restore) or (not old and self.fail_new):raise OSError('injected startup failure')
        if self.running != ('old' if old else 'new'):raise OSError('managed service is stopped')
        assert self.gated, 'writers reopened before identity verification'
        self.events.append('old-verified' if old else 'new-verified')
    def restore(self,job):self.db=job['backup']['database']; self.running='old'; self.events.append('carriers-restored')
    def start(self,job):self.running='old' if job.get('restorationCommitted') else 'new'
    def restart_old(self,job):self.running='old'
    def commit(self,job):self.old=copy.deepcopy(job['target']); self.events.append('published')
    def safe(self,message):return message

class SharedUpgrade(unittest.TestCase):
    def test_preparation_does_not_switch_and_failed_apply_restores_database_and_verified_service(self):
        from installer_upgrade_core import UpgradeCore
        port=TransactionPort(); core=UpgradeCore(port)
        target={'version':'0.1.4','commit':'b'*40}
        prepared=core.prepare(target)
        self.assertEqual(prepared['phase'],'prepared'); self.assertEqual(port.running,'old'); self.assertFalse(port.gated)
        port.fail_new=True
        failed=core.apply(prepared['id'])
        self.assertEqual(failed['phase'],'restored'); self.assertEqual(failed['failure'],'injected startup failure')
        self.assertEqual(port.db,'original'); self.assertEqual(port.running,'old'); self.assertFalse(port.gated)
        self.assertLess(port.events.index('old-verified'),port.events.index('open'))
        self.assertEqual(failed['target'],target)

    def test_failed_recovery_keeps_original_failure_and_closed_ingress(self):
        from installer_upgrade_core import UpgradeCore
        port=TransactionPort(); core=UpgradeCore(port); port.fail_new=True; port.fail_restore=True
        job=core.prepare({'version':'0.1.4','commit':'b'*40}); result=core.apply(job['id'])
        self.assertEqual(result['phase'],'recovery-failed'); self.assertTrue(port.gated)
        self.assertEqual(result['failure'],'injected startup failure')
        self.assertIn('recover',result['instruction'])
        with self.assertRaises(Exception):core.prepare({'version':'0.1.5','commit':'c'*40})
        self.assertEqual(core.status()['id'],job['id']); self.assertEqual(core.status()['phase'],'recovery-failed')
        port.fail_restore=False
        result=core.recover(job['id'])
        self.assertEqual(result['phase'],'restored'); self.assertNotIn('instruction',result)
        self.assertFalse(port.gated)

    def test_verified_backup_preserves_links_modes_absence_and_keeps_user_projects_outside_restore(self):
        from installer_upgrade_backup import PlatformBackup
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); data=root/'data'; data.mkdir()
            user=data/'users/alice'; user.mkdir(parents=True); project=user/'notes'; project.write_text('private project')
            database=data/'community-accounts.db'; database.write_bytes(b'original database'); database.chmod(0o600)
            config=root/'config'; config.write_text('private configuration'); config.chmod(0o640)
            (data/'profile-link').symlink_to('../not-followed')
            backup=PlatformBackup(data,root/'backup',{'configuration':config,'absent':root/'missing'})
            receipt=backup.create()
            self.assertFalse((root/'backup/data/users').exists())
            database.write_bytes(b'migrated database'); (data/'new-carrier').write_text('created by new version')
            (root/'missing').write_text('created configuration'); config.write_text('new configuration')
            project.write_text('retained user project')
            backup.restore(receipt)
            self.assertEqual(database.read_bytes(),b'original database'); self.assertEqual(database.stat().st_mode & 0o777,0o600)
            self.assertEqual(config.read_text(),'private configuration'); self.assertEqual(config.stat().st_mode & 0o777,0o640)
            self.assertFalse((root/'missing').exists()); self.assertFalse((data/'new-carrier').exists())
            self.assertEqual((data/'profile-link').readlink(),Path('../not-followed'))
            self.assertEqual(project.read_text(),'retained user project')
            database.write_bytes(b'migrated again'); (root/'backup/data/community-accounts.db').write_bytes(b'corrupt')
            with self.assertRaises(Exception):backup.restore(receipt)
            self.assertEqual(database.read_bytes(),b'migrated again')

    def test_public_prepare_keeps_old_service_and_apply_reports_verified_data_restoration(self):
        UpgradeMachine=runpy.run_path(str(Path(__file__).with_name('upgrade-machine.py')))['UpgradeMachine']
        with tempfile.TemporaryDirectory() as directory:
            machine=UpgradeMachine(directory); host=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0)
            host.request=lambda *args,**kwargs:b'login'
            with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(installer.main(machine.make_bundle('v0.1.1-rc.4'),host),0)
            data=machine.root/'var/lib/dsh-phalanx/data'; data.mkdir()
            database=data/'community-accounts.db'
            with sqlite3.connect(database) as connection:
                connection.executescript("PRAGMA user_version=4; CREATE TABLE note(value TEXT); INSERT INTO note VALUES('original');")
            original_config=(machine.root/'etc/dsh-phalanx/environment').read_bytes(); original_target=machine.running_target
            args=machine.make_bundle('v0.1.2-rc.1','d','e'); file=Path(args[3])/'manifest.json'; value=json.loads(file.read_text())
            value.update(schema=2,compatibility=CONTRACT,acceptancePolicy=POLICY); file.write_text(json.dumps(value))
            gate=type('GatePort',(),{'preflight':lambda self,ports:None,'install':lambda self,host,uid:None,'close':lambda self,ports:None,'open':lambda self:None})
            with patch('installer_upgrade_host.LinuxAdmissionGate',gate),contextlib.redirect_stdout(output:=io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(installer.main([*args,'--upgrade','prepare','--output','json'],host),0)
            operation=json.loads(output.getvalue())['operation']
            self.assertEqual(operation['phase'],'prepared'); self.assertEqual(machine.running_target,original_target)
            self.assertEqual((machine.root/'etc/dsh-phalanx/environment').read_bytes(),original_config)
            file.write_text('{}')  # apply must retain the prepared metadata, not follow changed release input
            tick=[0]; host.clock=lambda:tick[0]
            def migration(target):
                if json.loads((target/'build-info.json').read_text())['commit']=='d'*40:
                    with sqlite3.connect(database) as connection:connection.execute("UPDATE note SET value='migrated'")
            machine.after_start=migration
            def request(*args,**kwargs):
                if machine.running_target!=original_target:tick[0]+=100; raise OSError('new service unavailable')
                return b'login'
            host.request=request
            with patch('installer_upgrade_host.LinuxAdmissionGate',gate),contextlib.redirect_stdout(output:=io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(installer.main(['--upgrade','apply','--operation',operation['id'],'--yes','--output','json'],host),1)
            result=json.loads(output.getvalue())['operation']
            self.assertEqual(result['phase'],'restored'); self.assertEqual(machine.running_target,original_target)
            self.assertEqual((machine.root/'etc/dsh-phalanx/environment').read_bytes(),original_config)
            with sqlite3.connect(database) as connection:self.assertEqual(connection.execute('SELECT value FROM note').fetchone()[0],'original')
            self.assertFalse((machine.root/'etc/dsh-phalanx/maintenance').exists())
            self.assertNotIn('fixture-deployer-key',output.getvalue())

    def test_public_prepare_accepts_actual_legacy_receipt_without_a_saved_manifest(self):
        for mismatched in (False,True):
            UpgradeMachine=runpy.run_path(str(Path(__file__).with_name('upgrade-machine.py')))['UpgradeMachine']
            with tempfile.TemporaryDirectory() as directory:
                machine=UpgradeMachine(directory); host=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0)
                host.request=lambda *a,**k:b'login'
                old_args=machine.make_bundle('v0.1.1-rc.4'); old_bundle=Path(old_args[3]); old=json.loads((old_bundle/'manifest.json').read_text())
                with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):self.assertEqual(installer.main(old_args,host),0)
                receipt=machine.root/'etc/dsh-phalanx/install-state.json'; state=json.loads(receipt.read_text());state['version']='v0.1.1';receipt.write_text(json.dumps(state))
                (machine.root/'etc/dsh-phalanx/installed-manifest.json').unlink()
                original_receipt=receipt.read_bytes();original_config=(machine.root/'etc/dsh-phalanx/environment').read_bytes();original_target=machine.running_target
                data=machine.root/'var/lib/dsh-phalanx/data';data.mkdir()
                with sqlite3.connect(data/'community-accounts.db') as c:c.execute('PRAGMA user_version=4')
                requests=[]
                if mismatched:old['commit']='f'*40
                def request(url,*a,**k):
                    requests.append(url)
                    if url.endswith('/releases/tags/v0.1.1'):return json.dumps({'tag_name':'v0.1.1','draft':False,'prerelease':False,'assets':[{'name':n} for n in ['manifest.json','SHA256SUMS','dsh-phalanx-linux-amd64.tar.gz','dsh-phalanx-dsh-linux-amd64.oci.tar','acceptance.json','acceptance.md','release.json']]}).encode()
                    if url.endswith('/git/ref/tags/v0.1.1'):return json.dumps({'object':{'type':'commit','sha':old['commit']}}).encode()
                    if url.endswith('/v0.1.1/manifest.json'):return json.dumps(old).encode()
                    if url.endswith('/v0.1.1/SHA256SUMS'):return (old_bundle/'SHA256SUMS').read_bytes()
                    if url.startswith('http://'):return b'login'
                    raise AssertionError('Unexpected source request: '+url)
                host.request=request
                args=machine.make_bundle('v0.1.2-rc.1','d','e');file=Path(args[3])/'manifest.json';value=json.loads(file.read_text());value.update(schema=2,compatibility=CONTRACT,acceptancePolicy=POLICY);file.write_text(json.dumps(value))
                gate=type('GatePort',(),{'preflight':lambda self,ports:None,'install':lambda self,host,uid:None,'close':lambda self,ports:None,'open':lambda self:None})
                with patch('installer_upgrade_host.LinuxAdmissionGate',gate),contextlib.redirect_stdout(output:=io.StringIO()),contextlib.redirect_stderr(io.StringIO()):result=installer.main([*args,'--upgrade','prepare','--output','json'],host)
                if mismatched:
                    self.assertEqual(result,1);self.assertIn('manifest and receipt disagree',json.loads(output.getvalue())['reason'])
                    self.assertFalse((machine.root/'etc/dsh-phalanx/installed-manifest.json').exists())
                else:
                    self.assertEqual(result,0,output.getvalue());self.assertEqual(json.loads(output.getvalue())['operation']['phase'],'prepared')
                self.assertIn('https://api.github.com/repos/dake6767/dsh-phalanx/git/ref/tags/v0.1.1',requests)
                self.assertEqual(receipt.read_bytes(),original_receipt);self.assertEqual((machine.root/'etc/dsh-phalanx/environment').read_bytes(),original_config)
                self.assertEqual(machine.running_target,original_target);self.assertTrue(machine.active)


    def test_interrupted_switch_uses_completed_backup_and_duplicate_apply_does_not_switch_again(self):
        from installer_upgrade_core import UpgradeCore
        port=TransactionPort(); core=UpgradeCore(port); job=core.prepare({'version':'0.1.4','commit':'b'*40})
        switch=port.switch
        def interrupted(record):switch(record); raise KeyboardInterrupt('process died after switch')
        port.switch=interrupted
        with self.assertRaises(KeyboardInterrupt):core.apply(job['id'])
        self.assertEqual(core.status(job['id'])['phase'],'switching'); self.assertTrue(port.gated)
        restored=UpgradeCore(port).recover(job['id'])
        self.assertEqual(restored['phase'],'restored'); self.assertEqual(port.db,'original')
        starts=port.events.count('new-started')
        self.assertEqual(core.apply(job['id'])['phase'],'restored')
        self.assertEqual(port.events.count('new-started'),starts)

    def test_committed_interruption_never_rolls_back_writes_that_may_have_resumed(self):
        from installer_upgrade_core import UpgradeCore
        port=TransactionPort(); core=UpgradeCore(port); job=core.prepare({'version':'0.1.4','commit':'b'*40})
        gate=port.gate
        def interrupted(closed):
            gate(closed)
            if not closed:raise KeyboardInterrupt('died after reopening')
        port.gate=interrupted
        with self.assertRaises(KeyboardInterrupt):core.apply(job['id'])
        self.assertTrue(core.status(job['id'])['committed']); port.db='new member write'; port.gate=gate
        self.assertEqual(UpgradeCore(port).recover(job['id'])['phase'],'succeeded')
        self.assertEqual(port.db,'new member write'); self.assertNotIn('restored',port.events)

    def test_committed_recovery_restarts_after_transient_verification_failure_without_recopied_data(self):
        from installer_upgrade_core import UpgradeCore
        for restored in (False,True):
            with self.subTest(restored=restored):
                port=TransactionPort(); core=UpgradeCore(port); port.fail_new=restored
                job=core.prepare({'version':'0.1.4','commit':'b'*40}); gate=port.gate
                def interrupted(closed):
                    gate(closed)
                    if not closed:raise KeyboardInterrupt('died reopening admission')
                port.gate=interrupted
                with self.assertRaises(KeyboardInterrupt):core.apply(job['id'])
                port.gate=gate; port.db='member write retained'
                if restored:port.fail_restore=True
                else:port.fail_new=True
                self.assertEqual(core.recover(job['id'])['phase'],'recovery-failed'); self.assertIsNone(port.running)
                port.fail_restore=False; port.fail_new=False
                result=core.recover(job['id'])
                self.assertEqual(result['phase'],'restored' if restored else 'succeeded')
                self.assertNotIn('instruction',result)
                self.assertEqual(port.db,'member write retained')
                self.assertEqual(port.events.count('carriers-restored'),1 if restored else 0)

    def test_durable_submission_closes_admission_and_survives_client_or_executor_disconnect(self):
        from installer_upgrade_core import UpgradeCore
        port=TransactionPort();core=UpgradeCore(port);job=core.prepare({'version':'0.1.4','commit':'b'*40})
        accepted=core.submit_apply(job['id'])
        self.assertEqual(accepted['phase'],'stopping');self.assertTrue(port.gated);self.assertEqual(port.running,'old')
        with self.assertRaises(Exception):UpgradeCore(port).apply(job['id'])
        # A new executor recovers the recorded submission, never resubmits it.
        self.assertEqual(UpgradeCore(port).recover(job['id'])['phase'],'restored')
        self.assertNotIn('new-started',port.events);self.assertEqual(port.db,'original')

    def test_backup_failure_cannot_start_the_new_release(self):
        from installer_upgrade_core import UpgradeCore
        port=TransactionPort(); core=UpgradeCore(port); job=core.prepare({'version':'0.1.4','commit':'b'*40})
        def failed(_):raise OSError('backup unavailable')
        port.backup=failed
        result=core.apply(job['id'])
        self.assertEqual(result['phase'],'restored'); self.assertEqual(result['failure'],'backup unavailable')
        self.assertNotIn('new-started',port.events); self.assertEqual(port.db,'original'); self.assertFalse(port.gated)

    def test_unknown_or_malformed_release_protocol_fails_with_one_machine_result_before_host_changes(self):
        for protocol in (None,[],{'protocol':99}):
            with self.subTest(protocol=protocol),tempfile.TemporaryDirectory() as directory:
                machine=InstallationMachine(directory); args=machine.make_bundle('v0.1.4-rc.2')
                file=Path(args[3])/'manifest.json'; value=json.loads(file.read_text()); value.update(schema=2,compatibility=protocol,acceptancePolicy=POLICY); file.write_text(json.dumps(value))
                host=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0)
                with contextlib.redirect_stdout(output:=io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(installer.main([*args,'--output','json'],host),1)
                self.assertEqual(json.loads(output.getvalue())['status'],'failed'); self.assertEqual(machine.calls,[])

    def test_interruption_after_verified_restoration_does_not_repeat_database_restore(self):
        from installer_upgrade_core import UpgradeCore
        port=TransactionPort(); core=UpgradeCore(port); port.fail_new=True
        job=core.prepare({'version':'0.1.4','commit':'b'*40}); gate=port.gate
        def interrupted(closed):
            gate(closed)
            if not closed:raise KeyboardInterrupt('died while reopening old version')
        port.gate=interrupted
        with self.assertRaises(KeyboardInterrupt):core.apply(job['id'])
        self.assertTrue(core.status(job['id'])['restorationCommitted'])
        port.db='member write after restoration'; port.gate=gate
        self.assertEqual(core.recover(job['id'])['phase'],'restored')
        self.assertEqual(port.db,'member write after restoration'); self.assertEqual(port.events.count('carriers-restored'),1)

    def test_public_recovery_accepts_a_committed_protocol_journal_without_executor_fields(self):
        from installer_upgrade_host import UpgradeHost
        from installer_progress import Progress
        UpgradeMachine=runpy.run_path(str(Path(__file__).with_name('upgrade-machine.py')))['UpgradeMachine']
        with tempfile.TemporaryDirectory() as directory:
            machine=UpgradeMachine(directory);args=machine.make_bundle('v0.1.4-rc.2')
            file=Path(args[3])/'manifest.json';manifest=json.loads(file.read_text());manifest.update(schema=2,compatibility=CONTRACT,acceptancePolicy=POLICY);file.write_text(json.dumps(manifest))
            host=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0);host.request=lambda *a,**k:b'login'
            with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):self.assertEqual(installer.main(args,host),0)
            data=machine.root/'var/lib/dsh-phalanx/data';data.mkdir()
            with sqlite3.connect(data/'community-accounts.db') as connection:connection.execute('PRAGMA user_version=4')
            host.progress=Progress(machine.root,persist=False);port=UpgradeHost(host)
            job=port.begin({'version':'v0.1.4-rc.2','manifest':manifest,'manifestSha256':'f'*64})
            job.update(phase='committed',committed=True,prepared={'target':str(machine.running_target),'command':['node','/fixture-official-cli.js']})
            port.save(job)
            gate=type('GatePort',(),{'close':lambda self,ports:None,'open':lambda self:None})
            with patch('installer_upgrade_host.LinuxAdmissionGate',gate),contextlib.redirect_stdout(output:=io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(installer.main(['--upgrade','recover','--operation',job['id'],'--output','json'],host),0)
            self.assertEqual(json.loads(output.getvalue())['operation']['phase'],'succeeded')
            self.assertFalse((machine.root/'etc/dsh-phalanx/maintenance').exists())

    def test_public_install_rejects_self_consistent_but_incomplete_executor_before_activation(self):
        import tarfile,hashlib
        for fault in ('missing-module','contradictory-list'):
            with tempfile.TemporaryDirectory() as directory:
                machine=InstallationMachine(directory);args=machine.make_bundle('v0.1.4-rc.2');bundle=Path(args[3])
                package=bundle/'dsh-phalanx-linux-amd64.tar.gz';replacement=bundle/'replacement.tar.gz'
                with tarfile.open(package,'r:gz') as source,tarfile.open(replacement,'w:gz') as target:
                    for member in source:
                        if fault=='missing-module' and member.name=='updater/installer_progress.py':continue
                        if fault=='contradictory-list' and member.name=='updater/executor-files.json':
                            member.size=2;target.addfile(member,io.BytesIO(b'[]'));continue
                        if member.name=='updater/manifest.json':
                            value=json.load(source.extractfile(member))
                            if fault=='missing-module':value['files'].pop('installer_progress.py')
                            else:value['files']['executor-files.json']=hashlib.sha256(b'[]').hexdigest()
                            data=json.dumps(value).encode();member.size=len(data);target.addfile(member,io.BytesIO(data))
                        else:target.addfile(member,source.extractfile(member) if member.isfile() else None)
                replacement.replace(package)
                file=bundle/'manifest.json';manifest=json.loads(file.read_text());manifest.update(schema=2,compatibility=CONTRACT,acceptancePolicy=POLICY)
                manifest['files'][package.name]=hashlib.sha256(package.read_bytes()).hexdigest();file.write_text(json.dumps(manifest))
                (bundle/'SHA256SUMS').write_text(''.join(value+'  '+name+'\n' for name,value in manifest['files'].items()))
                host=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0);host.request=lambda *a,**k:b'login'
                with contextlib.redirect_stdout(output:=io.StringIO()),contextlib.redirect_stderr(io.StringIO()):self.assertEqual(installer.main([*args,'--output','json'],host),1)
                self.assertEqual(json.loads(output.getvalue())['status'],'failed');self.assertFalse(machine.active)
                self.assertFalse((machine.root/'opt/dsh-phalanx/updater').exists())

    def test_server_recovery_repairs_a_damaged_executor_after_a_terminal_result(self):
        from installer_upgrade_host import UpgradeHost
        from installer_executor_install import executor_package
        UpgradeMachine=runpy.run_path(str(Path(__file__).with_name('upgrade-machine.py')))['UpgradeMachine']
        with tempfile.TemporaryDirectory() as directory:
            machine=UpgradeMachine(directory);args=machine.make_bundle('v0.1.4-rc.2');file=Path(args[3])/'manifest.json'
            manifest=json.loads(file.read_text());manifest.update(schema=2,compatibility=CONTRACT,acceptancePolicy=POLICY);file.write_text(json.dumps(manifest))
            host=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0);host.request=lambda *a,**k:b'login'
            with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):self.assertEqual(installer.main(args,host),0)
            data=machine.root/'var/lib/dsh-phalanx/data';data.mkdir()
            with sqlite3.connect(data/'community-accounts.db') as connection:connection.execute('PRAGMA user_version=4')
            port=UpgradeHost(host);job=port.begin({'version':'v0.1.4-rc.2','manifest':manifest,'manifestSha256':'f'*64})
            engine=executor_package(machine.running_target/'updater');pointer=machine.root/'opt/dsh-phalanx/updater';old_bank=pointer.resolve()
            job.update(phase='succeeded',committed=True,prepared={'target':str(machine.running_target),'command':['node','/fixture-official-cli.js'],'executor':engine,'currentExecutor':engine});port.save(job)
            (old_bank/'installer_progress.py').write_text('damaged')
            machine.calls.clear()
            with contextlib.redirect_stdout(output:=io.StringIO()),contextlib.redirect_stderr(io.StringIO()):self.assertEqual(installer.main(['--upgrade','recover','--operation',job['id'],'--output','json'],host),0)
            self.assertEqual(json.loads(output.getvalue())['operation']['phase'],'succeeded')
            self.assertNotEqual(pointer.resolve(),old_bank);self.assertEqual(executor_package(pointer.resolve()),engine)
            self.assertIn(['systemctl','restart','--no-block','dsh-phalanx-updater.service'],machine.calls)

    def test_future_protocol_release_installs_with_initialization_output(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstallationMachine(directory); args=machine.make_bundle('v0.1.4-rc.2')
            file=Path(args[3])/'manifest.json'; manifest=json.loads(file.read_text())
            manifest.update(schema=2,compatibility=CONTRACT,acceptancePolicy=POLICY); file.write_text(json.dumps(manifest))
            host=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0)
            host.request=lambda *args,**kwargs:b'login'
            with contextlib.redirect_stdout(output:=io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(installer.main([*args,'--output','json'],host),0)
            result=json.loads(output.getvalue())
            self.assertEqual(result['candidate'],'v0.1.4-rc.2')
            self.assertTrue((machine.root/'opt/dsh-phalanx/updater').is_symlink())
            self.assertIn('User=root', (machine.root/'etc/systemd/system/dsh-phalanx-updater.service').read_text())
            self.assertTrue(any(args[0]=='apt-get' and 'install' in args and 'nftables' in args for args in machine.calls))
            self.assertIn('user@1001.service', (machine.root/'etc/systemd/system/dsh-phalanx-updater.service').read_text())
            self.assertEqual(result['initializationUrl'],'http://127.0.0.1:18080/bootstrap#credential='+'i'*43)

if __name__=='__main__':unittest.main()
