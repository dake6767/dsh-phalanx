"""Host admission observed through the public installation command and fake OS I/O."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import subprocess
import os
import runpy
import sqlite3
from unittest.mock import patch
from installer_contract_support import installer, InstallationMachine


class HostAdmission(unittest.TestCase):
    def test_distribution_package_version_identifies_pasta_built_without_a_version(self):
        for package, status, succeeds in (
            ('installed 0.0~git20240220.1e6f92b-1', 0, True),
            ('installed 0.0~git20240219.abcdef-1', 0, False),
            ('not-installed 0.0~git20240220.1e6f92b-1', 0, False),
            ('installed unknown', 0, False),
            ('', 1, False),
        ):
            with self.subTest(package=package), tempfile.TemporaryDirectory() as directory:
                machine = InstallationMachine(directory)
                def command(arguments, **kwargs):
                    if arguments == ['/usr/bin/pasta', '--version']:
                        return subprocess.CompletedProcess(arguments, 0, 'pasta unknown version\nCopyright Red Hat\n', '')
                    if arguments[:2] == ['dpkg-query', '-W'] and arguments[-1] == 'passt' and len(arguments) == 4:
                        return subprocess.CompletedProcess(arguments, status, package+'\n', '')
                    return machine.command(arguments, **kwargs)
                host = installer.Host(machine.root, command, system='Linux', machine='x86_64', uid=0)
                host.request = lambda *args, **kwargs: b'login'
                with contextlib.redirect_stdout(output := io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(installer.main([*machine.make_bundle(), '--output', 'json'], host), 0 if succeeds else 1, output.getvalue())
                if succeeds: self.assertEqual(json.loads(output.getvalue())['hostAdmission']['verified'], True)
                else:
                    self.assertIn('20240220', json.loads(output.getvalue())['reason'])
                    self.assertFalse(machine.user)

    def test_unreadable_cleanup_state_is_not_treated_as_an_absent_resource(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory); blocked = False
            original_stat = Path.stat
            original_lstat = Path.lstat
            def stat(path, *args, **kwargs):
                if blocked and path == machine.root / 'run/user/1002': raise PermissionError('fixture cleanup observation denied')
                return original_stat(path, *args, **kwargs)
            def lstat(path, *args, **kwargs):
                if blocked and path == machine.root / 'run/user/1002': raise PermissionError('fixture cleanup observation denied')
                return original_lstat(path, *args, **kwargs)
            def command(arguments, **kwargs):
                nonlocal blocked
                result = machine.command(arguments, **kwargs)
                if arguments[:2] == ['systemctl', 'stop'] and 'user@1002.service' in arguments: blocked = True
                return result
            host = installer.Host(machine.root, command, system='Linux', machine='x86_64', uid=0)
            host.request = lambda *args, **kwargs: b'login'
            with patch.object(Path, 'stat', stat), patch.object(Path, 'lstat', lstat), contextlib.redirect_stdout(output := io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(installer.main([*machine.make_bundle(), '--output', 'json'], host), 1, output.getvalue())
            self.assertIn('probe cleanup failed', json.loads(output.getvalue())['reason'])
            self.assertFalse(machine.user)

    def test_cleanup_accepts_an_already_stopped_session_only_after_resource_confirmation(self):
        for failed_command in (['loginctl', 'terminate-user'], ['systemctl', 'stop']):
            with self.subTest(command=failed_command), tempfile.TemporaryDirectory() as directory:
                machine = InstallationMachine(directory)
                def command(arguments, **kwargs):
                    if arguments[:2] == failed_command:
                        return subprocess.CompletedProcess(arguments, 1, '', 'fixture already absent')
                    return machine.command(arguments, **kwargs)
                host = installer.Host(machine.root, command, system='Linux', machine='x86_64', uid=0)
                host.request = lambda *args, **kwargs: b'login'
                with contextlib.redirect_stdout(output := io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(installer.main([*machine.make_bundle(), '--output', 'json'], host), 0, output.getvalue())
                self.assertEqual(machine.probes, {})

    def test_caller_path_cannot_hide_an_old_platform_runtime_binary(self):
        for command, older, newer, minimum in (
            ('podman', 'podman version 4.9.2', 'podman version 5.7.0', '4.9.3'),
            ('pasta', 'pasta 0.0~git20240219.abcdef', 'pasta 0.0~git20260120.abcdef', '20240220'),
        ):
            with self.subTest(command=command), tempfile.TemporaryDirectory() as directory:
                machine = InstallationMachine(directory)
                def execute(arguments, **kwargs):
                    if Path(arguments[0]).name == command and arguments[1:] == ['--version']:
                        return subprocess.CompletedProcess(arguments, 0, older if arguments[0] == '/usr/bin/'+command else newer, '')
                    return machine.command(arguments, **kwargs)
                host = installer.Host(machine.root, execute, system='Linux', machine='x86_64', uid=0)
                host.request = lambda *args, **kwargs: b'login'
                with contextlib.redirect_stdout(output := io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(installer.main([*machine.make_bundle(), '--output', 'json'], host), 1, output.getvalue())
                self.assertIn(older, json.loads(output.getvalue())['reason'])
                self.assertIn(minimum, json.loads(output.getvalue())['reason'])
                self.assertFalse(machine.user)

    def test_temporary_probe_does_not_inherit_deployment_proxy_credentials(self):
        proxy = 'http://fixture-proxy-user:fixture-proxy-password@proxy.example.test:8080'
        names = ('HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy')
        environment = {name: proxy if 'all' not in name.lower() else '' for name in names}
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, environment):
            machine = InstallationMachine(directory); observed = []
            def command(arguments, **kwargs):
                if arguments[0] == 'runuser' and arguments[2] != 'dsh-phalanx': observed.append(kwargs['env'])
                return machine.command(arguments, **kwargs)
            host = installer.Host(machine.root, command, system='Linux', machine='x86_64', uid=0)
            host.request = lambda *args, **kwargs: b'login'
            with contextlib.redirect_stdout(output := io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(installer.main([*machine.make_bundle(), '--output', 'json'], host), 0, output.getvalue())
            self.assertTrue(observed)
            for values in observed: self.assertFalse(set(names) & values.keys())

    def test_upgrade_preparation_shares_admission_and_preserves_the_running_source(self):
        support = runpy.run_path(str(Path(__file__).with_name('upgrade-cleanup.py')))
        cases = [
            {'name': 'ubuntu26', 'release': 'ID=ubuntu\nVERSION_ID="26.04"\n', 'verified': True},
            {'name': 'debian13', 'release': 'ID=debian\nVERSION_ID="13"\n', 'verified': False},
            {'name': 'derivative', 'release': 'ID=example\nID_LIKE=debian\nVERSION_ID="1"\n', 'verified': False},
            {'name': 'non-debian', 'release': 'ID=fedora\n', 'verified': False, 'reason': 'only Debian-family'},
            {'name': 'podman', 'podman': 'podman version 4.9.2', 'reason': '4.9.3'},
            {'name': 'passt', 'pasta': 'pasta 0.0~git20240219.abcdef', 'reason': '20240220'},
            {'name': 'passt-packaged', 'pasta': 'pasta unknown version', 'package': 'installed 0.0~git20240220.1e6f92b-1'},
            {'name': 'passt-packaged-old', 'pasta': 'pasta unknown version', 'package': 'installed 0.0~git20240219.abcdef-1', 'reason': '20240220'},
            {'name': 'rootless', 'rootless': False, 'reason': 'rootless'},
            {'name': 'cgroup', 'cgroup': 'v1', 'reason': 'cgroup v2'},
            {'name': 'init', 'init': 'openrc', 'reason': 'systemd'},
            {'name': 'manager', 'manager': False, 'reason': 'user manager'},
        ]
        for case in cases:
            with self.subTest(case=case['name']), tempfile.TemporaryDirectory() as directory, patch('installer_upgrade_host.LinuxAdmissionGate', support['GATE']):
                machine = support['CleanupMachine'](directory)
                host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
                host.request = lambda *args, **kwargs: b'login'
                def bundle(tag, identity):
                    arguments = machine.make_bundle(tag, identity, identity)
                    path = Path(arguments[3]) / 'manifest.json'
                    value = json.loads(path.read_text()); value.update(schema=2, compatibility=support['CONTRACT'], acceptancePolicy=support['POLICY'])
                    path.write_text(json.dumps(value))
                    return arguments
                source = bundle('v0.1.9-rc.1', 'a')
                with contextlib.redirect_stdout(initial := io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(installer.main([*source, '--output', 'json'], host), 0, initial.getvalue())
                data = machine.root / 'var/lib/dsh-phalanx/data'; data.mkdir()
                with sqlite3.connect(data / 'community-accounts.db') as connection: connection.execute('PRAGMA user_version=4')
                original = machine.running_target
                target = bundle('v0.1.10-rc.1', 'b')
                if 'release' in case: (machine.root / 'etc/os-release').write_text(case['release'])
                if 'init' in case: (machine.root / 'proc/1/comm').write_text(case['init']+'\n')
                def execute(arguments, **kwargs):
                    if arguments[:2] == ['dpkg-query', '-W'] and len(arguments) == 4 and arguments[-1] == 'passt' and 'package' in case:
                        return subprocess.CompletedProcess(arguments, 0, case['package']+'\n', '')
                    for command in ('podman', 'pasta'):
                        if Path(arguments[0]).name == command and arguments[1:] == ['--version'] and command in case:
                            return subprocess.CompletedProcess(arguments, 0, case[command], '')
                    if arguments[-3:] == ['info', '--format', 'json'] and ('rootless' in case or 'cgroup' in case):
                        return subprocess.CompletedProcess(arguments, 0, json.dumps({'host': {
                            'security': {'rootless': case.get('rootless', True)}, 'cgroupVersion': case.get('cgroup', 'v2'),
                        }}), '')
                    if 'systemctl' in arguments and arguments[-1] == 'default.target' and case.get('manager') is False:
                        return subprocess.CompletedProcess(arguments, 1, '', 'fixture user manager unavailable')
                    return machine.command(arguments, **kwargs)
                host.command = execute
                with contextlib.redirect_stdout(output := io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(installer.main([*target, '--upgrade', 'prepare', '--output', 'json'], host), 1 if 'reason' in case else 0, output.getvalue())
                result = json.loads(output.getvalue())
                if 'reason' in case:
                    reason = result['reason'] if result.get('status') == 'failed' else result['operation']['failure']
                    self.assertIn(case['reason'], reason)
                else: self.assertEqual(result['operation']['phase'], 'prepared')
                self.assertEqual(result['hostAdmission']['verified'], case.get('verified', True))
                self.assertTrue(machine.active)
                self.assertEqual(machine.running_target, original)
                self.assertEqual(machine.probes, {})

    def test_public_bootstrap_rejects_non_debian_before_calling_apt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); binary = root / 'bin'; binary.mkdir()
            (binary / 'uname').write_text('#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n')
            (binary / 'apt-get').write_text('#!/bin/sh\ntouch "$BOOTSTRAP_APT_MARKER"\nexit 91\n')
            (binary / 'python3').write_text('#!/bin/sh\ntouch "$BOOTSTRAP_PYTHON_MARKER"\nexit 92\n')
            for path in binary.iterdir(): path.chmod(0o755)
            environment = root / 'environment'
            environment.write_text('source() { ID=rocky; ID_LIKE="rhel fedora"; VERSION_ID=9; }\n')
            result = subprocess.run(['bash', str(Path(__file__).resolve().parents[2] / 'install.sh'), '--output', 'json', '--language', 'en', '--non-interactive'],
                capture_output=True, text=True, env={**os.environ, 'PATH': str(binary)+':'+os.environ['PATH'],
                    'BASH_ENV': str(environment), 'BOOTSTRAP_APT_MARKER': str(root / 'apt-called'),
                    'BOOTSTRAP_PYTHON_MARKER': str(root / 'python-called')})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('only Debian-family', json.loads(result.stdout)['reason'])
            self.assertFalse((root / 'apt-called').exists())
            self.assertFalse((root / 'python-called').exists())

    def test_partial_probe_creation_is_cleaned_and_cleanup_failure_refuses_product_installation(self):
        for failure in ('partial-useradd', 'interrupted-useradd', 'userdel', 'migrate', 'disable-linger', 'session-stop'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                machine = InstallationMachine(directory)
                def execute(arguments, **kwargs):
                    if arguments[0] == 'useradd' and arguments[-1] != 'dsh-phalanx' and failure in ('partial-useradd', 'interrupted-useradd'):
                        machine.command(arguments, **kwargs)
                        if failure == 'interrupted-useradd': raise KeyboardInterrupt('fixture interrupted after useradd effect')
                        return subprocess.CompletedProcess(arguments, 1, '', 'fixture partial user creation')
                    if arguments[0] == 'userdel' and failure == 'userdel':
                        return subprocess.CompletedProcess(arguments, 1, '', 'fixture cleanup failure')
                    if arguments[-2:] == ['system', 'migrate'] and failure == 'migrate':
                        return subprocess.CompletedProcess(arguments, 1, '', 'fixture migrate cleanup failure')
                    if arguments[:2] == ['loginctl', 'disable-linger'] and failure == 'disable-linger':
                        return subprocess.CompletedProcess(arguments, 1, '', 'fixture linger cleanup failure')
                    if arguments[:2] in (['systemctl', 'stop'], ['loginctl', 'terminate-user']) and failure == 'session-stop':
                        return subprocess.CompletedProcess(arguments, 1, '', 'fixture session cleanup failure')
                    return machine.command(arguments, **kwargs)
                host = installer.Host(machine.root, execute, system='Linux', machine='x86_64', uid=0)
                host.request = lambda *args, **kwargs: b'login'
                with contextlib.redirect_stdout(output := io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(installer.main([*machine.make_bundle(), '--output', 'json'], host), 130 if failure == 'interrupted-useradd' else 1, output.getvalue())
                self.assertFalse(machine.user)
                self.assertFalse((machine.root / 'etc/dsh-phalanx').exists())
                if failure in ('partial-useradd', 'interrupted-useradd'): self.assertEqual(machine.probes, {})
                else: self.assertIn('probe cleanup failed', json.loads(output.getvalue())['reason'])

    def test_runtime_capabilities_fail_without_creating_product_state_or_leaking_probe_accounts(self):
        for failure, expected in [
            ('init', 'systemd'), ('controllers', 'cgroup v2'), ('rootless', 'rootless'),
            ('cgroup', 'cgroup v2'), ('manager', 'user manager'), ('info', 'rootless'),
        ]:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                machine = InstallationMachine(directory)
                if failure == 'init': (machine.root / 'proc/1/comm').write_text('openrc\n')
                if failure == 'controllers': (machine.root / 'sys/fs/cgroup/cgroup.controllers').unlink()
                def execute(arguments, **kwargs):
                    if arguments[-3:] == ['info', '--format', 'json'] and failure in ('rootless', 'cgroup', 'info'):
                        machine.calls.append(arguments)
                        body = 'not-json' if failure == 'info' else json.dumps({'host': {
                            'security': {'rootless': failure != 'rootless'}, 'cgroupVersion': 'v1' if failure == 'cgroup' else 'v2',
                        }})
                        return subprocess.CompletedProcess(arguments, 0, body, '')
                    if arguments[:2] == ['systemctl', 'start'] and failure == 'manager':
                        machine.calls.append(arguments)
                        return subprocess.CompletedProcess(arguments, 1, '', 'fixture manager unavailable')
                    return machine.command(arguments, **kwargs)
                host = installer.Host(machine.root, execute, system='Linux', machine='x86_64', uid=0)
                host.request = lambda *args, **kwargs: b'login'
                with contextlib.redirect_stdout(output := io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(installer.main([*machine.make_bundle(), '--output', 'json'], host), 1, output.getvalue())
                self.assertIn(expected, json.loads(output.getvalue())['reason'])
                self.assertFalse(machine.user)
                self.assertFalse((machine.root / 'etc/dsh-phalanx').exists())
                self.assertEqual(machine.probes, {})

    def test_version_floors_reject_before_product_identity_or_configuration(self):
        for command, actual, minimum in [
            ('podman', 'podman version 4.9.2', '4.9.3'),
            ('pasta', 'pasta 0.0~git20240219.abcdef', '20240220'),
            ('podman', 'unknown', '4.9.3'),
            ('pasta', 'unknown', '20240220'),
        ]:
            with self.subTest(command=command, actual=actual), tempfile.TemporaryDirectory() as directory:
                machine = InstallationMachine(directory)
                def execute(arguments, **kwargs):
                    if Path(arguments[0]).name == command and arguments[1:] == ['--version']:
                        machine.calls.append(arguments)
                        return subprocess.CompletedProcess(arguments, 0, actual, '')
                    return machine.command(arguments, **kwargs)
                host = installer.Host(machine.root, execute, system='Linux', machine='x86_64', uid=0)
                host.request = lambda *args, **kwargs: b'login'
                with contextlib.redirect_stdout(output := io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(installer.main([*machine.make_bundle(), '--output', 'json'], host), 1, output.getvalue())
                reason = json.loads(output.getvalue())['reason']
                self.assertIn(actual, reason)
                self.assertIn(minimum, reason)
                self.assertFalse(machine.user)
                self.assertFalse((machine.root / 'etc/dsh-phalanx').exists())

    def test_verification_is_visible_in_human_and_json_output_without_confirmation(self):
        cases = [
            ('ID=ubuntu\nVERSION_ID="24.04"\n', 'ubuntu', '24.04', True),
            ('ID=ubuntu\nVERSION_ID="26.04"\n', 'ubuntu', '26.04', True),
            ('ID=debian\nVERSION_ID="13"\n', 'debian', '13', False),
            ('ID=ubuntu\nVERSION_ID="25.10"\n', 'ubuntu', '25.10', False),
            ('ID=linuxmint\nID_LIKE="ubuntu debian"\nVERSION_ID="22"\n', 'linuxmint', '22', False),
            ('ID=example\nID_LIKE=debian\nVERSION_ID="1"\n', 'example', '1', False),
        ]
        for release, distribution, version, verified in cases:
            for mode in ('human', 'json'):
                with self.subTest(distribution=distribution, version=version, output=mode), tempfile.TemporaryDirectory() as directory:
                    machine = InstallationMachine(directory)
                    (machine.root / 'etc/os-release').write_text(release)
                    host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
                    host.request = lambda *args, **kwargs: b'login'
                    with contextlib.redirect_stdout(output := io.StringIO()), contextlib.redirect_stderr(progress := io.StringIO()):
                        self.assertEqual(installer.main([*machine.make_bundle(), '--output', mode, '--language', 'en'], host), 0, output.getvalue())
                    if mode == 'json':
                        self.assertEqual(json.loads(output.getvalue())['hostAdmission'], {
                            'distribution': distribution, 'version': version, 'family': 'debian', 'verified': verified,
                        })
                    else:
                        self.assertIn('Host: '+distribution+' '+version+' ('+('verified' if verified else 'unverified')+')', output.getvalue())
                    self.assertEqual('WARNING:' in progress.getvalue(), not verified)

    def test_non_debian_hosts_are_rejected_before_any_host_changes(self):
        for release in ('ID=rocky\nID_LIKE="rhel fedora"\n', 'ID=fedora\n', 'ID=arch\n', 'ID=alpine\n', None):
            with self.subTest(release=release), tempfile.TemporaryDirectory() as directory:
                machine = InstallationMachine(directory)
                path = machine.root / 'etc/os-release'
                if release is None: path.unlink()
                else: path.write_text(release)
                arguments = machine.make_bundle()
                before = {str(p.relative_to(machine.root)): p.read_bytes() if p.is_file() else None for p in machine.root.rglob('*')}
                host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
                with contextlib.redirect_stdout(output := io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(installer.main([*arguments, '--output', 'json'], host), 1)
                result = json.loads(output.getvalue())
                self.assertIn('only Debian-family', result['reason'])
                self.assertEqual(result['hostAdmission']['family'], 'unsupported')
                with contextlib.redirect_stdout(human := io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(installer.main([*arguments, '--output', 'human', '--language', 'en'], host), 1)
                self.assertIn('(unsupported)', human.getvalue())
                self.assertNotIn('(unverified)', human.getvalue())
                self.assertEqual(machine.calls, [])
                self.assertEqual({str(p.relative_to(machine.root)): p.read_bytes() if p.is_file() else None for p in machine.root.rglob('*')}, before)

    def test_supported_ubuntu_2604_installs_without_unverified_warning(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            (machine.root / 'etc/os-release').write_text('ID=ubuntu\nVERSION_ID="26.04"\n')
            arguments = machine.make_bundle()
            host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
            host.request = lambda *args, **kwargs: b'login'
            with contextlib.redirect_stdout(output := io.StringIO()), contextlib.redirect_stderr(progress := io.StringIO()):
                result = installer.main([*arguments, '--output', 'json'], host)
            self.assertEqual(result, 0, output.getvalue())
            self.assertEqual(json.loads(output.getvalue())['hostAdmission'], {
                'distribution': 'ubuntu', 'version': '26.04', 'family': 'debian', 'verified': True,
            })
            self.assertNotIn('unverified', progress.getvalue().lower())


if __name__ == '__main__':
    unittest.main()
