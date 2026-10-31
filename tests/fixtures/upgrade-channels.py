"""Channel state and shared CLI/Web decisions at the existing installer OS seam."""
import contextlib
import copy
import hashlib
import io
import json
from pathlib import Path
import runpy
import subprocess
import tempfile
import threading
from types import SimpleNamespace
import unittest
import urllib.error
from unittest.mock import patch
from installer_contract_support import installer
from installer_executor import UpgradeExecutor
from installer_executor_server import ControlServer
from release_asset_support import stable_assets, candidate_assets

support=runpy.run_path(str(Path(__file__).with_name('upgrade-database.py')))
FORMAL='https://github.com/dake6767/dsh-phalanx/releases'
CANDIDATES='https://github.com/dake6767/dsh-phalanx-candidates/releases'
CHANNEL='https://raw.githubusercontent.com/dake6767/dsh-phalanx-candidates/main/candidate-channel.json'


class ChannelMachine(support['Machine']):
    def __init__(self,root):
        super().__init__(root);self.database_schema=15
    def command(self,args,**kwargs):
        if 'podman' in args and args[-3:]==['info','--format','json']:
            return subprocess.CompletedProcess(args,0,json.dumps({'host':{'security':{'rootless':True},'cgroupVersion':'v2'},'store':{'graphRoot':'/images','imageCopyTmpDir':'/image-tmp'}}),'')
        return super().command(args,**kwargs)


def command(fixture,args):
    if '--output' not in args:args=[*args,'--output','json']
    with contextlib.redirect_stdout(out:=io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
        code=installer.main(args,fixture.host())
    return code,json.loads(out.getvalue())


@contextlib.contextmanager
def web_control(fixture):
    service=UpgradeExecutor(fixture.host)
    path=str(fixture.machine.root/'control.sock');server=ControlServer(path,service,1001,peer_reader=lambda _:1001)
    thread=threading.Thread(target=server.serve_forever);thread.start()
    def request(value):
        client=support['UnixClient'](path);client.request('POST','/control',body=json.dumps(value),headers={'Content-Type':'application/json'})
        response=client.getresponse();body=json.loads(response.read());client.close()
        return response.status,body
    try:yield request
    finally:server.shutdown();server.server_close();thread.join();Path(path).unlink()


def web_check(fixture):
    with web_control(fixture) as request:return request({'action':'check'})


@contextlib.contextmanager
def installed_candidate(legacy=False):
    with tempfile.TemporaryDirectory() as directory:
        machine=ChannelMachine(directory);machine.database_schema=15
        args,manifest=support['bundle'](machine,'0.1.27','a',fresh=True)
        args[1]='run-123';manifest.update(tag='run-123',runId='123');manifest['image']['tag']='run-123'
        bundle=Path(args[3]);(bundle/'manifest.json').write_text(json.dumps(manifest));original=(bundle/'manifest.json').read_bytes()
        release=stable_assets(bundle,manifest);release['versions']=['v0.1.27'];(bundle/'release.json').write_text(json.dumps(release))
        proof=candidate_assets(bundle,manifest);proof['workflow'].update(ref='refs/heads/candidate/0.1.27',commit=manifest['commit'])
        (bundle/'candidate.json').write_text(json.dumps(proof))
        metadata={FORMAL+'/latest/download/release.json':json.dumps(release).encode(),**{FORMAL+'/download/v0.1.27/'+file.name:file.read_bytes() for file in bundle.iterdir() if file.is_file()}}
        requests=[];failures={}
        def request(url,**kwargs):
            requests.append(url)
            if url in failures:raise failures[url]
            if url in metadata:return metadata[url]
            if url.startswith('http://'):return b'login'
            if url.startswith((FORMAL+'/',CANDIDATES+'/')) or url==CHANNEL:
                raise installer.InstallError('Controlled release asset absent') from urllib.error.HTTPError(url,404,'Not found',{},None)
            raise AssertionError('Unexpected release source: '+url)
        def host():
            value=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0)
            value.request=request;return value
        state=machine.root/'etc/dsh-phalanx/install-state.json'
        fixture=SimpleNamespace(machine=machine,bundle=bundle,manifest=manifest,original=original,state=state,metadata=metadata,requests=requests,failures=failures,host=host)
        code,result=command(fixture,args);assert code==0,result
        if legacy:
            receipt=json.loads(state.read_text());receipt.pop('channel');state.write_text(json.dumps(receipt))
        machine.calls.clear();requests.clear()
        yield fixture


