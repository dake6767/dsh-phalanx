"""Public installation behavior, including a real heredoc/controlling terminal."""
import contextlib
import io
import json
import os
from pathlib import Path
import pty
import select
import shlex
import signal
import subprocess
import tempfile
import unittest
from installer_contract_support import installer, InstallationMachine


class InstallerExperience(unittest.TestCase):
    def test_missing_noninteractive_configuration_fails_before_download_or_host_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
            requests = []
            host.request = lambda url, **kwargs: requests.append(url) or b'{}'
            host.terminal_available = lambda: False
            with contextlib.redirect_stderr(error := io.StringIO()):
                self.assertEqual(installer.main(['--version', 'v0.1.1'], host), 1)
            self.assertIn('--public-origin', error.getvalue())
            self.assertIn('--host-public-addresses', error.getvalue())
            self.assertEqual(requests, [])
            self.assertEqual(machine.calls, [])
            self.assertFalse((machine.root / 'etc/dsh-phalanx').exists())

    def test_failed_first_installation_can_correct_gateway_without_editing_or_losing_data(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            args = machine.make_bundle(tag='v0.1.1-rc.1') + ['--gateway-port', '41081']
            host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
            host.clock = iter([0, 100]).__next__
            host.request = lambda *args, **kwargs: (_ for _ in ()).throw(OSError('injected startup failure'))
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(installer.main(args, host), 1)
            personal = machine.root / 'var/lib/dsh-phalanx/data/users/member/home/notes'
            personal.parent.mkdir(parents=True)
            personal.write_text('saved work')
            host.clock = installer.time.monotonic
            host.request = lambda *args, **kwargs: b'login'
            with contextlib.redirect_stdout(output := io.StringIO()), contextlib.redirect_stderr(error := io.StringIO()):
                self.assertEqual(installer.main(args[:-1]+['41082'], host), 0)
            self.assertIn('CONTAINER_GATEWAY_PORT', error.getvalue())
            self.assertIn('41082', (machine.root / 'etc/dsh-phalanx/environment').read_text())
            self.assertEqual(personal.read_text(), 'saved work')
            self.assertTrue(machine.active)

    def test_healthy_same_candidate_reuses_installed_assets_without_dependency_or_deployment_work(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            args = machine.make_bundle(tag='v0.1.1-rc.1')
            host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
            host.request = lambda *args, **kwargs: b'login'
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(installer.main(args, host), 0)
            machine.calls.clear()
            with contextlib.redirect_stdout(output := io.StringIO()):
                self.assertEqual(installer.main(args, host), 0)
            self.assertFalse(json.loads(output.getvalue())['changed'])
            self.assertFalse(any(call[0] in ('apt-get', 'dpkg-query', 'useradd', 'usermod', 'chown', 'loginctl') for call in machine.calls), machine.calls)
            self.assertFalse(any('stop' in call or 'enable' in call or 'load' in call or 'pull' in call for call in machine.calls), machine.calls)

    def test_default_gateway_avoids_conflict_and_keeps_the_saved_value(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            args = machine.make_bundle(tag='v0.1.1-rc.1')
            host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
            host.port_conflict = lambda address, port, **kwargs: 'fixture unrelated listener' if port == 3081 else None
            host.request = lambda *args, **kwargs: b'login'
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(error := io.StringIO()):
                self.assertEqual(installer.main(args, host), 0)
            self.assertIn('using 3082', error.getvalue())
            config = machine.root / 'etc/dsh-phalanx/environment'
            self.assertIn('DSH_PHALANX_CONTAINER_GATEWAY_PORT="3082"', config.read_text())
            original = config.read_bytes()
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(installer.main(args, host), 0)
            self.assertEqual(config.read_bytes(), original)

    def test_explicit_or_entry_port_conflicts_fail_without_modifying_the_host(self):
        for flag, port in [('--gateway-port', 3081), ('--port', 18080)]:
            with self.subTest(flag=flag), tempfile.TemporaryDirectory() as directory:
                machine = InstallationMachine(directory)
                args = machine.make_bundle(tag='v0.1.1-rc.1') + [flag, str(port)]
                host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
                host.port_conflict = lambda address, number, **kwargs: 'fixture unrelated listener' if number == port else None
                with contextlib.redirect_stderr(error := io.StringIO()):
                    self.assertEqual(installer.main(args, host), 1)
                self.assertIn(flag, error.getvalue())
                self.assertIn('No occupying process was stopped', error.getvalue())
                self.assertEqual(machine.calls, [])
                self.assertFalse((machine.root / 'etc/dsh-phalanx').exists())

    def test_invalid_deployment_facts_are_rejected_before_acquisition(self):
        for flag, value in [('--model', ''), ('--model-provider', ''), ('--model-provider', 'openai'),
                            ('--model-base-url', 'https://api.deepseek.com?x=1'),
                            ('--model-base-url', 'https://api.deepseek.com#fragment'),
                            ('--model-base-url', 'https://api.deepseek.com:bad'),
                            ('--model-base-url', 'https://bad host'),
                            ('--public-origin', 'https://bad host')]:
            with self.subTest(flag=flag), tempfile.TemporaryDirectory() as directory:
                machine = InstallationMachine(directory)
                host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
                requests = []
                host.request = lambda *args, **kwargs: requests.append(args) or b'{}'
                with contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(installer.main(['--version', 'v0.1.1', '--public-origin', 'http://127.0.0.1:18080', '--host-public-addresses', '', flag, value], host), 1)
                self.assertEqual(requests, [])
                self.assertEqual(machine.calls, [])

    def test_failed_retry_does_not_automatically_change_a_previously_explicit_gateway(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            args = machine.make_bundle(tag='v0.1.1-rc.1') + ['--gateway-port', '41081']
            host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
            machine.fail_enable_once = True
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(installer.main(args, host), 1)
            original = (machine.root / 'etc/dsh-phalanx/environment').read_bytes()
            host.port_conflict = lambda address, port, **kwargs: 'owned test listener' if port == 41081 else None
            with contextlib.redirect_stderr(error := io.StringIO()):
                self.assertEqual(installer.main(args[:-2], host), 1)
            self.assertIn('--gateway-port', error.getvalue())
            self.assertEqual((machine.root / 'etc/dsh-phalanx/environment').read_bytes(), original)

    def test_previous_success_receipt_with_implicit_gateway_needs_no_redownload_or_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            args = machine.make_bundle(tag='v0.1.1-rc.1')
            host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
            host.request = lambda *args, **kwargs: b'login'
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(installer.main(args, host), 0)
            # Persisted shape of the previous installer: no explicit default gateway,
            # no installed manifest. It still has the accepted asset identities.
            config = machine.root / 'etc/dsh-phalanx/environment'
            config.write_text('\n'.join(line for line in config.read_text().splitlines() if not line.startswith('DSH_PHALANX_CONTAINER_GATEWAY_PORT='))+'\n')
            original = config.read_bytes()
            (machine.root / 'etc/dsh-phalanx/installed-manifest.json').unlink()
            release = {'tag_name': 'v0.1.1', 'draft': False, 'prerelease': False,
                       'assets': [{'name': name} for name in ('manifest.json', 'SHA256SUMS', *installer.ASSETS, 'acceptance.json', 'acceptance.md', 'release.json')]}
            urls = []
            def request(url, **kwargs):
                urls.append(url)
                if url.endswith('/releases/latest'):
                    return json.dumps(release).encode()
                if url.endswith('/git/ref/tags/v0.1.1'):
                    return json.dumps({'object': {'type': 'commit', 'sha': 'a'*40}}).encode()
                if url.endswith('/manifest.json') or url.endswith('/SHA256SUMS'):
                    return (Path(args[3]) / url.rsplit('/', 1)[1]).read_bytes()
                if url.endswith('/login'):
                    return b'login'
                self.fail('Unexpected large download: '+url)
            host.request = request
            machine.calls.clear()
            with contextlib.redirect_stdout(output := io.StringIO()):
                self.assertEqual(installer.main(['--version', 'latest', *args[4:]], host), 0)
            self.assertEqual(config.read_bytes(), original)
            self.assertFalse(json.loads(output.getvalue())['changed'])
            self.assertFalse(any('stop' in call or 'enable' in call for call in machine.calls))
            self.assertFalse(any(url.endswith('.tar.gz') or url.endswith('.oci.tar') for url in urls))

    def test_heredoc_source_reads_the_controlling_terminal(self):
        source = Path(__file__).resolve().parents[2] / 'scripts/install/installer.py'
        code = f"import sys; sys.path.insert(0, {str(source.parent)!r}); import runpy; owner = runpy.run_path({str(source)!r}); print('ANSWER=' + owner['Host']().prompt('Browser URL: '))"
        pid, terminal = pty.fork()
        if pid == 0:
            os.execl('/bin/bash', 'bash', '-c', 'python3 - <<\'PYCODE\'\n'+code+'\nPYCODE\n')
        output = b''
        try:
            while b'Browser URL: ' not in output:
                self.assertTrue(select.select([terminal], [], [], 10)[0], output)
                chunk = os.read(terminal, 4096)
                self.assertTrue(chunk, output)
                output += chunk
            os.write(terminal, b'https://deployment.example.test\n')
            while True:
                self.assertTrue(select.select([terminal], [], [], 10)[0], output)
                try:
                    chunk = os.read(terminal, 4096)
                    if not chunk:
                        break
                    output += chunk
                except OSError:
                    break
            _, status = os.waitpid(pid, 0)
            self.assertEqual(os.waitstatus_to_exitcode(status), 0, output)
            self.assertIn(b'ANSWER=https://deployment.example.test', output)
        finally:
            os.close(terminal)
            with contextlib.suppress(ProcessLookupError):
                os.kill(pid, signal.SIGKILL)


if __name__ == '__main__':
    unittest.main()
