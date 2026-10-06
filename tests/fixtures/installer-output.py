"""Installation output contract and real slow I/O at the public owner seams."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import socket
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from installer_contract_support import installer, InstallationMachine


class InstallerOutput(unittest.TestCase):
    def test_default_human_and_explicit_json_share_safe_diagnostics(self):
        for output in ('human', 'json'):
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); machine = InstallationMachine(root)
                host = installer.Host(root, machine.command, system='Linux', machine='x86_64', uid=0)
                host.request = lambda *args, **kwargs: b'login'
                args = [*machine.make_bundle('v0.1.1-rc.1'), '--output', output]
                with contextlib.redirect_stdout(stdout := io.StringIO()), contextlib.redirect_stderr(stderr := io.StringIO()):
                    self.assertEqual(installer.main(args, host), 0)
                if output == 'json': self.assertEqual(json.loads(stdout.getvalue())['status'], 'installed')
                else:
                    self.assertIn('Next: open this link', stdout.getvalue())
                    self.assertIn('External access: not verified', stdout.getvalue())
                    self.assertNotIn('"platformSha256"', stdout.getvalue())
                self.assertIn('Dependencies', stderr.getvalue())
                logs = list((root/'var/log/dsh-phalanx').glob('*.jsonl'))
                self.assertEqual(len(logs), 1)
                self.assertEqual(logs[0].stat().st_mode & 0o777, 0o600)
                self.assertNotIn('i'*43, logs[0].read_text())
                self.assertNotIn('/bootstrap#', logs[0].read_text())

    def test_closed_tcp_connections_do_not_occupy_the_entry_port(self):
        server=socket.socket(); server.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
        server.bind(('127.0.0.1',0)); server.listen(); port=server.getsockname()[1]
        client=socket.create_connection(('127.0.0.1',port)); accepted,_=server.accept()
        accepted.shutdown(socket.SHUT_WR)
        self.assertEqual(client.recv(1),b'')
        client.close(); accepted.close(); server.close()
        # Use the real Host rather than the installation machine's port seam.
        from installer_host import Host
        host=Host(command=lambda args,**kwargs: subprocess.CompletedProcess(args,0,'OS listener metadata',''))
        self.assertIsNone(host.port_conflict('127.0.0.1',port))
        with socket.socket() as occupied:
            occupied.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            occupied.bind(('127.0.0.1',port)); occupied.listen()
            self.assertIsNotNone(host.port_conflict('127.0.0.1',port))

    def test_public_shell_help_has_an_explicit_machine_result(self):
        script=Path(__file__).resolve().parents[2]/'install.sh'
        result=subprocess.run(['bash',str(script),'--output','json','--help'],capture_output=True,text=True,check=True)
        self.assertEqual(json.loads(result.stdout)['status'],'help')
        if sys.platform != 'linux':
            failure=subprocess.run(['bash',str(script),'--output','json'],capture_output=True,text=True)
            self.assertNotEqual(failure.returncode,0)
            self.assertEqual(json.loads(failure.stdout)['phase'],'Bootstrap')

    def test_json_failure_is_one_result_with_phase_and_instructions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); machine=InstallationMachine(root)
            host=installer.Host(root,machine.command,system='Linux',machine='x86_64',uid=0)
            with contextlib.redirect_stdout(stdout := io.StringIO()), contextlib.redirect_stderr(stderr := io.StringIO()):
                self.assertEqual(installer.main(['--output','json'],host),1)
            receipt=json.loads(stdout.getvalue())
            self.assertEqual(receipt['status'],'failed')
            self.assertEqual(receipt['phase'],'Configuration')
            self.assertIn('sudo bash install.sh',stderr.getvalue())
            self.assertTrue(host.path(receipt['diagnosticLog']).is_file())

    def test_real_child_output_is_live_and_secrets_are_removed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); gate=root/'release'; secret='fixture-super-secret-127'; events=[]
            report=installer.Progress(root, verbose=True)
            report.protect(secret)
            def observe(event):
                events.append(event)
                if event.get('message','').startswith('ready '): gate.touch()
            report.subscribe(observe)
            host=installer.Host(root,system='Linux',machine='x86_64',uid=0); host.progress=report
            code="import pathlib,time; print('ready marker',flush=True); print('Authorization: Bearer fixture-super-secret-127',flush=True); p=pathlib.Path(__import__('sys').argv[1]);\nwhile not p.exists(): time.sleep(.01)\nprint('done',flush=True)"
            with report.stage('Dependencies'), contextlib.redirect_stderr(io.StringIO()):
                result=host.run([sys.executable,'-c',code,str(gate)])
            self.assertEqual(result.returncode,0); self.assertTrue(gate.exists())
            self.assertNotIn(secret,report.log.read_text())
            self.assertNotIn('Bearer fixture',json.dumps(events))
            self.assertIn('[REDACTED',report.log.read_text())

    def test_unregistered_journal_and_command_credentials_fail_closed(self):
        values=['unknown-header-value','unknown-key-value','unknown-url-value','unknown-space-value','unknown-flag-value','unknown-cookie-value','unknown-set-cookie-value']
        carriers=['{"Authorization":"Bearer '+values[0]+'"}', 'DSH_PHALANX_CUSTOM_KEY="'+values[1]+'"', 'dsh web: http://127.0.0.1:9000/?token='+values[2], 'API key: '+values[3], 'tool --custom-token '+values[4], 'Cookie: dsh-phalanx_session='+values[5], '{"Set-Cookie":"session='+values[6]+'; HttpOnly"}']
        with tempfile.TemporaryDirectory() as temporary:
            report=installer.Progress(Path(temporary)); events=[]; report.subscribe(events.append)
            with contextlib.redirect_stderr(stderr := io.StringIO()):
                for carrier in carriers: report.emit(message=carrier)
            for value in values:
                self.assertNotIn(value,stderr.getvalue()); self.assertNotIn(value,report.log.read_text()); self.assertNotIn(value,json.dumps(events))

    def test_quiet_child_reports_waiting_before_it_is_released(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); gate=root/'release'; events=[]
            report=installer.Progress(root)
            def observe(event):
                events.append(event)
                if event.get('message','').startswith('Still working'): gate.touch()
            report.subscribe(observe)
            host=installer.Host(root); host.progress=report
            code="import pathlib,time,sys; p=pathlib.Path(sys.argv[1]); deadline=time.monotonic()+10;\nwhile not p.exists() and time.monotonic()<deadline: time.sleep(.01)\nsys.exit(0 if p.exists() else 2)"
            with contextlib.redirect_stderr(io.StringIO()), report.stage('Quiet dependency command'):
                self.assertEqual(host.run([sys.executable,'-c',code,str(gate)]).returncode,0)
            self.assertTrue(any(row['message'].startswith('Still working') for row in events))

    def test_real_install_lock_reports_waiting_and_json_stays_clean(self):
        import fcntl
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); lock=root/'run/lock/dsh-phalanx-install.lock'; lock.parent.mkdir(parents=True)
            child="from pathlib import Path; from installer_contract_support import installer,InstallationMachine; import sys; m=InstallationMachine(Path(sys.argv[1])); h=installer.Host(m.root,m.command,system='Linux',machine='x86_64',uid=0); h.request=lambda *a,**k:b'login'; sys.exit(installer.main([*m.make_bundle('v0.1.1-rc.1'),'--output','json'],h))"
            with lock.open('w') as held:
                fcntl.flock(held,fcntl.LOCK_EX)
                process=subprocess.Popen([sys.executable,'-c',child,str(root)],cwd=Path(__file__).parent,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
                try:
                    waiting=False
                    for line in process.stderr:
                        if 'Waiting for another installer' in line:
                            waiting=True; fcntl.flock(held,fcntl.LOCK_UN); break
                    stdout,stderr=process.communicate(timeout=10)
                    self.assertTrue(waiting,stderr); self.assertEqual(process.returncode,0,stderr)
                    self.assertEqual(json.loads(stdout)['status'],'installed')
                finally:
                    if process.poll() is None: process.kill(); process.wait()
                    process.stdout.close(); process.stderr.close()

    def test_real_http_progress_releases_a_waiting_download(self):
        release=threading.Event(); events=[]
        class Slow(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200); self.send_header('Content-Length','131072'); self.end_headers()
                self.wfile.write(b'a'*65536); self.wfile.flush()
                if not release.wait(5): return
                self.wfile.write(b'b'*65536)
            def log_message(self,*_): pass
        server=ThreadingHTTPServer(('127.0.0.1',0),Slow); thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        try:
            with tempfile.TemporaryDirectory() as temporary:
                report=installer.Progress(Path(temporary)); host=installer.Host(Path(temporary)); host.progress=report
                def observe(event):
                    events.append(event)
                    if event.get('bytes') == 65536: release.set()
                report.subscribe(observe)
                with report.stage('Download'), contextlib.redirect_stderr(io.StringIO()):
                    body=host.request('http://127.0.0.1:'+str(server.server_port)+'/asset')
                self.assertEqual(len(body),131072)
                self.assertTrue(any(row.get('bytes') == 65536 and row.get('total') == 131072 for row in events))
        finally: release.set(); server.shutdown(); server.server_close(); thread.join()

if __name__ == '__main__': unittest.main()
