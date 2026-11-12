"""Drive public command prompts through a real controlling terminal."""
import os
import pty
import select
import signal
import sys
import time


def run_terminal(entry, args, dialogue):
    pid, master = pty.fork()
    if pid == 0:
        os.execv(sys.executable, [sys.executable, str(entry), *args])
    output = b''
    cursor = 0
    status = None

    def read():
        nonlocal output
        try:
            block = os.read(master, 65536)
        except OSError:
            return False
        output += block
        return bool(block)

    try:
        for prompt, answer in dialogue:
            deadline = time.monotonic() + 10
            while prompt.encode() not in output[cursor:]:
                if time.monotonic() >= deadline:
                    raise AssertionError((prompt, output.decode()))
                if select.select([master], [], [], 0.1)[0] and not read():
                    raise AssertionError(('terminal closed before ' + prompt, output.decode()))
            cursor = len(output)
            os.write(master, (answer + '\n').encode())
        deadline = time.monotonic() + 10
        while status is None:
            ended, result = os.waitpid(pid, os.WNOHANG)
            if ended:
                status = result
                break
            if time.monotonic() >= deadline:
                raise AssertionError('command did not finish: ' + output.decode())
            if select.select([master], [], [], 0.1)[0]:
                read()
        while select.select([master], [], [], 0.1)[0]:
            if not read():
                break
        return os.waitstatus_to_exitcode(status), output.decode()
    finally:
        if status is None:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)
        os.close(master)
