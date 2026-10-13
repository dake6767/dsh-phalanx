"""Capacity decisions before any download or service interruption."""
import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts/install'))
from installer_storage import capacity_plan
from installer_host import InstallError

class Capacity(unittest.TestCase):
    def test_same_device_adds_writes_once_without_adding_available_space(self):
        rows=[{'path':'/cache','purpose':'download','bytes':40},{'path':'/program','purpose':'unpack','bytes':50}]
        result=capacity_plan(rows,lambda _:('root',100),reserve=10)
        self.assertTrue(result['sufficient'])
        self.assertEqual(len(result['locations']),1)
        self.assertEqual(result['locations'][0]['availableBytes'],100)
        self.assertEqual(result['locations'][0]['requiredBytes'],100)

    def test_split_devices_cannot_borrow_free_space(self):
        result=capacity_plan([{'path':'/root','purpose':'cache','bytes':80},{'path':'/data','purpose':'image','bytes':80}],lambda path:('root',70) if path=='/root' else ('data',1000),reserve=0)
        self.assertFalse(result['sufficient'])
        self.assertEqual(result['locations'][0]['shortfallBytes'],10)

    def test_existing_shared_image_needs_no_duplicate_layer_reserve(self):
        result=capacity_plan([{'path':'/image','purpose':'existing verified image','bytes':0},{'path':'/backup','purpose':'backup','bytes':20}],lambda _:('root',25),reserve=5)
        self.assertTrue(result['sufficient'])
        self.assertEqual(result['locations'][0]['requiredBytes'],25)

    def test_no_write_on_a_separate_reused_volume_needs_no_extra_reserve(self):
        result=capacity_plan([{'path':'/image','purpose':'reused image','bytes':0}],lambda _:('image',0),reserve=16*1024*1024)
        self.assertTrue(result['sufficient']);self.assertEqual(result['locations'][0]['requiredBytes'],0)

    def test_unreliable_capacity_is_not_assumed_zero(self):
        for free in (None,-1,float('nan'),'100'):
            with self.subTest(free=free),self.assertRaises(InstallError):capacity_plan([{'path':'/data','purpose':'image','bytes':10}],lambda _:('root',free))

class SharedLayers(unittest.TestCase):
    def test_only_verified_matching_layer_prefix_is_reused(self):
        from installer_storage import missing_image_capacity
        layers=[{'diffId':'sha256:'+'a'*64,'downloadBytes':10,'expandedBytes':100},{'diffId':'sha256:'+'b'*64,'downloadBytes':20,'expandedBytes':200}]
        self.assertEqual(missing_image_capacity(layers,[['sha256:'+'a'*64]]),(20,400))
        self.assertEqual(missing_image_capacity(layers,[['sha256:'+'x'*64,'sha256:'+'b'*64]]),(30,600))
        self.assertEqual(missing_image_capacity(layers,[[row['diffId'] for row in layers]]),(0,0))

class PublicCapacity(unittest.TestCase):
    def test_public_prepare_blocks_before_archive_image_or_stop_and_reports_locations(self):
        import contextlib,io,json,runpy,sqlite3,tempfile,subprocess
        from unittest.mock import patch
        from installer_contract_support import installer
        UpgradeMachine=runpy.run_path(str(Path(__file__).with_name('upgrade-machine.py')))['UpgradeMachine']
        contract={'protocol':1,'source':{'min':'0.1.1','maxExclusive':'0.2.0'},'accounts':{'sourceMin':4,'sourceMax':4,'target':4},'environmentEpoch':1}
        policy={'ticket':9,'checks':['ci','linux','cleanInstall','upgrade','review']}
        for free,expected in [(0,1),(2**40,0),(None,1)]:
            with self.subTest(free=free),tempfile.TemporaryDirectory() as directory:
                machine=UpgradeMachine(directory)
                def command(args,**kwargs):
                    if 'podman' in args and args[-3:]==['info','--format','json']:
                        return subprocess.CompletedProcess(args,0,json.dumps({'host':{'security':{'rootless':True},'cgroupVersion':'v2'},'store':{'graphRoot':'/images','imageCopyTmpDir':'/image-tmp'}}),'')
                    return machine.command(args,**kwargs)
                host=installer.Host(machine.root,command,system='Linux',machine='x86_64',uid=0);host.request=lambda *a,**k:b'login'
                before=machine.make_bundle('v0.1.12-rc.1');file=Path(before[3])/'manifest.json';manifest=json.loads(file.read_text());manifest.update(schema=2,compatibility=contract,acceptancePolicy=policy);file.write_text(json.dumps(manifest))
                with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):self.assertEqual(installer.main(before,host),0)
                original=machine.running_target;data=machine.root/'var/lib/dsh-phalanx/data';data.mkdir()
                with sqlite3.connect(data/'community-accounts.db') as connection:connection.execute('PRAGMA user_version=4')
                (data/'keep.txt').write_text('keep platform data')
                historic=machine.root/'var/lib/dsh-phalanx-updater/22222222-2222-4222-8222-222222222222/backup';historic.mkdir(parents=True);(historic/'keep').write_text('historical backup')
                args=machine.make_bundle('v0.1.13-rc.1','d','e');file=Path(args[3])/'manifest.json';target=json.loads(file.read_text());target.update(schema=2,compatibility={**contract,'protocol':3},acceptancePolicy=policy,storage={key:1024 for key in ('platformArchiveBytes','platformExpandedBytes','imageDownloadBytes','imageExpandedBytes')},updater='{}');file.write_text(json.dumps(target))
                machine.calls.clear()
                gate=type('GatePort',(),{'preflight':lambda self,ports:None,'install':lambda self,host,uid:None,'close':lambda self,ports:None,'open':lambda self:None})
                # Override only the OS capacity observation; run the real public
                # CLI, journal, release verification and transaction ordering.
                import installer_storage
                from installer_release import acquire
                def observed_acquire(*args,**kwargs):
                    journal=machine.root/'var/lib/dsh-phalanx-updater'
                    current=(journal/'current').read_text().strip()
                    self.assertTrue(json.loads((journal/current/'operation.json').read_text())['space']['sufficient'])
                    return acquire(*args,**kwargs)
                actual=installer_storage.UpgradeStorage
                with patch('installer_upgrade_host.acquire',side_effect=observed_acquire),patch('installer_upgrade_host.UpgradeStorage',side_effect=lambda h:actual(h,lambda path:('root',free))),patch('installer_upgrade_host.LinuxAdmissionGate',gate),contextlib.redirect_stdout(output:=io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                    status=installer.main([*args,'--upgrade','prepare','--output','json'],host)
                result=json.loads(output.getvalue())['operation']
                self.assertEqual(status,expected,output.getvalue());self.assertEqual(machine.running_target,original)
                self.assertEqual((data/'keep.txt').read_text(),'keep platform data');self.assertEqual((historic/'keep').read_text(),'historical backup')
                self.assertFalse(any('stop' in call for call in machine.calls))
                if free is not None:
                    self.assertEqual(result['space']['sufficient'],expected==0)
                    self.assertGreater(result['space']['backupBytes'],0)
                    self.assertTrue(any('/images' in path for row in result['space']['locations'] for path in row['paths']))
                if expected:
                    self.assertFalse(any('load' in call or 'pull' in call for call in machine.calls))
                    self.assertEqual(len(list((machine.root/'opt/dsh-phalanx/releases').iterdir())),1)
                else:self.assertEqual(result['phase'],'prepared')

if __name__=='__main__':unittest.main()
