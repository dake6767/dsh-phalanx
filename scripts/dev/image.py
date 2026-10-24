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


def cached_image(root, inputs):
    """Verify archive bytes, OCI manifest and labels before importing host bytes."""
    if root is None: return None, 'host cache not configured'
    entry = root/inputs['inputHash']
    marker = 'dsh-phalanx-development-images-v1\n'
    try:
        for directory in (root, entry):
            if directory.is_symlink() or (directory/'.owner').is_symlink() or (directory/'.owner').read_text() != marker:
                raise ValueError('unowned host cache')
        metadata, archive = entry/'metadata.json', entry/'image.oci.tar'
        if metadata.is_symlink() or archive.is_symlink(): raise ValueError('symlink in host cache')
        value = json.loads(metadata.read_text())
        if not isinstance(value, dict): raise ValueError('host cache metadata must be an object')
        with archive.open('rb') as file: checksum = hashlib.file_digest(file, 'sha256').hexdigest()
        if checksum != value['archiveSha256']: raise ValueError('host cache archive checksum mismatch')
        reference = 'oci-archive:'+str(archive)
        raw = run(['skopeo', 'inspect', '--raw', reference], capture_output=True).stdout
        digest = 'sha256:'+hashlib.sha256(raw).hexdigest()
        if digest != value['digest']: raise ValueError('host cache image digest mismatch')
        config_digest = json.loads(raw)['config']['digest']
        if not isinstance(config_digest, str) or not re.fullmatch('sha256:[a-f0-9]{64}', config_digest):
            raise ValueError('host cache config digest is invalid')
        config = json.loads(run(['skopeo', 'inspect', '--config', reference], capture_output=True, text=True).stdout)
        if not matches(config, inputs): raise ValueError('host cache labels mismatch')
        run(['podman', 'unshare', 'skopeo', 'copy', '--preserve-digests', reference, 'containers-storage:'+LOCAL], capture_output=True)
        facts = json.loads(run(['podman', 'image', 'inspect', LOCAL], capture_output=True, text=True).stdout)[0]
        actual = {'os': facts.get('Os'), 'architecture': facts.get('Architecture'), 'config': facts.get('Config', {})}
        # Storage can retain the registry's compressed-manifest digest when an
        # equivalent OCI export is imported. Config identity includes rootfs
        # diff IDs and labels and remains stable across compression variants.
        image_id = facts.get('Id', '')
        if not isinstance(image_id, str) or image_id.removeprefix('sha256:') != config_digest[7:] or not matches(actual, inputs):
            raise ValueError('imported host cache config identity mismatch')
        return {**inputs, 'mode': 'cache', 'reference': LOCAL, 'digest': digest,
                'reason': 'verified host cache input and image config match',
                'imageConfigDigest': config_digest, 'storedManifestDigest': facts.get('Digest'),
                'buildCommit': config['config']['Labels']['org.opencontainers.image.revision']}, None
    except (OSError, ValueError, TypeError, KeyError, IndexError, subprocess.CalledProcessError) as error:
        return None, 'host cache unavailable: '+str(error)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--cache-root', type=Path)
    parser.add_argument('--preset', choices=['mainland', 'official'], required=True)
    args = parser.parse_args(); source = args.source_root.resolve()
    settings = runpy.run_path(str(source/'scripts/download-sources.py'))
    environment = settings['build_environment'](args.preset, 'arm64')
    inputs = json.loads(run(['node', source/'scripts/release/image-inputs.mjs', source,
                             '--platform', 'linux/arm64', '--node-image', environment['DSH_PHALANX_BUILD_NODE_IMAGE']],
                            capture_output=True, text=True).stdout)
    cached, cache_reason = cached_image(args.cache_root, inputs)
    if cached:
        print(json.dumps(cached)); return
    sources = json.loads((source/'src/domain/download-source-presets.json').read_text())
    mirror = sources[args.preset]['ghcrMirror']
    address = urllib.parse.urlsplit(mirror)
    transport = address.netloc+address.path+NAME.removeprefix('ghcr.io/') if mirror else NAME
    reason = 'registry metadata unavailable'
    try:
        # The mirror transports bytes; only the official registry selects identity.
        raw = run(['skopeo', 'inspect', '--raw', 'docker://'+NAME+':'+inputs['inputHash']], capture_output=True).stdout
        json.loads(raw)
        digest = 'sha256:'+hashlib.sha256(raw).hexdigest()
        reference = transport+'@'+digest
        reason = 'registry image identity mismatch'
        config = json.loads(run(['skopeo', 'inspect', '--config', 'docker://'+NAME+'@'+digest], capture_output=True, text=True).stdout)
        if not matches(config, inputs): raise ValueError(reason)
        reason = 'image pull failed'
        run(['podman', 'pull', reference], capture_output=True, text=True)
        reason = 'downloaded image digest or identity mismatch'
        facts = json.loads(run(['podman', 'image', 'inspect', reference], capture_output=True, text=True).stdout)[0]
        if not isinstance(facts, dict): raise ValueError(reason)
        actual = {'os': facts.get('Os'), 'architecture': facts.get('Architecture'), 'config': facts.get('Config', {})}
        if facts.get('Digest') != digest or not matches(actual, inputs): raise ValueError(reason)
        run(['podman', 'tag', reference, LOCAL], capture_output=True, text=True)
        print(json.dumps({**inputs, 'mode': 'pull', 'reason': cache_reason+'; verified registry input match', 'reference': LOCAL, 'registryReference': NAME+'@'+digest,
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
    print(json.dumps({**inputs, 'mode': 'build', 'reference': LOCAL, 'reason': cache_reason+'; '+reason, 'buildCommit': commit}))


if __name__ == '__main__':
    try: main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
