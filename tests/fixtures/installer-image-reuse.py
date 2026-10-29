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
import time
import unittest
from unittest.mock import patch
from installer_contract_support import installer,with_image_identity
from installer_storage import UpgradeStorage
from installer_release import verify_candidate_assets

UpgradeMachine=runpy.run_path(str(Path(__file__).with_name('upgrade-machine.py')))['UpgradeMachine']
GATE=type('Gate',(),{'preflight':lambda self,ports:None,'install':lambda self,host,uid:None,'close':lambda self,ports:None,'open':lambda self:None})
POLICY={'ticket':8,'checks':['ci','linux','cleanInstall','upgrade','review']}


class ImageReuse(unittest.TestCase):
    def test_successful_upgrade_and_failed_activation_restore_share_one_image(self):
        pair=[os.environ.get('DSH_PHALANX_REUSE_SOURCE'),os.environ.get('DSH_PHALANX_REUSE_TARGET')]
        if any(pair):self.assertTrue(all(pair),'Both candidate bundles are required')
        actual_pair=all(pair)
        reference=os.environ.get('DSH_PHALANX_REUSE_TEST_IMAGE')
        if actual_pair:self.assertTrue(reference,'Candidate rehearsal requires a real rootless image')
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
        phases=[]
        for fail_activation in (False,True):
            with self.subTest(fail_activation=fail_activation),tempfile.TemporaryDirectory() as directory,patch('installer_upgrade_host.LinuxAdmissionGate',GATE),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()),contextlib.ExitStack() as cleanup:
                Machine=runpy.run_path(str(Path(__file__).with_name('candidate-reuse-machine.py')))['CandidateMachine'] if actual_pair else UpgradeMachine
                machine=Machine(directory);machine.database_schema=5
                if actual_pair:cleanup.callback(machine.close)
                tick=[0];original=[None];reject=[False];image_paths=set()
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
                host=installer.Host(machine.root,command,system='Linux',machine='aarch64' if development else 'x86_64',uid=0);host.clock=lambda:time.monotonic()+tick[0]
                actual_request=host.request
                def request(*args,**kwargs):
                    if reject[0] and machine.running_target!=original[0]:tick[0]+=100;raise OSError('target readiness failed')
                    if actual_pair:
                        kwargs.pop('socket_mark',None)
                        return actual_request(*args,**kwargs)
                    return b'login'
                host.request=request
                def bundle(version,commit):
                    if actual_pair:
                        directory=Path(pair[0 if commit=='a' else 1]).resolve()
                        manifest=json.loads((directory/'manifest.json').read_text())
                        self.assertTrue(manifest['imageSelection']['rehearsal'])
                        self.assertEqual(manifest['image']['reference'],reference)
                        installer.verify_manifest(directory,manifest['tag'])
                        if commit=='a':
                            raw=(directory/'manifest.json').read_bytes()
                            verify_candidate_assets(type('Assets',(),{'request':lambda self,url,**kwargs:(directory/url.rsplit('/',1)[1]).read_bytes()})(), 'https://github.com/dake6767/dsh-phalanx-candidates/releases/download/'+manifest['tag']+'/',manifest,raw)
                        args=['--version',manifest['tag'],'--bundle-dir',str(directory),'--model-key-file',str(machine.root/'model-key'),
                              '--host-public-addresses','','--listen-address','127.0.0.1','--port',str(machine.port),'--gateway-port',str(machine.gateway),
                              '--public-origin',f'http://127.0.0.1:{machine.port}','--dev-image-reuse-rehearsal']
                        return args,manifest
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
                data=machine.root/'var/lib/dsh-phalanx/data';data.mkdir(exist_ok=True)
                with sqlite3.connect(data/'community-accounts.db') as connection:
                    if actual_pair:self.assertEqual(connection.execute('PRAGMA user_version').fetchone()[0],5)
                    else:connection.execute('PRAGMA user_version=5')
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
                    with contextlib.redirect_stdout(output:=io.StringIO()):status=installer.main(['--upgrade','apply','--operation',job['id'],'--yes','--output','json',*development,*(['--dev-image-reuse-rehearsal'] if actual_pair else [])],host)
                self.assertEqual(status,1 if fail_activation else 0,output.getvalue())
                result=json.loads(output.getvalue())['operation']
                self.assertEqual(result['phase'],'restored' if fail_activation else 'succeeded');phases.append(result['phase'])
                self.assertEqual(machine.running_target==original[0],fail_activation)
                self.assertEqual((data/'keep').read_text(),'member data')
                self.assertFalse(any('pull' in call or 'load' in call for call in machine.calls),machine.calls)
                inspections=[call for call in machine.calls if 'inspect' in call and 'podman' in call]
                self.assertGreaterEqual(sum(call[-1]==source['image']['reference'] for call in inspections),2)
                if actual_pair:machine.close()

        if actual_pair:print(json.dumps({'source':{'candidate':source['tag'],'commit':source['commit'],'files':source['files']},'target':{'candidate':target['tag'],'commit':target['commit'],'files':target['files']},'imageDigest':source['image']['digest'],'phases':phases,'imageTransfers':0,'imageCapacityBytes':0}))

if __name__=='__main__':unittest.main()
