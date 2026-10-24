"""Atomic PID lock for one owned development VM operation."""
import fcntl
import os
from pathlib import Path
import sys


def live(pid):
    try: os.kill(pid, 0)
    except ProcessLookupError: return False
    except PermissionError: return True
    return True


def acquire(path, pid):
    for _ in range(3):
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            if path.is_symlink() or not path.is_file():
                raise ValueError('Refusing an invalid operation lock: '+str(path))
            with path.open('r') as file:
                try: fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError: raise ValueError('Another process is reclaiming the operation lock.') from None
                owner = file.read().strip()
                if not owner.isdecimal() or int(owner) < 1:
                    raise ValueError('Operation lock is incomplete; inspect it before retrying.')
                if live(int(owner)):
                    raise ValueError('VM operation is occupied by pid '+owner)
                if path.stat().st_ino != os.fstat(file.fileno()).st_ino: continue
                path.unlink()
        else:
            with os.fdopen(descriptor, 'w') as file: file.write(str(pid)+'\n')
            return
    raise ValueError('Operation lock changed concurrently; retry later.')


def release(path, pid):
    if not path.is_symlink() and path.is_file() and path.read_text().strip() == str(pid):
        path.unlink()


if __name__ == '__main__':
    try:
        action, name, raw_pid = sys.argv[1:]
        pid = int(raw_pid)
        if pid < 1: raise ValueError('Invalid lock pid')
        {'acquire': acquire, 'release': release}[action](Path(name), pid)
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
