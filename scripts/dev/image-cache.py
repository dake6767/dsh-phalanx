"""Manage only marked host OCI entries, retaining the three latest versions."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

MARKER = 'dsh-phalanx-development-images-v1'


def owned(path):
    marker = path/'.owner'
    return not path.is_symlink() and marker.is_file() and not marker.is_symlink() and marker.read_text() == MARKER+'\n'


def initialize(root):
    if root.exists():
        if not owned(root): raise ValueError('Image cache is not owned by this tool: '+str(root))
    else:
        root.mkdir(parents=True, mode=0o755)
        (root/'.owner').write_text(MARKER+'\n')
    root.chmod(0o755)
    (root/'.owner').chmod(0o644)
    return root


def record(root, version, key):
    if not re.fullmatch(r'\d+\.\d+\.\d+', version) or not re.fullmatch('[a-f0-9]{64}', key):
        raise ValueError('Invalid cache version or input hash')
    index = root/'versions.json'
    if index.is_symlink(): raise ValueError('Cache version index must not be a symlink')
    versions = json.loads(index.read_text()) if index.exists() else {}
    entry = versions.setdefault(version, {'inputs': [], 'used': 0})
    entry['used'] = time.time_ns()
    if key not in entry['inputs']: entry['inputs'].append(key)
    versions = dict(sorted(versions.items(), key=lambda item: item[1]['used'], reverse=True)[:3])
    stage = root/'versions.json.tmp'
    if stage.is_symlink(): raise ValueError('Cache index stage must not be a symlink')
    stage.write_text(json.dumps(versions)+'\n'); stage.replace(index)
    keep = {item for value in versions.values() for item in value['inputs']}
    for entry in root.iterdir():
        if re.fullmatch('[a-f0-9]{64}', entry.name) and entry.name not in keep and owned(entry):
            # Never follow a foreign link, even inside a marked entry.
            shutil.rmtree(entry)


def collect(root, version):
    result = subprocess.run(['limactl', 'shell', '--workdir=/mnt/dsh-phalanx', 'development', 'sudo',
                             'cat', '/var/lib/dsh-phalanx-dev/build.json'], check=True, capture_output=True, text=True)
    receipt = json.loads(result.stdout)
    image = receipt['imageSource']; key = image['inputHash']
    if not re.fullmatch('[a-f0-9]{64}', key): raise ValueError('Invalid image input hash')
    target = root/key
    backup = root/('.replaced-'+key)
    if backup.exists():
        if not owned(backup): raise ValueError('Refusing a foreign cache replacement backup')
        if not target.exists(): backup.rename(target)
        elif owned(target): shutil.rmtree(backup)
        else: raise ValueError('Refusing a foreign cache replacement target')
    if target.exists() and not owned(target): raise ValueError('Refusing a foreign cache entry')
    # Recopy even a previously marked corrupt entry; the guest verified the new bundle.
    if image['mode'] != 'cache' or not target.exists():
        with tempfile.TemporaryDirectory(prefix='.image-', dir=root) as temporary:
            stage = Path(temporary)
            archive = stage/'image.oci.tar'
            subprocess.run(['limactl', 'copy', 'development:/var/lib/dsh-phalanx-dev/bundle/dsh-phalanx-dsh-linux-arm64.oci.tar', str(archive)], check=True)
            checksum = hashlib.sha256()
            with archive.open('rb') as file:
                for chunk in iter(lambda: file.read(1024*1024), b''): checksum.update(chunk)
            checksum = checksum.hexdigest()
            metadata = {**image, 'digest': receipt['manifest']['image']['digest'], 'archiveSha256': checksum}
            (stage/'metadata.json').write_text(json.dumps(metadata)+'\n')
            (stage/'.owner').write_text(MARKER+'\n')
            for file in stage.iterdir(): file.chmod(0o644)
            os.chmod(stage, 0o755)
            if target.exists(): target.rename(backup)
            stage.rename(target)
            if backup.exists(): shutil.rmtree(backup)
    record(root, version, key)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['init', 'collect'])
    parser.add_argument('root', type=Path)
    parser.add_argument('--version')
    args = parser.parse_args()
    try:
        root = initialize(args.root)
        if args.action == 'collect': collect(root, args.version)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, str(error)+'\n')
