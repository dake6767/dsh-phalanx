"""Exercise the public root fixture CLI with failures at its external OS port."""
import builtins
import contextlib
import io
from pathlib import Path
import pwd
import runpy
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
import unittest

class CleanupFailure(unittest.TestCase):
    def test_peer_reset_failure_does_not_prevent_linger_and_account_cleanup(self):
        original_open = builtins.open
        original_temporary = tempfile.TemporaryDirectory
        with original_temporary(dir='/tmp') as root:
            root = Path(root)
            service = root / 'service'
            (service / '.config/containers').mkdir(parents=True)
            (service / '.config/containers/storage.conf').write_text('[storage]\ndriver="overlay"\n')
            source = root / 'source'; source.mkdir(); (source / 'fixture').write_text('source')
            calls, peers = [], {}
            def command(args, **kwargs):
                args = [str(value) for value in args]; calls.append(args)
                if args[0] == 'useradd':
                    home = args[args.index('--home-dir')+1]; Path(home).mkdir()
                    peers[args[-1]] = home
                if 'podman' in args and 'load' in args:
                    raise subprocess.CalledProcessError(1, args, stderr='injected image load failure')
                if 'podman' in args and 'reset' in args:
                    raise subprocess.CalledProcessError(1, args, stderr='injected storage cleanup failure')
                return subprocess.CompletedProcess(args, 0, '', '')
            def account(name):
                return SimpleNamespace(pw_dir=str(service) if name == 'dsh-phalanx' else peers[name], pw_uid=1001 if name == 'dsh-phalanx' else 1002, pw_gid=1001 if name == 'dsh-phalanx' else 1002)
            def temporary(*args, **kwargs):
                kwargs['dir'] = str(root)
                return original_temporary(*args, **kwargs)
            def open_file(path, *args, **kwargs):
                return original_open(root / 'lock' if str(path) == '/run/lock/dsh-phalanx-t2.lock' else path, *args, **kwargs)
            arguments = ['t2-host.py', '--source', str(source), '--results', str(root / 'results'), '--image', 'fixture:image', '--oci', str(root / 'image.oci'), '--commit', 'a'*40, '--smoke']
            with patch('sys.argv', arguments), patch('os.geteuid', return_value=0), patch('os.chown'), patch('pwd.getpwnam', side_effect=account), patch('subprocess.run', side_effect=command), patch('tempfile.TemporaryDirectory', side_effect=temporary), patch('builtins.open', side_effect=open_file), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(Exception): runpy.run_path('scripts/validation/t2-host.py', run_name='__main__')
            self.assertTrue(any(row[:2] == ['loginctl', 'disable-linger'] for row in calls), calls)
            self.assertTrue(any(row[:2] == ['systemctl', 'stop'] for row in calls), calls)
            self.assertTrue(any(row[:2] == ['userdel', '--remove'] for row in calls), calls)

if __name__ == '__main__': unittest.main()
