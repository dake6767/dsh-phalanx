"""Small updater bootstrap through the public installer; no platform download."""
import contextlib
import copy
import io
import json
import hashlib
from pathlib import Path
import runpy
import sqlite3
import sys
import tarfile
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts/install'))
from installer_contract_support import installer
from installer_executor_install import installed_executor
from installer_compatibility import validate_contract

UpgradeMachine=runpy.run_path(str(Path(__file__).with_name('upgrade-machine.py')))['UpgradeMachine']
CONTRACT={'protocol':1,'source':{'min':'0.1.1','maxExclusive':'0.2.0'},'accounts':{'sourceMin':4,'sourceMax':4,'target':4},'environmentEpoch':1}
POLICY={'ticket':9,'checks':['ci','linux','cleanInstall','upgrade','review']}

class Bootstrap(unittest.TestCase):
    def test_bootstrap_verifies_small_commit_bound_files_and_only_restarts_updater(self):
        for corrupt in (False,True):
            with self.subTest(corrupt=corrupt),tempfile.TemporaryDirectory() as directory:
                machine=UpgradeMachine(directory);host=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0);host.request=lambda *a,**k:b'login'
                args=machine.make_bundle('v0.1.12-rc.1');file=Path(args[3])/'manifest.json';manifest=json.loads(file.read_text());manifest.update(schema=2,compatibility=CONTRACT,acceptancePolicy=POLICY);file.write_text(json.dumps(manifest))
                with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):self.assertEqual(installer.main(args,host),0)
                original=machine.running_target;old_engine=installed_executor(host)
                data=machine.root/'var/lib/dsh-phalanx/data';data.mkdir()
                with sqlite3.connect(data/'community-accounts.db') as connection:connection.execute('PRAGMA user_version=4')
                args=machine.make_bundle('v0.1.13-rc.1','d','e');bundle=Path(args[3]);file=bundle/'manifest.json';target=json.loads(file.read_text())
                with tarfile.open(bundle/'dsh-phalanx-linux-amd64.tar.gz') as archive:
                    files={entry.name.removeprefix('updater/'):archive.extractfile(entry).read() for entry in archive if entry.name.startswith('updater/')}
                target.update(schema=2,compatibility={**CONTRACT,'protocol':3},acceptancePolicy=POLICY,storage={key:1024 for key in ('platformArchiveBytes','platformExpandedBytes','imageDownloadBytes','imageExpandedBytes')},updater=files.pop('manifest.json').decode());file.write_text(json.dumps(target))
                updater_bytes=json.dumps({name:body.decode() for name,body in files.items()}).encode()
                target['updaterAsset']={'name':'updater.json','sha256':hashlib.sha256(updater_bytes).hexdigest()}
                file.write_text(json.dumps(target))
                # The two large assets are unavailable. Bootstrap must still work.
                for name in target['files']:(bundle/name).unlink()
                requests=[]
                def request(url,**kwargs):
                    if url.startswith('https://'):
                        self.assertEqual(url,'https://github.com/dake6767/dsh-phalanx/releases/download/v0.1.13-rc.1/updater.json')
                        self.assertEqual(kwargs,{'max_bytes':4*1024*1024});requests.append(url)
                        return updater_bytes+b'corruption' if corrupt else updater_bytes
                    return b'login'
                host.request=request;machine.calls.clear()
                with contextlib.redirect_stdout(output:=io.StringIO()),contextlib.redirect_stderr(io.StringIO()):status=installer.main([*args,'--upgrade','bootstrap','--output','json'],host)
                self.assertEqual(status,1 if corrupt else 0,output.getvalue())
                self.assertEqual(machine.running_target,original)
                self.assertFalse(any('stop' in call or 'load' in call or 'pull' in call for call in machine.calls))
                self.assertTrue(requests)
                if corrupt:self.assertEqual(installed_executor(host),old_engine)
                else:
                    self.assertEqual(installed_executor(host)['sourceCommit'],'d'*40)
                    self.assertTrue(any(call[:3]==['systemctl','restart','--no-block'] and call[-1]=='dsh-phalanx-updater.service' for call in machine.calls))
                    self.assertEqual(json.loads(output.getvalue())['status'],'updater-ready')

    def test_capacity_protocol_requires_finite_positive_storage_before_preparation(self):
        base={'schema':2,'targetVersion':'0.1.13','compatibility':{**CONTRACT,'protocol':3},'acceptancePolicy':POLICY,'updater':'{}'}
        for value in (None,{}, {'platformArchiveBytes':0}, {'platformArchiveBytes':float('nan')}):
            with self.subTest(value=value),self.assertRaises(installer.InstallError):validate_contract({**base,'storage':value})

if __name__=='__main__':unittest.main()
