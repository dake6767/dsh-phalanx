"""Exercise the read-only service with a different-UID owner and reject unallocated ranges."""
from pathlib import Path
import os
import runpy
from types import SimpleNamespace
import tempfile
from unittest.mock import patch

module = runpy.run_path('scripts/validation/port-owners.py')
def command(args, **options):
    if args[0] == 'ss': return SimpleNamespace(stdout='tcp LISTEN 0 10 127.0.0.1:22001 0.0.0.0:* users:(("foreign",pid=1234,fd=5))\n')
    assert args[:3] == ['ps', '-p', '1234']
    return SimpleNamespace(stdout='1234 0 root foreign-listener\n')
with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / 'owners.sock'
    with patch('os.geteuid', return_value=0), patch('subprocess.run', side_effect=command):
        server = module['start'](path, os.getuid())
        try:
            result = module['query'](path, 22000)
            assert result['processes'] == [{'pid':1234,'uid':0,'user':'root','command':'foreign-listener'}]
            assert 'error' in module['query'](path, 22)
        finally:
            server.shutdown(); server.server_close()
