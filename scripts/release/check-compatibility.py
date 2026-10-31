"""Release tooling exercises the installer reader; it owns no compatibility decisions."""
import json
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'install'))
from installer_compatibility import upgrade_outcome,validate_contract

for case in json.loads(Path(__file__).with_name('compatibility-cases.json').read_text()):
    actual=upgrade_outcome(case['source'],case['target'],case['schemas'])
    if actual!=case['expected']:raise ValueError('Compatibility sample failed: '+case['name'])
if not sys.stdin.isatty():
    body=sys.stdin.read(262145)
    if len(body)>262144:raise ValueError('Manifest exceeds release metadata bound')
    if body.strip():validate_contract(json.loads(body))
print('Installer compatibility samples passed')
