"""A never-onboarded development deployment is preserved, then installed fresh; an onboarded one is left alone."""
import json,os,runpy,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

module=runpy.run_path('scripts/dev/guest.py')

class UninitializedRebuild(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup)
        self.root=Path(self.temporary.name);self.config=self.root/'etc';self.home=self.root/'home'
        for path in (self.config,self.home/'data/postgres',self.home/'keys'):path.mkdir(parents=True)
        (self.home/'keys/database.json').write_text('{}')
        # Written by the installer's own serializer, including the JSON values it escapes.
        values={'DSH_PHALANX_DATA_ROOT':str(self.home/'data'),'DSH_PHALANX_DATABASE_CONFIG_FILE':str(self.home/'keys/database.json'),
                'DSH_PHALANX_DOWNLOAD_SOURCES':'{"preset":"mainland"}','DSH_PHALANX_RUNTIME_ARGS_JSON':'["--a","b\\\\c"]'}
        (self.config/'environment').write_text(''.join(f'{k}="'+v.replace('\\','\\\\').replace('"','\\"')+'"\n' for k,v in sorted(values.items())))
        for name in ('install-state.json','installed-manifest.json'):(self.config/name).write_text('{}')
        self.identity=SimpleNamespace(pw_name='dsh-phalanx',pw_uid=os.geteuid(),pw_gid=os.getegid(),pw_dir=str(self.home))
        self.start=self.root/'start';self.start.write_text('')
    def preserve(self,schema,**onboarding):
        function=module['preserve_uninitialized_deployment'];state=function.__globals__;calls=[]
        def run(args,**kwargs):
            calls.append([str(part) for part in args])
            if '--eval' in calls[-1]:
                if schema is None:return SimpleNamespace(returncode=1,stdout='')
                return SimpleNamespace(returncode=0,stdout=json.dumps({'state':'connected','schemaVersion':schema,**({'selection':None,'bootstrapComplete':False} if schema==0 else {}),**onboarding}))
            return SimpleNamespace(returncode=0,stdout='')
        real=Path
        def path(value,*rest):return self.start if value=='/opt/dsh-phalanx/current/start' else real(value,*rest)
        # Patch the real subprocess boundary too, so a call shape that subprocess.run rejects fails here.
        def subprocess_run(args,**kwargs):
            self.assertIs(kwargs.get('check'),False)
            return run(args,**kwargs)
        with patch.dict(state,ROOT=self.root,INSTALL_CONFIGURATION=self.config,run=run,Path=path),patch.object(state['subprocess'],'run',subprocess_run),patch.object(state['pwd'],'getpwnam',return_value=self.identity):
            return function(),calls
    def test_schema_zero_moves_all_five_paths_and_leaves_an_empty_data_root(self):
        preservation,calls=self.preserve(0)
        archive=Path(preservation);owner=json.loads((archive/'OWNER.json').read_text())
        self.assertEqual(owner['status'],'prepared-fresh-install');self.assertEqual(archive.stat().st_mode&0o777,0o700)
        self.assertEqual({row['original'] for row in owner['moves']},{str(self.home/'data'),str(self.home/'keys'),*[str(self.config/n) for n in ('environment','install-state.json','installed-manifest.json')]})
        for row in owner['moves']:self.assertTrue(Path(row['archive']).exists())
        self.assertTrue((archive/'0/postgres').is_dir());self.assertEqual(list((self.home/'data').iterdir()),[])
        for name in ('environment','install-state.json','installed-manifest.json'):self.assertFalse((self.config/name).exists())
        self.assertTrue(any('stop' in call and 'dsh-phalanx-postgres.service' in call for call in calls))
        self.assertEqual({p.name for p in archive.iterdir()},{'0','1','2','3','4','OWNER.json'})
        # The resume guard itself accepts exactly this preserved state before the installer runs.
        guard=module['assert_preserved_fresh_install'];state=guard.__globals__
        def run(args,**kwargs):return SimpleNamespace(returncode=0,stdout='inactive\n')
        with patch.dict(state,ROOT=self.root,INSTALL_CONFIGURATION=self.config,run=run),patch.object(state['pwd'],'getpwnam',return_value=self.identity):
            guard(archive)
    def test_initialized_schema_without_selection_or_bootstrap_is_preserved(self):
        preservation,_=self.preserve(8,selection=None,bootstrapComplete=False)
        self.assertIsNotNone(preservation)
        self.assertEqual(len(json.loads((Path(preservation)/'OWNER.json').read_text())['moves']),5)
    def test_separated_database_and_default_user_files_are_preserved_with_the_original_keys(self):
        (self.home/'data/postgres').rmdir()
        durable=self.home/'data.durable'
        (durable/'postgres').mkdir(parents=True)
        (durable/'users/member/home').mkdir(parents=True)
        (durable/'postgres/retained').write_text('KEEP_DATABASE')
        (durable/'users/member/home/retained').write_text('KEEP_USER_FILES')
        preservation,_=self.preserve(0)
        archive=Path(preservation);owner=json.loads((archive/'OWNER.json').read_text())
        moved={row['original']:Path(row['archive']) for row in owner['moves']}
        self.assertIn(str(durable),moved)
        self.assertEqual((moved[str(durable)]/'postgres/retained').read_text(),'KEEP_DATABASE')
        self.assertEqual((moved[str(durable)]/'users/member/home/retained').read_text(),'KEEP_USER_FILES')
        self.assertEqual((moved[str(self.home/'keys')]/'database.json').read_text(),'{}')
        self.assertFalse(durable.exists())
        guard=module['assert_preserved_fresh_install'];state=guard.__globals__
        with patch.dict(state,ROOT=self.root,INSTALL_CONFIGURATION=self.config,run=lambda *args,**kwargs:SimpleNamespace(returncode=0,stdout='inactive\n')),patch.object(state['pwd'],'getpwnam',return_value=self.identity):
            guard(archive)
    def test_schema_alone_or_committed_onboarding_never_allows_preservation(self):
        for fields in ({},{'selection':'builtin','bootstrapComplete':False},{'selection':'external','bootstrapComplete':False},
                       {'selection':None,'bootstrapComplete':True},{'selection':None}):
            with self.subTest(fields=fields):
                preservation,_=self.preserve(8,**fields)
                self.assertIsNone(preservation)
    def test_environment_parsing_matches_the_installer(self):
        # Two parsers of one file: guest must read every value the installer reads back.
        import sys;sys.path.insert(0,'scripts/install')
        from installer_config import read_configuration
        expected=read_configuration(SimpleNamespace(path=lambda value:self.config/Path(value).name))
        calls=self.preserve(0)[1];probe=next(call for call in calls if '--eval' in call)
        self.assertEqual(probe[-2],expected['DSH_PHALANX_DATABASE_CONFIG_FILE'])
        self.assertEqual(probe[-1],expected['DSH_PHALANX_DATA_ROOT'])
    def test_a_missing_path_refuses_before_moving_anything(self):
        (self.config/'installed-manifest.json').unlink()
        with self.assertRaisesRegex(ValueError,'Incomplete uninitialized deployment'):self.preserve(0)
        self.assertTrue((self.home/'keys/database.json').exists());self.assertTrue((self.home/'data/postgres').is_dir())
        self.assertEqual([p for p in self.root.iterdir() if p.name.startswith('uninitialized-predecessor-')],[])
    def test_onboarded_or_unreachable_deployment_is_never_moved(self):
        for schema in (7,'unreachable','malformed'):
            with self.subTest(schema=schema):
                if schema=='malformed':
                    saved=(self.config/'environment').read_text()
                    (self.config/'environment').write_text(saved+'DSH_PHALANX_BROKEN="unterminated\n')
                    try:preservation,calls=self.preserve(0)
                    finally:(self.config/'environment').write_text(saved)
                    self.assertFalse(any('--eval' in call for call in calls))
                else:
                    preservation,calls=self.preserve(None if schema=='unreachable' else schema)
                    self.assertTrue(any('--eval' in call for call in calls))
                self.assertIsNone(preservation)
                self.assertTrue((self.home/'keys/database.json').exists());self.assertTrue((self.config/'environment').exists())
                self.assertEqual([p for p in self.root.iterdir() if p.name.startswith('uninitialized-predecessor-')],[])

unittest.main(verbosity=1)
