"""Explicit office-library facts probe; run inside the native user-instance image."""
import argparse
import json
from pathlib import Path
import platform
import subprocess
import sys
import time
import urllib.parse
import venv

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--requirements', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--index-url', required=True)
args = parser.parse_args()
assert platform.system() == 'Linux' and platform.machine() in {'aarch64', 'x86_64'}
args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
python = args.output / 'venv/bin/python'
started = time.monotonic()
venv.create(args.output / 'venv', with_pip=True)
with (args.output / 'installation.log').open('w') as log:
    subprocess.run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input',
                    '--only-binary=:all:', '--report', str(args.output / 'pip-report.json'),
                    '--index-url', args.index_url, '-r', str(args.requirements)],
                   stdout=log, stderr=subprocess.STDOUT, check=True)
report = json.loads((args.output / 'pip-report.json').read_text())
assert report['install'] and all(urllib.parse.urlsplit(row['download_info']['url']).path.endswith('.whl') for row in report['install'])
modules = ['yaml', 'pptx', 'xlsxwriter', 'pathops', 'uharfbuzz', 'edge_tts', 'fitz', 'mammoth',
           'markdownify', 'ebooklib', 'nbconvert', 'openpyxl', 'PIL', 'numpy', 'requests', 'bs4', 'curl_cffi', 'google.genai']
probe = 'import importlib,json; modules=' + repr(modules) + '; [importlib.import_module(name) for name in modules]; print(json.dumps(modules))'
imports = json.loads(subprocess.check_output([str(python), '-c', probe], text=True))
locked = subprocess.check_output([str(python), '-m', 'pip', 'freeze'], text=True)
assert all('==' in line and not line.startswith(('-', '#')) for line in locked.splitlines() if line)
(args.output / 'requirements.lock').write_text(locked)
result = {'status': 'passed', 'python': sys.version, 'machine': platform.machine(), 'wheelOnly': True,
          'installedDistributions': len(report['install']), 'importedModules': imports,
          'elapsedSeconds': round(time.monotonic() - started, 2),
          'packages': {row['metadata']['name']: row['metadata']['version'] for row in report['install']}}
(args.output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
