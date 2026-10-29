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
from installer_contract_support import installer
from installer_executor import UpgradeExecutor
from installer_executor_server import ControlServer

Machine=runpy.run_path(str(Path(__file__).with_name('upgrade-machine.py')))['UpgradeMachine']
POLICY=json.loads(Path('release-policy.json').read_text())
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
PREVIOUS_POLICY['compatibility']['source']={'min':LEGACY,'maxExclusive':PREVIOUS}


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
            state=machine.root/'etc/dsh-phalanx/install-state.json';receipt=json.loads(state.read_text());receipt['version']='v'+LEGACY;state.write_text(json.dumps(receipt))
            manifest=machine.root/'etc/dsh-phalanx/installed-manifest.json';manifest.unlink()
            selected={'version':'v'+CURRENT,'manifest':target,'manifestSha256':'d'*64}
            service=UpgradeExecutor(host,selector=lambda *a:selected)
            path=str(machine.root/'control.sock');server=ControlServer(path,service,1001,peer_reader=lambda _:1001)
            thread=threading.Thread(target=server.serve_forever);thread.start()
            try:
                client=UnixClient(path);client.request('POST','/control',body=json.dumps({'action':'check'}),headers={'Content-Type':'application/json'})
                response=client.getresponse();result=json.loads(response.read());client.close()
                self.assertEqual(response.status,200);self.assertEqual(result['check']['status'],'incompatible')
                self.assertTrue(result['check']['freshInstallRequired'])
                self.assertIn('requires a fresh installation',result['check']['reason'])
                client=UnixClient(path);client.request('POST','/control',body=json.dumps({'action':'prepare','version':'v'+CURRENT,'manifestSha256':'d'*64}),headers={'Content-Type':'application/json'})
                response=client.getresponse();refusal=json.loads(response.read());client.close()
                self.assertEqual(response.status,409);self.assertIn('requires a fresh installation',refusal['error']);self.assertFalse(manifest.exists())
                self.assertFalse(any('database-wait' in call for call in machine.calls))
            finally:server.shutdown();server.server_close();thread.join()

    def test_http_uses_active_database_cli_and_bounds_unavailable_or_malformed_status(self):
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
                service=UpgradeExecutor(host,selector=lambda *a:selected)
                path=str(machine.root/'control.sock');server=ControlServer(path,service,1001,peer_reader=lambda _:1001)
                thread=threading.Thread(target=server.serve_forever);thread.start()
                try:
                    client=UnixClient(path);client.request('POST','/control',body=json.dumps({'action':'check'}),headers={'Content-Type':'application/json'})
                    response=client.getresponse();result=json.loads(response.read());client.close()
                    self.assertEqual(response.status,200);self.assertEqual(result['check']['status'],expected)
                    calls=[call for call in machine.calls if 'database-wait' in call];self.assertEqual(len(calls),1)
                    self.assertIn(str(machine.root/'var/lib/dsh-phalanx/keys/active-external.json'),calls[0])
                    self.assertIn(str(Path(machine.running_target)/'start'),calls[0]);self.assertIn('20s',calls[0]);self.assertIn('--kill-after=5s',calls[0])
                    if expected=='incompatible':self.assertIn('Platform database status is unavailable',result['check']['reason'])
                    self.assertNotIn('private-password-diagnostic',json.dumps(result))
                finally:server.shutdown();server.server_close();thread.join()

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
                state=machine.root/'etc/dsh-phalanx/install-state.json';receipt=json.loads(state.read_text());receipt['version']='v'+version
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
