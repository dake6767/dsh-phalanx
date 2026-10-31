"""The installer asks the installed platform only when there is a platform and a selected database to answer."""
import json,subprocess,sys,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,'scripts/install')
from installer_config import platform_facts,configured_download_sources

class PlatformFacts(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.root=Path(self.temporary.name); self.calls=[]; self.answer=(0,json.dumps({'selection':None}))
        self.host=SimpleNamespace(path=lambda value:self.root/str(value).lstrip('/'),tell=lambda text:self.calls.append(('tell',text)),
            run=self.command,
            user=self.user)
        self.values={'DSH_PHALANX_DATA_ROOT':'/var/lib/dsh-phalanx/data'}
    def command(self,args,check=True,**kwargs):
        self.calls.append(('run',args))
        if args[0]=='getent':return subprocess.CompletedProcess(args,0,'dsh-phalanx:x:1001:1001::/var/lib/dsh-phalanx:/usr/sbin/nologin\n','')
        return subprocess.CompletedProcess(args,self.answer[0],self.answer[1],'diagnostic')
    def test_download_choices_use_a_narrow_node_reader_instead_of_the_platform_entry(self):
        self.install();self.answer=(0,json.dumps({'selection':{'preset':'mainland'}}))
        self.assertEqual(platform_facts(self.host,self.values,'download-sources'),{'selection':{'preset':'mainland'}})
        commands=[args for kind,args in self.calls if kind in ('run','user')]
        self.assertFalse(any(any(argument.endswith('/start') for argument in args) for args in commands),commands)
        self.assertTrue(any(any(argument.endswith('/node') for argument in args) for args in commands),commands)
    def test_download_source_failure_uses_the_recorded_choice_without_reusing_a_previous_answer(self):
        self.install();self.values['DSH_PHALANX_DOWNLOAD_SOURCES']=json.dumps({'preset':'official'})
        self.answer=(0,json.dumps({'selection':{'preset':'mainland'}}))
        self.assertEqual(configured_download_sources(self.host,self.values,platform_running=True),{'preset':'mainland'})
        self.answer=(2,'')
        self.assertEqual(configured_download_sources(self.host,self.values,platform_running=True),{'preset':'official'})
    def user(self,uid,args,check=True):
        self.calls.append(('user',args)); return subprocess.CompletedProcess(args,self.answer[0],self.answer[1],'diagnostic')
    def install(self,*,database=True):
        start=self.host.path('/opt/dsh-phalanx/current/start'); start.parent.mkdir(parents=True,exist_ok=True); start.write_text('')
        if database:
            config=self.host.path('/var/lib/dsh-phalanx/keys/database.json'); config.parent.mkdir(parents=True,exist_ok=True); config.write_text('{}')
    def test_no_platform_or_no_selected_database_never_runs_the_command(self):
        self.assertIsNone(platform_facts(self.host,self.values,'download-sources'))
        self.install(database=False)
        self.assertIsNone(platform_facts(self.host,self.values,'download-sources'))
        self.assertEqual([call for call in self.calls if call[0]=='user'],[])
    def test_an_unavailable_database_falls_back_and_names_the_fact(self):
        self.install(); self.answer=(2,'')
        self.assertIsNone(platform_facts(self.host,self.values,'plugin-budget-rows'))
        self.assertIn(('tell','The platform database did not answer; using the local record instead of plugin-budget-rows'),self.calls)
    def test_other_failures_stop_and_answers_are_parsed(self):
        self.install(); self.answer=(1,'')
        with self.assertRaises(ValueError):platform_facts(self.host,self.values,'download-sources')
        self.answer=(0,json.dumps({'selection':{'preset':'mainland'}}))
        self.assertEqual(platform_facts(self.host,self.values,'download-sources'),{'selection':{'preset':'mainland'}})

unittest.main(verbosity=1)
