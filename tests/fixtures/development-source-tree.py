"""Read complete snapshot trees, including builder-owned repositories on the owned VM."""
import json
import os
from pathlib import Path
import pwd
import runpy
import subprocess
import sys
import tempfile

module = runpy.run_path('scripts/dev/guest.py')
foreign = sys.argv[1:] == ['--foreign']
if foreign: module['guard']()
with tempfile.TemporaryDirectory(dir='/var/tmp' if foreign else None) as directory:
    root = Path(directory)
    def git(*args):
        return subprocess.run(['git', '-C', str(root), *args], capture_output=True, text=True, check=True).stdout.strip()
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
    (root / 'example.txt').write_text('snapshot')
    git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')
    sha = git('rev-parse', 'HEAD:example.txt')
    if foreign:
        account = pwd.getpwnam('dsh-development-builder')
        for path in [*root.rglob('*'), root]: os.chown(path, account.pw_uid, account.pw_gid)
    tree = module['source_tree'](root)
    assert tree == {'truncated':False, 'tree':[{'path':'example.txt','mode':'100644','type':'blob','sha':sha}]}, tree
    print(json.dumps({'result':'passed','foreignOwner':foreign}))
