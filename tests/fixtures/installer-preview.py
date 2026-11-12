"""Exercise only the public preview subprocess, including real PTY input."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from functools import partial
from terminal_dialogue import run_terminal

ENTRY = str(Path(__file__).resolve().parents[2] / 'scripts/install/preview.py')


def run(*args):
    return subprocess.run([sys.executable, ENTRY, *args], capture_output=True, text=True, timeout=10)


terminal = partial(run_terminal, ENTRY)


class PreviewContract(unittest.TestCase):
    def test_noninteractive_missing_mapping_is_not_explicit_none(self):
        result = run('--server-ip', '192.0.2.10', '--output', 'json')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)['missing'], ['--host-public-addresses'])

    def test_machine_failure_stages_and_success_are_side_effect_free(self):
        with tempfile.TemporaryDirectory() as directory:
            for stage in ('lookup', 'prepare', 'download', 'deploy', 'ready', None):
                args = ['--server-ip', '192.0.2.10', '--host-public-addresses', '', '--output', 'json', '--user-data-root', directory + '/untouched']
                result = run(*args, *(['--fail-stage', stage] if stage else []))
                self.assertEqual(result.returncode, 1 if stage else 0, result.stderr)
                record = json.loads(result.stdout)
                self.assertTrue(record['simulation'])
                self.assertFalse(record['changed'])
                self.assertEqual(record['status'], 'failed' if stage else 'succeeded')
                if stage:
                    self.assertEqual(record['stage'], stage)
                else:
                    self.assertEqual(record['initialization_url'], 'http://192.0.2.10:18080/bootstrap')
                self.assertEqual(list(Path(directory).iterdir()), [])

    def test_english_full_terminal_https_advanced_edit_and_source_recheck(self):
        code, output = terminal([], [
            ('Language:', 'en'), ('Download source:', ''), ('Server access IP', 'bad'),
            ('Invalid input;', '192.0.2.10'), ('Platform entry port', 'abc'),
            ('Invalid input;', '18080'), ('Full browser URL', 'https://team.example.com'),
            ('Port forwarding or public NAT?', 'none'), ('Open advanced settings?', 'y'),
            ('Internal gateway port', '3082'), ('Member data directory', '/srv/team/users'),
            ('Existing data mount', '/srv/team'), ('Summary: install', 'edit'),
            ('Edit: source', 'source'), ('Download source:', 'mainland'),
            ('Summary: install', 'install'),
        ])
        self.assertEqual(code, 0, output)
        self.assertIn('Initialization URL: https://team.example.com/bootstrap', output)
        self.assertIn('version recheck', output)
        self.assertIn('small teams', output)
        self.assertIn('https://github.com/dake6767/dsh-phalanx', output)
        self.assertNotIn('preview-port', output)
        self.assertNotIn('preview-origin', output)

    def test_default_chinese_lan_and_cancel(self):
        for action in ('install', 'cancel'):
            code, output = terminal([], [
                ('Language:', ''), ('下载源：', ''), ('服务器访问 IP', '192.168.1.20'),
                ('平台入口端口', ''), ('完整浏览器访问网址', ''),
                ('是否设置过路由器端口转发或公网 NAT？', ''), ('展开高级设置？', ''), ('摘要：install', action),
            ])
            self.assertEqual(code, 0, output)
            self.assertIn('【模拟】', output)
            self.assertIn('方括号 [] 内是默认值，直接回车采用', output)
            self.assertIn('[none]', output)
            self.assertIn('明确没有额外映射', output)
            self.assertIn('http://192.168.1.20:18080', output)
            self.assertIn('模拟安装完成' if action == 'install' else '模拟已取消', output)
            self.assertNotIn('服务预览', output)

    def test_public_mapping_list_and_undeclared_are_distinct(self):
        for choice, extra, expected in [('list', [('完整公网 IPv4 清单', '8.8.8.8,9.9.9.9')], '8.8.8.8,9.9.9.9'), ('undeclared', [], '未声明，成员出网被阻止')]:
            code, output = terminal(['--language', 'zh-CN'], [
                ('下载源：', ''), ('服务器访问 IP', '203.0.113.5'), ('平台入口端口', ''),
                ('完整浏览器访问网址', ''), ('是否设置过路由器端口转发或公网 NAT？', choice), *extra,
                ('展开高级设置？', ''), ('摘要：install', 'install'),
            ])
            self.assertEqual(code, 0, output)
            self.assertIn(expected, output)

    def test_management_states_partial_failure_and_purge_confirmation(self):
        for command in ('start', 'stop', 'uninstall'):
            for extra in ([], ['--fail-stage', 'operation'], ['--state', 'maintenance']):
                result = run(command, '--yes', '--output', 'json', *extra)
                self.assertEqual(result.returncode, 1 if extra else 0, result.stderr)
                self.assertFalse(json.loads(result.stdout)['changed'])
        for state in ('running', 'stopped', 'partial', 'maintenance', 'not-installed', 'query-failed'):
            result = run('status', '--state', state, '--output', 'json')
            self.assertEqual(json.loads(result.stdout)['deployment_state'], state)
            self.assertEqual(result.returncode, 1 if state in ('query-failed','partial') else 0)
        code, output = terminal(['uninstall', '--purge', '--language', 'en'], [('Type PURGE', 'PURGE')])
        self.assertEqual(code, 0, output)
        self.assertIn('external directories', output)
        self.assertIn('Always retain: external PostgreSQL', output)
        result = run('uninstall', '--language', 'en', '--yes')
        self.assertIn('matching keys', result.stdout)
        self.assertIn('sudo bash install.sh --uninstall --purge', result.stdout)

    def test_rehearsal_cannot_write_or_operate_the_host(self):
        guard = """
