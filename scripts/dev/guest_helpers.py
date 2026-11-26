"""Standalone helpers for the owned Lima development guest."""
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import runpy
import shlex
import shutil
import subprocess
import sys
import time
from uuid import UUID

MOUNT = Path('/mnt/dsh-phalanx')
ROOT = Path('/var/lib/dsh-phalanx-dev')
SOURCE = ROOT / 'source'
BUILDER = 'dsh-development-builder'
NODE = Path('/opt/dsh-phalanx-development-node')


def run(args, **options):
    return subprocess.run([str(part) for part in args], check=True, **options)


def output(args, **options):
    return run(args, capture_output=True, text=True, **options).stdout.strip()


def guard():
    marker = Path('/etc/dsh-phalanx-development-vm')
    if not marker.is_file() or marker.is_symlink() or marker.read_text() != 'dsh-phalanx-development-v1\n':
        raise ValueError('This command only manages the dedicated development VM; use scripts/dev/vm.sh on the Mac.')
    info = marker.stat()
    if info.st_uid != 0 or info.st_mode & 0o077 or os.geteuid() != 0:
        raise ValueError('The development VM marker must be root-owned and protected; run through the Mac entry.')
    if platform.system() != 'Linux' or platform.machine() != 'aarch64':
        raise ValueError('The development guest must be native Linux arm64.')


def configure_clock():
    """Use Lima time only, and require a new boot to clear previous NTP discipline."""
    if output(['systemctl', 'is-active', 'lima-guestagent.service']) != 'active':
        raise ValueError('Lima guest agent must be active before changing clock configuration.')
    ROOT.mkdir(mode=0o755, exist_ok=True)
    state = ROOT / 'host-clock-configured-boot'
    configured_boot = None
    if state.exists() or state.is_symlink():
        if state.is_symlink() or not state.is_file() or state.stat().st_uid != 0 or state.stat().st_mode & 0o077:
            raise ValueError('The development clock state must be a protected root-owned file.')
        configured_boot = str(UUID(state.read_text().strip()))
    boot = str(UUID(Path('/proc/sys/kernel/random/boot_id').read_text().strip()))
    ntp = output(['timedatectl', 'show', '--property=NTP', '--value'])
    if ntp not in {'yes', 'no'}:
        raise ValueError('Cannot determine the guest network time synchronization state.')
    run(['timedatectl', 'set-ntp', 'false'])
    if configured_boot is None or ntp == 'yes':
        state.touch(mode=0o600)
        state.write_text(boot + '\n')
        configured_boot = boot
    print('restart-required' if configured_boot == boot else 'ready')


def source_tree(directory):
    rows = run(['git', '-c', 'safe.directory=' + str(directory), '-C', directory, 'ls-tree', '-rz', 'HEAD'], capture_output=True).stdout.split(b'\0')
    entries = []
    for row in rows:
        if not row:
            continue
        header, name = os.fsdecode(row).split('\t', 1)
        mode, kind, sha = header.split(' ')
        entries.append({'path': name, 'mode': mode, 'type': kind, 'sha': sha})
    return {'truncated': False, 'tree': entries}


