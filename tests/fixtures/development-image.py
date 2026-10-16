"""Exercise the development image CLI with external Podman/registry fixtures."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2]
RAW = b'{"schemaVersion":2,"layers":[]}'
DIGEST = 'sha256:'+hashlib.sha256(RAW).hexdigest()


def external():
    root = Path(os.environ['DEVELOPMENT_IMAGE_FIXTURE'])
    command, args = sys.argv[1], sys.argv[2:]
    with (root/'calls.jsonl').open('a') as file: file.write(json.dumps([command, *args])+'\n')
    inputs = json.loads((root/'inputs.json').read_text())
    mode = os.environ.get('DEVELOPMENT_IMAGE_CASE', 'ready')
    built = (root/'built').exists()
    labels = {'dsh.input.sha256': inputs['inputHash'], 'dsh.revision': inputs['dshRevision'],
              'org.opencontainers.image.source': 'https://github.com/dake6767/dsh-phalanx',
              'org.opencontainers.image.revision': 'a'*40, 'dsh.development': 'unsupported'}
    if mode == 'wrong-hash' and not built: labels['dsh.input.sha256'] = '0'*64
    config = {'User': 'node', 'Labels': labels}
    if command == 'skopeo':
        if mode == 'missing': sys.exit(1)
        if '--raw' in args: sys.stdout.buffer.write(RAW)
        elif '--config' in args: print(json.dumps({'os': 'linux', 'architecture': 'arm64', 'config': config}))
        else: raise ValueError('Unexpected skopeo command')
    elif args[0] == 'build':
        if mode == 'build-failed': sys.exit(1)
        (root/'built').touch()
    elif args[:2] == ['image', 'inspect']:
        print(json.dumps([{'Digest': 'sha256:'+'0'*64 if mode == 'wrong-digest' and not built else DIGEST,
                           'Os': 'linux', 'Architecture': 'arm64', 'Config': config}]))
    elif args[0] == 'pull':
        if mode in ('pull-failed', 'build-failed'): sys.exit(1)
    elif args[0] != 'tag': raise ValueError('Unexpected Podman command')


class DevelopmentImage(unittest.TestCase):
    def test_public_cli(self):
        inputs = json.loads(subprocess.run(['node', 'scripts/release/image-inputs.mjs', '--platform', 'linux/arm64'],
                                         cwd=SOURCE, check=True, capture_output=True, text=True).stdout)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); (root/'inputs.json').write_text(json.dumps(inputs))
            for command in ('podman', 'skopeo'):
                path = root/command
                path.write_text('#!/bin/sh\nexec "'+sys.executable+'" "'+str(Path(__file__).resolve())+'" '+command+' "$@"\n')
                path.chmod(0o755)
            for mode, preset in [('ready', 'official'), ('ready', 'mainland'), ('missing', 'official'),
                                 ('wrong-hash', 'official'), ('pull-failed', 'official'), ('wrong-digest', 'official')]:
                (root/'calls.jsonl').write_text(''); (root/'built').unlink(missing_ok=True)
                result = subprocess.run([sys.executable, SOURCE/'scripts/dev/image.py', '--source-root', SOURCE, '--preset', preset],
                                        env={**os.environ, 'PATH': str(root)+':'+os.environ['PATH'],
                                             'DEVELOPMENT_IMAGE_FIXTURE': str(root), 'DEVELOPMENT_IMAGE_CASE': mode}, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                value = json.loads(result.stdout)
                calls = [json.loads(line) for line in (root/'calls.jsonl').read_text().splitlines()]
                if mode == 'ready':
                    self.assertEqual(value['mode'], 'pull'); self.assertEqual(value['digest'], DIGEST)
                    self.assertFalse(any(call[1] == 'build' for call in calls))
                    metadata = next(call for call in calls if call[0] == 'skopeo' and '--raw' in call)
                    self.assertEqual(metadata[-1], 'docker://ghcr.io/dake6767/dsh-phalanx-dev:'+inputs['inputHash'])
                    prefix = 'ghcr.nju.edu.cn/' if preset == 'mainland' else 'ghcr.io/'
                    pull = next(call for call in calls if call[1] == 'pull')
                    self.assertEqual(pull[-1], prefix+'dake6767/dsh-phalanx-dev@'+DIGEST)
                else:
                    self.assertEqual(value['mode'], 'build')
                    self.assertTrue(any(call[1] == 'build' for call in calls))
                    self.assertIn('falling back to local build', result.stderr)
                self.assertEqual(value['inputHash'], inputs['inputHash'])
            (root/'built').unlink(missing_ok=True)
            failed = subprocess.run([sys.executable, SOURCE/'scripts/dev/image.py', '--source-root', SOURCE, '--preset', 'official'],
                                    env={**os.environ, 'PATH': str(root)+':'+os.environ['PATH'], 'DEVELOPMENT_IMAGE_FIXTURE': str(root),
                                         'DEVELOPMENT_IMAGE_CASE': 'build-failed'}, capture_output=True, text=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn('falling back to local build', failed.stderr)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] in ('podman', 'skopeo'): external()
    else: unittest.main()