import os, runpy, sys
entry, *arguments = sys.argv[1:]
sys.argv = [entry, *arguments]
def audit(event, arguments):
    if event.startswith(('subprocess.', 'socket.')) or event in ('os.system', 'os.remove', 'os.rmdir', 'os.rename', 'os.mkdir', 'os.chmod', 'os.chown', 'os.kill'):
        raise AssertionError('host effect: ' + event)
    if event == 'open':
        mode, flags = arguments[1:3]
        if (isinstance(mode, str) and any(letter in mode for letter in 'wax+')) or (isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC)):
            raise AssertionError('host write')
sys.addaudithook(audit)
runpy.run_path(entry, run_name='__main__')
"""
        for args in [
            ['install', '--server-ip', '192.0.2.10', '--host-public-addresses', ''],
            ['start', '--state', 'stopped'], ['stop', '--yes'],
            ['status'], ['uninstall', '--purge', '--yes'],
        ]:
            result = subprocess.run([sys.executable, '-B', '-c', guard, ENTRY, *args, '--output', 'json'], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(json.loads(result.stdout)['changed'])

    def test_source_overrides_and_human_component_status(self):
        result = run('--server-ip', '192.0.2.10', '--host-public-addresses', '', '--download-source-preset', 'mainland', '--npm-registry', 'https://npm.example.com', '--output', 'json')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['configuration']['overrides']['npm'], 'https://npm.example.com')
        status = run('status', '--state', 'partial', '--language', 'en')
        self.assertIn('platform: stopped', status.stdout)
        self.assertIn('members: running', status.stdout)

    def test_editing_generated_url_tracks_ip_and_port(self):
        code, output = terminal(['--language', 'en'], [
            ('Download source:', ''), ('Server access IP', '192.0.2.10'),
            ('Platform entry port', ''), ('Full browser URL', ''),
            ('Port forwarding or public NAT?', 'none'), ('Open advanced settings?', ''),
            ('Summary: install', 'edit'), ('Edit: source', 'common'),
            ('Server access IP', '192.0.2.11'), ('Platform entry port', '18081'),
            ('Full browser URL', ''), ('Port forwarding or public NAT?', 'none'),
            ('Summary: install', 'install'),
        ])
        self.assertEqual(code, 0, output)
        self.assertIn('Initialization URL: http://192.0.2.11:18081/bootstrap', output)

    def test_custom_source_before_lookup_and_explicit_domain_survives_edit(self):
        code, output = terminal(['--language', 'en'], [
            ('Download source:', 'custom'), ('Custom base', 'mainland'),
            ('Override category or done:', 'npm'), ('Source URL', 'https://npm.example.com'),
            ('Override category or done:', 'done'), ('Server access IP', '192.0.2.10'),
            ('Platform entry port', ''), ('Full browser URL', 'https://team.example.com'),
            ('Port forwarding or public NAT?', 'none'), ('Open advanced settings?', ''),
            ('Summary: install', 'edit'), ('Edit: source', 'common'),
            ('Server access IP', '192.0.2.11'), ('Platform entry port', '18081'),
            ('Full browser URL', ''), ('Port forwarding or public NAT?', 'none'),
            ('Summary: install', 'install'),
        ])
        self.assertEqual(code, 0, output)
        self.assertLess(output.index('https://npm.example.com'), output.index('Simulating version lookup'))
        self.assertIn('Initialization URL: https://team.example.com/bootstrap', output)
        for flag in ('--npm-registry', '--pypi-index', '--container-mirror', '--ghcr-mirror', '--github-proxy-prefix', '--github-api-proxy-prefix', '--browser-download-host', '--chromium-arm64-download-host'):
            result = run('--server-ip', '192.0.2.10', '--host-public-addresses', '', flag, 'https://source.example.com', '--output', 'json')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(json.loads(result.stdout)['configuration']['overrides']), 1)

    def test_help_and_bad_configuration(self):
        for language in ('en', 'zh-CN'):
            result = run('--language', language, '--help')
            self.assertEqual(result.returncode, 0)
            self.assertNotIn('--preview-port', result.stdout)
            self.assertNotIn('--preview-origin', result.stdout)
            self.assertIn('--gateway-port', result.stdout)
            machine = run('--language', language, '--help', '--output', 'json')
            self.assertEqual(json.loads(machine.stdout)['status'], 'help')
            self.assertNotIn('--preview-port', machine.stdout)
            self.assertNotIn('--preview-origin', machine.stdout)
        for flag, value in [('--port', '0'), ('--public-origin', 'https://user:secret@example.com'), ('--server-ip', 'bad')]:
            result = run('--server-ip', '192.0.2.10', '--host-public-addresses', '', flag, value, '--output', 'json')
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)['code'], 'invalid_configuration')


if __name__ == '__main__':
    unittest.main()
