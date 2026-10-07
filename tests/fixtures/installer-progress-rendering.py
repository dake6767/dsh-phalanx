"""Human rendering keeps the same safe facts consumed by the upgrade executor."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from installer_contract_support import installer

class ProgressRendering(unittest.TestCase):
    def test_download_blocks_remain_in_diagnostics_without_growing_redirected_output(self):
        clock = [0.0]
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stderr(output := io.StringIO()):
            report = installer.Progress(Path(directory), clock=lambda: clock[0])
            facts = []; report.subscribe(facts.append)
            with report.stage('Download'):
                for received in range(1, 2001):
                    report.emit(message='Downloaded', action='Downloading platform', bytes=received, total=2000)
                clock[0] = 45
                report.heartbeat()
            text = output.getvalue()
            self.assertLess(len(text.splitlines()), 8)
            self.assertNotIn('\x1b', text)
            self.assertIn('100%', text)
            self.assertIn('phase 45.0s', text)
            self.assertIn('total 45.0s', text)
            self.assertEqual(len([row for row in facts if 'bytes' in row]), 2002)
            self.assertEqual(facts[-2]['action'], 'Downloading platform')
            self.assertEqual(facts[-2]['bytes'], 2000)
            self.assertEqual(len(report.log.read_text().splitlines()), len(facts))

    def test_unknown_total_details_and_prompt_do_not_invent_or_erase_results(self):
        clock = [0.0]
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stderr(output := io.StringIO()):
            report = installer.Progress(Path(directory), clock=lambda: clock[0])
            with report.stage('Image'):
                report.emit(message='Fetching image', action='Fetching instance image')
                for index in range(500): report.emit('detail', f'layer {index}')
                clock[0] = 40; report.heartbeat()
                with report.input():
                    output.write('Apply now? [y/N]: yes\n'); clock[0] = 50; report.heartbeat()
            with report.stage('Verify'):
                clock[0] = 55
            text = output.getvalue()
            self.assertIn('Fetching instance image', text)
            self.assertIn('Apply now?', text)
            self.assertIn('phase 5.0s', text)
            self.assertNotIn('%', text)
            self.assertNotIn('layer 499', text)
            self.assertIn('layer 499', report.log.read_text())

    def test_operator_interrupt_has_one_failed_json_result_and_preserved_diagnostics(self):
        import subprocess
        child = "from installer_contract_support import installer,InstallationMachine; from pathlib import Path; import os,signal,sys; m=InstallationMachine(Path(sys.argv[1])); command=m.command;\ndef interrupt(args,**kwargs):\n if args[0]=='apt-get':os.kill(os.getpid(),signal.SIGINT)\n return command(args,**kwargs)\nh=installer.Host(m.root,interrupt,system='Linux',machine='x86_64',uid=0);sys.exit(installer.main([*m.make_bundle('v0.1.1-rc.1'),'--output','json'],h))"
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([sys.executable, '-c', child, directory], cwd=Path(__file__).parent, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 130, result.stderr)
            self.assertEqual(json.loads(result.stdout)['status'], 'failed')
            self.assertIn('Interrupted', result.stdout)
            self.assertNotIn('Traceback', result.stderr)
            self.assertTrue(list((Path(directory)/'var/log/dsh-phalanx').glob('*.jsonl')))

    def test_real_pty_keeps_completed_phases_and_dumb_term_uses_append_only(self):
        import fcntl, pty, struct, subprocess, termios
        child = "from installer_contract_support import installer; clock=[0]; r=installer.Progress(persist=False,clock=lambda:clock[0]);\nwith r.stage('Download verified release'):\n r.emit(message='Downloaded', action='Downloading platform', bytes=20, total=100); clock[0]=45; r.heartbeat()\nwith r.stage('Verify'):\n r.emit(message='Checking hash')\nprint('FINAL SUMMARY')"
        for term in ('xterm-256color', 'dumb'):
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 50, 0, 0))
            process = subprocess.Popen([sys.executable, '-c', child], cwd=Path(__file__).parent, stdout=slave, stderr=slave, env={**os.environ, 'TERM': term})
            os.close(slave); chunks = []
            try:
                while True:
                    try: block = os.read(master, 4096)
                    except OSError: break
                    if not block: break
                    chunks.append(block)
                self.assertEqual(process.wait(timeout=10), 0)
            finally:
                os.close(master)
                if process.poll() is None: process.kill(); process.wait()
            text = b''.join(chunks).decode()
            self.assertIn('FINAL SUMMARY', text)
            self.assertIn('completed', text)
            self.assertEqual('\x1b[2K' in text, term != 'dumb')
            if term != 'dumb':
                self.assertIn('Downloading platform 20% phase45s total45s', text)

if __name__ == '__main__': unittest.main()
