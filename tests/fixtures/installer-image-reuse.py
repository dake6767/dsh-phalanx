"""Public installer transactions with a shared image; optional real rootless Podman.

Account/systemd/admission and disk observations use the established OS seam.
In T2 every image observation uses the actual installed image, with mutations
forbidden. Two fixture platform bundles exercise activation and restoration.
"""
import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from installer_contract_support import installer,with_image_identity
from installer_storage import UpgradeStorage

UpgradeMachine=runpy.run_path(str(Path(__file__).with_name('upgrade-machine.py')))['UpgradeMachine']
GATE=type('Gate',(),{'preflight':lambda self,ports:None,'install':lambda self,host,uid:None,'close':lambda self,ports:None,'open':lambda self:None})
POLICY={'ticket':8,'checks':['ci','linux','cleanInstall','upgrade','review']}


class ImageReuse(unittest.TestCase):
    def test_successful_upgrade_and_failed_activation_restore_share_one_image(self):
        reference=os.environ.get('DSH_PHALANX_REUSE_TEST_IMAGE')
        facts=None
        if reference:
            self.assertEqual(os.uname().sysname,'Linux');self.assertNotEqual(os.geteuid(),0)
            info=json.loads(subprocess.check_output(['podman','info','--format','json'],text=True))
            self.assertTrue(info['host']['security']['rootless'])
            facts=json.loads(subprocess.check_output(['podman','image','inspect',reference],text=True))[0]
            reference='ghcr.io/dake6767/dsh-phalanx@'+facts['Digest']
            # Exercise the actual existing image without allowing implicit pulls.
            subprocess.run(['podman','run','--rm','--pull=never','--network=none',reference,'node','-e',
                            'if(process.getuid()===0)process.exit(1)'],check=True,capture_output=True,text=True)
        architecture=facts['Architecture'] if facts else 'amd64'
        development=['--dev-arm64'] if architecture=='arm64' else []
        for fail_activation in (False,True):
            with self.subTest(fail_activation=fail_activation),tempfile.TemporaryDirectory() as directory,patch('installer_upgrade_host.LinuxAdmissionGate',GATE),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                machine=UpgradeMachine(directory);tick=[0];original=[None];reject=[False];image_paths=set()
                def command(args,**kwargs):
                    nested=args[args.index('--')+1:] if args[0]=='runuser' else []
                    if nested[:1]==['podman']:
                        if facts:
                            # This fixture borrows the T2 image, never its ownership.
                            self.assertIn(tuple(nested[1:3]),[('image','exists'),('image','inspect'),('info','--format'),('ps','--all'),('images','--filter'),('images','--no-trunc'),('container','inspect')],nested)
                            machine.calls.append(args)
                            result=subprocess.run(nested,capture_output=True,text=True)
                        elif nested[1:3]==['info','--format']:
                            result=subprocess.CompletedProcess(args,0,json.dumps({'host':{'security':{'rootless':True},'cgroupVersion':'v2'},'store':{'graphRoot':'/images','imageCopyTmpDir':'/image-tmp'}}),'')
                        else:return machine.command(args,**kwargs)
                        if nested[1:3]==['info','--format']:
                            store=json.loads(result.stdout)['store']
                            image_paths.update(str(machine.root/path.lstrip('/')) for path in (store['graphRoot'],store['imageCopyTmpDir']))
                        return result
                    return machine.command(args,**kwargs)
                host=installer.Host(machine.root,command,system='Linux',machine='aarch64' if development else 'x86_64',uid=0);host.clock=lambda:tick[0]
                def request(*args,**kwargs):
                    if reject[0] and machine.running_target!=original[0]:tick[0]+=100;raise OSError('target readiness failed')
                    return b'login'
                host.request=request
                def bundle(version,commit):
                    args=machine.make_bundle(version,commit,architecture=architecture);manifest=with_image_identity(machine,args)
                    manifest.update(schema=2,compatibility={'protocol':3,'source':{'min':'0.1.16','maxExclusive':'0.1.19'},'accounts':{'sourceMin':5,'sourceMax':5,'target':5},'environmentEpoch':1},acceptancePolicy=POLICY,
                                    storage={key:1024 for key in ('platformArchiveBytes','platformExpandedBytes','imageDownloadBytes','imageExpandedBytes')},updater='{}')
                    if facts:
                        labels=facts['Config']['Labels'];manifest['dshRevision']=labels['dsh.revision']
                        manifest['image'].update(digest=facts['Digest'],reference=reference)
                        manifest['imageIdentity']={'inputHash':labels['dsh.input.sha256'],'dshRevision':labels['dsh.revision'],'digest':facts['Digest'],'buildCommit':labels['org.opencontainers.image.revision']}
                    (Path(args[3])/'manifest.json').write_text(json.dumps(manifest))
                    return [*args,*development],manifest
                args,source=bundle('v0.1.17-rc.1','a')
                self.assertEqual(installer.main(args,host),0);original[0]=machine.running_target
                data=machine.root/'var/lib/dsh-phalanx/data';data.mkdir()
                with sqlite3.connect(data/'community-accounts.db') as connection:connection.execute('PRAGMA user_version=5')
                (data/'keep').write_text('member data')
                args,target=bundle('v0.1.18-rc.1','d')
                self.assertNotEqual(source['commit'],target['commit']);self.assertEqual(source['imageIdentity'],target['imageIdentity'])
                machine.calls.clear()
                # Separate image volumes have no free bytes: reuse must require zero.
                probe=lambda path:('images',0) if str(path) in image_paths else ('platform',2**40)
                with patch('installer_upgrade_host.UpgradeStorage',side_effect=lambda h:UpgradeStorage(h,probe)):
                    with contextlib.redirect_stdout(output:=io.StringIO()):status=installer.main([*args,'--upgrade','prepare','--output','json'],host)
                    self.assertEqual(status,0,output.getvalue());job=json.loads(output.getvalue())['operation']
                    rows=[row for row in job['space']['locations'] if 'rootless image layers and import' in row['purposes']]
                    self.assertEqual(len(rows),1);self.assertEqual(rows[0]['requiredBytes'],0);self.assertEqual(rows[0]['availableBytes'],0)
                    self.assertEqual(machine.running_target,original[0]);reject[0]=fail_activation
                    with contextlib.redirect_stdout(output:=io.StringIO()):status=installer.main(['--upgrade','apply','--operation',job['id'],'--yes','--output','json',*development],host)
                self.assertEqual(status,1 if fail_activation else 0,output.getvalue())
                result=json.loads(output.getvalue())['operation']
                self.assertEqual(result['phase'],'restored' if fail_activation else 'succeeded')
                self.assertEqual(machine.running_target==original[0],fail_activation)
                self.assertEqual((data/'keep').read_text(),'member data')
                self.assertFalse(any('pull' in call or 'load' in call for call in machine.calls),machine.calls)
                inspections=[call for call in machine.calls if 'inspect' in call and 'podman' in call]
                self.assertGreaterEqual(sum(call[-1]==source['image']['reference'] for call in inspections),2)

if __name__=='__main__':unittest.main()
