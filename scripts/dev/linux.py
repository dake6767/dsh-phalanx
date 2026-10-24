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
        summaries = [line.removeprefix('Linux acceptance receipt: ') for line in (directory / 'output.log').read_text().splitlines() if line.startswith('Linux acceptance receipt: ')]
        if summaries: state['acceptance'] = json.loads(summaries[-1])
        if not summaries or state['acceptance']['status'] != 'passed': state['status'] = 'failed'
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
    parser.add_argument('action', choices=['start', 'status'])
    parser.add_argument('run', nargs='?')
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--files')
    group.add_argument('--full', action='store_true')
    group.add_argument('--retry', help='Background run ID whose failed files should be rerun')
    parser.add_argument('--quota-reset-at')
    args = parser.parse_args()
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
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
