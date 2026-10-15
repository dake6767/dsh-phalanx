"""Development architecture acceptance at the installation command boundary."""
import contextlib
import base64
import io
import json
from pathlib import Path
import tempfile
import runpy
import sqlite3
from unittest.mock import patch
import unittest
from installer_contract_support import installer, InstallationMachine


def run_bundle(machine):
    args = machine.make_bundle('v0.1.16-rc.1')
    bundle = Path(args[3]); args[1] = 'run-42'
    manifest = json.loads((bundle / 'manifest.json').read_text())
    manifest.update(schema=2, tag='run-42', compatibility={'protocol': 3,
        'source': {'min': '0.1.13', 'maxExclusive': '0.1.16'},
        'accounts': {'sourceMin': 5, 'sourceMax': 5, 'target': 5}, 'environmentEpoch': 1},
        acceptancePolicy={'ticket': 8, 'checks': ['ci', 'linux', 'cleanInstall', 'upgrade', 'review']},
        storage={'platformArchiveBytes': 100, 'platformExpandedBytes': 200, 'imageDownloadBytes': 300, 'imageExpandedBytes': 400}, updater='{}')
    manifest['image']['tag'] = 'run-42'
    (bundle / 'manifest.json').write_text(json.dumps(manifest))
    return args, bundle, manifest


