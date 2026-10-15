"""Run the installation/update CLI through an actual HTTP proxy fixture."""
import base64
import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import runpy
import sqlite3
import tempfile
import threading
from unittest.mock import patch
import unittest
from installer_contract_support import installer, InstallationMachine

run_bundle = runpy.run_path(str(Path(__file__).with_name('installer-development.py')))['run_bundle']


@contextlib.contextmanager
def proxy_server(respond):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            status, body = respond(self.path[1:])
            self.send_response(status); self.send_header('Content-Length', str(len(body)))
            self.end_headers(); self.wfile.write(body)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try: yield 'http://127.0.0.1:'+str(server.server_port)+'/'
    finally: server.shutdown(); server.server_close(); thread.join()


class ProxyInstallation(unittest.TestCase):
    def test_proxy_preserves_installation_upgrade_and_artifact_verification(self):
        for case in ('install', 'upgrade', 'tampered', 'truncated', 'unavailable'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                support = runpy.run_path(str(Path(__file__).with_name('upgrade-cleanup.py')))
                machine = support['CleanupMachine'](directory) if case == 'upgrade' else InstallationMachine(directory)
                args, bundle, manifest = run_bundle(machine)
                host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
                wire_request = host.request
                if case == 'upgrade':
                    target_image = machine.image_facts
                    before = machine.make_bundle('v0.1.15-rc.1', 'f', 'f')
                    path = Path(before[3]) / 'manifest.json'; prior = json.loads(path.read_text())
                    prior.update({key: manifest[key] for key in ('schema', 'compatibility', 'acceptancePolicy', 'storage', 'updater')})
                    path.write_text(json.dumps(prior)); host.request = lambda *a, **k: b'login'
                    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        self.assertEqual(installer.main(before, host), 0)
                    data = machine.root / 'var/lib/dsh-phalanx/data'; data.mkdir()
                    with contextlib.closing(sqlite3.connect(data / 'community-accounts.db')) as connection:
                        connection.execute('PRAGMA user_version=5')
                    (data / 'keep').write_text('preserve member data')
                    machine.image_facts = target_image
                base = 'https://github.com/dake6767/dsh-phalanx-candidates/releases'
                api = 'https://api.github.com/repos/dake6767/dsh-phalanx'
                workflow = 'c'*40; source = manifest['commit']
                facts = {
                    api+'-candidates/releases/tags/run-42': {'tag_name': 'run-42', 'draft': False, 'prerelease': True,
                        'assets': [{'name': name} for name in ('manifest.json', 'SHA256SUMS', *installer.ASSETS)]},
                    api+'-candidates/git/ref/tags/run-42': {'object': {'type': 'commit', 'sha': 'd'*40}},
                    api+'/actions/runs/42': {'id': 42, 'status': 'completed', 'conclusion': 'success', 'event': 'workflow_dispatch',
                        'head_branch': 'main', 'head_sha': workflow, 'path': '.github/workflows/candidate.yml'},
                    api+'/compare/'+source+'...'+workflow: {'status': 'ahead'},
                    api+'/contents/package.json?ref='+source: {'content': base64.b64encode(b'{"version":"0.1.16"}').decode()},
                }
                requests = []
                def respond(url):
                    requests.append(url)
                    if case == 'unavailable': return 503, b'fixture unavailable'
                    if url in facts: return 200, json.dumps(facts[url]).encode()
                    if url.startswith(base+'/download/run-42/'):
                        name = url.rsplit('/', 1)[1]; body = (bundle / name).read_bytes()
                        if name == installer.ASSETS[0]:
                            if case == 'tampered': body = b'changed archive bytes'
                            if case == 'truncated': body = body[:len(body)//2]
                        return 200, body
                    return 404, b'Unexpected fixture path'
                with proxy_server(respond) as proxy:
                    selection = {'preset': 'official', 'overrides': {'githubApi': proxy, 'githubAssets': proxy,
                        'ghcrMirror': 'https://images.example.test/'}}
                    flags = ['--github-api-proxy-prefix', proxy, '--github-proxy-prefix', proxy, '--ghcr-mirror', 'https://images.example.test/']
                    if case == 'upgrade':
                        (data / 'download-sources.json').write_text(json.dumps(selection)); flags = []
                    # Readiness remains the OS fixture; GitHub bytes cross real HTTP.
                    host.request = lambda url, **options: wire_request(url, **options) if url.startswith('https://') else b'login'
                    with patch('installer_upgrade_host.LinuxAdmissionGate', support['GATE']), contextlib.redirect_stdout(out := io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        result = installer.main([*args[:2], *args[4:], '--dev-release-base-url', base, *flags, '--yes', '--output', 'json'], host)
                    self.assertEqual(result, 0 if case in ('install', 'upgrade') else 1, out.getvalue())
                    self.assertTrue(requests, 'The configured proxy must receive actual requests')
                    if case == 'unavailable':
                        self.assertIn('GitHub API', out.getvalue()); self.assertIn(proxy, out.getvalue())
                        self.assertIn('--github-api-proxy-prefix', out.getvalue())
                    elif case in ('tampered', 'truncated'):
                        self.assertIn('checksum', out.getvalue().lower()); self.assertFalse(machine.active)
                    else:
                        nested = [row[row.index('--')+1:] for row in machine.calls if row[0] == 'runuser']
                        self.assertIn(['podman', 'pull', 'images.example.test/dake6767/dsh-phalanx@'+manifest['image']['digest']], nested)
                        self.assertIn(['podman', 'tag', 'images.example.test/dake6767/dsh-phalanx@'+manifest['image']['digest'], 'ghcr.io/dake6767/dsh-phalanx:run-42'], nested)
                        if case == 'upgrade':
                            self.assertEqual(json.loads(out.getvalue())['operation']['phase'], 'succeeded')
                            self.assertEqual((data / 'keep').read_text(), 'preserve member data')


if __name__ == '__main__': unittest.main()
