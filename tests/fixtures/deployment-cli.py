"""Public deployment command exercised at its filesystem and operating-system seams."""
import contextlib
import io
import json
import hashlib
import fcntl
import runpy
import subprocess
import sys
import tempfile
import urllib.error
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts/install'))
from installer_host import Host
from installer_deployment_cli import main
from terminal_dialogue import run_terminal


class InstalledMachine:
    def __init__(self,root):
        support=runpy.run_path(str(Path(__file__).with_name('installer-bilingual.py')))
        self.machine=support['InstallationMachine'](root)
        self.host=support['installer'].Host(self.machine.root,self.machine.command,system='Linux',machine='x86_64',uid=0)
        self.host.request=lambda *args,**kwargs:b'login'
        self.install = support['installer'].main
        self.install_args = support['modern_bundle'](self.machine)
        with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            assert self.install(self.install_args,self.host)==0
        self.root=self.machine.root
        self.units={name:'active' for name in ('dsh-phalanx.service','dsh-phalanx-postgres.service','dsh-phalanx-updater.service','dsh-phalanx-maintenance.service')}
        for name in self.units:
            group=self.root/'sys/fs/cgroup/dsh-fixture'/name
            group.mkdir(parents=True)
            (group/'cgroup.procs').write_text('' if name=='dsh-phalanx-maintenance.service' else '2000\n')
        self.query_failure=None
        self.external_proof=None
        self.extra_mounts=[]
        self.fail_action=None
        self.independent_units=[]
        self.readiness_failure=False
        self.containers=[]
        self.builtin_containers=[]
        self.commands=[]

    def command(self,args,**kwargs):
        self.commands.append(args)
        if args==['nft','-j','list','tables']:
            return subprocess.CompletedProcess(args,0,'{"nftables":[]}','')
        if args[:6]==['runuser','-u','dsh-phalanx','--','test','-O']:
            return subprocess.CompletedProcess(args,0 if Path(args[-1]).exists() else 1,'','')
        if 'platform-facts' in args and 'user-storage' in args:
            return subprocess.CompletedProcess(args,0,json.dumps(self.external_proof),'')
        if args[:4]==['findmnt','--json','--list','--output']:
            return subprocess.CompletedProcess(args,0,json.dumps({'filesystems':[{'target':str(p)} for p in self.extra_mounts]}),'')
        if 'systemctl' in args and 'disable' in args and self.fail_action==(args[-1],'disable'):
            return subprocess.CompletedProcess(args,42,'','Synthetic action failure')
        if 'systemctl' in args and 'show' in args and any('LoadState,' in part for part in args):
            unit=next((part for part in args if part in self.units),None)
            if unit:
                if unit==self.query_failure:return subprocess.CompletedProcess(args,1,'','Observation unavailable')
                active=self.units[unit]
                sub='exited' if unit=='dsh-phalanx-maintenance.service' and active=='active' else 'running' if active=='active' else 'dead'
                pid=2000 if active=='active' and sub=='running' else 0
                return subprocess.CompletedProcess(args,0,f'LoadState=loaded\nActiveState={active}\nSubState={sub}\nMainPID={pid}\nControlPID=0\nControlGroup=/dsh-fixture/{unit}\nUnitFileState=enabled\n','')
        if 'systemctl' in args and 'list-units' in args:return subprocess.CompletedProcess(args,0,'\n'.join(self.independent_units),'')
        if 'systemctl' in args and any(action in args for action in ('stop','start')):
            unit=next((part for part in args if part in self.units),None)
            if unit:
                action='stop' if 'stop' in args else 'start'
                if self.fail_action==(unit,action):return subprocess.CompletedProcess(args,42,'','Synthetic action failure')
                self.units[unit]='inactive' if action=='stop' else 'active'
                (self.root/'sys/fs/cgroup/dsh-fixture'/unit/'cgroup.procs').write_text('' if action=='stop' or unit=='dsh-phalanx-maintenance.service' else '2000\n')
                return subprocess.CompletedProcess(args,0,'','')
        if 'podman' in args and 'ps' in args:
            rows=self.builtin_containers if 'label=dsh.phalanx.database=builtin' in args else self.containers
            return subprocess.CompletedProcess(args,0,json.dumps(rows),'')
        if 'podman' in args and 'inspect' in args:return subprocess.CompletedProcess(args,0,json.dumps([row for row in self.builtin_containers if row['Id']==args[-1]]),'')
        if 'podman' in args and 'rm' in args:
            identity=args[-1]
            assert any(row['Id']==identity for row in [*self.containers,*self.builtin_containers]),'Cannot remove an unknown container'
            self.containers=[row for row in self.containers if row['Id']!=identity]
            self.builtin_containers=[row for row in self.builtin_containers if row['Id']!=identity]
            return subprocess.CompletedProcess(args,0,'','')
        return self.machine.command(args,**kwargs)

    def add_builtin_database(self):
        fixture=runpy.run_path(str(Path(__file__).with_name('installer-database.py')))
        database=fixture['Host'](str(self.root))
        fixture['prepare_builtin_database'](database,1001,1001,'/product',{'DSH_PHALANX_DATA_ROOT':'/var/lib/dsh-phalanx/data'},{'platform':'linux/arm64'})
        self.builtin_containers=[{'Id':'b'*64,'Name':'/dsh-phalanx-postgres','State':'running','Labels':{'dsh.phalanx.database':'builtin'},'Config':{'Labels':{'dsh.phalanx.database':'builtin'}},'Mounts':[{'Type':'bind','Source':str((self.root/'var/lib/dsh-phalanx/data.durable/postgres').resolve()),'Destination':'/var/lib/postgresql/data'}]}]

    def command_host(self):
        # The Host constructor owns the callback; recreate it with the same root and OS facts.
        host=Host(self.root,self.command,system='Linux',machine='x86_64',uid=0)
        def request(*args,**kwargs):
            if self.readiness_failure:raise urllib.error.URLError('Synthetic readiness observation failed')
            return b'login'
        host.request=request
        return host

    def invoke(self,*args,output_format='json'):
        host=self.command_host()
        self.commands=[]
        with contextlib.redirect_stdout(output:=io.StringIO()):
            code=main([*args,'--output',output_format],host)
        return code,json.loads(output.getvalue()) if output_format=='json' else output.getvalue()


