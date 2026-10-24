"""Bundle integrity, failed-file selection and the persistent retry-budget seam."""
import copy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import runpy
import tempfile
import time
from unittest.mock import patch

module = runpy.run_path('scripts/dev/guest.py')

def rejected(action):
    try: action()
    except ValueError: return
    raise AssertionError('Expected refusal')

parent = {'firstRun': '1', 'builtSnapshot': 'original', 'status': 'failed', 'startedAt': time.time()-60,
          'files': [{'file': 'failed', 'status': 'failed'}, {'file': 'passed', 'status': 'passed'}]}
receipt = {'snapshotCommit': 'original'}
plan = {'rebuild': False}
select = module['retry_files']
assert select(parent, receipt, plan, None) == ['failed']
rejected(lambda: select(parent, {'snapshotCommit': 'new'}, plan, None))
rejected(lambda: select(parent, receipt, {'rebuild': True}, None))
quota = copy.deepcopy(parent)
quota['files'][0]['quotaFailure'] = True
rejected(lambda: select(quota, receipt, plan, None))
rejected(lambda: select(quota, receipt, plan, datetime.fromtimestamp(time.time()+60, timezone.utc).isoformat()))
assert select(quota, receipt, plan, datetime.fromtimestamp(time.time()-30, timezone.utc).isoformat()) == ['failed']
ledger = {'attempts': {}, 'runs': ['1']}
module['reserve_retry'](ledger, ['failed'], '2')
module['reserve_retry'](ledger, ['failed'], '3')
rejected(lambda: module['reserve_retry'](ledger, ['failed'], '4'))
assert ledger == {'attempts': {'failed': 2}, 'runs': ['1', '2', '3']}

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    manifest, archive, platform = root/'manifest.json', root/'image.tar', root/'platform.tar.gz'
    manifest.write_text('{}'); archive.write_bytes(b'image'); platform.write_bytes(b'platform')
    receipt = {'snapshotCommit': 'original', 'manifest': {'files': {
        archive.name: hashlib.sha256(archive.read_bytes()).hexdigest(), platform.name: hashlib.sha256(platform.read_bytes()).hexdigest()}}}
    with patch.object(Path, 'read_text', return_value=json.dumps({'commit': 'original', 'platform': 'linux/arm64'})):
        module['verify_bundle'](receipt, manifest, archive, platform)
        archive.write_bytes(b'corrupted')
        rejected(lambda: module['verify_bundle'](receipt, manifest, archive, platform))
        archive.write_bytes(b'image')
    with patch.object(Path, 'read_text', return_value=json.dumps({'commit': 'different', 'platform': 'linux/arm64'})):
        rejected(lambda: module['verify_bundle'](receipt, manifest, archive, platform))
