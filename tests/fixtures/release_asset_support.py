"""Published release fixtures shared by installer command acceptance."""
import hashlib
import json


def stable_assets(bundle, manifest=None):
    manifest = manifest or json.loads((bundle / 'manifest.json').read_text())
    policy = manifest.get('acceptancePolicy', {'ticket': 14 if manifest['targetVersion'] == '0.1.0' else 9,
        'checks': ['ci', 'linux', 'cleanInstall', 'https', 'dogfood'] if manifest['targetVersion'] == '0.1.0' else
        ['ci', 'linux', 'cleanInstall', 'https', 'models', 'spaces', 'recovery', 'storage', 'upgrade', 'review']})
    summary = b'Accepted fixture release.\n'
    summary_hash = hashlib.sha256(summary).hexdigest()
    acceptance = {'schema': 1, 'ticket': policy['ticket'], 'status': 'accepted', 'candidate': manifest['tag'],
        'commit': manifest['commit'], 'runId': manifest['runId'],
        'platformSha256': manifest['files']['dsh-phalanx-linux-amd64.tar.gz'], 'imageDigest': manifest['image']['digest'],
        'summarySha256': summary_hash, 'checks': {key: 'passed' for key in policy['checks']}}
    acceptance_bytes = json.dumps(acceptance).encode()
    release = {'schema': 1, 'version': manifest['targetVersion'], 'candidate': manifest['tag'], 'candidateRun': manifest['runId'],
        'commit': manifest['commit'], 'files': manifest['files'], 'image': manifest['image']['name']+':'+manifest['targetVersion'],
        'imageDigest': manifest['image']['digest'], 'acceptanceSha256': hashlib.sha256(acceptance_bytes).hexdigest(),
        'summarySha256': summary_hash, 'releaseNotes': 'Fixture release notes.'}
    for name, body in {'acceptance.md': summary, 'acceptance.json': acceptance_bytes, 'release.json': json.dumps(release).encode()}.items():
        (bundle / name).write_bytes(body)
    return release


def candidate_assets(bundle, manifest):
    proof = {'schema': 1, 'repository': 'dake6767/dsh-phalanx', 'candidate': manifest['tag'], 'runId': manifest['runId'],
        'commit': manifest['commit'], 'targetVersion': manifest['targetVersion'],
        'manifestSha256': hashlib.sha256((bundle / 'manifest.json').read_bytes()).hexdigest(),
        'workflow': {'path': '.github/workflows/candidate.yml', 'commit': 'c'*40, 'ref': 'refs/heads/main'}}
    (bundle / 'candidate.json').write_text(json.dumps(proof))
    return proof
