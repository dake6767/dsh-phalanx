"""The development DNS repair preserves unowned hosts and rejects private answers."""
import io
import json
from pathlib import Path
import runpy
import tempfile
from unittest.mock import patch
import unittest

dns = runpy.run_path('scripts/dev/registry-dns.py')


class DevelopmentDns(unittest.TestCase):
    def test_official_source_does_not_depend_on_unselected_mirror_dns(self):
        with tempfile.TemporaryDirectory() as directory:
            hosts = Path(directory) / 'hosts'
            hosts.write_text('127.0.0.1 localhost\n')
            def resolve(name, port):
                if name != 'registry.npmjs.org': raise OSError('unselected mirror is unavailable')
                return [(None, None, None, None, ('104.16.1.35', port))]
            with patch('socket.getaddrinfo', side_effect=resolve) as lookup:
                result = dns['registry_dns']('https://registry.npmjs.org/', hosts)
                self.assertEqual(result['ownedRegistryEntries'], 0)
                lookup.assert_called_once_with('registry.npmjs.org', 443)

    def test_refresh_keeps_registry_repair_when_resolver_caches_the_old_hosts_answer(self):
        with tempfile.TemporaryDirectory() as directory:
            hosts = Path(directory) / 'hosts'
            retained = '127.0.0.1 localhost\n10.1.2.3 retained.internal\n'
            hosts.write_text(retained + dns['BEGIN'] + '104.16.1.35 registry.npmjs.org\n' + dns['END'])
            # systemd-resolved may still answer from its hosts cache immediately
            # after that managed block is removed. A later lookup returns synthetic DNS.
            cached = [(None, None, None, None, ('104.16.1.35', 443))]
            answer = io.BytesIO(b'{"Status":0,"Answer":[{"type":1,"data":"104.16.2.35"}]}')
            with patch('socket.getaddrinfo', return_value=cached), patch('urllib.request.urlopen', return_value=answer):
                dns['registry_dns']('https://registry.npmjs.org/', hosts)
            self.assertTrue(hosts.read_text().startswith(retained))
            self.assertIn('104.16.2.35 registry.npmjs.org\n', hosts.read_text())
            self.assertEqual(hosts.read_text().count(dns['BEGIN']), 1)

    def test_refreshes_only_owned_entries_and_rejects_nonpublic_answers(self):
        with tempfile.TemporaryDirectory() as directory:
            hosts = Path(directory) / 'hosts'
            original = '127.0.0.1 localhost\n10.1.2.3 retained.internal\n'
            hosts.write_text(original)
            answer = lambda *a, **k: io.BytesIO(json.dumps({'Status': 0, 'Answer': [{'type': 1, 'data': '104.16.1.35'}]}).encode())
            synthetic = lambda *a, **k: [(None, None, None, None, ('198.18.0.22', 443))]
            with patch('socket.getaddrinfo', side_effect=synthetic), patch('urllib.request.urlopen', side_effect=answer):
                result = dns['registry_dns']('https://registry.npmmirror.com/', hosts)
                self.assertEqual(result['ownedRegistryEntries'], 2)
                self.assertTrue(hosts.read_text().startswith(original))
                dns['registry_dns']('https://registry.npmmirror.com/', hosts)
                self.assertEqual(hosts.read_text().count(dns['BEGIN']), 1)
            private = lambda *a, **k: io.BytesIO(b'{"Status":0,"Answer":[{"type":1,"data":"127.0.0.1"}]}')
            with patch('socket.getaddrinfo', side_effect=synthetic), patch('urllib.request.urlopen', side_effect=private):
                with self.assertRaisesRegex(ValueError, 'public DNS'): dns['registry_dns']('https://registry.npmmirror.com/', hosts)
            self.assertEqual(hosts.read_text(), original)
            hosts.write_text(original+dns['BEGIN']+'malformed')
            with self.assertRaisesRegex(ValueError, 'marker'): dns['registry_dns']('https://registry.npmmirror.com/', hosts)
            self.assertEqual(hosts.read_text(), original+dns['BEGIN']+'malformed')


if __name__ == '__main__': unittest.main()
