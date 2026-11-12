"""Exercise localized installation through the public CLI and external host seam."""
import contextlib
import io
import os
import json
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from installer_contract_support import installer, InstallationMachine
from release_asset_support import stable_assets
from terminal_dialogue import run_terminal


def modern_bundle(machine):
    args = machine.make_bundle(tag='v0.1.34-rc.1')
    manifest_file = Path(args[3])/'manifest.json'
    manifest = json.loads(manifest_file.read_text())
    manifest.update(schema=2, compatibility={'protocol':3, 'source':{'min':'0.1.33','maxExclusive':'0.1.34'}, 'accounts':{'sourceMin':5,'sourceMax':5,'target':5}, 'environmentEpoch':1}, acceptancePolicy={'ticket':8,'checks':['ci','linux','upgrade','cleanInstall']}, storage={key:1 for key in ('platformArchiveBytes','platformExpandedBytes','imageDownloadBytes','imageExpandedBytes')}, updater='{}')
    manifest_file.write_text(json.dumps(manifest))
    key = args.index('--model-key-file')
    del args[key:key+2]
    return args


class BilingualInstall(unittest.TestCase):
    def test_selected_language_guides_installation_and_preserves_hidden_configuration(self):
        for language, expected in [('zh-CN', '下一步'), ('en', 'Next:')]:
            with self.subTest(language=language), tempfile.TemporaryDirectory() as directory:
                machine = InstallationMachine(directory)
                args = modern_bundle(machine)
                host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
                host.request = lambda *args, **kwargs: b'login'
                with contextlib.redirect_stdout(output := io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    result = installer.main([*args, '--language', language, '--preview-port', '18081', '--preview-origin', 'http://127.0.0.1:18081'], host)
                self.assertEqual(result, 0, output.getvalue())
                self.assertIn(expected, output.getvalue())
                self.assertIn('https://github.com/dake6767/dsh-phalanx', output.getvalue())
                self.assertNotIn('preview-port', output.getvalue())
                saved = (machine.root/'etc/dsh-phalanx/environment').read_text()
                self.assertIn('DSH_PHALANX_HOST_PUBLIC_ADDRESSES=""', saved)
                self.assertIn('DSH_PHALANX_PREVIEW_PORT="18081"', saved)
                with contextlib.redirect_stdout(repeated := io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(installer.main([*args, '--language', language], host), 0)
                self.assertEqual((machine.root/'etc/dsh-phalanx/environment').read_text(), saved)
                self.assertNotIn('preview-origin', repeated.getvalue())

    def test_source_is_chosen_before_lookup_and_invalid_answers_can_be_corrected(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            args = machine.make_bundle(tag='v0.1.1-rc.1')
            bundle = Path(args[3])
            release = stable_assets(bundle)
            host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
            host.terminal_available = lambda: True
            events = []
            answers = iter([
                ('Download source:', 'mainland'), ('Server access IP', '192.168.1.20'),
                ('Platform entry port', 'bad'), ('Platform entry port', '18080'),
                ('Full browser URL', 'https://team.example.com'),
                ('Port forwarding or public NAT?', 'none'), ('Open advanced settings?', 'n'),
                ('Summary: install', 'edit'), ('Edit: source', 'source'),
                ('Download source:', 'official'), ('Summary: install', 'install'),
            ])
            def prompt(label, **kwargs):
                expected, answer = next(answers)
                self.assertIn(expected, label)
                events.append(('prompt', expected))
                return answer
            host.prompt = prompt
            def request(url, **kwargs):
                events.append(('request', url))
                if url.startswith('http://127.0.0.1:'):
                    return b'login'
                if url.endswith('/release.json'):
                    return json.dumps(release).encode()
                return (bundle/url.rsplit('/',1)[1]).read_bytes()
            host.request = request
            with contextlib.redirect_stdout(output := io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                result = installer.main(['--language', 'en', '--model-key-file', args[5]], host)
            self.assertEqual(result, 0, output.getvalue())
            self.assertEqual(events[0], ('prompt', 'Download source:'))
            self.assertGreaterEqual(sum(kind == 'request' and value.endswith('/release.json') for kind, value in events), 2)
            values = (machine.root/'etc/dsh-phalanx/environment').read_text()
            self.assertIn('DSH_PHALANX_PUBLIC_ORIGIN="https://team.example.com"', values)
            self.assertIn('\"official\"', values.replace('\\"', '"'))

    def test_mapping_declarations_are_persisted_distinctly_and_missing_automation_fails(self):
        for mapping, expected in [('none', 'DSH_PHALANX_HOST_PUBLIC_ADDRESSES=""'), ('undeclared', None), ('list', 'DSH_PHALANX_HOST_PUBLIC_ADDRESSES="8.8.8.8"')]:
            with self.subTest(mapping=mapping), tempfile.TemporaryDirectory() as directory:
                machine = InstallationMachine(directory)
                args = modern_bundle(machine)
                for flag in ('--public-origin', '--host-public-addresses'):
                    index = args.index(flag)
                    del args[index:index+2]
                host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
                host.request = lambda *args, **kwargs: b'login'
                with contextlib.redirect_stdout(output := io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(installer.main([*args, '--non-interactive', '--output', 'json'], host), 1)
                self.assertEqual(json.loads(output.getvalue())['status'], 'failed')
                self.assertFalse((machine.root/'etc/dsh-phalanx/environment').exists())
                host.terminal_available = lambda: True
                answers = iter(['192.168.1.20', '', '', mapping, *(['8.8.8.8'] if mapping == 'list' else []), 'n', 'install'])
                host.prompt = lambda *args, **kwargs: next(answers)
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(installer.main([*args, '--language', 'en', '--download-source-preset', 'official'], host), 0)
                saved = (machine.root/'etc/dsh-phalanx/environment').read_text()
                if expected is None:
                    self.assertNotIn('DSH_PHALANX_HOST_PUBLIC_ADDRESSES=', saved)
                else:
                    self.assertIn(expected, saved)

    def test_saved_hidden_listener_conflict_fails_without_prompt_or_configuration_change(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            args = modern_bundle(machine)
            host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
            host.request = lambda *args, **kwargs: b'login'
            machine.fail_enable_once = True
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(installer.main([*args, '--preview-port', '18081', '--preview-origin', 'http://127.0.0.1:18081'], host), 1)
            config = machine.root/'etc/dsh-phalanx/environment'
            original = config.read_bytes()
            host.terminal_available = lambda: True
            host.port_conflict = lambda address, port, **kwargs: 'fixture listener' if port == 18081 else None
            prompts = []
            def answer(label, **kwargs):
                prompts.append(label)
                if 'New ' in label: return '18082'
                if '展开高级' in label: return 'n'
                if '摘要：' in label: return 'install'
                return ''
            host.prompt = answer
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                result = installer.main([*args, '--language', 'zh-CN', '--download-source-preset', 'official'], host)
            self.assertEqual(result, 1)
            self.assertEqual(config.read_bytes(), original)
            self.assertFalse(any('--preview-' in label for label in prompts))

    def test_conflicting_entry_port_uses_selected_language_retry_and_cancel(self):
        for action in ('install', 'cancel'):
            with self.subTest(action=action), tempfile.TemporaryDirectory() as directory:
                machine = InstallationMachine(directory)
                args = modern_bundle(machine)
                index = args.index('--public-origin')
                del args[index:index+2]
                host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
                host.request = lambda *args, **kwargs: b'login'
                host.terminal_available = lambda: True
                host.port_conflict = lambda address, port, **kwargs: 'fixture listener' if port == 18080 else None
                (machine.root/'proc/net/tcp').write_text('header\n0: 00000000:46A2 00000000:0000 0A 0 0 0 0 0 42\n')
                prompts = []
                answers = iter(['192.168.1.20', '', '', 'n', 'bad', '18082', 'install'] if action == 'install' else ['192.168.1.20', '', '', 'n', 'cancel'])
                def answer(label, **kwargs):
                    prompts.append(label)
                    return next(answers)
                host.prompt = answer
                with contextlib.redirect_stdout(output := io.StringIO()), contextlib.redirect_stderr(errors := io.StringIO()):
                    self.assertEqual(installer.main([*args, '--language', 'zh-CN', '--download-source-preset', 'official'], host), 0)
                self.assertFalse(any('New --port' in label for label in prompts))
                if action == 'cancel':
                    self.assertIn('取消', output.getvalue())
                    self.assertFalse((machine.root/'etc/dsh-phalanx/environment').exists())
                else:
                    saved = (machine.root/'etc/dsh-phalanx/environment').read_text()
                    self.assertIn('DSH_PHALANX_PORT="18082"', saved)
                    self.assertIn('DSH_PHALANX_PUBLIC_ORIGIN="http://192.168.1.20:18082"', saved)
                    self.assertIn('输入无效', errors.getvalue())

    def test_standalone_help_is_localized_and_hides_compatible_explicit_settings(self):
        entry = str(Path(__file__).resolve().parents[2]/'install.sh')
        for language, title in [('zh-CN', '安装到'), ('en', 'Install on')]:
            result = subprocess.run(['bash', entry, '--help', '--language', language], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(title, result.stdout)
            self.assertIn('--gateway-port', result.stdout)
            self.assertNotIn('--preview-port', result.stdout)
            self.assertNotIn('--preview-origin', result.stdout)
            machine = subprocess.run(['bash', entry, '--help', '--language', language, '--output', 'json'], capture_output=True, text=True, timeout=10)
            self.assertEqual(json.loads(machine.stdout)['status'], 'help')
            self.assertNotIn('--preview-port', machine.stdout)
            self.assertNotIn('--preview-origin', machine.stdout)

    def test_real_controlling_terminal_defaults_retries_and_cancel(self):
        for language, action in [('zh-CN', 'install'), ('en', 'install'), ('en', 'cancel')]:
            with self.subTest(language=language, action=action), tempfile.TemporaryDirectory() as directory:
                chinese = language == 'zh-CN'
                dialogue = [('Language:', '')] if chinese else []
                dialogue += [
                    ('下载源：' if chinese else 'Download source:', ''),
                    ('服务器访问 IP' if chinese else 'Server access IP', '192.168.1.20'),
                    ('平台入口端口' if chinese else 'Platform entry port', 'bad'),
                    ('平台入口端口' if chinese else 'Platform entry port', ''),
                    ('完整浏览器访问网址' if chinese else 'Full browser URL', ''),
                    ('是否设置过路由器端口转发或公网 NAT？' if chinese else 'Port forwarding or public NAT?', ''),
                    ('展开高级设置？' if chinese else 'Open advanced settings?', 'n'),
                    ('摘要：install' if chinese else 'Summary: install', action),
                ]
                code, output = run_terminal(Path(__file__), ['terminal-child', directory, language], dialogue)
                self.assertEqual(code, 0, output)
                self.assertIn('输入无效' if chinese else 'Invalid input', output)
                self.assertIn('[none]', output)
                if chinese:
                    self.assertNotIn(' · Preflight · ', output)
                    self.assertNotIn(' · Configuration · ', output)
                self.assertNotIn('--preview-port', output)
                self.assertNotIn('summary (simulation)', output)
                self.assertNotIn('配置摘要（模拟）', output)
                if action == 'cancel':
                    self.assertIn('cancelled', output)
                    self.assertFalse((Path(directory)/'etc/dsh-phalanx/environment').exists())
                else:
                    self.assertIn('下一步' if chinese else 'Next:', output)
                    saved = (Path(directory)/'etc/dsh-phalanx/environment').read_text()
                    self.assertIn('DSH_PHALANX_PUBLIC_ORIGIN="http://192.168.1.20:18080"', saved)

    def test_bootstrap_language_precedes_host_admission(self):
        with tempfile.TemporaryDirectory() as directory:
            code, output = run_terminal(Path(__file__), ['bootstrap-child', directory], [('Language', 'en')])
            self.assertEqual(code, 1, output)
            self.assertNotIn('cannot execute', output)
            self.assertLess(output.index('Language'), output.index('Installation requires Linux amd64'))
            self.assertFalse((Path(directory)/'apt-called').exists())
            self.assertFalse((Path(directory)/'python-called').exists())

    def test_explicit_noninteractive_mode_does_not_prompt_even_with_a_terminal(self):
        with tempfile.TemporaryDirectory() as directory:
            code, output = run_terminal(Path(__file__), ['noninteractive-child', directory], [])
            self.assertEqual(code, 0, output)
            self.assertEqual(json.loads(output)['status'], 'installed')
            self.assertNotIn('> [', output)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'bootstrap-child':
        root = Path(sys.argv[2])
        binary = root/'bin'
        binary.mkdir()
        (binary/'uname').write_text('#!/bin/sh\necho StandaloneFixture\n')
        for name in ('apt-get', 'python3'):
            (binary/name).write_text('#!/bin/sh\ntouch "'+str(root/('apt-called' if name == 'apt-get' else 'python-called'))+'"\nexit 91\n')
        for command in binary.iterdir():
            command.chmod(0o755)
        environment = {key:value for key,value in os.environ.items() if key != 'BASH_ENV'}
        environment['PATH'] = str(binary)+':'+os.environ['PATH']
        os.execve('/bin/bash', ['bash', str(Path(__file__).resolve().parents[2]/'install.sh')], environment)
    if len(sys.argv) > 1 and sys.argv[1] == 'noninteractive-child':
        machine = InstallationMachine(sys.argv[2])
        host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
        host.terminal_available = lambda: True
        host.request = lambda *args, **kwargs: b'login'
        with contextlib.redirect_stderr(io.StringIO()):
            sys.exit(installer.main([*modern_bundle(machine), '--non-interactive', '--output', 'json'], host))
    if len(sys.argv) > 1 and sys.argv[1] == 'terminal-child':
        from installer_host import Host as TerminalHost
        machine = InstallationMachine(sys.argv[2])
        args = modern_bundle(machine)
        for flag in ('--host-public-addresses', '--public-origin'):
            index = args.index(flag)
            del args[index:index+2]
        if sys.argv[3] == 'en':
            args += ['--language', 'en']
        host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
        host.terminal_available = lambda: TerminalHost.terminal_available(host)
        host.request = lambda *args, **kwargs: b'login'
        sys.exit(installer.main(args, host))
    unittest.main()
