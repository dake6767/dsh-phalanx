"""Exercise guest preflight before any build or acceptance operation runs."""
from pathlib import Path
import runpy
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

module = runpy.run_path('scripts/dev/guest.py')

class ReachedOperation(Exception):
    pass

def operation(*args):
    raise ReachedOperation()

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    for action in ('up', 'test'):
        function = module['up' if action == 'up' else 'main']
        state = function.__globals__
        state['ROOT'] = root
        state['guard'] = lambda: None
        state['build_swap'] = operation
        # Stop acceptance immediately after its preflight and build-receipt read.
        state['runpy'] = SimpleNamespace(run_path=operation)
        state['threading'] = SimpleNamespace(Event=operation)
        scenarios = [(False, 23, False), (False, 24, True), (True, 4, False), (True, 5, True), (True, 9, True)] if action == 'up' else [(True, 4, False), (True, 5, True), (True, 9, True)]
        byte_scenarios = [(resident, gib * 1024**3, allowed) for resident, gib, allowed in scenarios]
        byte_scenarios.append((True, 5 * 1024**3 - 1, False))
        for resident, free_bytes, allowed in byte_scenarios:
            receipt = root / 'build.json'
            if resident:
                receipt.write_text('{}')
            elif receipt.exists():
                receipt.unlink()
            with patch('shutil.disk_usage', return_value=SimpleNamespace(free=free_bytes)), patch.object(sys, 'argv', ['guest.py', 'test']):
                try:
                    function('official') if action == 'up' else function()
                except ReachedOperation:
                    assert allowed, (action, resident, free_bytes)
                except ValueError as error:
                    assert not allowed, (action, resident, free_bytes, str(error))
                    assert 'Reserve ' in str(error)
                else:
                    raise AssertionError('Expected the preflight or operation boundary')
