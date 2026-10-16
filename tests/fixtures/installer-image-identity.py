"""Image identity through the public installer with the existing external OS seam."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import http.client
import socket
import threading
import time
import runpy
import sqlite3
import subprocess
from unittest.mock import patch
from release_asset_support import stable_assets
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts/install'))
from installer_executor import UpgradeExecutor
from installer_executor_server import ControlServer
import unittest
from installer_contract_support import installer,InstallationMachine,with_image_identity



class ImageIdentity(unittest.TestCase):
    def test_rejects_wrong_hash_revision_digest_architecture_and_command_before_start(self):
        for fault in ('hash','revision','digest','architecture','command','extension'):
            with self.subTest(fault=fault),tempfile.TemporaryDirectory() as directory:
                machine=InstallationMachine(directory);args=machine.make_bundle('v0.1.1-rc.1')
                with_image_identity(machine,args)
                facts=machine.image_facts
                if fault=='hash':facts['Config']['Labels']['dsh.input.sha256']='a'*64
                elif fault=='revision':facts['Config']['Labels']['dsh.revision']='a'*40
                elif fault=='digest':facts['Digest']='sha256:'+'a'*64
                elif fault=='architecture':facts['Architecture']='arm64'
                elif fault=='command':facts['Config']['Cmd']=[]
                else:
                    path=Path(args[3])/'manifest.json';value=json.loads(path.read_text());value['imageIdentity']=None;path.write_text(json.dumps(value))
                host=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0);host.request=lambda *a,**k:b'login'
                with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):self.assertEqual(installer.main(args,host),1)
                self.assertFalse(machine.active)

    def test_unix_http_prepares_both_formats_and_restores_verified_source_on_failure(self):
        UpgradeMachine=runpy.run_path(str(Path(__file__).with_name('upgrade-machine.py')))['UpgradeMachine']
        Gate=type('Gate',(),{'preflight':lambda self,ports:None,'install':lambda self,host,uid:None,'close':lambda self,ports:None,'open':lambda self:None})
        class Client(http.client.HTTPConnection):
            def __init__(self,path):super().__init__('localhost',timeout=5);self.path=path
            def connect(self):self.sock=socket.socket(socket.AF_UNIX);self.sock.connect(self.path)
        for source_independent in (False,True,'reuse'):
            with self.subTest(source_independent=source_independent),tempfile.TemporaryDirectory() as directory,patch('installer_upgrade_host.LinuxAdmissionGate',Gate),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                machine=UpgradeMachine(directory);tick=[0];fault=[False];original=[None];bundle=[None]
                def factory():
                    def command(args,**kwargs):
                        if 'podman' in args and args[-3:]==['info','--format','json']:
                            return subprocess.CompletedProcess(args,0,json.dumps({'host':{'security':{'rootless':True},'cgroupVersion':'v2'},'store':{'graphRoot':'/images','imageCopyTmpDir':'/image-tmp'}}),'')
                        return machine.command(args,**kwargs)
                    host=installer.Host(machine.root,command,system='Linux',machine='x86_64',uid=0);host.clock=lambda:tick[0]
                    def request(url,**kwargs):
                        if url.startswith('https://github.com/'):
                            return (bundle[0]/url.rsplit('/',1)[1]).read_bytes()
                        if fault[0] and machine.running_target!=original[0]:tick[0]+=100;raise OSError('target unavailable')
                        return b'login'
                    host.request=request;return host
                args=machine.make_bundle('v0.1.16-rc.1')
                source_path=Path(args[3])/'manifest.json';source=json.loads(source_path.read_text())
                storage={key:1 for key in ('platformArchiveBytes','platformExpandedBytes','imageDownloadBytes','imageExpandedBytes')}
                source.update(schema=2,compatibility={'protocol':3,'source':{'min':'0.1.13','maxExclusive':'0.1.16'},'accounts':{'sourceMin':5,'sourceMax':5,'target':5},'environmentEpoch':1},acceptancePolicy={'ticket':8,'checks':['ci','linux','cleanInstall','upgrade','review']},storage=storage,updater='{}')
                source_path.write_text(json.dumps(source))
                if source_independent:with_image_identity(machine,args)
                self.assertEqual(installer.main(args,factory()),0);original[0]=machine.running_target
                data=machine.root/'var/lib/dsh-phalanx/data';data.mkdir()
                with sqlite3.connect(data/'community-accounts.db') as connection:connection.execute('PRAGMA user_version=5')
                (data/'keep').write_text('member data')
                machine.calls.clear()
                args=machine.make_bundle('v0.1.17-rc.1','d','c' if source_independent=='reuse' else 'e');bundle[0]=Path(args[3])
                if not source_independent or source_independent=='reuse':with_image_identity(machine,args)
                path=bundle[0]/'manifest.json';manifest=json.loads(path.read_text())
                manifest.update(schema=2,compatibility={'protocol':3,'source':{'min':'0.1.16','maxExclusive':'0.1.17'},'accounts':{'sourceMin':5,'sourceMax':5,'target':5},'environmentEpoch':1,'sourceDshRevisions':['b'*40]},acceptancePolicy={'ticket':8,'checks':['ci','linux','cleanInstall','upgrade','review']},storage=storage,updater='{}',dshRevision='c'*40)
                if 'imageIdentity' in manifest:manifest['imageIdentity']['dshRevision']='c'*40
                machine.image_facts['Config']['Labels']['dsh.revision']='c'*40
                if source_independent=='reuse':
                    manifest['dshRevision']='b'*40;manifest['imageIdentity']['dshRevision']='b'*40;machine.image_facts['Config']['Labels']['dsh.revision']='b'*40
                path.write_text(json.dumps(manifest));stable_assets(bundle[0],manifest)
                service=UpgradeExecutor(factory);address=str(machine.root/'control.sock')
                server=ControlServer(address,service,1001,peer_reader=lambda socket:1001)
                thread=threading.Thread(target=server.serve_forever);thread.start()
                def call(value):
                    client=Client(address);client.request('POST','/control',json.dumps(value),{'Content-Type':'application/json'})
                    response=client.getresponse();body=json.loads(response.read());client.close();self.assertEqual(response.status,200,body);return body
                def wait(phase):
                    deadline=time.monotonic()+10
                    while time.monotonic()<deadline:
                        status=call({'action':'status'})
                        if status['operation']['phase']==phase:return status
                        if status['operation']['phase'] in ('failed','recovery-failed'):self.fail(str(status))
                        time.sleep(0.01)
                    self.fail(str(status))
                try:
                    checked=call({'action':'check'})['check'];self.assertEqual(checked['status'],'available',checked)
                    call({'action':'prepare','version':checked['version'],'manifestSha256':checked['manifestSha256']})
                    prepared=wait('prepared');self.assertEqual(machine.running_target,original[0])
                    fault[0]=True
                    with contextlib.redirect_stdout(applied:=io.StringIO()):
                        status=installer.main(['--upgrade','apply','--operation',prepared['operation']['id'],'--yes','--output','json'],factory())
                    self.assertEqual(status,1,applied.getvalue())
                    self.assertEqual(json.loads(applied.getvalue())['operation']['phase'],'restored')
                    restored=call({'action':'status'});self.assertEqual(restored['runningVersion'],'v0.1.16-rc.1')
                    self.assertEqual(machine.running_target,original[0]);self.assertEqual((data/'keep').read_text(),'member data')
                    if source_independent=='reuse':self.assertFalse(any('pull' in call or 'load' in call for call in machine.calls))
                finally:
                    server.shutdown();server.server_close();thread.join()
                    with service.mutex:pass

    def test_new_identity_is_independent_of_platform_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstallationMachine(directory);args=machine.make_bundle('v0.1.1-rc.1')
            with_image_identity(machine,args)
            host=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0)
            host.request=lambda *args,**kwargs:b'login'
            with contextlib.redirect_stdout(output:=io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                status=installer.main([*args,'--output','json'],host)
            self.assertEqual(status,0,output.getvalue())
            self.assertTrue(machine.active)
            self.assertEqual(json.loads(output.getvalue())['imageDigest'],'sha256:'+'c'*64)

if __name__=='__main__':unittest.main()
