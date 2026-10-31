"""Public CLI and Unix HTTP reject legacy sources before platform database I/O."""
import contextlib
import copy
import hashlib
import http.client
import io
import json
from pathlib import Path
import runpy
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch
import subprocess
from installer_contract_support import installer
from installer_executor import UpgradeExecutor
from installer_executor_server import ControlServer

Machine=runpy.run_path(str(Path(__file__).with_name('upgrade-machine.py')))['UpgradeMachine']
from release_policy_support import release_policy
POLICY=release_policy()
# The shipped policy targets this checkout; its declared source is the platform-database predecessor.
CURRENT=json.loads(Path('package.json').read_text())['version']
PREVIOUS=POLICY['compatibility']['source']['min']
LEGACY=POLICY['compatibility']['freshInstallThrough']

class UnixClient(http.client.HTTPConnection):
    def __init__(self,path):super().__init__('localhost',timeout=5);self.path=path
    def connect(self):self.sock=socket.socket(socket.AF_UNIX);self.sock.connect(self.path)


def bundle(machine,version,commit,*,fresh=False,policy=None):
    args=machine.make_bundle('v'+version+'-rc.1',commit,'c')
    # This version never accepts a legacy model credential on installation.
    del args[4:6]
    p=Path(args[3])/'manifest.json';m=json.loads(p.read_text())
    m.update(schema=2,compatibility={'protocol':3,'source':{'min':'0.1.23','maxExclusive':version},
        'accounts':{'sourceMin':5,'sourceMax':5,'target':5},'environmentEpoch':1},
        storage={k:1 for k in ('platformArchiveBytes','platformExpandedBytes','imageDownloadBytes','imageExpandedBytes')},
        updater='{}',acceptancePolicy={'ticket':9,'checks':['ci','linux','upgrade','cleanInstall']})
    if fresh:m.update(copy.deepcopy(policy or POLICY))
    p.write_text(json.dumps(m));return args,m


# The predecessor shipped its own policy: same contract, one interval earlier.
PREVIOUS_POLICY=copy.deepcopy(POLICY)
PREVIOUS_POLICY['compatibility']={'protocol':3,'source':{'min':'0.1.25','maxExclusive':PREVIOUS},'accounts':{'sourceMin':7,'sourceMax':15,'target':15},'environmentEpoch':1,'freshInstallThrough':'0.1.24'}


