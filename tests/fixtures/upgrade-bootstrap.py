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
from installer_contract_support import installer,with_image_identity
from installer_executor_install import installed_executor
from installer_compatibility import validate_contract

UpgradeMachine=runpy.run_path(str(Path(__file__).with_name('upgrade-machine.py')))['UpgradeMachine']
CONTRACT={'protocol':1,'source':{'min':'0.1.1','maxExclusive':'0.2.0'},'accounts':{'sourceMin':4,'sourceMax':4,'target':4},'environmentEpoch':1}
POLICY={'ticket':9,'checks':['ci','linux','cleanInstall','upgrade','review']}

class Bootstrap(unittest.TestCase):
    def test_bootstrap_verifies_small_commit_bound_files_and_only_restarts_updater(self):
        for corrupt,independent,version in ((False,False,'0.1.13'),(True,False,'0.1.13'),(False,True,'0.1.13'),(True,True,'0.1.13'),(False,False,'0.1.24'),(True,False,'0.1.24')):
            with self.subTest(corrupt=corrupt,independent=independent,version=version),tempfile.TemporaryDirectory() as directory:
                machine=UpgradeMachine(directory);host=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0);host.request=lambda *a,**k:b'login'
                args=machine.make_bundle('v0.1.12-rc.1');file=Path(args[3])/'manifest.json';manifest=json.loads(file.read_text());manifest.update(schema=2,compatibility=CONTRACT,acceptancePolicy=POLICY);file.write_text(json.dumps(manifest))
                if independent:with_image_identity(machine,args)
                with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):self.assertEqual(installer.main(args,host),0)
                original=machine.running_target;old_engine=installed_executor(host)
                data=machine.root/'var/lib/dsh-phalanx/data';data.mkdir()
                with sqlite3.connect(data/'community-accounts.db') as connection:connection.execute('PRAGMA user_version=4')
                args=machine.make_bundle('v'+version+'-rc.1','d','e');bundle=Path(args[3]);file=bundle/'manifest.json';target=json.loads(file.read_text())
                with tarfile.open(bundle/'dsh-phalanx-linux-amd64.tar.gz') as archive:
                    files={entry.name.removeprefix('updater/'):archive.extractfile(entry).read() for entry in archive if entry.name.startswith('updater/')}
                target.update(schema=2,compatibility={**CONTRACT,'protocol':3},acceptancePolicy=POLICY if version=='0.1.13' else {'ticket':9,'checks':['ci','linux','upgrade']},storage={key:1024 for key in ('platformArchiveBytes','platformExpandedBytes','imageDownloadBytes','imageExpandedBytes')},updater=files.pop('manifest.json').decode());file.write_text(json.dumps(target))
                updater_bytes=json.dumps({name:body.decode() for name,body in files.items()}).encode()
                target['updaterAsset']={'name':'updater.json','sha256':hashlib.sha256(updater_bytes).hexdigest()}
                file.write_text(json.dumps(target))
                # The two large assets are unavailable. Bootstrap must still work.
                for name in target['files']:(bundle/name).unlink()
                requests=[]
                def request(url,**kwargs):
                    if url.startswith('https://'):
                        self.assertEqual(url,'https://github.com/dake6767/dsh-phalanx/releases/download/v'+version+'-rc.1/updater.json')
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

    def test_bootstrap_can_replace_only_the_executor_for_an_authenticated_legacy_initialization_failure(self):
        from installer_executor_bootstrap import bootstrap_executor
        from installer_operations import JOURNAL,MARKER
        from types import SimpleNamespace
        import os,uuid
        scripts=Path(__file__).resolve().parents[2]/'scripts/install'
        names=json.loads((scripts/'executor-files.json').read_text())+['updater.service.in','executor-files.json']
        files={name:(scripts/name).read_text() for name in names}
        raw=json.dumps({'schema':1,'sourceCommit':'d'*40,'files':{name:hashlib.sha256(text.encode()).hexdigest() for name,text in files.items()}})
        body=json.dumps(files).encode()
        target={'version':'v0.1.33','manifest':{'schema':2,'commit':'d'*40,'targetVersion':'0.1.33','compatibility':{**CONTRACT,'protocol':3},'storage':{key:1024 for key in ('platformArchiveBytes','platformExpandedBytes','imageDownloadBytes','imageExpandedBytes')},'updater':raw,'updaterAsset':{'name':'updater.json','sha256':hashlib.sha256(body).hexdigest()}}}
        for scenario in ('legacy','foreign-marker','new-job','initialized','changed-source'):
            with self.subTest(scenario=scenario),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);calls=[]
                source={'uid':os.geteuid(),'gid':os.getegid(),'target':str(root/'release'),'values':{'DSH_PHALANX_DATA_ROOT':'/data','DSH_PHALANX_DATABASE_CONFIG_FILE':'/keys/database.json'}}
                (root/'release').mkdir();(root/'release/start').touch()
                marker='legacy marker\n';job={'schema':1,'id':str(uuid.uuid4()),'action':'master-key-rotate','phase':'working','source':source,'deploymentId':'deployment-fixture','configFile':'/keys/database.json','marker':marker}
                if scenario=='new-job':job['rotationCheck']={}
                if scenario=='changed-source':job['source']={**source,'target':'/different'}
                def command(args,**kwargs):
                    calls.append(args)
                    if kwargs.get('stdin'):
                        self.assertEqual(json.load(kwargs['stdin'])['fact'],'rotation')
                        ready=scenario=='initialized'
                        return SimpleNamespace(returncode=0,stdout=json.dumps({'ready':ready,'initializationPending':not ready,'deploymentId':'deployment-fixture','fingerprint':'sha256:'+'f'*64,'identity':[]}),stderr='')
                    return SimpleNamespace(returncode=0,stdout='',stderr='')
                host=installer.Host(root,command,system='Linux',machine='x86_64',uid=0)
                host.atomic(JOURNAL,json.dumps(job)+'\n');host.atomic(MARKER,'foreign' if scenario=='foreign-marker' else marker,0o644)
                original={path:host.path(path).read_bytes() for path in (JOURNAL,MARKER)}
                host.request=lambda *args,**kwargs:body
                class Port:
                    def check_fresh_install(self,target):pass
                    def operation(self):return None
                    def source(self):return source
                    def check_compatibility(self,*args):pass
                    def verify_source(self,*args):raise AssertionError('The old platform is stopped')
                with tempfile.TemporaryDirectory(dir=root) as temporary:
                    if scenario=='legacy':
                        result=bootstrap_executor(host,Port(),target,Path(temporary))
                        self.assertEqual(result['sourceCommit'],'d'*40)
                    else:
                        with self.assertRaises(installer.InstallError):bootstrap_executor(host,Port(),target,Path(temporary))
                self.assertEqual({path:host.path(path).read_bytes() for path in (JOURNAL,MARKER)},original)
                self.assertFalse(any('stop' in call or 'pull' in call or 'load' in call for call in calls))

    def test_capacity_protocol_requires_finite_positive_storage_before_preparation(self):
        base={'schema':2,'targetVersion':'0.1.13','compatibility':{**CONTRACT,'protocol':3},'acceptancePolicy':POLICY,'updater':'{}'}
        for value in (None,{}, {'platformArchiveBytes':0}, {'platformArchiveBytes':float('nan')}):
            with self.subTest(value=value),self.assertRaises(installer.InstallError):validate_contract({**base,'storage':value})

    def _write_executor_package(self, directory, declared, *, commit='a'*40, extra_files=None, syntax_error=None, symlink_name=None, corrupt_name=None):
        directory=Path(directory);directory.mkdir(parents=True,exist_ok=True)
        files={'updater.service.in':'[Service]\nUser=@UID@\nGroup=@GID@\n','executor-files.json':json.dumps(declared)}
        for name in declared:
            if name not in files:
                files[name]='def broken(:\n' if name==syntax_error else '# verified executor module\nVALUE = 1\n'
        for name,text in files.items():
            path=directory/name
            if name==symlink_name:
                target=directory.parent/(name+'.outside');target.write_text(text);path.symlink_to(target)
            else:
                path.write_text(text)
        manifest_files={name:hashlib.sha256(text.encode()).hexdigest() for name,text in files.items()}
        if corrupt_name:
            manifest_files[corrupt_name]='0'*64
        if extra_files:
            for name,text in extra_files.items():
                (directory/name).write_text(text)
        manifest={'schema':1,'sourceCommit':commit,'files':manifest_files}
        (directory/'manifest.json').write_text(json.dumps(manifest))
        return files,manifest

    def test_executor_package_accepts_legacy_current_and_expanded_whitelisted_inventories(self):
        from installer_executor_install import executor_package
        scripts=Path(__file__).resolve().parents[2]/'scripts/install'
        current_modules=json.loads((scripts/'executor-files.json').read_text())
        legacy_subset=['updater.py','installer_executor.py','installer_host.py','installer_upgrade_gate.py']
        expanded_26=[*current_modules,'installer_split_alpha.py','installer_split_beta.py','installer_split_gamma.py']
        max_62=['updater.py',*[f'installer_mod_{chr(97+i//26)}_{chr(97+i%26)}.py' for i in range(61)]]
        for label,declared in (('legacy',legacy_subset),('current',current_modules),('expanded-26',expanded_26),('cap-64',max_62)):
            with self.subTest(label=label),tempfile.TemporaryDirectory() as directory:
                package=Path(directory)/'updater'
                self._write_executor_package(package,declared,commit='b'*40)
                identity=executor_package(package,'b'*40)
                self.assertEqual(identity['sourceCommit'],'b'*40)
                self.assertEqual(len(identity['packageSha256']),64)

    def test_executor_package_rejects_disallowed_names_mismatch_cap_symlinks_checksum_and_syntax(self):
        from installer_executor_install import executor_package
        base=['updater.py','installer_host.py']
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            # Disallowed module names & malformed declared lists
            for label,declared in (
                ('empty',[]),
                ('missing-updater',['installer_host.py']),
                ('duplicate',['updater.py','installer_host.py','installer_host.py']),
                ('non-installer-name',['updater.py','helper.py']),
                ('uppercase',['updater.py','installer_Host.py']),
                ('digits',['updater.py','installer_mod1.py']),
                ('path-traversal',['updater.py','../installer_host.py']),
                ('over-cap-65',['updater.py',*[f'installer_mod_{chr(97+i//26)}_{chr(97+i%26)}.py' for i in range(62)]]),
            ):
                with self.subTest(label=label):
                    package=root/label
                    if label=='path-traversal':
                        package.mkdir()
                        files={'updater.service.in':'x','executor-files.json':json.dumps(declared),'updater.py':'VALUE=1\n'}
                        for name,text in files.items():(package/name).write_text(text)
                        manifest={'schema':1,'sourceCommit':'c'*40,'files':{name:hashlib.sha256(text.encode()).hexdigest() for name,text in files.items()}}
                        (package/'manifest.json').write_text(json.dumps(manifest))
                    else:
                        self._write_executor_package(package,declared,commit='c'*40)
                    with self.assertRaises(installer.InstallError):executor_package(package,'c'*40)
            # Extra file on disk
            extra_dir=root/'extra-file'
            self._write_executor_package(extra_dir,base,commit='c'*40,extra_files={'stray.txt':'nope'})
            with self.assertRaises(installer.InstallError):executor_package(extra_dir,'c'*40)
            # Manifest missing a declared module
            missing_dir=root/'missing-manifest-entry'
            files,_=self._write_executor_package(missing_dir,base,commit='c'*40)
            reduced={name:hashlib.sha256(text.encode()).hexdigest() for name,text in files.items() if name!='installer_host.py'}
            (missing_dir/'manifest.json').write_text(json.dumps({'schema':1,'sourceCommit':'c'*40,'files':reduced}))
            with self.assertRaises(installer.InstallError):executor_package(missing_dir,'c'*40)
            # Symlinked module & symlinked executor-files.json
            for name in ('installer_host.py','executor-files.json'):
                with self.subTest(symlink=name):
                    sym_dir=root/('sym-'+name)
                    self._write_executor_package(sym_dir,base,commit='c'*40,symlink_name=name)
                    with self.assertRaises(installer.InstallError):executor_package(sym_dir,'c'*40)
            # Checksum mismatch
            bad_hash_dir=root/'bad-hash'
            self._write_executor_package(bad_hash_dir,base,commit='c'*40,corrupt_name='installer_host.py')
            with self.assertRaises(installer.InstallError):executor_package(bad_hash_dir,'c'*40)
            # Boolean schema: true must be rejected (True == 1 in Python)
            bool_schema_dir=root/'bool-schema'
            files,_=self._write_executor_package(bool_schema_dir,base,commit='c'*40)
            (bool_schema_dir/'manifest.json').write_text(json.dumps({'schema':True,'sourceCommit':'c'*40,'files':{name:hashlib.sha256(text.encode()).hexdigest() for name,text in files.items()}}))
            with self.assertRaises(installer.InstallError):executor_package(bool_schema_dir,'c'*40)
            # Syntax error in a module
            bad_syntax_dir=root/'bad-syntax'
            self._write_executor_package(bad_syntax_dir,base,commit='c'*40,syntax_error='installer_host.py')
            with self.assertRaises(SyntaxError):executor_package(bad_syntax_dir,'c'*40)

    def test_bootstrap_executor_accepts_future_expanded_inventory_and_rejects_disallowed_manifest(self):
        from installer_executor_bootstrap import bootstrap_executor
        from types import SimpleNamespace
        import os
        scripts=Path(__file__).resolve().parents[2]/'scripts/install'
        current_modules=json.loads((scripts/'executor-files.json').read_text())
        future_modules=[*current_modules,'installer_future_split.py']
        files={name:(scripts/name).read_text() for name in current_modules+['updater.service.in']}
        files['installer_future_split.py']='# future split module\nREADY = True\n'
        files['executor-files.json']=json.dumps(future_modules)
        raw=json.dumps({'schema':1,'sourceCommit':'e'*40,'files':{name:hashlib.sha256(text.encode()).hexdigest() for name,text in files.items()}})
        body=json.dumps(files).encode()
        target={'version':'v0.1.44','manifest':{'schema':2,'commit':'e'*40,'targetVersion':'0.1.44','compatibility':{**CONTRACT,'protocol':3},'storage':{key:1024 for key in ('platformArchiveBytes','platformExpandedBytes','imageDownloadBytes','imageExpandedBytes')},'updater':raw,'updaterAsset':{'name':'updater.json','sha256':hashlib.sha256(body).hexdigest()}}}
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            source={'uid':os.geteuid(),'gid':os.getegid(),'target':str(root/'release'),'values':{'DSH_PHALANX_DATA_ROOT':'/data'}}
            host=installer.Host(root,lambda args,**kwargs:SimpleNamespace(returncode=0,stdout='',stderr=''),system='Linux',machine='x86_64',uid=0)
            host.request=lambda *args,**kwargs:body
            class Port:
                def check_fresh_install(self,target):pass
                def operation(self):return None
                def source(self):return source
                def check_compatibility(self,*args):pass
                def verify_source(self,*args):pass
            with tempfile.TemporaryDirectory(dir=root) as temporary:
                result=bootstrap_executor(host,Port(),target,Path(temporary))
                self.assertEqual(result['sourceCommit'],'e'*40)
                self.assertTrue((host.path('/opt/dsh-phalanx/updater')/'installer_future_split.py').is_file())
            # Reject disallowed filename in manifest['updater'] before any download
            bad_files={**files,'../escape.py':'evil=1\n'}
            bad_raw=json.dumps({'schema':1,'sourceCommit':'e'*40,'files':{name:hashlib.sha256(text.encode()).hexdigest() for name,text in bad_files.items()}})
            bad_target=copy.deepcopy(target);bad_target['manifest']['updater']=bad_raw
            downloaded=[]
            host.request=lambda *args,**kwargs:(downloaded.append(args),body)[1]
            with tempfile.TemporaryDirectory(dir=root) as temporary,self.assertRaises(installer.InstallError):
                bootstrap_executor(host,Port(),bad_target,Path(temporary))
            self.assertEqual(downloaded,[])

if __name__=='__main__':unittest.main()
