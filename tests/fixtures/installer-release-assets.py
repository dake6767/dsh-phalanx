"""Stable and candidate discovery crosses HTTP using release assets only."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import tempfile
import unittest
from installer_contract_support import installer, InstallationMachine
from release_asset_support import stable_assets, candidate_assets

support = runpy.run_path(str(Path(__file__).with_name('installer-download-sources.py')))
proxy_server, run_bundle = support['proxy_server'], support['run_bundle']


class AssetDiscovery(unittest.TestCase):
    def test_release_assets_select_and_verify_without_api_requests(self):
        for case in ('latest', 'explicit', 'candidate', 'pointer-mismatch', 'incomplete', 'bad-acceptance', 'bad-candidate'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                machine = InstallationMachine(directory)
                args, bundle, manifest = run_bundle(machine)
                release = stable_assets(bundle, manifest)
                proof = candidate_assets(bundle, manifest)
                candidate = case in ('candidate', 'bad-candidate')
                tag = manifest['tag'] if candidate else 'v'+manifest['targetVersion']
                base = 'https://github.com/dake6767/dsh-phalanx'+('-candidates' if candidate else '')+'/releases'
                version = tag if case in ('explicit', 'candidate', 'bad-candidate') else 'latest'
                pointer = dict(release)
                if case == 'pointer-mismatch': pointer['commit'] = 'f'*40
                if case == 'bad-acceptance': (bundle/'acceptance.json').write_text('{}')
                if case == 'bad-candidate':
                    proof['commit'] = 'f'*40; (bundle/'candidate.json').write_text(json.dumps(proof))
                requests = []
                def respond(url):
                    requests.append(url)
                    if url == base+'/latest/download/release.json': return 200, json.dumps(pointer).encode()
                    prefix = base+'/download/'+tag+'/'
                    if url.startswith(prefix):
                        name = url[len(prefix):]
                        if case == 'incomplete' and name == 'acceptance.md': return 404, b'missing'
                        if (bundle/name).is_file(): return 200, (bundle/name).read_bytes()
                    return 404, b'Only release assets are available'
                with proxy_server(respond) as proxy:
                    host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
                    wire = host.request
                    def request(url, **kwargs):
                        if 'api.github.com' in url:
                            requests.append(url); raise installer.InstallError('GitHub API is unavailable')
                        return wire(url, **kwargs) if url.startswith('https://') else b'login'
                    host.request = request
                    flags = ['--dev-release-base-url', base] if candidate else []
                    with contextlib.redirect_stdout(out := io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        result = installer.main(['--version', version, *args[4:], '--github-proxy-prefix', proxy, *flags, '--output', 'json'], host)
                valid = case in ('latest', 'explicit', 'candidate')
                self.assertEqual(result, 0 if valid else 1, out.getvalue())
                self.assertTrue(requests)
                self.assertFalse(any('api.github.com' in url for url in requests))
                self.assertEqual(machine.active, valid)
                if valid:
                    receipt=json.loads((machine.root/'etc/dsh-phalanx/install-state.json').read_text())
                    self.assertEqual(receipt.get('channel'),{'kind':'candidate' if candidate else 'formal','baseUrl':base})
                    self.assertNotIn('channel',manifest)

                if not valid:
                    self.assertEqual(machine.calls, [])
                    self.assertRegex(out.getvalue(), 'Release|release|acceptance|Candidate|candidate')


if __name__ == '__main__': unittest.main()