class DevelopmentInstall(unittest.TestCase):
    def test_installation_persists_download_preset_and_per_category_overrides(self):
        for flags, expected in (([], {'preset': 'official'}),
                (['--download-source-preset', 'mainland', '--npm-registry', 'https://packages.example.test/registry/'],
                 {'preset': 'mainland', 'overrides': {'npm': 'https://packages.example.test/registry'}})):
            with self.subTest(flags=flags), tempfile.TemporaryDirectory() as directory:
                machine = InstallationMachine(directory)
                args, _, _ = run_bundle(machine)
                host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
                host.request = lambda *a, **k: b'login'
                with contextlib.redirect_stdout(out := io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    result = installer.main([*args, *flags, '--output', 'json'], host)
                self.assertEqual(result, 0, out.getvalue())
                import installer_config
                values = installer_config.read_configuration(host)
                self.assertEqual(json.loads(values['DSH_PHALANX_DOWNLOAD_SOURCES']), expected)

    def test_rebuilds_the_same_development_version_through_the_upgrade_transaction_only_with_local_arm64_opt_in(self):
        support = runpy.run_path(str(Path(__file__).with_name('upgrade-cleanup.py')))
        for case in ('development-rebuild', 'production-same-version', 'development-downgrade', 'runtime-change'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                architecture = 'amd64' if case == 'production-same-version' else 'arm64'
                flags = [] if architecture == 'amd64' else ['--dev-arm64']
                machine = support['CleanupMachine'](directory)
                host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64' if architecture == 'amd64' else 'aarch64', uid=0)
                host.request = lambda *a, **k: b'login'
                for index in (1, 2):
                    version = '0.1.15' if index == 2 and case == 'development-downgrade' else '0.1.16'
                    args = machine.make_bundle('v'+version+'-rc.'+str(index), 'a' if index == 1 else 'b', 'a' if index == 1 else 'b', architecture)
                    path = Path(args[3]) / 'manifest.json'; manifest = json.loads(path.read_text())
                    manifest.update(schema=2, compatibility={'protocol': 3,
                        'source': {'min': '0.1.13', 'maxExclusive': '0.1.16'},
                        'accounts': {'sourceMin': 5, 'sourceMax': 5, 'target': 5}, 'environmentEpoch': 1},
                        acceptancePolicy={'ticket': 8, 'checks': ['ci', 'linux', 'cleanInstall', 'upgrade', 'review']},
                        storage={'platformArchiveBytes': 100, 'platformExpandedBytes': 200, 'imageDownloadBytes': 300, 'imageExpandedBytes': 400}, updater='{}')
                    if index == 2 and case == 'runtime-change': manifest['dshRevision'] = 'f'*40
                    path.write_text(json.dumps(manifest))
                    with patch('installer_upgrade_host.LinuxAdmissionGate', support['GATE']), contextlib.redirect_stdout(out := io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        result = installer.main([*args, *flags, '--yes', '--output', 'json'], host)
                    if index == 1:
                        self.assertEqual(result, 0, out.getvalue())
                        data = machine.root / 'var/lib/dsh-phalanx/data'; data.mkdir()
                        with contextlib.closing(sqlite3.connect(data / 'community-accounts.db')) as connection: connection.execute('PRAGMA user_version=5')
                        (data / 'keep').write_text('member data before rebuild')
                    else:
                        self.assertEqual(result, 0 if case == 'development-rebuild' else 1, out.getvalue())
                        if case == 'development-rebuild':
                            self.assertEqual(json.loads(out.getvalue())['operation']['phase'], 'succeeded')
                            self.assertIn('rc.2-', str(machine.running_target))
                        self.assertEqual((data / 'keep').read_text(), 'member data before rebuild')

    def test_run_candidate_rejects_mismatched_run_or_corrupted_bytes_before_host_changes(self):
        for case in ('valid', 'different-run', 'corrupted-platform'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                machine = InstallationMachine(directory)
                args, bundle, manifest = run_bundle(machine)
                if case == 'different-run': manifest['runId'] = '43'
                if case == 'corrupted-platform': (bundle / 'dsh-phalanx-linux-amd64.tar.gz').write_bytes(b'corrupt')
                (bundle / 'manifest.json').write_text(json.dumps(manifest))
                host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
                host.request = lambda url, **kwargs: b'login'
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(installer.main([*args, '--output', 'json'], host), 0 if case == 'valid' else 1)
                self.assertEqual(machine.active, case == 'valid')
                if case != 'valid': self.assertEqual(machine.calls, [])

    def test_online_candidate_source_is_explicit_and_preserves_manifest_and_run_verification(self):
        source_repo = 'dake6767/dsh-phalanx'
        candidate_repo = source_repo + '-candidates'
        base = 'https://github.com/' + candidate_repo + '/releases'
        api = 'https://api.github.com/repos/'
        for case in ('valid', 'valid-upgrade', 'wrong-run', 'wrong-workflow', 'untrusted-source', 'corrupt-platform', 'wrong-base', 'latest', 'default-source'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                support = runpy.run_path(str(Path(__file__).with_name('upgrade-cleanup.py')))
                machine = support['CleanupMachine'](directory) if case == 'valid-upgrade' else InstallationMachine(directory)
                args, bundle, manifest = run_bundle(machine)
                host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
                if case == 'valid-upgrade':
                    target_image = machine.image_facts
                    before = machine.make_bundle('v0.1.15-rc.1', 'f', 'f')
                    path = Path(before[3]) / 'manifest.json'; prior = json.loads(path.read_text())
                    prior.update({key: manifest[key] for key in ('schema', 'compatibility', 'acceptancePolicy', 'storage', 'updater')})
                    path.write_text(json.dumps(prior)); host.request = lambda *a, **k: b'login'
                    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        self.assertEqual(installer.main(before, host), 0)
                    data = machine.root / 'var/lib/dsh-phalanx/data'; data.mkdir()
                    with contextlib.closing(sqlite3.connect(data / 'community-accounts.db')) as connection: connection.execute('PRAGMA user_version=5')
                    (data / 'keep').write_text('member data before candidate upgrade')
                    machine.image_facts = target_image
                args = args[:2] + args[4:]
                if case != 'default-source': args += ['--dev-release-base-url', base if case != 'wrong-base' else 'https://example.test/releases']
                if case == 'latest': args[1] = 'latest'
                source = manifest['commit']; workflow = 'c' * 40
                release = {'tag_name': 'run-42', 'draft': False, 'prerelease': True,
                           'assets': [{'name': name} for name in ('manifest.json', 'SHA256SUMS', *installer.ASSETS)]}
                run = {'id': 43 if case == 'wrong-run' else 42, 'status': 'completed', 'conclusion': 'success',
                       'event': 'workflow_dispatch', 'head_branch': 'main', 'head_sha': workflow,
                       'path': '.github/workflows/other.yml' if case == 'wrong-workflow' else '.github/workflows/candidate.yml'}
                facts = {
                    api + candidate_repo + '/releases/tags/run-42': release,
                    api + candidate_repo + '/git/ref/tags/run-42': {'object': {'type': 'commit', 'sha': 'd' * 40}},
                    api + source_repo + '/actions/runs/42': run,
                    api + source_repo + '/compare/' + source + '...' + workflow: {'status': 'diverged' if case == 'untrusted-source' else 'ahead'},
                    api + source_repo + '/contents/package.json?ref=' + source: {'content': base64.b64encode(b'{"version":"0.1.16"}').decode()},
                }
                requests = []
                def request(url, **kwargs):
                    requests.append(url)
                    if url in facts: return json.dumps(facts[url]).encode()
                    if url.startswith(base + '/download/run-42/'):
                        name = url.rsplit('/', 1)[1]
                        return b'corrupt' if case == 'corrupt-platform' and name == installer.ASSETS[0] else (bundle / name).read_bytes()
                    if url.startswith('http://127.0.0.1:'): return b'login'
                    raise AssertionError('Unexpected HTTP request: ' + url)
                host.request = request
                valid = case in ('valid', 'valid-upgrade')
                with patch('installer_upgrade_host.LinuxAdmissionGate', support['GATE']), contextlib.redirect_stdout(output := io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(installer.main([*args, '--yes', '--output', 'json'], host), 0 if valid else 1, output.getvalue())
                self.assertEqual(machine.active, valid)
                if not valid: self.assertEqual(machine.calls, [])
                if case == 'valid-upgrade':
                    self.assertEqual(json.loads(output.getvalue())['operation']['phase'], 'succeeded')
                    self.assertEqual((data / 'keep').read_text(), 'member data before candidate upgrade')
                    self.assertIn('run-42-', str(machine.running_target))
                if case in ('wrong-base', 'latest', 'default-source'): self.assertEqual(requests, [])

    def test_development_opt_in_does_not_admit_wrong_artifacts_or_online_releases(self):
        for case in ('amd64-host', 'amd64-package', 'amd64-image', 'online'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                machine = InstallationMachine(directory)
                args = machine.make_bundle(architecture='amd64' if case == 'amd64-package' else 'arm64')
                host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64' if case == 'amd64-host' else 'aarch64', uid=0)
                if case == 'amd64-image': machine.image_facts['Architecture'] = 'amd64'
                if case == 'online': args = args[:2] + args[4:]
                requests = []
                host.request = lambda url, **kwargs: requests.append(url) or b'login'
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(installer.main([*args, '--dev-arm64', '--output', 'json'], host), 1)
                self.assertFalse(machine.active)
                self.assertEqual(requests, [])

    def test_arm64_install_requires_explicit_development_opt_in(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            args = machine.make_bundle(architecture='arm64')
            host = installer.Host(machine.root, machine.command, system='Linux', machine='aarch64', uid=0)
            host.request = lambda url, **kwargs: b'login'
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(installer.main([*args, '--output', 'json'], host), 1)
            self.assertFalse(machine.user)
            with contextlib.redirect_stdout(output := io.StringIO()):
                self.assertEqual(installer.main([*args, '--dev-arm64', '--output', 'json'], host), 0)
            self.assertTrue(json.loads(output.getvalue())['changed'])
            self.assertTrue(machine.active)


if __name__ == '__main__': unittest.main()
