"""Apply the product presets to CI, developer builds and validation commands."""
import argparse
import json
import os
from pathlib import Path
import platform
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts/install'))
from installer_config import DOWNLOAD_SOURCE_PRESETS, download_source_environment, resolve_download_sources


def build_environment(preset, architecture):
    sources = resolve_download_sources({'preset': preset})
    values = download_source_environment(sources, architecture)
    base = re.search(r'^ARG NODE_IMAGE=(.+)$', (ROOT / 'containers/dsh/Containerfile').read_text(), re.M).group(1)
    if sources['containerMirror']:
        base = sources['containerMirror'].removeprefix('https://').removeprefix('http://') + base.removeprefix('docker.io/')
    values.update(DSH_PHALANX_BUILD_NODE_IMAGE=base,
                  DSH_PHALANX_NODE_DOWNLOAD_PREFIX=DOWNLOAD_SOURCE_PRESETS['bootstrap'][preset]['nodePrefix'],
                  DSH_PHALANX_DOWNLOAD_SOURCES=json.dumps({'preset': preset}, separators=(',', ':')))
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--preset', choices=['official', 'mainland'], default='official')
    parser.add_argument('--github-env', action='store_true')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    values = build_environment(args.preset, 'arm64' if platform.machine() in ('arm64', 'aarch64') else 'amd64')
    if args.github_env:
        if args.command: parser.error('Choose environment output or a command')
        print('\n'.join(key+'='+value for key, value in values.items()))
    else:
        command = args.command[1:] if args.command[:1] == ['--'] else args.command
        if not command: parser.error('Provide a command after --')
        os.execvpe(command[0], command, {**os.environ, **values})


if __name__ == '__main__': main()
