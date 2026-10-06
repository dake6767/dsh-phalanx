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


class HumanProgressRenderer:
    """One transient line on capable terminals; bounded milestones on redirected output."""
    def __init__(self, verbose=False):
        self.verbose = verbose
        self.last = float('-inf')
        self.line = False
        self.paused = False

    def terminal(self):
        return sys.stderr.isatty() and os.environ.get('TERM', '') not in ('', 'dumb')

    def finish(self):
        if self.line:
            print(file=sys.stderr, flush=True)
            self.line = False

    def render(self, event, *, milestone=False):
        if self.paused or event['status'] == 'detail' and not self.verbose: return
        terminal = self.terminal()
        final = event['status'] in ('completed', 'warning', 'failed', 'info', 'detail')
        if not final and not milestone and event['elapsed'] - self.last < (1 if terminal else 30): return
        self.last = event['elapsed']
        detail = event.get('action') or event['message']
        if event['status'] == 'detail': detail = event['message']
        if 'bytes' in event:
            detail += f" · {event['bytes']} bytes"
            if event.get('total', 0) and event['total'] >= event['bytes']:
                detail += f" / {event['total']} bytes ({event['bytes'] * 100 / event['total']:.0f}%)"
        line = f"[{event['phase']}] {event['status']} · {detail} · phase {event['phaseElapsed']:.1f}s / total {event['elapsed']:.1f}s"
        line = ' '.join(line.split())
        if terminal:
            try: width = os.get_terminal_size(sys.stderr.fileno()).columns
            except (OSError, ValueError): width = 80
            # A current line must not wrap: finalized milestones can wrap normally.
            if not final and len(line) >= width:
                # Keep facts at the right on narrow terminals; truncating the full
                # line would erase both the changing progress and waiting time.
                quantity = ''
                if 'bytes' in event:
                    quantity = f"{event['bytes']}B "
                    if event.get('total', 0) and event['total'] >= event['bytes']:
                        quantity = f"{event['bytes'] * 100 / event['total']:.0f}% "
                suffix = f"{quantity}phase{event['phaseElapsed']:.0f}s total{event['elapsed']:.0f}s"
                action = event.get('action') or event['message']
                budget = max(0, width-2-len(suffix))
                line = action[:budget] + ' ' + suffix
            if not final: line = line.encode('ascii', errors='replace').decode()[:max(1, width-1)]
            sys.stderr.write(('\r\x1b[2K' if self.line else '') + line + ('\n' if final else ''))
            sys.stderr.flush(); self.line = not final
        else:
            self.finish(); print(line, file=sys.stderr, flush=True)


class Progress:
    def __init__(self, root=Path('/'), *, output='human', verbose=False, persist=True, clock=time.monotonic):
        self.output, self.verbose = output, verbose
        self.clock = clock
        self.started = self.phase_started = clock()
        self.current = {}
        self.renderer = HumanProgressRenderer(verbose)
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
        text = re.sub(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)', '', str(text))
        text = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', text)
        text = re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', '', text)
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


    def emit(self, status='running', message='', *, milestone=False, **facts):
        with self.lock:
            now = self.clock()
            if status != 'detail':
                if message and not facts.get('heartbeat'):
                    if 'bytes' not in facts: self.current = {}
                    self.current['action'] = self.safe(facts.get('action', message))
                self.current.update({key: value for key, value in facts.items() if key in ('bytes', 'total')})
            event = {'phase': self.phase, 'status': status, 'elapsed': round(now-self.started, 1),
                     'phaseElapsed': round(now-self.phase_started, 1), 'message': self.safe(message), **self.current}
            if self.log:
                try:
                    with self.log.open('a') as file: file.write(json.dumps(event)+'\n')
                except OSError:
                    self.log = None
                    self.renderer.finish()
                    print('Diagnostic log unavailable; check disk space and permissions.', file=sys.stderr, flush=True)
            self.renderer.render(event, milestone=milestone)
            for observer in self.observers: observer(dict(event))

    def heartbeat(self):
        self.emit(message='Still working; waiting for this step to finish', heartbeat=True)

    @contextlib.contextmanager
    def input(self):
        with self.lock:
            self.renderer.finish(); self.renderer.paused = True
        try: yield
        finally:
            with self.lock: self.renderer.paused = False

    @contextlib.contextmanager
    def stage(self, name):
        with self.lock:
            self.phase = name; self.phase_started = self.clock(); self.current = {}
            self.emit(message='Starting', action=name, milestone=True)
        stop = threading.Event()
        def pulse():
            while not stop.wait(1): self.heartbeat()
        thread = threading.Thread(target=pulse, daemon=True); thread.start()
        try:
            yield
        except BaseException:
            self.emit('failed', 'Step did not complete')
            raise
        else: self.emit('completed', heartbeat=True)
        finally:
            stop.set(); thread.join()
            with self.lock: self.renderer.finish()

    def result(self, receipt, *, port=None):
        self.renderer.finish()
        if self.output == 'json': print(json.dumps(receipt, indent=2))
        elif receipt['status'] == 'failed':
            print('Installation failed during '+receipt['phase']+': '+receipt['reason'])
            if receipt.get('diagnosticLog'): print('Diagnostic log: '+receipt['diagnosticLog'])
        else:
            print(f"dsh-phalanx {receipt['version']} installed · {self.clock()-self.started:.1f}s\n")
            if receipt.get('initializationUrl'):
                print('Next: open this link to create your administrator account\n'+receipt['initializationUrl']+'\n')
            print('Admin: '+receipt['adminUrl']+'\nService: ready on this host')
            print('External access: not verified; check browser access'+(f' to entry port {port}' if port else ''))
            print('If using an HTTPS reverse proxy, check its route to this entry.\nAfter signup, configure shared models in the admin page.')
            if self.verbose:
                detail = {key:value for key,value in receipt.items() if key != 'initializationUrl'}
                print(self.safe(json.dumps(detail, indent=2)), file=sys.stderr)

    def upgrade_result(self,result):
        self.renderer.finish()
        if self.output=='json':print(json.dumps(result,indent=2)); return
        job=result['operation']
        if job is None:print('No upgrade operation has been recorded.'); return
        print('System update '+job['id']+': '+job['phase'])
        print('Release: '+job['sourceVersion']+' → '+job['targetVersion'])
        if job['phase']=='prepared':print('Download verified; current service is unchanged. Apply with --upgrade apply --operation '+job['id']+'.')
        elif job['phase']=='succeeded':print('Selected release identity and readiness verified; work is open.')
        elif job['phase']=='restored':print('Update failed. Previous data and service were restored and verified.')
        elif job['phase']=='recovery-failed':print('Recovery failed; follow the server recovery instruction before resuming work.')
        for key in ('failure','recoveryFailure','stopFailure','instruction'):
            if job.get(key):print(self.safe(job[key]))
        if result.get('diagnosticLog'):print('Diagnostic log: '+result['diagnosticLog'])

    def failure(self, error):
        reason = self.safe(str(error))
        self.emit('failed', reason)
        log = '/var/log/dsh-phalanx/'+self.log.name if self.log else None
        print('Inspect the managed user service: sudo journalctl _SYSTEMD_USER_UNIT=dsh-phalanx.service _UID="$(id -u dsh-phalanx)" -n 80 --no-pager', file=sys.stderr)
        print('Retry with sudo bash install.sh and corrected deployment flags; preserve the data directory.', file=sys.stderr)
        if log: print('Diagnostic log: '+log, file=sys.stderr)
        receipt = {'status':'failed', 'phase':self.phase, 'reason':reason, 'diagnosticLog':log}
        self.result(receipt)
