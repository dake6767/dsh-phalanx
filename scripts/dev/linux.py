"""Launch one owned background Linux acceptance operation and retain its receipt."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import uuid
import hashlib

ENTRY = Path(__file__).resolve().with_name('vm.sh')
SOURCE = ENTRY.parents[2]
STATE = Path(os.environ.get('DSH_PHALANX_VALIDATION_STATE_ROOT', str(Path.home() / '.local/state/dsh-phalanx-validation'))) / 'linux'


def write(path, value):
    stage = path.with_suffix('.next')
    stage.write_text(json.dumps(value, indent=2)+'\n')
    stage.replace(path)


def host_memory():
    if sys.platform != 'darwin': return None
    rows = subprocess.run(['vm_stat'], capture_output=True, text=True, check=True).stdout
    page = int(re.search(r'page size of (\d+) bytes', rows)[1])
    values = {key: int(value) for key, value in re.findall(r'^([^:\n]+):\s+(\d+)\.', rows, re.M)}
    total = int(subprocess.run(['sysctl', '-n', 'hw.memsize'], capture_output=True, text=True, check=True).stdout)
    return total - (values.get('Pages free', 0) + values.get('Pages speculative', 0)) * page


def acceptance_receipt(log, read_canonical):
    summaries = [line.removeprefix('Linux acceptance receipt: ') for line in log.splitlines() if line.startswith('Linux acceptance receipt: ')]
    if not summaries: raise ValueError('The guest did not return an acceptance receipt')
    try: return json.loads(summaries[-1]), None
    except json.JSONDecodeError as error:
        # SSH stdout/stderr chunks can interleave a warning inside a large JSON line.
        identity = re.search(r'"runId"\s*:\s*"([1-9][0-9]*)"', summaries[-1][:1024])
        if not identity: raise ValueError('The damaged receipt has no bounded guest run identity') from None
        run_id = identity[1]
        raw = read_canonical(run_id)
        summary = json.loads(raw)
        if summary.get('runId') != run_id or summary.get('results') != '/var/lib/dsh-phalanx-dev/t2-results/'+run_id:
            raise ValueError('The canonical guest receipt does not match its recorded run')
        return summary, {'method': 'guest-canonical-summary', 'runId': run_id,
                         'sha256': hashlib.sha256(raw).hexdigest(), 'originalParseError': str(error)}


def canonical_receipt(run_id, directory):
    home = Path(os.environ.get('DSH_PHALANX_VM_HOME', str(Path.home()/'.lima-dsh-phalanx')))
    version = json.loads((SOURCE/'package.json').read_text())['version']
    if not home.is_absolute() or home.is_symlink(): raise ValueError('Use an owned absolute Lima home')
    for name, expected in (('.dsh-phalanx-checkout', str(SOURCE.resolve())), ('.dsh-phalanx-version', version)):
        marker = home/name
        if marker.is_symlink() or not marker.is_file() or marker.read_text().strip() != expected:
            raise ValueError('The Lima home is not owned by this version checkout')
    path = '/var/lib/dsh-phalanx-dev/t2-results/'+run_id+'/summary.json'
    # Keep stderr separate while reading the immutable file; do not merge SSH channels again.
    result = subprocess.run(['limactl','shell','--workdir=/','development','sudo','cat',path],
        env={**os.environ, 'LIMA_HOME': str(home)}, capture_output=True, check=True, timeout=30)
    (directory/'guest-summary.json').write_bytes(result.stdout)
    return result.stdout


def recover_receipt(previous_id):
    previous_path = STATE/previous_id/'status.json'
    previous = json.loads(previous_path.read_text())
    if previous['status'] != 'failed' or previous.get('exitCode') != 0 or previous.get('acceptance'):
        raise ValueError('Receipt recovery requires a successful guest command with a failed host parse')
    run_id = str(time.time_ns())+'-'+uuid.uuid4().hex[:8]
    directory = STATE/run_id; directory.mkdir(mode=0o700)
    state = {'runId': run_id, 'status': 'failed', 'operation': 'receipt-recovery',
             'directory': str(directory), 'log': str(directory/'output.log'),
             'recoveredFromHostRun': previous_id, 'originalStatusSha256': hashlib.sha256(previous_path.read_bytes()).hexdigest(),
             'originalExecutionElapsedSeconds': previous.get('elapsedSeconds'), 'exitCode': previous['exitCode']}
    started = time.monotonic()
    try:
        summary, transport = acceptance_receipt((STATE/previous_id/'output.log').read_text(), lambda identity: canonical_receipt(identity, directory))
        if not transport: raise ValueError('The original receipt did not need transport recovery')
        state.update(acceptance=summary, receiptTransport=transport, status=summary['status'])
        (directory/'output.log').write_text('Recovered canonical guest receipt: '+transport['runId']+' '+transport['sha256']+'\n')
    except Exception as error:
        state['error'] = str(error)
        (directory/'output.log').write_text('Receipt transport recovery failed: '+str(error)+'\n')
    state['elapsedSeconds'] = round(time.monotonic()-started, 2)
    write(directory/'status.json', state)
    print(json.dumps({key: state[key] for key in ('runId','status','directory','recoveredFromHostRun')}))
    if state['status'] != 'passed': raise SystemExit(1)


def worker(directory):
    receipt = directory / 'status.json'
    state = json.loads(receipt.read_text())
    state.update(status='running', workerPid=os.getpid())
    write(receipt, state)
    started = time.monotonic()
    stopped = threading.Event()
    peak = [0]
    def sample():
        while not stopped.wait(1):
            value = host_memory()
            if value is not None: peak[0] = max(peak[0], value)
    sampler = threading.Thread(target=sample, daemon=True)
    sampler.start()
    try:
        with (directory / 'output.log').open('w') as log:
            result = subprocess.run(['bash', str(ENTRY), 'test', *state['arguments']], cwd=SOURCE, stdout=log, stderr=subprocess.STDOUT,
                env={**os.environ, 'DSH_PHALANX_VM_READY_FILE': str(directory / 'ready')})
        state['exitCode'] = result.returncode
        state['status'] = 'passed' if result.returncode == 0 else 'failed'
        state['acceptance'], state['receiptTransport'] = acceptance_receipt((directory / 'output.log').read_text(), lambda identity: canonical_receipt(identity, directory))
        if state['acceptance']['status'] != 'passed': state['status'] = 'failed'
    except Exception as error:
        state.update(status='failed', error=str(error))
    finally:
        stopped.set(); sampler.join()
        state.update(elapsedSeconds=round(time.monotonic()-started, 2), hostPeakUsedMemoryBytes=peak[0],
                     hostMemoryDefinition='physical total minus free and speculative pages; includes reclaimable cache')
        write(receipt, state)


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--worker':
        worker(Path(sys.argv[2])); return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'status', 'recover-receipt'])
    parser.add_argument('run', nargs='?')
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--files')
    group.add_argument('--full', action='store_true')
    group.add_argument('--retry', help='Background run ID whose failed files should be rerun')
    parser.add_argument('--quota-reset-at')
    args = parser.parse_args()
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.action == 'recover-receipt':
        if not args.run or not re.fullmatch(r'[0-9]+-[a-f0-9]+', args.run) or args.files or args.full or args.retry or args.quota_reset_at:
            raise ValueError('Use the completed host run ID for receipt recovery')
        recover_receipt(args.run); return
    if args.action == 'status':
        if not args.run or not re.fullmatch(r'[0-9]+-[a-f0-9]+', args.run): raise ValueError('Use the returned background run ID')
        print((STATE / args.run / 'status.json').read_text()); return
    if args.run or not (args.files or args.full or args.retry): raise ValueError('Select --files, --full or --retry')
    arguments = ['--files', args.files] if args.files else []
    if args.retry:
        if not re.fullmatch(r'[0-9]+-[a-f0-9]+', args.retry): raise ValueError('Use the returned background run ID')
        previous = json.loads((STATE / args.retry / 'status.json').read_text())
        if previous['status'] != 'failed' or not previous.get('acceptance'): raise ValueError('Retry requires a completed failed Linux receipt')
        arguments = ['--retry', previous['acceptance']['runId']]
        if args.quota_reset_at: arguments.extend(['--quota-reset-at', args.quota_reset_at])
    run_id = str(time.time_ns())+'-'+uuid.uuid4().hex[:8]
    directory = STATE / run_id
    directory.mkdir(mode=0o700)
    receipt = directory / 'status.json'
    write(receipt, {'runId': run_id, 'status': 'starting', 'arguments': arguments, 'directory': str(directory), 'log': str(directory / 'output.log')})
    with (directory / 'worker.log').open('w') as log:
        process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--worker', str(directory)],
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(750):
        state = json.loads(receipt.read_text())
        ready = (directory / 'ready').read_text().strip() if (directory / 'ready').exists() else ''
        if ready.isdecimal():
            state['operationPid'] = int(ready)
            print(json.dumps(state)); return
        if state['status'] in ('passed', 'failed') or process.poll() is not None:
            print(json.dumps(state)); sys.exit(1 if state['status'] != 'passed' else 0)
        time.sleep(.02)
    raise ValueError('Background worker did not acquire its VM/cache locks; inspect '+str(directory / 'worker.log'))


if __name__ == '__main__':
    os.umask(0o077)
    try: main()
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr); sys.exit(1)