def file_hash(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def node_runtime(preset):
    versions = json.loads((SOURCE / 'runtime-versions.json').read_text())
    if (NODE / 'bin/node').exists() and output([NODE / 'bin/node', '--version']) == 'v' + versions['node']:
        return
    archive = ROOT / 'node.tar.xz'
    pin = versions['nodeLinuxArm64']
    presets = json.loads((SOURCE / 'src/domain/download-source-presets.json').read_text())
    url = pin['url'].replace('https://nodejs.org/dist/', presets['bootstrap'][preset]['nodePrefix'])
    run(['curl', '--fail', '--location', '--retry', '3', '--output', archive, url])
    with archive.open('rb') as file:
        actual = hashlib.file_digest(file, 'sha256').hexdigest()
    if actual != pin['sha256']:
        raise ValueError('Pinned Node checksum mismatch')
    stage = ROOT / 'node-stage'
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir()
    run(['tar', '-xJf', archive, '--strip-components=1', '-C', stage])
    if NODE.exists():
        shutil.rmtree(NODE)
    stage.rename(NODE)
    archive.unlink()
    run([NODE / 'bin/corepack', 'enable'], env={**os.environ, 'PATH': str(NODE / 'bin') + ':' + os.environ['PATH']})


def identities():
    sys.path.insert(0, str(SOURCE / 'scripts/install'))
    import installer
    host = installer.Host()
    installer.dependencies(host)
    installer.identity(host)
    try:
        identity = pwd.getpwnam(BUILDER)
    except KeyError:
        run(['useradd', '--create-home', '--user-group', '--home-dir', ROOT / 'builder', '--shell', '/usr/sbin/nologin', BUILDER])
        identity = pwd.getpwnam(BUILDER)
    if identity.pw_dir != str(ROOT / 'builder'):
        raise ValueError('The development builder account belongs to another installation.')
    storage = Path(identity.pw_dir) / '.config/containers'
    storage.mkdir(parents=True, exist_ok=True)
    shutil.copy2('/var/lib/dsh-phalanx/.config/containers/storage.conf', storage / 'storage.conf')
    run(['chown', '-R', BUILDER + ':' + BUILDER, identity.pw_dir, SOURCE])
    run(['loginctl', 'enable-linger', BUILDER])
    run(['systemctl', 'start', 'user@' + str(identity.pw_uid) + '.service'])


def model_service():
    shutil.copy2(SOURCE / 'scripts/dev/model.mjs', ROOT / 'model.mjs')
    unit = '''[Unit]
Description=Local development model (fixed responses, no inference)
After=network.target
[Service]
DynamicUser=true
ExecStart=/opt/dsh-phalanx-development-node/bin/node /var/lib/dsh-phalanx-dev/model.mjs
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
Restart=on-failure
[Install]
WantedBy=multi-user.target
'''
    Path('/etc/systemd/system/dsh-phalanx-development-model.service').write_text(unit)
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'enable', 'dsh-phalanx-development-model.service'])
    run(['systemctl', 'restart', 'dsh-phalanx-development-model.service'])


def build_swap():
    """Keep the upstream parallel compiler within a 6 GiB development guest."""
    swap = ROOT / 'build.swap'
    size = 4 * 1024**3
    if swap.exists() or swap.is_symlink():
        info = swap.lstat()
        if (swap.is_symlink() or not swap.is_file() or info.st_uid != 0
                or info.st_mode & 0o077 or info.st_nlink != 1 or info.st_size != size):
            raise ValueError('The development build swap must be a protected root-owned 4 GiB file.')
    else:
        if shutil.disk_usage(ROOT).free < size + 12 * 1024**3:
            raise ValueError('Reserve 16 GiB inside the development VM before creating build swap.')
        with swap.open('xb') as file:
            os.fchmod(file.fileno(), 0o600)
        run(['fallocate', '-l', str(size), swap])
        run(['mkswap', swap])
    active = output(['swapon', '--show=NAME', '--noheadings', '--raw']).splitlines()
    if str(swap) not in active:
        run(['swapon', swap])


def mainland_apt_mirror(preset):
    if preset != 'mainland':
        return
    # The default ports.ubuntu.com origin is frequently unreachable from mainland
    # networks; the mainland preset already mirrors Ubuntu artifacts on mirrors.nju.edu.cn.
    sources = Path('/etc/apt/sources.list.d/ubuntu.sources')
    if sources.is_file() and not sources.is_symlink():
        text = sources.read_text()
        sources.write_text(text.replace('http://ports.ubuntu.com/ubuntu-ports', 'https://mirrors.nju.edu.cn/ubuntu-ports'))


def retry_files(parent, receipt, plan, quota_reset_at):
    if not parent.get('firstRun') or not parent.get('files'):
        raise ValueError('No completed file evidence; diagnose and start a new run')
    if parent['status'] == 'passed':
        raise ValueError('The selected Linux run already passed')
    if plan['rebuild']:
        raise ValueError('Deliverables changed; start a new run so the bundle is rebuilt')
    if parent['builtSnapshot'] != receipt['snapshotCommit']:
        raise ValueError('Retry must use the original bundle')
    failed = [row for row in parent['files'] if row['status'] != 'passed']
    if not failed:
        raise ValueError('No failed files remain to rerun')
    if any(row.get('quotaFailure') for row in failed):
        if not quota_reset_at:
            raise ValueError('Quota failure requires an elapsed provider reset (--quota-reset-at ISO8601)')
        reset = datetime.fromisoformat(quota_reset_at.replace('Z', '+00:00')).timestamp()
        if reset <= parent['startedAt'] or reset > time.time():
            raise ValueError('Provider reset must follow the failed run and have elapsed')
    return [row['file'] for row in failed]


