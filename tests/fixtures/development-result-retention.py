"""Every run keeps its receipts; only the latest failed run keeps file trees."""
import json
from pathlib import Path
import runpy
import shutil
import tempfile

module = runpy.run_path('scripts/dev/guest.py')
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    def run(name, status):
        base = root / name
        file = base / 'linux-files/0'
        (file / 'tmp/node-compile-cache').mkdir(parents=True)
        (file / 'browser-failures').mkdir()
        for receipt in ('report.json', 'execution.json', 'output.log'): (file / receipt).write_text('{}')
        if status: (base / 'summary.json').write_text(json.dumps({'status': status, 'files': [] if name == '450' else [{'file': 'x', 'status': status}]}))
        return file
    old_failure, passed, latest_failure, interrupted = run('100', 'failed'), run('200', 'passed'), run('300', 'failed'), run('400', None)
    refused = run('450', 'failed')  # a retry the executor refused before running any file
    outside = root.parent / (root.name + '-outside'); (outside / 'kept').mkdir(parents=True)
    linked = root / '500'; (linked / 'linux-files').mkdir(parents=True); (linked / 'linux-files/0').symlink_to(outside)
    (root / '600').symlink_to(outside)
    try:
        module['prune_results'](root)
        for pruned in (old_failure, passed, interrupted, refused):
            assert sorted(path.name for path in pruned.iterdir()) == ['execution.json', 'output.log', 'report.json'], pruned
        # An interrupted newer run never displaces the latest real failure's diagnostics.
        assert (latest_failure / 'tmp/node-compile-cache').is_dir() and (latest_failure / 'browser-failures').is_dir()
        assert (root / '200/summary.json').exists() and (outside / 'kept').is_dir()
    finally: shutil.rmtree(outside)
    assert module['prune_results'](root / 'missing') == []
