"""Public cleanup adoption preserves references and independently retries disposal."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from types import ModuleType
from unittest.mock import patch
from installer_contract_support import installer,with_image_identity
UpgradeMachine=runpy.run_path(str(Path(__file__).with_name('upgrade-machine.py')))['UpgradeMachine']
CONTRACT={'protocol':1,'source':{'min':'0.1.1','maxExclusive':'0.2.0'},'accounts':{'sourceMin':4,'sourceMax':4,'target':4},'environmentEpoch':1}
POLICY={'ticket':10,'checks':['ci','linux','cleanInstall','upgrade','review']}
GATE=type('GatePort',(),{'preflight':lambda self,ports:None,'install':lambda self,host,uid,program=None:None,'close':lambda self,ports:None,'open':lambda self:None})

class CleanupMachine(UpgradeMachine):
    def __init__(self,root):
        super().__init__(root);self.containers=[];self.removed=[];self.interrupt=False
        self.graph=self.root/'images';self.graph.mkdir();(self.graph/'shared').write_bytes(bytes(65536))
    def make_bundle(self,*args):
        result=super().make_bundle(*args)
        self.image_facts['GraphDriver']={'Name':'overlay','Data':{'UpperDir':'/images/'+self.image_facts['Digest'][7:]}}
        self.image_facts.update(Id=self.image_facts['Digest'][7:],RepoTags=['ghcr.io/dake6767/dsh-phalanx:'+args[0][1:]],Size=999_000_000_000)
        return result
    def command(self,args,**kwargs):
        nested=args[args.index('--')+1:] if args[0]=='runuser' else []
        output=None
        if nested[:2]==['podman','ps']:output=json.dumps(self.containers)
        elif nested[:3]==['podman','container','inspect']:
            row=next(row for row in self.containers if row['Id']==nested[-1]);output=json.dumps([{'Id':row['Id'],'Image':row['ImageID'],'Mounts':row.get('Mounts',[])}])
        elif nested[:2]==['podman','images']:
            images=list(self.images.values())
            if '--filter' in nested:
                key,value=nested[nested.index('--filter')+1].removeprefix('label=').split('=',1)
                images=[image for image in images if image['Config']['Labels'].get(key)==value]
            output='\n'.join(('sha256:' if getattr(self,'prefixed_ids',False) else '')+image['Id'] for image in images)+'\n'
        elif nested[:3]==['podman','info','--format']:
            output=json.dumps({'host':{'security':{'rootless':True},'cgroupVersion':'v2'},'store':{'graphRoot':'/images','imageCopyTmpDir':'/image-tmp'}})
        elif nested[:3]==['podman','image','inspect']:
            matches=[image for ref,image in self.images.items() if nested[-1] in (ref,image['Id'])]
            if matches:output=json.dumps(matches)
        elif nested[:2]==['podman','untag']:
            image=next(image for image in self.images.values() if image['Id']==nested[2])
            image['RepoTags']=[tag for tag in image['RepoTags'] if tag not in nested[3:]];output=''
        elif nested[:2]==['podman','rmi']:
            assert '--force' not in nested
            identity=nested[-1];assert identity not in [item['ImageID'] for item in self.containers]
            key=next(key for key,image in self.images.items() if image['Id']==identity)
            if len(self.images[key]['RepoTags'])>1:raise OSError('image has multiple names')
            if self.interrupt:self.interrupt=False;raise KeyboardInterrupt('interrupted before image deletion')
            del self.images[key];(self.graph/identity).unlink();self.removed.append(identity);output=identity
        if output is not None:self.calls.append(args);return subprocess.CompletedProcess(args,0,output,'')
        result=super().command(args,**kwargs)
        if nested[:2] in (['podman','load'],['podman','pull']):(self.graph/self.image['Id']).write_bytes(bytes(131072))
        return result

def install_history(machine,host,entry=installer,*,run_addressed=False):
    manifests=[];targets=[]
    for index,(version,identity) in enumerate([(9,'a'),(10,'b'),(11,'c'),(12,'d')]):
        args=machine.make_bundle('v0.1.'+str(version)+'-rc.1',identity,identity)
        path=Path(args[3])/'manifest.json';manifest=json.loads(path.read_text());manifest.update(schema=2,compatibility=CONTRACT,acceptancePolicy=POLICY)
        if run_addressed:
            manifest.update(tag='run-'+str(version),runId=str(version));manifest['image']['tag']=manifest['tag'];args[1]=manifest['tag']
            machine.image_facts['RepoTags']=['ghcr.io/dake6767/dsh-phalanx:'+manifest['tag']]
        path.write_text(json.dumps(manifest));manifests.append(manifest)
        with contextlib.redirect_stdout(output:=io.StringIO()):status=entry.main([*args,'--yes','--output','json'],host)
        assert status==0,output.getvalue()
        targets.append(Path(machine.running_target))
        if index==0:
            data=machine.root/'var/lib/dsh-phalanx/data';data.mkdir()
            with sqlite3.connect(data/'community-accounts.db') as connection:connection.execute('PRAGMA user_version=4')
            (data/'keep').write_text('live user data')
    return manifests,targets,data


class Cleanup(unittest.TestCase):
    def test_independent_image_history_uses_the_same_ownership_and_protection_rules(self):
        class IndependentMachine(CleanupMachine):
            def make_bundle(self,*args):
                result=super().make_bundle(*args);with_image_identity(self,result);return result
        with tempfile.TemporaryDirectory() as temporary,patch('installer_upgrade_host.LinuxAdmissionGate',GATE),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            machine=IndependentMachine(temporary);host=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0);host.request=lambda *a,**k:b'login'
            _,targets,data=install_history(machine,host)
            with contextlib.redirect_stdout(output:=io.StringIO()):status=installer.main(['--upgrade','cleanup','--output','json'],host)
            self.assertEqual(status,0,output.getvalue());self.assertEqual(machine.removed,['a'*64,'b'*64])
            self.assertTrue(targets[2].exists());self.assertTrue(targets[3].exists())
            self.assertEqual((data/'keep').read_text(),'live user data')


    def test_run_candidate_history_reclaims_owned_images_and_preserves_current_and_previous(self):
        with tempfile.TemporaryDirectory() as temporary,patch('installer_upgrade_host.LinuxAdmissionGate',GATE),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            machine=CleanupMachine(temporary);host=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0);host.request=lambda *a,**k:b'login'
            _,targets,data=install_history(machine,host,run_addressed=True)
            with contextlib.redirect_stdout(out:=io.StringIO()):status=installer.main(['--upgrade','cleanup','--output','json'],host)
            self.assertEqual(status,0,out.getvalue())
            self.assertFalse(targets[0].exists());self.assertFalse(targets[1].exists())
            self.assertTrue(targets[2].exists());self.assertTrue(targets[3].exists())
            self.assertEqual(machine.removed,['a'*64,'b'*64])
            self.assertEqual((data/'keep').read_text(),'live user data')

    def test_standalone_generated_installer_cleans_the_same_verified_history(self):
        source=Path(__file__).resolve().parents[2]/'install.sh'
        embedded=ModuleType('standalone_installer');embedded.__file__=str(source)
        body=source.read_text().split("<<'DSH_PHALANX_INSTALLER_PYTHON'\n",1)[1].rsplit('\nDSH_PHALANX_INSTALLER_PYTHON',1)[0]
        exec(compile(body,str(source),'exec'),embedded.__dict__)
        class ContractHost(embedded.Host):
            def terminal_available(self):return False
            def port_conflict(self,*args,**kwargs):return None
        with tempfile.TemporaryDirectory() as temporary,patch.object(embedded,'LinuxAdmissionGate',GATE),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            machine=CleanupMachine(temporary);host=ContractHost(machine.root,machine.command,system='Linux',machine='x86_64',uid=0);host.request=lambda *a,**k:b'login'
            _,targets,data=install_history(machine,host,embedded);original=machine.running_target;machine.calls.clear()
            with contextlib.redirect_stdout(out:=io.StringIO()):status=embedded.main(['--upgrade','cleanup','--output','json'],host)
            self.assertEqual(status,0,out.getvalue());job=json.loads(out.getvalue())['operation']
            self.assertEqual(job['phase'],'succeeded');self.assertEqual(job['cleanup']['status'],'succeeded')
            self.assertFalse(targets[0].exists());self.assertFalse(targets[1].exists())
            self.assertTrue(targets[2].exists());self.assertTrue(targets[3].exists())
            self.assertEqual((data/'keep').read_text(),'live user data');self.assertEqual(machine.running_target,original)
            self.assertFalse(any('stop' in call or '--force' in call or 'prune' in call for call in machine.calls))

    def test_public_first_adoption_retains_current_previous_containers_backups_and_unknowns(self):
        with tempfile.TemporaryDirectory() as temporary,patch('installer_upgrade_host.LinuxAdmissionGate',GATE),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            machine=CleanupMachine(temporary);host=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0);host.request=lambda *a,**k:b'login'
            manifests,targets,data=install_history(machine,host);machine.prefixed_ids=True
            graph=machine.graph;unknown=graph/'unknown';unknown.write_bytes(bytes(4096))
            machine.containers=[{'Id':'1'*64,'ImageID':'b'*64,'State':'exited','Mounts':[{'Source':str(targets[1]),'Destination':'/previous-program'}]}]
            releases=targets[0].parent;unowned=releases/'not-managed';unowned.mkdir();(unowned/'keep').write_text('unknown program')
            cache=machine.root/'var/cache/dsh-phalanx';cache.mkdir(parents=True,exist_ok=True)
            old_archive=cache/(manifests[0]['files']['dsh-phalanx-linux-amd64.tar.gz']+'.tar.gz')
            shutil.copyfile(machine.root/'inputs-v0.1.9-rc.1/dsh-phalanx-linux-amd64.tar.gz',old_archive)
            mounted_archive=cache/(manifests[1]['files']['dsh-phalanx-linux-amd64.tar.gz']+'.tar.gz')
            shutil.copyfile(machine.root/'inputs-v0.1.10-rc.1/dsh-phalanx-linux-amd64.tar.gz',mounted_archive)
            machine.containers[0]['Mounts'].append({'Source':str(mounted_archive),'Destination':'/archive'})
            (cache/'keep').write_text('unknown cache')
            journal=machine.root/'var/lib/dsh-phalanx-updater';operation=(journal/'current').read_text().strip()
            backups={str(path):path.read_bytes() for path in journal.rglob('backup/data/keep')};self.assertTrue(backups)
            original=machine.running_target;machine.calls.clear()
            with contextlib.redirect_stdout(output:=io.StringIO()):status=installer.main(['--upgrade','cleanup','--operation',operation,'--output','json'],host)
            self.assertEqual(status,0,output.getvalue());job=json.loads(output.getvalue())['operation']
            self.assertEqual(job['phase'],'succeeded');self.assertEqual(job['cleanup']['status'],'succeeded')
            self.assertEqual(machine.removed,['a'*64]);self.assertEqual(machine.running_target,original)
            self.assertFalse(targets[0].exists());self.assertTrue(targets[1].exists())
            self.assertTrue(targets[2].exists());self.assertTrue(targets[3].exists());self.assertTrue(unowned.exists())
            self.assertFalse(old_archive.exists());self.assertTrue(mounted_archive.exists());self.assertTrue((cache/'keep').exists());self.assertTrue(unknown.exists())
            self.assertEqual((data/'keep').read_text(),'live user data')
            for path,body in backups.items():self.assertEqual(Path(path).read_bytes(),body)
            self.assertFalse(any('stop' in command or '--force' in command or 'prune' in command for command in machine.calls))
            # Concurrent filesystem writers can consume freed blocks before the second measurement.
            self.assertGreaterEqual(job['cleanup']['reclaimedBytes'],0);self.assertLess(job['cleanup']['reclaimedBytes'],20*1024*1024)

    def test_independent_retry_preserves_committed_data_and_reports_failure(self):
        with tempfile.TemporaryDirectory() as temporary,patch('installer_upgrade_host.LinuxAdmissionGate',GATE),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            machine=CleanupMachine(temporary);host=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0);host.request=lambda *a,**k:b'login'
            _,targets,data=install_history(machine,host)
            original=machine.running_target;machine.calls.clear();command=machine.command
            def failure(args,**kwargs):
                if 'rmi' in args:raise OSError('temporary storage failure')
                return command(args,**kwargs)
            host.command=failure
            with contextlib.redirect_stdout(out:=io.StringIO()):status=installer.main(['--upgrade','cleanup','--output','json'],host)
            self.assertEqual(status,1);job=json.loads(out.getvalue())['operation']
            self.assertEqual(job['phase'],'succeeded');self.assertEqual(job['cleanup']['status'],'failed')
            (data/'keep').write_text('new write after upgrade');host.command=command
            with contextlib.redirect_stdout(out:=io.StringIO()):status=installer.main(['--upgrade','cleanup','--output','json'],host)
            self.assertEqual(status,0);self.assertEqual(json.loads(out.getvalue())['operation']['cleanup']['status'],'succeeded')
            journal=machine.root/'var/lib/dsh-phalanx-updater';receipts=[json.loads(path.read_text()) for path in journal.glob('*/cleanup-*.json')]
            self.assertTrue(any(value['status']=='failed' for value in receipts));self.assertTrue(any(value['status']=='succeeded' for value in receipts))
            self.assertEqual((data/'keep').read_text(),'new write after upgrade');self.assertEqual(machine.running_target,original)
            self.assertFalse(any('stop' in call or '--force' in call or 'prune' in call for call in machine.calls))

    def test_corrupt_history_fails_closed_before_any_disposal(self):
        with tempfile.TemporaryDirectory() as temporary,patch('installer_upgrade_host.LinuxAdmissionGate',GATE),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            machine=CleanupMachine(temporary);host=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0);host.request=lambda *a,**k:b'login'
            _,targets,_=install_history(machine,host)
            journal=machine.root/'var/lib/dsh-phalanx-updater';current=(journal/'current').read_text().strip()
            other=next(path for path in journal.glob('*/operation.json') if path.parent.name!=current);other.write_text('{incomplete')
            with contextlib.redirect_stdout(out:=io.StringIO()):status=installer.main(['--upgrade','cleanup','--output','json'],host)
            self.assertEqual(status,1);self.assertTrue(all(path.exists() for path in targets));self.assertEqual(machine.removed,[])
            self.assertEqual(json.loads(out.getvalue())['operation']['phase'],'succeeded')

    def test_active_process_and_foreign_image_names_remain_while_owned_aliases_are_reclaimed(self):
        with tempfile.TemporaryDirectory() as temporary,patch('installer_upgrade_host.LinuxAdmissionGate',GATE),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            machine=CleanupMachine(temporary);host=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0);host.request=lambda *a,**k:b'login'
            _,targets,_=install_history(machine,host)
            proc=machine.root/'proc/998';proc.mkdir();(proc/'cwd').symlink_to(targets[0]);(proc/'exe').symlink_to(targets[0]/'node/bin/node')
            for image in machine.images.values():
                if image['Id']=='a'*64:image['RepoTags'].append('ghcr.io/dake6767/dsh-phalanx:0.1.9')
                if image['Id']=='b'*64:image['RepoTags'].append('localhost/another-service:keep')
            with contextlib.redirect_stdout(out:=io.StringIO()):status=installer.main(['--upgrade','cleanup','--output','json'],host)
            self.assertEqual(status,0,out.getvalue());self.assertTrue(targets[0].exists());self.assertFalse(targets[1].exists())
            self.assertEqual(machine.removed,['a'*64]);self.assertTrue((machine.graph/'shared').exists())
            self.assertIn('another-service:keep',json.dumps(list(machine.images.values())))

    def test_interrupted_cleanup_retries_without_reapplying_committed_update(self):
        with tempfile.TemporaryDirectory() as temporary,patch('installer_upgrade_host.LinuxAdmissionGate',GATE),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            machine=CleanupMachine(temporary);host=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0);host.request=lambda *a,**k:b'login'
            _,_,data=install_history(machine,host);machine.interrupt=True;machine.calls.clear()
            installer.main(['--upgrade','cleanup','--output','json'],host)
            journal=machine.root/'var/lib/dsh-phalanx-updater';file=journal/(journal/'current').read_text().strip()/'operation.json';job=json.loads(file.read_text())
            self.assertEqual(job['phase'],'succeeded');self.assertEqual(job['cleanup']['status'],'running')
            (data/'keep').write_text('write after interruption')
            with contextlib.redirect_stdout(out:=io.StringIO()):status=installer.main(['--upgrade','cleanup','--output','json'],host)
            self.assertEqual(status,0,out.getvalue());self.assertEqual((data/'keep').read_text(),'write after interruption')
            self.assertFalse(any('stop' in call for call in machine.calls))

    def test_protocol_three_cleans_before_capacity_blocks_without_stopping_service(self):
        with tempfile.TemporaryDirectory() as temporary,patch('installer_upgrade_host.LinuxAdmissionGate',GATE),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            machine=CleanupMachine(temporary);host=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0);host.request=lambda *a,**k:b'login'
            _,targets,_=install_history(machine,host);original=machine.running_target
            args=machine.make_bundle('v0.1.13-rc.1','e','e');file=Path(args[3])/'manifest.json';manifest=json.loads(file.read_text())
            manifest.update(schema=2,compatibility={**CONTRACT,'protocol':3},acceptancePolicy=POLICY,storage={key:1024 for key in ('platformArchiveBytes','platformExpandedBytes','imageDownloadBytes','imageExpandedBytes')},updater='{}');file.write_text(json.dumps(manifest));machine.calls.clear()
            from installer_storage import UpgradeStorage
            def probe(path):
                self.assertFalse(targets[0].exists());self.assertFalse(targets[1].exists())
                return ('root',0)
            with patch('installer_upgrade_host.UpgradeStorage',side_effect=lambda h:UpgradeStorage(h,probe)),contextlib.redirect_stdout(out:=io.StringIO()):status=installer.main([*args,'--upgrade','prepare','--output','json'],host)
            self.assertEqual(status,1,out.getvalue());job=json.loads(out.getvalue())['operation']
            self.assertEqual(job['phase'],'prepare-failed');self.assertFalse(job['space']['sufficient'])
            self.assertEqual(job['cleanup']['status'],'succeeded');self.assertEqual(machine.running_target,original)
            self.assertTrue(targets[2].exists());self.assertTrue(targets[3].exists())
            self.assertFalse(any('stop' in call or 'load' in call or 'pull' in call for call in machine.calls))

    def test_enumeration_failure_receipt_remains_after_successful_retry(self):
        with tempfile.TemporaryDirectory() as temporary,patch('installer_upgrade_host.LinuxAdmissionGate',GATE),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            machine=CleanupMachine(temporary);host=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0);host.request=lambda *a,**k:b'login'
            install_history(machine,host);command=machine.command
            def failed(args,**kwargs):
                if 'podman' in args and 'ps' in args:raise OSError('container inventory unavailable')
                return command(args,**kwargs)
            host.command=failed
            self.assertEqual(installer.main(['--upgrade','cleanup','--output','json'],host),1)
            host.command=command
            self.assertEqual(installer.main(['--upgrade','cleanup','--output','json'],host),0)
            receipts=[json.loads(path.read_text()) for path in (machine.root/'var/lib/dsh-phalanx-updater').glob('*/cleanup-*.json')]
            self.assertTrue(any(value['status']=='failed' and 'container inventory unavailable' in value.get('failure','') for value in receipts))

if __name__=='__main__':unittest.main()