def reserve_retry(ledger, files, run_id):
    for file in files:
        if ledger['attempts'].get(file, 0) >= 2:
            raise ValueError('Two failed-file reruns exhausted: ' + file)
    for file in files:
        ledger['attempts'][file] = ledger['attempts'].get(file, 0) + 1
    ledger['runs'].append(run_id)


def verify_bundle(receipt, manifest, archive, platform_archive):
    files = receipt['manifest']['files']
    if file_hash(archive) != files[archive.name] or file_hash(platform_archive) != files[platform_archive.name]:
        raise ValueError('Built bundle archive hash mismatch')
    installed = json.loads(Path('/opt/dsh-phalanx/current/build-info.json').read_text())
    if installed['commit'] != receipt['snapshotCommit'] or installed['platform'] != 'linux/arm64':
        raise ValueError('Installed bundle identity mismatch')
    return {'manifestSha256': file_hash(manifest), 'ociSha256': file_hash(archive), 'platformSha256': file_hash(platform_archive)}


def prune_results(root):
    """Keep receipts for every run, full trees only for the latest failed run.

    Per-file receipts (report, execution, diagnostics, output) stay because retries and
    result verification read reused rows' reports; their temporary trees do not."""
    # The executor chowns run roots to the test account, so never follow a link out of the results root.
    directory = lambda path: path.is_dir() and not path.is_symlink()
    runs = sorted((path for path in root.iterdir() if path.name.isdecimal() and directory(path)), key=lambda path: int(path.name)) if directory(root) else []

    def failed(path):
        try:
            summary = json.loads((path / 'summary.json').read_text())
        except (OSError, ValueError):
            return False
        return summary.get('status') == 'failed' and bool(summary.get('files'))

    # Interrupted runs and refused runs that executed no file must not displace the latest real failure.
    keep = [path for path in runs if failed(path)][-1:]
    pruned = []
    for run_root in runs:
        if run_root in keep:
            continue
        for group in run_root.glob('*-files'):
            if not directory(group):
                continue
            for entry in group.iterdir():
                if not directory(entry):
                    continue
                for item in entry.iterdir():
                    # Recheck after listing: a swapped-in link must not redirect the delete outside the root.
                    if directory(item) and item.resolve().is_relative_to(root.resolve()):
                        shutil.rmtree(item)
                        pruned.append(str(item.relative_to(root)))
    return pruned


def deployment_storage_paths(home, values, separated, install_configuration=Path('/etc/dsh-phalanx')):
    """The installer owns the default layout; preserve its durable namespace as one unit."""
    install_dir = Path(__file__).resolve().parents[1] / 'install'
    if str(install_dir) not in sys.path:
        sys.path.insert(0, str(install_dir))
    layout = runpy.run_path(str(install_dir / 'installer_config.py'))
    data = Path(os.path.abspath(values['DSH_PHALANX_DATA_ROOT']))
    durable = Path(layout['default_storage_root'](str(data)))
    paths = [data, home / 'keys', *[install_configuration / name for name in ('environment', 'install-state.json', 'installed-manifest.json')]]
    if separated:
        paths.append(durable)
    if values.get('DSH_PHALANX_USER_DATA_ROOT'):
        users = Path(os.path.abspath(values['DSH_PHALANX_USER_DATA_ROOT']))
        if not any(users == path or users.is_relative_to(path) for path in paths):
            paths.append(users)
    return paths, durable


def installed_environment_values(configuration):
    if not configuration.is_file() or configuration.is_symlink():
        return None
    try:
        values = {
            key: words[0]
            for key, value in (line.split('=', 1) for line in configuration.read_text().splitlines() if '=' in line)
            for words in [shlex.split(value)]
            if len(words) == 1
        }
    except ValueError:
        return None
    return values if 'DSH_PHALANX_DATA_ROOT' in values else None
