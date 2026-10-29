"""Resume a verified built bundle without compiling or adopting a residual deployment."""
import hashlib,io,json,os,runpy,subprocess,tarfile,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

module=runpy.run_path('scripts/dev/guest.py')

class ResumeInstallation(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup)
        self.root=Path(self.temporary.name);self.source=self.root/'source';self.source.mkdir();self.bundle=self.root/'bundle';self.bundle.mkdir()
        self.config=self.root/'etc';self.config.mkdir();self.home=self.root/'home';self.home.mkdir();(self.home/'data').mkdir()
        self.original='a'*40
        subprocess.run(['git','init','-q',self.source],check=True)
        (self.source/'fixture').write_text('built input')
        subprocess.run(['git','-C',self.source,'add','.'],check=True)
        subprocess.run(['git','-C',self.source,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Local development snapshot of '+self.original],check=True)
        self.snapshot=subprocess.check_output(['git','-C',self.source,'rev-parse','HEAD'],text=True).strip()
        self.platform=self.bundle/'dsh-phalanx-linux-arm64.tar.gz'
        with tarfile.open(self.platform,'w:gz') as archive:
            data=json.dumps({'commit':self.snapshot,'platform':'linux/arm64'}).encode();entry=tarfile.TarInfo('./build-info.json');entry.size=len(data);archive.addfile(entry,io.BytesIO(data))
        self.image=self.bundle/'dsh-phalanx-dsh-linux-arm64.oci.tar';self.image.write_bytes(b'verified image')
        self.manifest={'commit':self.snapshot,'platform':'linux/arm64','tag':'v0.1.25-rc.1','targetVersion':'0.1.25','files':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (self.platform,self.image)}}
        (self.bundle/'manifest.json').write_text(json.dumps(self.manifest))
        self.archive=self.root/'preserved';self.archive.mkdir(mode=0o700)
        paths=[self.home/'data',self.home/'keys',self.config/'environment',self.config/'install-state.json',self.config/'installed-manifest.json']
        self.moves=[]
        for index,path in enumerate(paths):
            target=self.archive/str(index);target.mkdir() if index<2 else target.write_text('protected old metadata')
            if path==self.config/'environment':target.write_text('DSH_PHALANX_DATA_ROOT="'+str(self.home/'data')+'"\n')
            self.moves.append({'original':str(path),'archive':str(target)})
        self.identity=SimpleNamespace(pw_name='dsh-phalanx',pw_uid=os.geteuid(),pw_gid=os.getegid(),pw_dir=str(self.home))
        self.preparation={'status':'prepared-fresh-install','uid':os.geteuid(),'gid':os.getegid(),'home':str(self.home),'moves':self.moves}
        (self.archive/'OWNER.json').write_text(json.dumps(self.preparation))
        self.context={'originalCommit':self.original,'snapshotCommit':self.snapshot,'sourcePreset':'mainland','builtTree':module['source_tree'](self.source),'resumedFrom':{'preparation':str(self.archive),'buildAttemptLogSha256':'b'*64}}
    def invoke(self):
        function=module['install_built_bundle'];state=function.__globals__
        commands=[]
        def run(args,**kwargs):
            if str(args[0])=='git':return subprocess.run([str(part) for part in args],check=True,**kwargs)
            commands.append(args)
            if str(args[0])=='bash':kwargs['stdout'].write('{}')
            return SimpleNamespace(stdout='inactive\n')
        with patch.dict(state,ROOT=self.root,SOURCE=self.source,INSTALL_CONFIGURATION=self.config),patch.dict(state,run=run,model_service=lambda:None),patch.object(state['pwd'],'getpwnam',return_value=self.identity):
            function(self.context,{} ,resume=True)
        return commands
    def test_success_installs_the_existing_archives_and_records_actual_install_only(self):
        commands=self.invoke();self.assertEqual(sum(str(row[0])=='bash' for row in commands),1)
        receipt=json.loads((self.root/'build.json').read_text());self.assertEqual(receipt['originalCommit'],self.original);self.assertEqual(receipt['resumedFrom'],self.context['resumedFrom'])
        self.assertEqual(set(receipt['stepSeconds']),{'installerTransaction'})
        self.assertFalse(any(any(word in str(part) for word in ('package.mjs','build:admin-ui')) for row in commands for part in row))
    def test_bad_archive_never_enters_installer(self):
        self.image.write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError,'archive hash'):self.invoke()
        self.assertFalse((self.root/'operator.json').exists())
    def test_foreign_snapshot_never_enters_installer(self):
        self.context['snapshotCommit']='c'*40
        with self.assertRaisesRegex(ValueError,'snapshot'):self.invoke()
        self.assertFalse((self.root/'operator.json').exists())
    def test_residual_configuration_never_enters_installer(self):
        (self.config/'environment').write_text('residual')
        with self.assertRaisesRegex(ValueError,'Residual'):self.invoke()
        self.assertFalse((self.root/'operator.json').exists())

if __name__=='__main__':unittest.main()
