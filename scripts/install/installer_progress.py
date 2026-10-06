"""Structured installation events, operator output and private safe diagnostics."""
import contextlib
import json
import os
from pathlib import Path
import re
import secrets
import sys
import threading
import time


class Progress:
    def __init__(self, root=Path('/'), *, output='human', verbose=False, persist=True):
        self.output, self.verbose = output, verbose
        self.started = time.monotonic()
        self.phase = 'Preflight'
        self.secrets = set()
        self.observers = []
        self.lock = threading.RLock()
        self.log = None
        if persist:
            directory = root/'var/log/dsh-phalanx'
            for parent in (directory, *directory.parents):
                if parent.is_symlink(): raise OSError('Diagnostic paths must not be symbolic links')
                if parent == root: break
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            directory.chmod(0o700)
            self.log = directory/(time.strftime('%Y%m%dT%H%M%S')+'-'+secrets.token_hex(4)+'.jsonl')
            descriptor = os.open(self.log, os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW, 0o600)
            os.close(descriptor)

    def protect(self, *values):
        with self.lock: self.secrets.update(str(value) for value in values if value)

    def safe(self, text):
        text = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', str(text))
        with self.lock:
            for value in sorted(self.secrets, key=len, reverse=True): text = text.replace(value, '[REDACTED]')
        # Diagnostic carriers are untrusted: discard whole sensitive lines,
        # including quoted JSON fields and future environment/CLI key names.
        text = re.sub(r'https?://[^\s\"\']*/bootstrap[^\s\"\']*', '[REDACTED initialization link]', text, flags=re.I)
        text = re.sub(r'https?://[^\s\"\']*[?#][^\s\"\']*', '[REDACTED URL parameters]', text, flags=re.I)
        text = re.sub(r'(?im)^.*(?:authorization|(?:set[-_ ]?)?cookie|[a-z0-9_ -]*(?:key|secret|credential|password|token)[a-z0-9_ -]*)[\"\']?\s*[:=].*$', '[REDACTED sensitive line]', text)
        text = re.sub(r'(?im)^.*--[^\s]*(?:key|secret|credential|password|token)[^\s]*(?:=|\s+).*$', '[REDACTED sensitive command]', text)
        text = re.sub(r'(?i)(https?://)[^\s/@]+:[^\s/@]+@', r'\1[REDACTED]@', text)
        return text

    def subscribe(self, observer):
        self.observers.append(observer)

    def emit(self, status='running', message='', **facts):
        with self.lock:
            event = {'phase': self.phase, 'status': status, 'elapsed': round(time.monotonic()-self.started, 1), 'message': self.safe(message), **facts}
            if self.log:
                try:
                    with self.log.open('a') as file: file.write(json.dumps(event)+'\n')
                except OSError:
                    self.log = None
                    print('Diagnostic log unavailable; check disk space and permissions.', file=sys.stderr, flush=True)
            detail = event['message']
            if 'bytes' in facts:
                detail += f" {facts['bytes']} bytes" + (f" / {facts['total']} bytes" if facts.get('total') else '')
            print(f"[{event['phase']}] {status} · {event['elapsed']}s"+(f": {detail}" if detail else ''), file=sys.stderr, flush=True)
            for observer in self.observers: observer(dict(event))

    @contextlib.contextmanager
    def stage(self, name):
        self.phase = name
        self.emit(message='Starting')
        stop = threading.Event()
        def pulse():
            while not stop.wait(3): self.emit(message='Still working; waiting for this step to finish')
        thread = threading.Thread(target=pulse, daemon=True); thread.start()
        try:
            yield
        except BaseException:
            self.emit('failed', 'Step did not complete')
            raise
        else: self.emit('completed')
        finally: stop.set(); thread.join()

    def result(self, receipt, *, port=None):
        if self.output == 'json': print(json.dumps(receipt, indent=2))
        elif receipt['status'] == 'failed':
            print('Installation failed during '+receipt['phase']+': '+receipt['reason'])
            if receipt.get('diagnosticLog'): print('Diagnostic log: '+receipt['diagnosticLog'])
        else:
            print(f"dsh-phalanx {receipt['version']} installed · {time.monotonic()-self.started:.1f}s\n")
            if receipt.get('initializationUrl'):
                print('Next: open this link to create your administrator account\n'+receipt['initializationUrl']+'\n')
            print('Admin: '+receipt['adminUrl']+'\nService: ready on this host')
            print('External access: not verified; check browser access'+(f' to entry port {port}' if port else ''))
            print('If using an HTTPS reverse proxy, check its route to this entry.\nAfter signup, configure shared models in the admin page.')
            if self.verbose:
                detail = {key:value for key,value in receipt.items() if key != 'initializationUrl'}
                print(self.safe(json.dumps(detail, indent=2)), file=sys.stderr)

    def failure(self, error):
        reason = self.safe(str(error))
        self.emit('failed', reason)
        log = '/var/log/dsh-phalanx/'+self.log.name if self.log else None
        print('Inspect the managed user service: sudo journalctl _SYSTEMD_USER_UNIT=dsh-phalanx.service _UID="$(id -u dsh-phalanx)" -n 80 --no-pager', file=sys.stderr)
        print('Retry with sudo bash install.sh and corrected deployment flags; preserve the data directory.', file=sys.stderr)
        if log: print('Diagnostic log: '+log, file=sys.stderr)
        receipt = {'status':'failed', 'phase':self.phase, 'reason':reason, 'diagnosticLog':log}
        self.result(receipt)
