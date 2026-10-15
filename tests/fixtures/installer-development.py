"""Development architecture acceptance at the installation command boundary."""
import contextlib
import io
import json
import tempfile
import unittest
from installer_contract_support import installer, InstallationMachine


class DevelopmentInstall(unittest.TestCase):
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
