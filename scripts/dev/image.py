"""Select a verified arm64 development image, or build the local fallback."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import runpy
import subprocess
import sys
import urllib.parse

NAME = 'ghcr.io/dake6767/dsh-phalanx-dev'
LOCAL = 'localhost/dsh-development:current'


def run(args, **options):
    return subprocess.run([str(part) for part in args], check=True, **options)


def matches(config, inputs):
    if not isinstance(config, dict) or not isinstance(config.get('config'), dict): return False
    labels = config['config'].get('Labels')
    if not isinstance(labels, dict): return False
    return (config.get('os') == 'linux' and config.get('architecture') == 'arm64' and
            config.get('config', {}).get('User') == 'node' and
            labels.get('dsh.input.sha256') == inputs['inputHash'] and
            labels.get('dsh.revision') == inputs['dshRevision'] and
            labels.get('org.opencontainers.image.source') == 'https://github.com/dake6767/dsh-phalanx' and
            isinstance(labels.get('org.opencontainers.image.revision'), str) and
            re.fullmatch('[a-f0-9]{40}', labels['org.opencontainers.image.revision']) is not None and
            labels.get('dsh.development') == 'unsupported')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--preset', choices=['mainland', 'official'], required=True)
    args = parser.parse_args(); source = args.source_root.resolve()
    settings = runpy.run_path(str(source/'scripts/download-sources.py'))
    environment = settings['build_environment'](args.preset, 'arm64')
    inputs = json.loads(run(['node', source/'scripts/release/image-inputs.mjs', source,
                             '--platform', 'linux/arm64', '--node-image', environment['DSH_PHALANX_BUILD_NODE_IMAGE']],
                            capture_output=True, text=True).stdout)
    sources = json.loads((source/'src/domain/download-source-presets.json').read_text())
    mirror = sources[args.preset]['ghcrMirror']
    address = urllib.parse.urlsplit(mirror)
    transport = address.netloc+address.path+NAME.removeprefix('ghcr.io/') if mirror else NAME
    reason = 'registry metadata unavailable'
    try:
        raw = run(['skopeo', 'inspect', '--raw', 'docker://'+transport+':'+inputs['inputHash']], capture_output=True).stdout
        json.loads(raw)
        digest = 'sha256:'+hashlib.sha256(raw).hexdigest()
        reference = transport+'@'+digest
        reason = 'registry image identity mismatch'
        config = json.loads(run(['skopeo', 'inspect', '--config', 'docker://'+reference], capture_output=True, text=True).stdout)
        if not matches(config, inputs): raise ValueError(reason)
        reason = 'image pull failed'
        run(['podman', 'pull', reference], capture_output=True, text=True)
        reason = 'downloaded image digest or identity mismatch'
        facts = json.loads(run(['podman', 'image', 'inspect', reference], capture_output=True, text=True).stdout)[0]
        if not isinstance(facts, dict): raise ValueError(reason)
        actual = {'os': facts.get('Os'), 'architecture': facts.get('Architecture'), 'config': facts.get('Config', {})}
        if facts.get('Digest') != digest or not matches(actual, inputs): raise ValueError(reason)
        run(['podman', 'tag', reference, LOCAL], capture_output=True, text=True)
        print(json.dumps({**inputs, 'mode': 'pull', 'reference': LOCAL, 'registryReference': NAME+'@'+digest,
                          'digest': digest, 'buildCommit': config['config']['Labels']['org.opencontainers.image.revision']}))
        return
    except (OSError, ValueError, KeyError, IndexError, subprocess.CalledProcessError):
        print('Development image unavailable ('+reason+'); falling back to local build.', file=sys.stderr)
    commit = run(['git', '-C', source, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
    run(['podman', 'build', '--format', 'oci', '--label', 'dsh.input.sha256='+inputs['inputHash'],
         '--label', 'org.opencontainers.image.revision='+commit,
         '--label', 'org.opencontainers.image.source=https://github.com/dake6767/dsh-phalanx',
         '--label', 'dsh.development=unsupported', '--label', 'org.opencontainers.image.description=For development only; unsupported',
         '--build-arg', 'NPM_REGISTRY='+environment['NPM_CONFIG_REGISTRY'],
         '--build-arg', 'NODE_IMAGE='+environment['DSH_PHALANX_BUILD_NODE_IMAGE'],
         '-t', LOCAL, '-f', source/'containers/dsh/Containerfile', source/'containers/dsh'], stdout=sys.stderr)
    print(json.dumps({**inputs, 'mode': 'build', 'reference': LOCAL, 'reason': reason, 'buildCommit': commit}))


if __name__ == '__main__':
    try: main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