class DatabaseUpgrade(unittest.TestCase):
    def test_legacy_cli_and_http_refuse_without_reading_database_or_stopping_source(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=Machine(directory)
            def host():
                h=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0)
                h.request=lambda url,**k:json.dumps({'version':CURRENT,'releaseNotes':'Fresh installation required.'}).encode() if url.endswith('/release.json') else b'login';return h
            args,source=bundle(machine,LEGACY,'a')
            with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):self.assertEqual(installer.main(args,host()),0)
            keep=machine.root/'var/lib/dsh-phalanx/data/keep';keep.parent.mkdir(exist_ok=True);keep.write_bytes(b'legacy data remains')
            before=machine.running_target
            config=(machine.root/'etc/dsh-phalanx/environment').read_bytes()
            args,target=bundle(machine,CURRENT,'d',fresh=True);machine.calls.clear()
            with contextlib.redirect_stdout(out:=io.StringIO()),contextlib.redirect_stderr(err:=io.StringIO()):
                status=installer.main([*args,'--upgrade','prepare','--output','json'],host())
            self.assertEqual(status,1)
            self.assertIn('requires a fresh installation',out.getvalue()+err.getvalue())
            self.assertEqual(machine.running_target,before);self.assertEqual(keep.read_bytes(),b'legacy data remains')
            self.assertEqual((machine.root/'etc/dsh-phalanx/environment').read_bytes(),config)
            self.assertFalse((machine.root/'etc/dsh-phalanx/maintenance').exists())
            self.assertFalse(any('database-wait' in call for call in machine.calls))
            state=machine.root/'etc/dsh-phalanx/install-state.json';receipt=json.loads(state.read_text());receipt['version']='v'+LEGACY;receipt.pop('channel',None);state.write_text(json.dumps(receipt))
            manifest=machine.root/'etc/dsh-phalanx/installed-manifest.json';manifest.unlink()
            # The new floor is authoritative even if a future release omits the legacy boundary.
            target['compatibility'].pop('freshInstallThrough')
            selected={'version':'v'+CURRENT,'manifest':target,'manifestSha256':'d'*64}
            service=UpgradeExecutor(host,selector=lambda *a:selected,version_lister=lambda *args:[selected['version']])
            path=str(machine.root/'control.sock');server=ControlServer(path,service,1001,peer_reader=lambda _:1001)
            thread=threading.Thread(target=server.serve_forever);thread.start()
            try:
                client=UnixClient(path);client.request('POST','/control',body=json.dumps({'action':'check'}),headers={'Content-Type':'application/json'})
                response=client.getresponse();result=json.loads(response.read());client.close()
                self.assertEqual(response.status,200);self.assertEqual(result['check']['status'],'incompatible')
                self.assertTrue(result['check']['freshInstallRequired'])
                self.assertEqual(result['check']['versions'][0]['outcomeCode'],'update.below-floor')
                self.assertIn('requires a fresh installation',result['check']['reason'])
                client=UnixClient(path);client.request('POST','/control',body=json.dumps({'action':'prepare','version':'v'+CURRENT,'manifestSha256':'d'*64}),headers={'Content-Type':'application/json'})
                response=client.getresponse();refusal=json.loads(response.read());client.close()
                self.assertEqual(response.status,409);self.assertIn('requires a fresh installation',refusal['error']);self.assertFalse(manifest.exists())
                self.assertFalse(any('database-wait' in call for call in machine.calls))
            finally:server.shutdown();server.server_close();thread.join()

    def test_http_uses_active_database_reader_and_bounds_unavailable_or_malformed_status(self):
        for exit_code,body,expected in [(0,json.dumps({'state':'connected','schemaVersion':POLICY['compatibility']['accounts']['sourceMax']}),'available'),
                (1,'private-password-diagnostic','incompatible'),(124,'','incompatible'),(0,'not-json','incompatible'),
                (0,json.dumps({'state':'connected','schemaVersion':True}),'incompatible')]:
            with self.subTest(exit=exit_code,body=body),tempfile.TemporaryDirectory() as directory:
                machine=Machine(directory);machine.database_status_exit=exit_code;machine.database_status_body=body
                def host():
                    h=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0)
                    h.request=lambda url,**k:json.dumps({'version':CURRENT,'releaseNotes':'Update'}).encode() if url.endswith('/release.json') else b'login';return h
                args,source=bundle(machine,PREVIOUS,'a',fresh=True,policy=PREVIOUS_POLICY)
                with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):self.assertEqual(installer.main(args,host()),0)
                environment=machine.root/'etc/dsh-phalanx/environment'
                with environment.open('a') as f:f.write('DSH_PHALANX_DATABASE_CONFIG_FILE=/var/lib/dsh-phalanx/keys/active-external.json\n')
                target=copy.deepcopy(source);target['targetVersion']=CURRENT;target['compatibility']=copy.deepcopy(POLICY['compatibility'])
                selected={'version':'v'+CURRENT,'manifest':target,'manifestSha256':'d'*64}
                service=UpgradeExecutor(host,selector=lambda *a:selected,version_lister=lambda *args:[selected['version']])
                path=str(machine.root/'control.sock');server=ControlServer(path,service,1001,peer_reader=lambda _:1001)
                thread=threading.Thread(target=server.serve_forever);thread.start()
                try:
                    client=UnixClient(path);client.request('POST','/control',body=json.dumps({'action':'check'}),headers={'Content-Type':'application/json'})
                    response=client.getresponse();result=json.loads(response.read());client.close()
                    self.assertEqual(response.status,200);self.assertEqual(result['check']['status'],expected)
                    reads=[row for row in machine.fact_requests if row['request']['fact']=='schemas'];self.assertEqual(len(reads),1)
                    self.assertEqual(str(machine.root/'var/lib/dsh-phalanx/keys/active-external.json'),reads[0]['request']['configFile'])
                    self.assertIn(str(Path(machine.running_target)/'node/bin/node'),reads[0]['arguments']);self.assertIn('20s',reads[0]['arguments']);self.assertIn('--kill-after=5s',reads[0]['arguments'])
                    if expected=='incompatible':self.assertIn('Platform database status is unavailable',result['check']['reason'])
                    self.assertNotIn('private-password-diagnostic',json.dumps(result))
                finally:server.shutdown();server.server_close();thread.join()

    def test_check_returns_each_releases_own_conclusion(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=Machine(directory);machine.database_status_body=json.dumps({'state':'connected','schemaVersion':15});notes=['Release']
            def host():
                h=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0)
                h.request=lambda url,**kw:json.dumps({'version':url.split('/download/v')[1].split('/')[0],'releaseNotes':notes[0]}).encode() if '/download/v' in url else b'login'
                return h
            args,source=bundle(machine,PREVIOUS,'a',fresh=True,policy=PREVIOUS_POLICY)
            with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):self.assertEqual(installer.main(args,host()),0)
            intermediate=copy.deepcopy(source);intermediate['targetVersion']='0.1.27';intermediate['compatibility']=copy.deepcopy(POLICY['compatibility'])
            latest=copy.deepcopy(intermediate);latest['targetVersion']='0.1.28';latest['compatibility'].update(source={'min':'0.1.26','maxExclusive':'0.1.28'},breakpoints=[{'version':'0.1.27','environmentEpoch':1}])
            targets={'v0.1.27':{'version':'v0.1.27','manifest':intermediate,'manifestSha256':'c'*64},'v0.1.28':{'version':'v0.1.28','manifest':latest,'manifestSha256':'d'*64}}
            def select(h,args,path):return targets['v0.1.28' if args.version=='latest' else args.version]
            service=UpgradeExecutor(host,selector=select,version_lister=lambda *args:['v0.1.27','v0.1.28'])
            result=service.check()['check']
            self.assertEqual(result['outcomeCode'],'update.breakpoint-required');self.assertEqual(result['requiredVersion'],'0.1.27')
            self.assertEqual([(row['version'],row['outcomeCode']) for row in result['versions']],
                             [('v0.1.27','update.available'),('v0.1.28','update.breakpoint-required')])
            self.assertEqual(result['versions'][0]['manifestSha256'],'c'*64)
            latest['compatibility']['minimumReader']='0.1.29'
            refused=service.check()['check']
            self.assertEqual(refused['outcomeCode'],'update.reader-update-required')
            self.assertEqual([(row['version'],row['outcomeCode']) for row in refused['versions']],
                             [('v0.1.27','update.available'),('v0.1.28','update.reader-update-required')])
            latest['compatibility']['minimumReader']='0.1.27';notes[0]='x'*32768
            bounded=service.check()
            self.assertEqual(bounded['check'].get('outcomeCode'),'update.breakpoint-required')
            self.assertEqual(bounded['check']['releaseNotes'],notes[0])
            self.assertLess(len(json.dumps(bounded).encode()),64*1024)
            notes[0]='中'*20000;bounded=service.check()
            self.assertEqual(bounded['check'].get('outcomeCode'),'update.breakpoint-required')
            self.assertLess(len(json.dumps(bounded,ensure_ascii=False).encode()),64*1024)
            path=str(machine.root/'notes-control.sock');server=ControlServer(path,service,1001,peer_reader=lambda _:1001)
            thread=threading.Thread(target=server.serve_forever);thread.start()
            try:
                client=UnixClient(path);client.request('POST','/control',body=json.dumps({'action':'check'}),headers={'Content-Type':'application/json'})
                response=client.getresponse();body=response.read();client.close()
                self.assertEqual(response.status,200);self.assertEqual(int(response.getheader('Content-Length')),len(body))
                self.assertIn('中'.encode(),body);self.assertLess(len(body),128*1024)
                self.assertEqual(json.loads(body)['check']['outcomeCode'],'update.breakpoint-required')
            finally:server.shutdown();server.server_close();thread.join()

    def test_check_samples_once_per_request_and_rechecks_changed_connection_identity(self):
        for changed in ('none','configuration','key','source'):
            with self.subTest(changed=changed),tempfile.TemporaryDirectory() as directory:
                machine=Machine(directory);machine.database_schema=15;mutated=[]
                def host():
                    h=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0)
                    def request(url,**kwargs):
                        if url.endswith('/release.json'):
                            if changed!='none' and not mutated:
                                if changed=='configuration':config.write_text(json.dumps({'masterKeyPath':str(key),'rotation':1}))
                                elif changed=='key':key.write_bytes(b'j'*32)
                                else:
                                    with (machine.root/'etc/dsh-phalanx/environment').open('a') as file:file.write('DSH_PHALANX_ALLOWED_MODEL="changed-model"\n')
                                machine.database_schema=16;mutated.append(True)
                            return json.dumps({'version':CURRENT,'releaseNotes':'Update'}).encode()
                        return b'login'
                    h.request=request;return h
                args,source=bundle(machine,PREVIOUS,'a',fresh=True,policy=PREVIOUS_POLICY)
                with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):self.assertEqual(installer.main(args,host()),0)
                config=machine.root/'var/lib/dsh-phalanx/keys/database.json';config.parent.mkdir(parents=True,exist_ok=True)
                key=config.with_name('fixture.key');key.write_bytes(b'k'*32);key.chmod(0o600);config.write_text(json.dumps({'masterKeyPath':str(key)}));config.chmod(0o600)
                target=copy.deepcopy(source);target['targetVersion']=CURRENT;target['compatibility']=copy.deepcopy(POLICY['compatibility'])
                selected={'version':'v'+CURRENT,'manifest':target,'manifestSha256':'d'*64};machine.fact_requests.clear()
                service=UpgradeExecutor(host,selector=lambda *args:selected,version_lister=lambda *args:[selected['version']])
                try:result=service.handle({'action':'check'})['check']
                finally:service.close()
                self.assertEqual(result['status'],'available' if changed=='none' else 'incompatible')
                self.assertEqual([row['request']['fact'] for row in machine.fact_requests],['check'] if changed=='none' else ['check','schemas'])

    def test_current_version_does_not_turn_an_early_schema_failure_into_a_check_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=Machine(directory);machine.database_status_exit=2
            def host():
                h=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0)
                h.request=lambda url,**kwargs:json.dumps({'version':PREVIOUS,'releaseNotes':'Current'}).encode() if url.endswith('/release.json') else b'login';return h
            args,manifest=bundle(machine,PREVIOUS,'a',fresh=True,policy=PREVIOUS_POLICY)
            with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):self.assertEqual(installer.main(args,host()),0)
            receipt=machine.root/'etc/dsh-phalanx/install-state.json';state=json.loads(receipt.read_text());state.update(version='v'+PREVIOUS,channel={'kind':'formal','baseUrl':'https://github.com/dake6767/dsh-phalanx/releases'});receipt.write_text(json.dumps(state))
            config=machine.root/'var/lib/dsh-phalanx/keys/database.json';config.parent.mkdir(parents=True,exist_ok=True)
            key=config.with_name('fixture.key');key.write_bytes(b'k'*32);key.chmod(0o600);config.write_text(json.dumps({'masterKeyPath':str(key)}));config.chmod(0o600)
            selected={'version':'v'+PREVIOUS,'manifest':manifest,'manifestSha256':'d'*64};machine.fact_requests.clear()
            service=UpgradeExecutor(host,selector=lambda *args:selected,version_lister=lambda *args:[selected['version']])
            try:result=service.handle({'action':'check'})['check']
            finally:service.close()
            self.assertEqual(result['status'],'current');self.assertEqual(result['outcomeCode'],'update.current')
            self.assertEqual([row['request']['fact'] for row in machine.fact_requests],['check'])

    def test_current_source_reports_its_own_registered_schemas_without_platform_cli(self):
        from installer_upgrade_host import UpgradeHost
        with tempfile.TemporaryDirectory() as directory:
            machine=Machine(directory);calls=[];requests=[]
            def command(arguments,**kwargs):
                calls.append(arguments)
                if kwargs.get('stdin'):requests.append(json.load(kwargs['stdin']))
                return subprocess.CompletedProcess(arguments,0,json.dumps({'schemas':[{'name':'dsh_phalanx','version':15},{'name':'isolated_probe','version':2}]}),'')
            h=installer.Host(machine.root,command,system='Linux',machine='x86_64',uid=0)
            target=machine.root/'opt/dsh-phalanx/releases/source';target.mkdir(parents=True);(target/'start').write_text('fixture entry')
            config=machine.root/'fixture/database.json';config.parent.mkdir();config.write_text('{}')
            source={'manifest':{'targetVersion':'0.1.27','compatibility':{'schemas':[{'name':'dsh_phalanx'},{'name':'isolated_probe'}]}},'target':str(target),'uid':1001,
                    'values':{'DSH_PHALANX_DATA_ROOT':'/fixture/data','DSH_PHALANX_DATABASE_CONFIG_FILE':'/fixture/database.json'}}
            self.assertEqual(UpgradeHost(h).schema(source),{'dsh_phalanx':15,'isolated_probe':2})
            self.assertFalse(any(argument.endswith('/start') for call in calls for argument in call),calls)
            self.assertEqual(requests[0]['schemas'],['dsh_phalanx','isolated_probe'])

    def test_new_target_schema_facts_can_complete_the_upgrade(self):
        gate=type('Gate',(),{'preflight':lambda self,ports:None,'install':lambda self,host,uid:None,'close':lambda self,ports:None,'open':lambda self:None})
        for extra,phase,fault in [(None,'succeeded',None),(3,'succeeded',None),(2,'restored',None),(None,'succeeded','before-cleanup'),(2,'restored','after-delete'),(2,'recovery-failed','restore-fails'),(None,'restored','backup-incomplete')]:
            with self.subTest(extra=extra,fault=fault),tempfile.TemporaryDirectory() as directory,patch('installer_upgrade_host.LinuxAdmissionGate',gate):
                machine=Machine(directory);machine.database_schema=15
                def command(args,**kwargs):
                    if fault=='restore-fails' and len(args)>1 and Path(args[1]).name=='database-adapter.mjs':
                        stream=kwargs['stdin'];position=stream.tell();action=json.load(stream)['action'];stream.seek(position)
                        if action=='restore':return subprocess.CompletedProcess(args,1,'','fixture restoration unavailable')
                    if any(Path(argument).name=='executor-facts.mjs' for argument in args):
                        stream=kwargs['stdin'];position=stream.tell();request=json.load(stream);stream.seek(position)
                        if request['fact']=='schemas':return subprocess.CompletedProcess(args,0,json.dumps({'schemas':[{'name':name,'version':15 if name=='dsh_phalanx' else extra} for name in request['schemas']]}),'')
                    if 'podman' in args and args[-3:]==['info','--format','json']:return subprocess.CompletedProcess(args,0,json.dumps({'host':{'security':{'rootless':True},'cgroupVersion':'v2'},'store':{'graphRoot':'/images','imageCopyTmpDir':'/image-tmp'}}),'')
                    return machine.command(args,**kwargs)
                host=installer.Host(machine.root,command,system='Linux',machine='x86_64',uid=0);host.request=lambda *a,**kw:b'login'
                args,_=bundle(machine,'0.1.26','a',fresh=True,policy=PREVIOUS_POLICY)
                with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):self.assertEqual(installer.main(args,host),0)
                (machine.root/'var/lib/dsh-phalanx/data').mkdir(exist_ok=True)
                build=Path(machine.running_target)/'build-info.json';info=json.loads(build.read_text())
                info['versions']={'postgres':{'image':'docker.io/library/postgres:17.11-bookworm','digest':'sha256:'+'b'*64}}
                build.write_text(json.dumps(info))
                keys=machine.root/'var/lib/dsh-phalanx/keys';keys.mkdir(exist_ok=True)
                (keys/'master.key').write_bytes(b'original-key');(keys/'database.json').write_bytes(b'original-connection')
                database_unit=machine.root/'var/lib/dsh-phalanx/.config/systemd/user/dsh-phalanx-postgres.service'
                database_unit.write_bytes(b'original-database-unit')
                def target_migration(target):
                    if json.loads((target/'build-info.json').read_text())['commit']=='d'*40:
                        (keys/'master.key').write_bytes(b'changed-key');(keys/'database.json').write_bytes(b'changed-connection')
                        database_unit.write_bytes(b'changed-database-unit')
                        if extra==2:
                            identity=(machine.root/'var/lib/dsh-phalanx-updater/current').read_text().strip()
                            orphan=machine.root/'var/lib/dsh-phalanx-updater'/identity/'backup/database/.database-tool-11111111-1111-4111-8111-111111111111'
                            orphan.mkdir(mode=0o700);(orphan/'pgpass').write_bytes(b'fixture-private-postgres');(orphan/'pgpass').chmod(0o600)
                machine.after_start=target_migration
                args=machine.make_bundle('v0.1.27-rc.1','d','e');del args[4:6]
                file=Path(args[3])/'manifest.json';target=json.loads(file.read_text())
                target.update(copy.deepcopy(POLICY),schema=2,storage={key:1 for key in ('platformArchiveBytes','platformExpandedBytes','imageDownloadBytes','imageExpandedBytes')},updater='{}')
                if extra is not None:target['compatibility']['schemas'].append({'name':'isolated_probe','sourceMin':0,'sourceMax':0,'target':3})
                file.write_text(json.dumps(target))
                with contextlib.redirect_stdout(out:=io.StringIO()),contextlib.redirect_stderr(io.StringIO()):code=installer.main([*args,'--upgrade','prepare','--output','json'],host)
                self.assertEqual(code,0,out.getvalue());operation=json.loads(out.getvalue())['operation']
                apply=['--upgrade','apply','--operation',operation['id'],'--yes','--output','json']
                if fault in ('before-cleanup','after-delete'):
                    import shutil
                    atomic=host.atomic;remove=shutil.rmtree;interrupted=[]
                    def interrupted_atomic(path,content,*args,**kwargs):
                        result=atomic(path,content,*args,**kwargs)
                        if str(path).endswith('/operation.json') and json.loads(content)['phase'] in ('succeeded','restored'):
                            interrupted.append('terminal-written')
                            raise KeyboardInterrupt('process interrupted after terminal journal write')
                        return result
                    def interrupted_remove(path,*args,**kwargs):
                        result=remove(path,*args,**kwargs)
                        if Path(path).name=='backup':
                            interrupted.append('backup-deleted');raise KeyboardInterrupt('process interrupted after backup deletion')
                        return result
                    with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()),patch.object(host,'atomic',interrupted_atomic if fault=='before-cleanup' else atomic),patch('installer_cleanup.shutil.rmtree',side_effect=interrupted_remove if fault=='after-delete' else remove):
                        self.assertEqual(installer.main(apply,host),130)
                    self.assertTrue(interrupted)
                    with contextlib.redirect_stdout(out:=io.StringIO()),contextlib.redirect_stderr(io.StringIO()):code=installer.main(['--upgrade','recover','--operation',operation['id'],'--output','json'],host)
                elif fault=='backup-incomplete':
                    original_open=io.open
                    configuration=machine.root/'etc/dsh-phalanx/environment'
                    def interrupted_read(path,mode='r',*args,**kwargs):
                        if not isinstance(path,int) and Path(path)==configuration and mode=='rb':raise OSError('fixture backup read failed')
                        return original_open(path,mode,*args,**kwargs)
                    with patch('io.open',side_effect=interrupted_read),contextlib.redirect_stdout(out:=io.StringIO()),contextlib.redirect_stderr(io.StringIO()):code=installer.main(apply,host)
                else:
                    with contextlib.redirect_stdout(out:=io.StringIO()),contextlib.redirect_stderr(io.StringIO()):code=installer.main(apply,host)
                self.assertEqual(json.loads(out.getvalue())['operation']['phase'],phase,out.getvalue());self.assertEqual(code,0 if phase=='succeeded' else 1)
                self.assertEqual((machine.root/'var/lib/dsh-phalanx-updater'/operation['id']/'backup').exists(),phase=='recovery-failed')
                if phase=='restored':
                    self.assertEqual((keys/'master.key').read_bytes(),b'original-key')
                    self.assertEqual((keys/'database.json').read_bytes(),b'original-connection')
                    self.assertEqual(database_unit.read_bytes(),b'original-database-unit')
                    self.assertFalse((machine.root/'var/lib/dsh-phalanx-updater'/operation['id']/'backup/database/.database-tool-11111111-1111-4111-8111-111111111111').exists())

    def test_missing_legacy_manifest_requires_fresh_install_before_any_metadata_request(self):
        for version,action,fault in ((version,action,fault) for version in ('0.1.1',LEGACY) for action in ('prepare','install','bootstrap') for fault in (None,'candidate','commit')):
            with self.subTest(version=version,action=action,fault=fault),tempfile.TemporaryDirectory() as directory:
                machine=Machine(directory);requests=[]
                def host():
                    h=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0)
                    def request(url,**kw):
                        if url.startswith('https://'):requests.append(url)
                        return b'login'
                    h.request=request;return h
                args=machine.make_bundle('v0.1.1-rc.4') if version=='0.1.1' else bundle(machine,version,'a')[0]
                with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):self.assertEqual(installer.main(args,host()),0)
                state=machine.root/'etc/dsh-phalanx/install-state.json';receipt=json.loads(state.read_text());receipt['version']='v'+version;receipt.pop('channel',None)
                if fault=='candidate':receipt['version']+='-rc.1'
                if fault=='commit':receipt['commit']='invalid'
                state.write_text(json.dumps(receipt))
                manifest=machine.root/'etc/dsh-phalanx/installed-manifest.json';manifest.unlink()
                before=state.read_bytes();args,_=bundle(machine,CURRENT,'d',fresh=True)
                machine.calls.clear();requests.clear()
                with contextlib.redirect_stdout(out:=io.StringIO()),contextlib.redirect_stderr(err:=io.StringIO()):status=installer.main([*args,*([] if action=='install' else ['--upgrade',action]),'--output','json'],host())
                self.assertEqual(status,1)
                if fault is None:
                    self.assertIn('requires a fresh installation',out.getvalue()+err.getvalue());self.assertEqual(requests,[])
                else:self.assertNotIn('requires a fresh installation',out.getvalue()+err.getvalue())
                self.assertFalse(manifest.exists());self.assertEqual(state.read_bytes(),before)
                self.assertFalse(any('database-wait' in call for call in machine.calls))

if __name__=='__main__':unittest.main()