class Channels(unittest.TestCase):
    def test_standalone_cli_keeps_release_fetch_and_carrier_backup_separate(self):
        generated=Path('install.sh').read_text().split("<<'DSH_PHALANX_INSTALLER_PYTHON'\n",1)[1].rsplit('\nDSH_PHALANX_INSTALLER_PYTHON',1)[0]
        embedded={'__name__':'standalone_installer','__file__':str(Path('install.sh').resolve())}
        exec(compile(generated,'install.sh','exec'),embedded)
        with installed_candidate() as fixture:
            before=fixture.state.read_bytes()
            with contextlib.redirect_stdout(out:=io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                code=embedded['main'](['--upgrade','check','--output','json'],fixture.host())
            result=json.loads(out.getvalue())
            self.assertEqual(code,0,result)
            self.assertEqual(result['check']['outcomeCode'],'update.channel-switch')
            self.assertEqual(fixture.state.read_bytes(),before)
            self.assertTrue(fixture.requests)
            source=fixture.machine.root/'carrier';source.write_bytes(b'carrier data')
            target=fixture.machine.root/'carrier-copy'
            copied=embedded['copy_carrier'](source,target)
            self.assertEqual(target.read_bytes(),b'carrier data')
            self.assertEqual(copied,embedded['inventory'](target))

    def test_candidate_cli_and_web_check_offer_the_same_version_from_formal(self):
        for legacy in (False,True):
            with self.subTest(legacyReceipt=legacy),installed_candidate(legacy) as fixture:
                before=fixture.state.read_bytes()
                code,result=command(fixture,['--version','v0.1.27','--upgrade','check','--output','json'])
                self.assertEqual(code,0,result);cli=result['check']
                self.assertEqual(cli['outcomeCode'],'update.channel-switch')
                self.assertEqual(cli['status'],'available');self.assertEqual(cli['version'],'v0.1.27')
                status,result=web_check(fixture);self.assertEqual(status,200)
                self.assertEqual({key:result['check'][key] for key in ('outcomeCode','status','version')},{key:cli[key] for key in ('outcomeCode','status','version')})
                self.assertEqual(fixture.state.read_bytes(),before)
                self.assertNotIn(CHANNEL,fixture.requests)
                self.assertEqual((fixture.bundle/'manifest.json').read_bytes(),fixture.original)
                self.assertFalse(any('stop' in call for call in fixture.machine.calls))
                data=fixture.machine.root/'var/lib/dsh-phalanx/data';data.mkdir(exist_ok=True)
                (data/'mutable-index').write_text('retained index')
                member=fixture.machine.root/'var/lib/dsh-phalanx/data.durable/users/member/home/project'
                member.parent.mkdir(parents=True,exist_ok=True);member.write_text('retained member file');member_before=member.stat().st_mtime_ns
                build=Path(fixture.machine.running_target)/'build-info.json';info=json.loads(build.read_text())
                info['versions']={'postgres':{'image':'docker.io/library/postgres:17.11-bookworm','digest':'sha256:'+'b'*64}};build.write_text(json.dumps(info))
                gate=type('Gate',(),{'preflight':lambda self,ports:None,'install':lambda self,host,uid:None,'close':lambda self,ports:None,'open':lambda self:None})
                with patch('installer_upgrade_host.LinuxAdmissionGate',gate),contextlib.redirect_stdout(applied:=io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(installer.main(['--version','v0.1.27','--upgrade','prepare','--output','json'],fixture.host()),0,applied.getvalue())
                operation=json.loads(applied.getvalue())['operation']
                self.assertEqual(operation['phase'],'prepared')
                with patch('installer_upgrade_host.LinuxAdmissionGate',gate),contextlib.redirect_stdout(applied:=io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(installer.main(['--upgrade','apply','--operation',operation['id'],'--yes','--output','json'],fixture.host()),0,applied.getvalue())
                self.assertEqual(json.loads(applied.getvalue())['operation']['phase'],'succeeded')
                self.assertEqual(json.loads(applied.getvalue())['operation']['cleanup']['status'],'succeeded')
                self.assertEqual(json.loads(fixture.state.read_text()).get('channel'),{'kind':'formal','baseUrl':'https://github.com/dake6767/dsh-phalanx/releases'})
                self.assertEqual(member.read_text(),'retained member file');self.assertEqual(member.stat().st_mtime_ns,member_before)
                self.assertEqual((data/'mutable-index').read_text(),'retained index')
                self.assertEqual((fixture.bundle/'manifest.json').read_bytes(),fixture.original)

    def test_invalid_or_unbound_candidate_metadata_cannot_change_the_deployment(self):
        for fault in ('missing','null','array','commit','checksum','target','reader'):
            with self.subTest(fault=fault),installed_candidate() as fixture:
                for url in list(fixture.metadata):
                    if url.startswith(FORMAL+'/download/'):del fixture.metadata[url]
                fixture.metadata[FORMAL+'/latest/download/release.json']=json.dumps({'version':'0.1.26','versions':['v0.1.26']}).encode()
                target=copy.deepcopy(fixture.manifest)
                if fault=='reader':target['compatibility']['minimumReader']='0.9.0'
                manifest=json.dumps(target).encode();digest=hashlib.sha256(manifest).hexdigest()
                index={'schema':1,'candidate':'run-123','targetVersion':'0.1.27','commit':target['commit'],'manifestSha256':digest}
                if fault=='null':index={'schema':1,'candidate':None}
                elif fault=='array':index['candidate']=['run-123']
                elif fault=='commit':index['commit']='f'*40
                elif fault=='checksum':index['manifestSha256']='f'*64
                elif fault=='target':index['targetVersion']='0.1.28'
                if fault!='missing':fixture.metadata[CHANNEL]=json.dumps(index).encode()
                base=CANDIDATES+'/download/run-123/'
                fixture.metadata.update({base+file.name:file.read_bytes() for file in fixture.bundle.iterdir() if file.is_file()})
                fixture.metadata[base+'manifest.json']=manifest
                proof=json.loads(fixture.metadata[base+'candidate.json']);proof['manifestSha256']=digest;fixture.metadata[base+'candidate.json']=json.dumps(proof).encode()
                before=fixture.state.read_bytes();code,result=command(fixture,['--upgrade','check'])
                if fault=='reader':
                    self.assertEqual(code,0,result);self.assertEqual(result['check']['outcomeCode'],'update.reader-update-required')
                    self.assertEqual(result['check']['version'],'run-123');self.assertEqual(result['check']['requiredVersion'],'0.9.0')
                else:self.assertEqual(code,1,result);self.assertEqual(result['check']['status'],'failed')
                self.assertEqual(fixture.state.read_bytes(),before)
                self.assertFalse(any('stop' in call for call in fixture.machine.calls))

    def test_formal_metadata_failure_does_not_fall_back_to_a_candidate(self):
        for fault in ('server','corrupt','partial','future-error'):
            with self.subTest(fault=fault),installed_candidate() as fixture:
                url=FORMAL+'/download/v0.1.27/manifest.json'
                if fault=='server':fixture.failures[url]=urllib.error.HTTPError(url,500,'Server error',{},None)
                elif fault=='future-error':fixture.failures[url]=installer.InstallError('Opaque future release failure',code='future.vendor-failure')
                elif fault=='corrupt':fixture.metadata[url]=b'{}'
                else:del fixture.metadata[FORMAL+'/download/v0.1.27/release.json']
                before=fixture.state.read_bytes();code,result=command(fixture,['--upgrade','check'])
                self.assertEqual(code,1,result);self.assertNotIn(CHANNEL,fixture.requests)
                if fault=='future-error':
                    status,web=web_check(fixture);self.assertEqual(status,200);self.assertIsNone(web['operation'])
                    self.assertEqual(web['check']['errorCode'],'future.vendor-failure')
                    diagnostic=fixture.machine.root/web['check']['diagnosticLog'].lstrip('/')
                    self.assertEqual(diagnostic.stat().st_mode&0o777,0o600)
                    self.assertIn('Opaque future release failure',diagnostic.read_text())

                self.assertEqual(fixture.state.read_bytes(),before)
                self.assertFalse(any('stop' in call for call in fixture.machine.calls))

    def test_malformed_manifests_are_release_errors_through_cli_and_unix_check_and_prepare(self):
        with installed_candidate() as fixture,web_control(fixture) as request:
            for fault in ('json','utf8','commit','platform','image','files','toolchain'):
                with self.subTest(fault=fault):
                    target=copy.deepcopy(fixture.manifest)
                    if fault=='commit':target['commit']=7
                    elif fault=='platform':target['platform']=[]
                    elif fault=='image':target['image']['digest']=7
                    elif fault=='files':target['files'][next(iter(target['files']))]=7
                    elif fault=='toolchain':target['toolchain']['node']=7
                    body=b'{' if fault=='json' else b'\xff' if fault=='utf8' else json.dumps(target).encode()
                    fixture.metadata[FORMAL+'/download/v0.1.27/manifest.json']=body
                    before=fixture.state.read_bytes()
                    code,cli=command(fixture,['--upgrade','check'])
                    status,checked=request({'action':'check'})
                    prepared_status,prepared=request({'action':'prepare','version':'v0.1.27','manifestSha256':hashlib.sha256(body).hexdigest()})
                    self.assertIsNone(checked['operation'])
                    self.assertEqual({'cli':(code,cli['check']['errorCode']),
                        'check':(status,checked['check']['errorCode']),
                        'prepare':(prepared_status,prepared.get('errorCode'))},
                        {'cli':(1,'release.metadata-invalid'),'check':(200,'release.metadata-invalid'),
                         'prepare':(409,'release.metadata-invalid')})
                    self.assertIsNone(request({'action':'status'})[1]['operation'])
                    self.assertEqual(fixture.state.read_bytes(),before)
                    self.assertNotIn(CHANNEL,fixture.requests)
                    self.assertFalse(any('stop' in call for call in fixture.machine.calls))

    def test_normal_installer_converts_equal_bytes_through_the_upgrade_transaction(self):
        for failure in (False,True):
            with self.subTest(startupFailure=failure),installed_candidate() as fixture:
                (fixture.machine.root/'var/lib/dsh-phalanx/data').mkdir(exist_ok=True)
                build=Path(fixture.machine.running_target)/'build-info.json';info=json.loads(build.read_text())
                info['versions']={'postgres':{'image':'docker.io/library/postgres:17.11-bookworm','digest':'sha256:'+'b'*64}};build.write_text(json.dumps(info))
                gate=type('Gate',(),{'preflight':lambda self,ports:None,'install':lambda self,host,uid:None,'close':lambda self,ports:None,'open':lambda self:None})
                original=fixture.state.read_bytes();starts=[]
                def started(target):
                    starts.append(target)
                    if failure and len(starts)==1:raise installer.InstallError('Controlled startup failure')
                fixture.machine.after_start=started
                with patch('installer_upgrade_host.LinuxAdmissionGate',gate):
                    code,result=command(fixture,['--version','v0.1.27','--yes'])
                self.assertEqual(code,1 if failure else 0,result)
                self.assertEqual(result.get('operation',{}).get('phase'),'restored' if failure else 'succeeded',result)
                self.assertEqual(json.loads(fixture.state.read_text())['channel']['kind'],'candidate' if failure else 'formal')
                if failure:self.assertEqual(fixture.state.read_bytes(),original)

    def test_candidate_channel_discovers_its_latest_target_without_a_same_version_formal(self):
        for version,outcome,status in [('0.1.28','update.available','available'),('0.1.27','update.current','current')]:
            with self.subTest(target=version),installed_candidate() as fixture:
                for url in list(fixture.metadata):
                    if url.startswith(FORMAL+'/download/v0.1.27/'):del fixture.metadata[url]
                fixture.metadata[FORMAL+'/latest/download/release.json']=json.dumps({'version':'0.1.26','versions':['v0.1.26']}).encode()
                if version=='0.1.28':
                    target_args,target=support['bundle'](fixture.machine,version,'d',fresh=True);target_bundle=Path(target_args[3])
                else:target=copy.deepcopy(fixture.manifest);target_bundle=fixture.bundle
                target.update(tag='run-124',runId='124',targetVersion=version,commit='d'*40)
                target['compatibility']['source']['maxExclusive']=version;target['image']['tag']='run-124'
                target['image'].update(digest='sha256:'+'d'*64,reference='ghcr.io/dake6767/dsh-phalanx@sha256:'+'d'*64)
                fixture.machine.image_facts['Digest']=target['image']['digest']
                manifest=json.dumps(target).encode();digest=hashlib.sha256(manifest).hexdigest()
                fixture.metadata[CHANNEL]=json.dumps({'schema':1,'candidate':'run-124','targetVersion':version,'commit':target['commit'],'manifestSha256':digest}).encode()
                base=CANDIDATES+'/download/run-124/'
                fixture.metadata[base+'manifest.json']=manifest
                fixture.metadata.update({base+file.name:file.read_bytes() for file in target_bundle.iterdir() if file.is_file()})
                fixture.metadata[base+'manifest.json']=manifest
                fixture.metadata[base+'SHA256SUMS']=(target_bundle/'SHA256SUMS').read_bytes()
                fixture.metadata[base+'candidate.json']=json.dumps({'schema':1,'repository':'dake6767/dsh-phalanx','candidate':'run-124','runId':'124',
                    'commit':target['commit'],'targetVersion':version,'manifestSha256':digest,
                    'workflow':{'path':'.github/workflows/candidate.yml','ref':'refs/heads/candidate/'+version,'commit':target['commit']}}).encode()
                before=fixture.state.read_bytes()
                code,result=command(fixture,['--upgrade','check','--output','json'])
                self.assertEqual(code,0,result);check=result['check']
                self.assertEqual(check['outcomeCode'],outcome);self.assertEqual(check['status'],status)
                self.assertEqual(check['version'],'run-124');self.assertEqual(check['targetVersion'],version)
                self.assertEqual([row['version'] for row in check['versions']],['run-124'])
                self.assertIn(CHANNEL,fixture.requests)
                self.assertFalse(any('api.github.com' in url for url in fixture.requests))
                self.assertEqual(fixture.state.read_bytes(),before)
                self.assertFalse(any('stop' in call for call in fixture.machine.calls))
                if version=='0.1.28':
                    (fixture.machine.root/'var/lib/dsh-phalanx/data').mkdir(exist_ok=True)
                    fixture.requests.clear()
                    build=Path(fixture.machine.running_target)/'build-info.json';info=json.loads(build.read_text())
                    info['versions']={'postgres':{'image':'docker.io/library/postgres:17.11-bookworm','digest':'sha256:'+'b'*64}};build.write_text(json.dumps(info))
                    gate=type('Gate',(),{'preflight':lambda self,ports:None,'install':lambda self,host,uid:None,'close':lambda self,ports:None,'open':lambda self:None})
                    with patch('installer_upgrade_host.LinuxAdmissionGate',gate):
                        code,result=command(fixture,['--version','run-124','--upgrade','prepare'])
                    self.assertEqual(code,0,result)
                    self.assertEqual(result['operation']['phase'],'prepared',result)
                    self.assertIn(base+'dsh-phalanx-linux-amd64.tar.gz',fixture.requests)
                    self.assertNotIn(CHANNEL,fixture.requests)
                    self.assertFalse(any(url.startswith(FORMAL+'/') for url in fixture.requests))


if __name__=='__main__':unittest.main()