class DeploymentCommand(unittest.TestCase):
    def test_uninstall_confirmation_reports_retention_without_changing_services(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            command=machine.root/'usr/local/bin/dsh-phalanx'
            state=machine.root/'etc/dsh-phalanx/install-state.json'
            before=state.read_bytes()
            code,result=machine.invoke('uninstall')
            self.assertEqual(code,1,result)
            self.assertTrue(result.get('confirmationRequired'),result)
            self.assertIn('/etc/dsh-phalanx/environment',result['retained'])
            self.assertEqual(state.read_bytes(),before)
            self.assertTrue(command.exists())
            self.assertFalse(any(word in args for args in machine.commands for word in ('stop','disable')))

    def test_default_uninstall_removes_programs_and_keeps_recovery_data(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            machine.add_builtin_database()
            durable=machine.root/'var/lib/dsh-phalanx/data.durable'
            member=durable/'users/member/home/retained'
            member.parent.mkdir(parents=True)
            member.write_text('member data')
            keys=machine.root/'var/lib/dsh-phalanx/keys'
            keys.mkdir(exist_ok=True)
            (keys/'master.key').write_text('matching key')
            env=machine.root/'etc/dsh-phalanx/environment'
            config=env.read_bytes()
            code,result=machine.invoke('uninstall','--yes')
            self.assertEqual(code,0,result)
            self.assertEqual(result['state'],'uninstalled')
            self.assertTrue(result['changed'])
            self.assertEqual(member.read_text(),'member data')
            self.assertEqual((keys/'master.key').read_text(),'matching key')
            self.assertEqual(env.read_bytes(),config)
            self.assertFalse((machine.root/'usr/local/bin/dsh-phalanx').exists())
            self.assertFalse((machine.root/'opt/dsh-phalanx/current').is_symlink())
            self.assertTrue(any('disable' in args and 'dsh-phalanx.service' in args for args in machine.commands))
            self.assertEqual(machine.invoke('uninstall','--yes')[0],0)

    def test_retained_data_can_be_purged_by_the_installer_with_explicit_confirmation(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            machine.add_builtin_database()
            users=machine.root/'var/lib/dsh-phalanx/data.durable/users'
            for name in ('retired', '_spaces/'+'a'*32):
                member=users/name/'home'
                member.mkdir(parents=True)
                (member/'keep').write_text('private member content')
            neighbor=machine.root/'var/lib/dsh-phalanx/foreign'
            neighbor.write_text('shared')
            self.assertEqual(machine.invoke('uninstall','--yes')[0],0)
            support=runpy.run_path(str(Path(__file__).with_name('installer-bilingual.py')))
            for args,expected in [(['--purge'],1),(['--purge','--yes'],0),(['--purge','--yes'],0)]:
                with contextlib.redirect_stdout(output:=io.StringIO()):
                    code=support['installer'].main(['--uninstall','--non-interactive','--output','json',*args],machine.command_host())
                self.assertEqual(code,expected,output.getvalue())
                self.assertEqual(users.exists(),expected==1)
                self.assertEqual(neighbor.read_text(),'shared')

    def test_retained_deployment_reinstalls_the_same_bundle_with_existing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            machine.add_builtin_database()
            state=machine.root/'var/lib/dsh-phalanx/data/persisted'
            state.write_text('account state')
            self.assertEqual(machine.invoke('uninstall','--yes')[0],0)
            config=machine.root/'etc/dsh-phalanx/environment'
            original=config.stat()
            machine.machine.fail_enable_once=True
            with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(machine.install(machine.install_args,machine.host),1)
                self.assertEqual(machine.install(machine.install_args,machine.host),0)
            self.assertEqual(config.stat().st_ino,original.st_ino)
            self.assertTrue((machine.root/'usr/local/bin/dsh-phalanx').exists())
            self.assertFalse((machine.root/'etc/dsh-phalanx/uninstall-state.json').exists())
            self.assertEqual(state.read_text(),'account state')

    def test_uninstall_partial_failure_keeps_data_and_can_be_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            machine.add_builtin_database()
            machine.fail_action=('dsh-phalanx-updater.service','disable')
            code,result=machine.invoke('uninstall','--yes')
            self.assertEqual(code,1,result)
            self.assertEqual(result['state'],'partial')
            self.assertTrue(result['pending'])
            self.assertTrue((machine.root/'etc/dsh-phalanx/environment').exists())
            self.assertEqual(machine.invoke('start')[0],1)
            machine.fail_action=None
            self.assertEqual(machine.invoke('uninstall','--yes')[0],0)

    def test_partial_purge_reports_completed_pending_and_existing_data(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            machine.add_builtin_database()
            self.assertEqual(machine.invoke('uninstall','--yes')[0],0)
            mount=machine.root/'var/lib/dsh-phalanx/data.durable/nested'
            mount.mkdir()
            machine.extra_mounts=[mount]
            code,result=machine.invoke('uninstall','--purge','--yes')
            self.assertEqual(code,1,result)
            self.assertIn('/var/lib/dsh-phalanx/data',result['completed'])
            self.assertNotIn('/var/lib/dsh-phalanx/data',result['retained'])
            self.assertIn('/var/lib/dsh-phalanx/data.durable',result['pending'])
            self.assertIn('/var/lib/dsh-phalanx/data.durable',result['retained'])
            code,output=machine.invoke('uninstall','--purge','--yes','--language','en',output_format='human')
            self.assertEqual(code,1,output)
            for label in ('Completed','Pending','Still present'):
                self.assertIn(label,output)
            machine.extra_mounts=[]
            self.assertEqual(machine.invoke('uninstall','--purge','--yes')[0],0)

    def test_absent_install_receipt_does_not_hide_leftover_program(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            unit=root/'etc/systemd/system/dsh-phalanx-updater.service'
            unit.parent.mkdir(parents=True)
            unit.write_text('unknown unit')
            host=Host(root,system='Linux',machine='x86_64',uid=0)
            with contextlib.redirect_stdout(output:=io.StringIO()):
                self.assertEqual(main(['uninstall','--yes','--output','json'],host),1)
            self.assertIn('Cannot verify ownership',json.loads(output.getvalue())['errors'][0]['reason'])
            self.assertEqual(unit.read_text(),'unknown unit')

    def test_external_purge_requires_the_original_mount_and_storage_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            machine.add_builtin_database()
            mount=machine.root/'mnt/external'
            users=mount/'members'
            users.mkdir(parents=True)
            neighbor=mount/'shared'
            neighbor.write_text('shared content')
            marker=users/'.dsh-phalanx-storage.json'
            owner='a'*32
            identity='b'*32
            marker.write_text(json.dumps({'id':identity,'owner':owner}))
            marker.chmod(0o600)
            (users/'retired').mkdir()
            (users/'_spaces').mkdir()
            with (machine.root/'etc/dsh-phalanx/environment').open('a') as file:
                file.write('DSH_PHALANX_USER_DATA_ROOT="/mnt/external/members"\nDSH_PHALANX_USER_DATA_MOUNT="/mnt/external"\n')
            machine.machine.mountpoint='/mnt/external'
            machine.extra_mounts=[mount]
            database_config=machine.root/'var/lib/dsh-phalanx/keys/database.json'
            database_config.write_text(json.dumps({'selection':'external'}))
            database_config.chmod(0o600)
            machine.external_proof={'owner':owner,'binding':{'id':identity,'path':'/mnt/external/members'}}
            self.assertEqual(machine.invoke('uninstall','--yes')[0],0)
            machine.machine.mountpoint=None
            code,result=machine.invoke('uninstall','--purge','--yes')
            self.assertEqual(code,1,result)
            self.assertIn('mount changed',result['errors'][0]['reason'])
            self.assertTrue(users.exists())
            machine.machine.mountpoint='/mnt/external'
            self.assertEqual(machine.invoke('uninstall','--purge','--yes')[0],0)
            self.assertFalse(users.exists())
            self.assertEqual(neighbor.read_text(),'shared content')

    def test_uninstalled_status_is_readonly_and_machine_readable(self):
        with tempfile.TemporaryDirectory() as directory:
            commands=[]
            def run(args,**kwargs):
                commands.append(args)
                raise AssertionError('An uninstalled status has no system queries')
            host=Host(Path(directory),run,system='Linux',machine='x86_64',uid=0)
            with contextlib.redirect_stdout(output:=io.StringIO()):
                self.assertEqual(main(['status','--output','json'],host),0)
            self.assertEqual(json.loads(output.getvalue())['state'],'not-installed')
            self.assertEqual(list(Path(directory).iterdir()),[])
            self.assertEqual(commands,[])

    def test_installed_status_observes_services_without_mutating_files_or_starting_anything(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            before={str(p.relative_to(machine.root)):p.read_bytes() for p in machine.root.rglob('*') if p.is_file() and not p.is_symlink()}
            code,result=machine.invoke('status')
            self.assertEqual(code,0,result)
            self.assertEqual(result['state'],'running')
            self.assertTrue(any(row['name']=='platform' and row['state']=='running' for row in result['components']))
            self.assertFalse(any(any(part in ('start','stop','enable','disable','rm') for part in args) for args in machine.commands))
            after={str(p.relative_to(machine.root)):p.read_bytes() for p in machine.root.rglob('*') if p.is_file() and not p.is_symlink()}
            self.assertEqual(after,before)

    def test_uninitialized_running_platform_observes_bootstrap_without_claiming_member_readiness(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            host=machine.command_host();requests=[]
            def request(url,**kwargs):requests.append(url);return b'bootstrap'
            host.request=request
            with contextlib.redirect_stdout(output:=io.StringIO()):code=main(['status','--output','json'],host)
            result=json.loads(output.getvalue())
            self.assertEqual(code,0,result)
            self.assertEqual(result['state'],'running')
            platform=next(row for row in result['components'] if row['name']=='platform')
            self.assertTrue(platform['initializationRequired'])
            self.assertTrue(any(url.endswith('/login') for url in requests))
            self.assertFalse(any(url.endswith('/readyz') for url in requests))

    def test_selected_database_requires_actual_readiness_instead_of_bootstrap_response(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            config=machine.root/'var/lib/dsh-phalanx/keys/database.json'
            config.parent.mkdir(parents=True,exist_ok=True)
            config.write_text(json.dumps({'selection':'builtin'}));config.chmod(0o600)
            with (machine.root/'etc/dsh-phalanx/environment').open('a') as environment:environment.write('DSH_PHALANX_DATABASE_CONFIG_FILE="/var/lib/dsh-phalanx/keys/database.json"\n')
            host=machine.command_host();requests=[]
            def request(url,**kwargs):
                requests.append(url)
                if url.endswith('/readyz'):raise urllib.error.HTTPError(url,503,'Service Unavailable',{},None)
                return b'bootstrap'
            host.request=request
            with contextlib.redirect_stdout(output:=io.StringIO()):code=main(['status','--output','json'],host)
            result=json.loads(output.getvalue())
            self.assertEqual(code,1,result)
            self.assertEqual(result['state'],'query-failed')
            self.assertTrue(any(url.endswith('/readyz') for url in requests))
            self.assertFalse(any(url.endswith('/login') for url in requests))

    def test_status_retains_observed_components_when_another_query_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            machine.query_failure='dsh-phalanx-updater.service'
            code,result=machine.invoke('status')
            self.assertEqual(code,1)
            self.assertEqual(result['state'],'query-failed')
            self.assertTrue(any(row['name']=='platform' and row['state']=='running' for row in result['components']))
            self.assertTrue(result['errors'])

    def test_status_reports_residual_owned_member_and_maintenance_without_repair(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            machine.units={name:'inactive' for name in machine.units}
            for group in (machine.root/'sys/fs/cgroup/dsh-fixture').iterdir():
                (group/'cgroup.procs').write_text('')
            machine.containers=[{'Id':'a'*64,'State':'running','Labels':{'dsh-phalanx.community':'1','dsh-phalanx.community-root':hashlib.sha256(str(Path('/var/lib/dsh-phalanx/data').resolve()).encode()).hexdigest()}}]
            code,result=machine.invoke('status')
            self.assertEqual(code,1)
            self.assertEqual(result['state'],'partial')
            (machine.root/'etc/dsh-phalanx/maintenance').write_text('{}')
            code,result=machine.invoke('status')
            self.assertEqual(result['state'],'maintenance')
            self.assertFalse(any('stop' in args or 'rm' in args for args in machine.commands))

    def test_stop_removes_detached_owned_workloads_and_preserves_files_and_autostart(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            machine.containers=[{'Id':'a'*64,'State':'running','Labels':{'dsh-phalanx.community':'1','dsh-phalanx.community-root':hashlib.sha256(str(Path('/var/lib/dsh-phalanx/data').resolve()).encode()).hexdigest()}}]
            environment=machine.root/'etc/dsh-phalanx/environment'
            original=environment.read_bytes()
            code,result=machine.invoke('stop','--yes')
            self.assertEqual(code,0,result)
            self.assertEqual(result['state'],'stopped')
            self.assertEqual(machine.containers,[])
            self.assertEqual(environment.read_bytes(),original)
            self.assertFalse(any('disable' in args or 'enable' in args or 'userdel' in args for args in machine.commands))
            self.assertTrue(any('rm' in args and args[-1]=='a'*64 for args in machine.commands))
            code,repeated=machine.invoke('stop')
            self.assertEqual(code,0,repeated)
            self.assertFalse(repeated['changed'])
            self.assertFalse(any('stop' in args or 'rm' in args for args in machine.commands))

    def test_start_uses_existing_services_without_reenabling_or_restarting_running_units(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            machine.units={name:'inactive' for name in machine.units}
            for group in (machine.root/'sys/fs/cgroup/dsh-fixture').iterdir():(group/'cgroup.procs').write_text('')
            code,result=machine.invoke('start')
            self.assertEqual(code,0,result)
            self.assertEqual(result['state'],'running')
            self.assertFalse(any('enable' in args or 'restart' in args for args in machine.commands))
            code,repeated=machine.invoke('start')
            self.assertEqual(code,0,repeated)
            self.assertFalse(repeated['changed'])
            self.assertFalse(any('start' in args for args in machine.commands))

    def test_active_maintenance_refuses_mutations_and_noninteractive_stop_requires_confirmation(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            code,result=machine.invoke('stop')
            self.assertEqual(code,1)
            self.assertTrue(result['errors'])
            self.assertFalse(any('stop' in args for args in machine.commands))
            (machine.root/'etc/dsh-phalanx/maintenance').write_text('{}')
            for action in ('start','stop'):
                code,result=machine.invoke(action,'--yes')
                self.assertEqual(code,1)
                self.assertEqual(result['state'],'maintenance')
                self.assertFalse(any('stop' in args or 'start' in args or 'rm' in args for args in machine.commands))

    def test_human_status_reports_actual_components_in_the_selected_language_and_json_help_parses(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            for language,label in (('zh-CN','运行中'),('en','Running')):
                code,text=machine.invoke('status','--language',language,output_format='human')
                self.assertEqual(code,0)
                self.assertIn(label,text)
                self.assertNotIn('未安装',text)
            with contextlib.redirect_stdout(output:=io.StringIO()):
                self.assertEqual(main(['--help','--output','json']),0)
            self.assertEqual(json.loads(output.getvalue())['status'],'help')

    def test_public_installation_delivers_an_executable_global_management_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            entry=machine.root/'usr/local/bin/dsh-phalanx'
            self.assertTrue(entry.is_file())
            self.assertEqual(entry.stat().st_mode&0o777,0o755)
            self.assertFalse(entry.is_symlink())

    def test_shared_installation_lease_refuses_start_and_stop_while_status_stays_readonly(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            path=machine.root/'run/lock/dsh-phalanx-install.lock'
            with path.open('r+') as held:
                fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
                self.assertEqual(machine.invoke('status')[0],0)
                for action in ('start','stop'):
                    code,result=machine.invoke(action,'--yes')
                    self.assertEqual(code,1)
                    self.assertTrue(result['conflict'])
                    self.assertFalse(any('start' in args or 'stop' in args for args in machine.commands))

    def test_partial_stop_retains_successful_components_and_can_be_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            machine.fail_action=('dsh-phalanx-updater.service','stop')
            code,result=machine.invoke('stop','--yes')
            self.assertEqual(code,1)
            self.assertEqual(result['state'],'partial')
            self.assertTrue(any(row['component']=='updater' and row['status']=='failed' for row in result['steps']))
            self.assertEqual(machine.units['dsh-phalanx.service'],'inactive')
            machine.fail_action=None
            code,result=machine.invoke('stop','--yes')
            self.assertEqual(code,0,result)
            self.assertEqual(result['state'],'stopped')

    def test_builtin_database_is_stopped_but_external_configuration_and_dependencies_remain(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            machine.add_builtin_database()
            config=machine.root/'var/lib/dsh-phalanx/keys/database.json'
            config.write_text(json.dumps({'selection':'external','connection':{'host':'external.example.test'}}))
            config.chmod(0o600)
            with (machine.root/'etc/dsh-phalanx/environment').open('a') as environment:environment.write('DSH_PHALANX_DATABASE_CONFIG_FILE="/var/lib/dsh-phalanx/keys/database.json"\n')
            workspace=machine.root/'var/lib/dsh-phalanx/data.durable/users/member/workspace'
            workspace.mkdir(parents=True)
            (workspace/'keep.txt').write_text('MEMBER_DATA_RETAINED')
            original=config.read_bytes()
            code,result=machine.invoke('stop','--yes')
            self.assertEqual(code,0,result)
            self.assertEqual(machine.units['dsh-phalanx-postgres.service'],'inactive')
            self.assertEqual(config.read_bytes(),original)
            self.assertEqual((workspace/'keep.txt').read_text(),'MEMBER_DATA_RETAINED')
            self.assertFalse(any('external.example.test' in str(args) or 'userdel' in args or 'apt-get' in args for args in machine.commands))
            code,result=machine.invoke('start')
            self.assertEqual(code,0,result)
            self.assertEqual(machine.units['dsh-phalanx-postgres.service'],'inactive')
            self.assertEqual(config.read_bytes(),original)

    def test_unknown_independent_maintenance_unit_is_retained_and_prevents_false_full_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            unknown='dsh-phalanx-upgrade-page-11111111-1111-4111-8111-111111111111.service'
            machine.independent_units=[unknown+' loaded active running']
            code,result=machine.invoke('stop','--yes')
            self.assertEqual(code,1)
            self.assertEqual(result['state'],'query-failed')
            self.assertFalse(any('stop' in args and unknown in args for args in machine.commands))

    def test_initial_installation_retains_a_foreign_global_command_on_conflict(self):
        with tempfile.TemporaryDirectory() as directory:
            support=runpy.run_path(str(Path(__file__).with_name('installer-bilingual.py')))
            machine=support['InstallationMachine'](directory)
            entry=machine.root/'usr/local/bin/dsh-phalanx'
            entry.parent.mkdir(parents=True)
            entry.write_text('FOREIGN_COMMAND_RETAINED')
            host=support['installer'].Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0)
            host.request=lambda *args,**kwargs:b'login'
            with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(support['installer'].main(support['modern_bundle'](machine),host),1)
            self.assertEqual(entry.read_text(),'FOREIGN_COMMAND_RETAINED')
            self.assertFalse(machine.active)

    def test_running_processes_with_unavailable_readiness_are_not_reported_healthy(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            machine.readiness_failure=True
            code,result=machine.invoke('status')
            self.assertEqual(code,1)
            self.assertEqual(result['state'],'query-failed')
            platform=next(row for row in result['components'] if row['name']=='platform')
            self.assertEqual(platform['state'],'running')
            self.assertFalse(platform['ready'])
            self.assertFalse(any('start' in args or 'stop' in args for args in machine.commands))

    def test_detached_builtin_database_is_observed_and_stopped_after_its_unit_is_inactive(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            machine.add_builtin_database()
            machine.units={name:'inactive' for name in machine.units}
            for group in (machine.root/'sys/fs/cgroup/dsh-fixture').iterdir():(group/'cgroup.procs').write_text('')
            code,result=machine.invoke('status')
            self.assertEqual(code,1)
            self.assertEqual(result['state'],'partial')
            code,result=machine.invoke('stop','--yes')
            self.assertEqual(code,0,result)
            self.assertEqual(result['state'],'stopped')
            self.assertEqual(machine.builtin_containers,[])

    def test_conflicting_database_container_ownership_refuses_without_stopping_it(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            machine.add_builtin_database()
            machine.builtin_containers[0]['Mounts'][0]['Source']='/foreign/database'
            code,result=machine.invoke('stop','--yes')
            self.assertEqual(code,1)
            self.assertTrue(machine.builtin_containers)
            self.assertFalse(any('stop' in args or 'rm' in args for args in machine.commands))

    def test_malformed_maintenance_journal_retains_observations_and_refuses_actions(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            root=machine.root/'var/lib/dsh-phalanx-updater'
            root.mkdir(mode=0o700)
            journal=root/'maintenance-operation.json'
            journal.write_text('[]')
            journal.chmod(0o600)
            code,result=machine.invoke('status')
            self.assertEqual(code,1)
            self.assertEqual(result['state'],'query-failed')
            self.assertTrue(any(row['name']=='platform' and row['state']=='running' for row in result['components']))
            code,result=machine.invoke('stop','--yes')
            self.assertEqual(code,1)
            self.assertFalse(any('stop' in args or 'rm' in args for args in machine.commands))

    def test_malformed_container_observation_preserves_other_status_and_never_claims_stopped(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstalledMachine(directory)
            machine.containers=[None]
            code,result=machine.invoke('status')
            self.assertEqual(code,1)
            self.assertEqual(result['state'],'query-failed')
            self.assertTrue(any(row['name']=='platform' and row['state']=='running' for row in result['components']))
            self.assertTrue(any(row['component']=='members' for row in result['errors']))

    def test_real_terminal_confirms_or_cancels_stopping_and_machine_output_never_prompts(self):
        for language,answer in (('zh-CN','yes'),('en','yes'),('en','cancel')):
            with self.subTest(language=language,answer=answer),tempfile.TemporaryDirectory() as directory:
                prompt='输入 yes 确认' if language=='zh-CN' else 'Type yes to confirm'
                code,output=run_terminal(Path(__file__),['terminal-child',directory,language,answer],[(prompt,answer)])
                self.assertEqual(code,0,output)
                self.assertIn(('已取消' if language=='zh-CN' else 'Cancelled') if answer=='cancel' else ('已停止' if language=='zh-CN' else 'Stopped'),output)
        with tempfile.TemporaryDirectory() as directory:
            code,output=run_terminal(Path(__file__),['terminal-child',directory,'en','machine'],[])
            self.assertEqual(code,1,output)
            result=json.loads(output)
            self.assertEqual(result['status'],'failed')
            self.assertTrue(result['confirmationRequired'])

    def test_help_names_supported_actions_without_operating_on_the_host(self):
        for language in ('zh-CN','en'):
            with contextlib.redirect_stdout(output:=io.StringIO()):
                self.assertEqual(main(['--help','--language',language]),0)
            for action in ('start','stop','status'):
                self.assertIn(action,output.getvalue())
            self.assertIn('https://github.com/dake6767/dsh-phalanx',output.getvalue())


if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='terminal-child':
        machine=InstalledMachine(sys.argv[2])
        arguments=['stop','--language',sys.argv[3]]+(['--output','json'] if sys.argv[4]=='machine' else [])
        code=main(arguments,machine.command_host())
        assert machine.units['dsh-phalanx.service']==('inactive' if sys.argv[4]=='yes' else 'active')
        raise SystemExit(code)
    unittest.main()
