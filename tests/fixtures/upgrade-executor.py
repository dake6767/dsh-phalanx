"""Restricted public Unix HTTP control seam; Linux peer facts are separate."""
import http.client
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest

class UnixClient(http.client.HTTPConnection):
    def __init__(self,path):super().__init__('localhost',timeout=5);self.path=path
    def connect(self):self.sock=socket.socket(socket.AF_UNIX);self.sock.connect(self.path)

class RestrictedControl(unittest.TestCase):
    def test_closed_protocol_and_peer_scope_before_any_privileged_effect(self):
        from installer_executor_server import ControlServer
        calls=[];peer=[1001]
        class Service:
            def handle(self,value):calls.append(value);return {'operation':None}
        with tempfile.TemporaryDirectory() as directory:
            path=str(Path(directory)/'control.sock')
            server=ControlServer(path,Service(),1001,peer_reader=lambda socket:peer[0]);thread=threading.Thread(target=server.serve_forever);thread.start()
            def request(value):
                client=UnixClient(path);client.request('POST','/control',body=json.dumps(value),headers={'Content-Type':'application/json'})
                response=client.getresponse();body=json.loads(response.read());client.close();return response.status,body
            try:
                self.assertEqual(request({'action':'status'})[0],200)
                self.assertEqual(request({'action':'apply','operation':'11111111-1111-4111-8111-111111111111','command':'arbitrary shell'})[0],400)
                self.assertEqual(request({'action':'prepare','version':'v0.1.4-rc.1','manifestSha256':'a'*64})[0],400)
                self.assertEqual(request({'action':'prepare','version':'https://untrusted.example.test/file','manifestSha256':'a'*64})[0],400)
                peer[0]=1002;self.assertEqual(request({'action':'status'})[0],403)
                self.assertEqual(calls,[{'action':'status'}])
            finally:server.shutdown();server.server_close();thread.join()

    def test_admin_status_projects_bounded_progress_and_redacts_credentials(self):
        from installer_executor import UpgradeExecutor
        from installer_contract_support import installer,InstallationMachine
        import contextlib,io
        with tempfile.TemporaryDirectory() as directory:
            machine=InstallationMachine(directory)
            def host():return installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0)
            with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                h=host();h.request=lambda *a,**k:b'login';self.assertEqual(installer.main(machine.make_bundle('v0.1.1-rc.4'),h),0)
            diagnostic='20261005T000000-12345678.jsonl'
            log=machine.root/'var/log/dsh-phalanx'/diagnostic
            log.write_text(''.join(json.dumps({'phase':'Download','status':'running','message':'authorization: private-fixture','bytes':i,'total':100})+'\n' for i in range(40)))
            job={'id':'11111111-1111-4111-8111-111111111111','phase':'preparing','target':{'version':'v0.1.4','manifest':{'targetVersion':'0.1.4','commit':'b'*40,'files':{'dsh-phalanx-linux-amd64.tar.gz':'d'*64},'image':{'digest':'sha256:'+'e'*64}}},'source':{'version':'v0.1.1','manifest':{'targetVersion':'0.1.1'}},'diagnostic':diagnostic}
            class Port:
                def operation(self,*args):return job
                def source(self):raise installer.InstallError('No verified running process')
            service=UpgradeExecutor(host,port_factory=lambda h:Port())
            result=service.status()
            self.assertIsNone(result['runningVersion']);self.assertEqual(len(result['events']),30)
            self.assertEqual(result['events'][-1]['bytes'],39);self.assertEqual(result['events'][-1]['total'],100)
            self.assertNotIn('private-fixture',json.dumps(result))

    def test_accepted_work_survives_http_disconnect_and_duplicates_share_cli_lock(self):
        import fcntl
        import runpy
        from installer_executor import UpgradeExecutor
        from installer_executor_server import ControlServer
        from installer_contract_support import installer,InstallationMachine
        Port=runpy.run_path(str(Path(__file__).with_name('upgrade-core.py')))['TransactionPort']
        entered=threading.Event();release=threading.Event();completed=threading.Event()
        port=Port();port.old['manifest']={'targetVersion':'0.1.2'}
        target={'version':'v0.1.4','manifestSha256':'c'*64,'manifest':{'targetVersion':'0.1.4','commit':'b'*40,'files':{'dsh-phalanx-linux-amd64.tar.gz':'d'*64},'image':{'digest':'sha256:'+'e'*64}}}
        prepare=port.prepare
        def waiting(job):entered.set();release.wait(5);return prepare(job)
        port.prepare=waiting
        save=port.save
        def observe(job):
            save(job)
            if job['phase'] in ('prepared','succeeded'):completed.set()
        port.save=observe
        with tempfile.TemporaryDirectory() as directory:
            machine=InstallationMachine(directory)
            def host():return installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0)
            import contextlib,io
            with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                h=host();h.request=lambda *a,**k:b'login';self.assertEqual(installer.main(machine.make_bundle('v0.1.1-rc.4'),h),0)
            service=UpgradeExecutor(host,selector=lambda *args:target,port_factory=lambda host:port)
            path=str(machine.root/'control.sock');server=ControlServer(path,service,1001,peer_reader=lambda s:1001)
            thread=threading.Thread(target=server.serve_forever);thread.start()
            def request(value):
                client=UnixClient(path);client.request('POST','/control',body=json.dumps(value),headers={'Content-Type':'application/json'})
                response=client.getresponse();body=json.loads(response.read());client.close();return response.status,body
            value={'action':'prepare','version':'v0.1.4','manifestSha256':'c'*64}
            try:
                first=request(value);self.assertEqual(first[0],200);self.assertTrue(entered.wait(5))
                identity=first[1]['operation']['id'];self.assertEqual(request(value)[1]['operation']['id'],identity)
                self.assertEqual(request({**value,'manifestSha256':'f'*64})[0],409)
                lock=host().path('/run/lock/dsh-phalanx-install.lock')
                with lock.open('w') as file:
                    with self.assertRaises(BlockingIOError):fcntl.flock(file,fcntl.LOCK_EX|fcntl.LOCK_NB)
                release.set();self.assertTrue(completed.wait(5))
                with lock.open('w') as file:fcntl.flock(file,fcntl.LOCK_EX)
                completed.clear()
                with lock.open('w') as file:
                    fcntl.flock(file,fcntl.LOCK_EX|fcntl.LOCK_NB)
                    self.assertEqual(request({'action':'apply','operation':identity})[0],409)
                client=UnixClient(path);client.request('POST','/control',body=json.dumps({'action':'apply','operation':identity}),headers={'Content-Type':'application/json'});client.close()
                self.assertTrue(completed.wait(5))
                with lock.open('w') as file:fcntl.flock(file,fcntl.LOCK_EX)
                self.assertEqual(port.operation(identity)['phase'],'succeeded');self.assertEqual(port.events.count('new-started'),1)
                self.assertEqual(request({'action':'apply','operation':identity})[1]['operation']['phase'],'succeeded')
                self.assertEqual(port.events.count('new-started'),1)
            finally:release.set();server.shutdown();server.server_close();thread.join()

if __name__=='__main__':unittest.main()
