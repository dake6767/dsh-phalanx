"""Owned Lima guest lifecycle; installation and upgrades use the product CLI."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import pwd
import runpy
import shutil
import subprocess
import sys
import time
import threading
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
        state.write_text(boot+'\n')
        configured_boot = boot
    print('restart-required' if configured_boot == boot else 'ready')


def user_command(account, args, environment=None):
    identity = pwd.getpwnam(account)
    values = {'HOME': identity.pw_dir, 'USER': account, 'LOGNAME': account,
              'PATH': str(NODE / 'bin') + ':/usr/local/bin:/usr/bin:/bin',
              'XDG_RUNTIME_DIR': '/run/user/' + str(identity.pw_uid),
              'XDG_CONFIG_HOME': identity.pw_dir + '/.config', 'LANG': 'C.UTF-8', 'CI': 'true'}
    values.update(environment or {})
    return ['runuser', '-u', account, '--', 'env', '-i', *[key+'='+value for key, value in values.items()], *args]


def snapshot(activate=True):
    """Copy only Git-visible files; ignored local secrets and caches stay on the Mac."""
    git = ['git', '-c', 'safe.directory='+str(MOUNT), '-C', str(MOUNT)]
    original = output([*git, 'rev-parse', 'HEAD'])
    stamp = output([*git, 'show', '-s', '--format=%ct', 'HEAD'])
    names = run([*git, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], capture_output=True).stdout.split(b'\0')
    stage = ROOT / 'snapshot'
    if stage.exists(): shutil.rmtree(stage)
    stage.mkdir()
    for raw in names:
        if not raw: continue
        name = os.fsdecode(raw)
        source, target = MOUNT / name, stage / name
        if not source.exists() and not source.is_symlink(): continue
        if not source.resolve().is_relative_to(MOUNT.resolve()):
            raise ValueError('Source symlink escapes the checkout: '+name)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target, follow_symlinks=False)
    run(['git', 'init', '--quiet', stage])
    run(['git', '-C', stage, 'add', '--all'])
    env = {**os.environ, 'GIT_AUTHOR_NAME': 'Development snapshot', 'GIT_AUTHOR_EMAIL': 'development@example.invalid',
           'GIT_COMMITTER_NAME': 'Development snapshot', 'GIT_COMMITTER_EMAIL': 'development@example.invalid',
           'GIT_AUTHOR_DATE': stamp+' +0000', 'GIT_COMMITTER_DATE': stamp+' +0000'}
    run(['git', '-C', stage, 'commit', '--quiet', '-m', 'Local development snapshot of '+original], env=env)
    commit = output(['git', '-C', stage, 'rev-parse', 'HEAD'])
    if not activate: return original, commit, stage
    activate_snapshot(stage)
    return original, commit


def activate_snapshot(stage):
    if SOURCE.exists():
        for relative in ('node_modules', 'admin-ui/node_modules'):
            old, new = SOURCE / relative, stage / relative
            if old.exists():
                new.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(old, new)
        shutil.rmtree(SOURCE)
    stage.rename(SOURCE)


def source_tree(directory):
    rows = run(['git', '-c', 'safe.directory='+str(directory), '-C', directory, 'ls-tree', '-rz', 'HEAD'], capture_output=True).stdout.split(b'\0')
    entries = []
    for row in rows:
        if not row: continue
        header, name = os.fsdecode(row).split('\t', 1)
        mode, kind, sha = header.split(' ')
        entries.append({'path': name, 'mode': mode, 'type': kind, 'sha': sha})
    return {'truncated': False, 'tree': entries}


def file_hash(path):
    with path.open('rb') as file: return hashlib.file_digest(file, 'sha256').hexdigest()


def node_runtime(preset):
    versions = json.loads((SOURCE / 'runtime-versions.json').read_text())
    if (NODE / 'bin/node').exists() and output([NODE / 'bin/node', '--version']) == 'v'+versions['node']:
        return
    archive = ROOT / 'node.tar.xz'
    pin = versions['nodeLinuxArm64']
    presets = json.loads((SOURCE / 'src/domain/download-source-presets.json').read_text())
    url = pin['url'].replace('https://nodejs.org/dist/', presets['bootstrap'][preset]['nodePrefix'])
    run(['curl', '--fail', '--location', '--retry', '3', '--output', archive, url])
    with archive.open('rb') as file: actual = hashlib.file_digest(file, 'sha256').hexdigest()
    if actual != pin['sha256']:
        raise ValueError('Pinned Node checksum mismatch')
    stage = ROOT / 'node-stage'
    if stage.exists(): shutil.rmtree(stage)
    stage.mkdir()
    run(['tar', '-xJf', archive, '--strip-components=1', '-C', stage])
    if NODE.exists(): shutil.rmtree(NODE)
    stage.rename(NODE)
    archive.unlink()
    run([NODE / 'bin/corepack', 'enable'], env={**os.environ, 'PATH': str(NODE / 'bin')+':'+os.environ['PATH']})


def identities():
    sys.path.insert(0, str(SOURCE / 'scripts/install'))
    import installer
    host = installer.Host()
    installer.dependencies(host)
    installer.identity(host)
    try: identity = pwd.getpwnam(BUILDER)
    except KeyError:
        run(['useradd', '--create-home', '--user-group', '--home-dir', ROOT / 'builder', '--shell', '/usr/sbin/nologin', BUILDER])
        identity = pwd.getpwnam(BUILDER)
    if identity.pw_dir != str(ROOT / 'builder'):
        raise ValueError('The development builder account belongs to another installation.')
    storage = Path(identity.pw_dir) / '.config/containers'
    storage.mkdir(parents=True, exist_ok=True)
    shutil.copy2('/var/lib/dsh-phalanx/.config/containers/storage.conf', storage / 'storage.conf')
    run(['chown', '-R', BUILDER+':'+BUILDER, identity.pw_dir, SOURCE])
    run(['loginctl', 'enable-linger', BUILDER])
    run(['systemctl', 'start', 'user@'+str(identity.pw_uid)+'.service'])


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


def up(preset):
    started = time.monotonic()
    timings = {}
    def measured(label, action):
        begin = time.monotonic()
        try: return action()
        finally: timings[label] = round(time.monotonic()-begin, 2)
    required = (5 if (ROOT / 'build.json').exists() else 24) * 1024**3
    if shutil.disk_usage('/var/lib').free < required:
        raise ValueError('Reserve '+str(required // 1024**3)+' GiB inside the development VM before building. Remove disposable guest caches or destroy and recreate this VM.')
    ROOT.mkdir(mode=0o755, exist_ok=True)
    measured('buildSwap', build_swap)
    run(['apt-get', '-o', 'DPkg::Lock::Timeout=600', 'update'], env={**os.environ, 'DEBIAN_FRONTEND': 'noninteractive'})
    run(['apt-get', '-o', 'DPkg::Lock::Timeout=600', 'install', '-y', 'git', 'curl', 'ca-certificates', 'xz-utils', 'skopeo', 'python3-venv', 'libnss3-tools'])
    original, commit = measured('sourceSnapshot', snapshot)
    measured('nodeRuntime', lambda: node_runtime(preset))
    measured('hostPrerequisites', identities)
    settings = runpy.run_path(str(SOURCE / 'scripts/download-sources.py'))
    env = {**settings['build_environment'](preset, 'arm64'), 'COREPACK_DEFAULT_TO_LATEST': '0'}
    dns = measured('registryDns', lambda: runpy.run_path(str(SOURCE / 'scripts/dev/registry-dns.py'))['registry_dns'](env['NPM_CONFIG_REGISTRY']))
    command = lambda args: measured(' '.join(args[:3]), lambda: run(user_command(BUILDER, args, env), cwd=SOURCE))
    command(['corepack', 'pnpm', 'install', '--frozen-lockfile'])
    command(['corepack', 'pnpm', 'build'])
    command(['corepack', 'pnpm', 'build:admin-ui'])
    image_source = json.loads(measured('developmentImage', lambda: run(user_command(BUILDER,
        ['python3', 'scripts/dev/image.py', '--source-root', SOURCE, '--preset', preset, '--cache-root', '/mnt/dsh-image-cache'], env),
        cwd=SOURCE, stdout=subprocess.PIPE, text=True)).stdout)
    bundle = ROOT / 'bundle'
    if bundle.exists(): shutil.rmtree(bundle)
    bundle.mkdir()
    run(['chown', BUILDER+':'+BUILDER, bundle])
    command(['node', 'scripts/release/package.mjs', str(bundle), '--dev-arm64'])
    version = json.loads((SOURCE / 'package.json').read_text())['version']
    run_id = str(int(commit[:12], 16))
    tag = 'v'+version+'-rc.'+run_id
    image = 'ghcr.io/dake6767/dsh-phalanx:'+tag[1:]
    command(['podman', 'tag', 'localhost/dsh-development:current', image])
    command(['podman', 'unshare', 'skopeo', 'copy', '--dest-compress', 'containers-storage:'+image,
             'oci-archive:'+str(bundle / 'dsh-phalanx-dsh-linux-arm64.oci.tar')+':'+image])
    manifest_options = []
    if image_source['mode'] in ('pull', 'cache'):
        # This local VM bundle is never published or promoted. Its export may use
        # different compression while retaining the verified independent inputs.
        raw = run(user_command(BUILDER, ['skopeo', 'inspect', '--raw',
                  'oci-archive:'+str(bundle/'dsh-phalanx-dsh-linux-arm64.oci.tar')]), cwd=SOURCE, capture_output=True).stdout
        digest = 'sha256:'+hashlib.sha256(raw).hexdigest()
        selection = {key: image_source[key] for key in ('inputHash', 'dshRevision', 'baseImageDigest', 'platform')}
        selection.update(mode='reuse', reason='input-match', rehearsal=True, digest=digest,
                         reference='ghcr.io/dake6767/dsh-phalanx@'+digest)
        selection_path = bundle/'image-selection.json'
        selection_path.write_text(json.dumps(selection))
        run(['chown', BUILDER+':'+BUILDER, selection_path])
        manifest_options = ['--image-selection', str(selection_path)]
    run(user_command(BUILDER, ['node', 'scripts/release/manifest.mjs', str(bundle), '--dev-arm64', *manifest_options],
                     {**env, 'CANDIDATE_TAG': tag, 'GITHUB_RUN_ID': run_id}), cwd=SOURCE)
    model_service()
    args = ['bash', str(SOURCE / 'install.sh'), '--dev-arm64', '--version', tag, '--bundle-dir', str(bundle), '--yes', '--output', 'json', '--download-source-preset', preset]
    if not Path('/etc/dsh-phalanx/install-state.json').exists():
        key = ROOT / 'model-key'
        key.touch(mode=0o600)
        key.write_text('development-only-fixture\n')
        args += ['--host-public-addresses', '', '--listen-address', '0.0.0.0', '--port', '8080',
                 '--public-origin', 'http://127.0.0.1:18080', '--model-base-url', 'http://127.0.0.1:18081',
                 '--model', 'development-model', '--model-key-file', str(key)]
    receipt = ROOT / 'operator.json'
    with receipt.open('w') as file:
        os.fchmod(file.fileno(), 0o600)
        measured('installerTransaction', lambda: run(args, stdout=file))
    manifest = json.loads((bundle / 'manifest.json').read_text())
    (ROOT / 'build.json').write_text(json.dumps({'originalCommit': original, 'snapshotCommit': commit,
        'builtTree': source_tree(SOURCE), 'sourcePreset': preset, 'registryDns': dns, 'imageSource': image_source, 'manifest': manifest, 'stepSeconds': timings, 'elapsedSeconds': round(time.monotonic()-started, 2)}, indent=2)+'\n')
    (ROOT / 'build.json').chmod(0o644)
    (bundle / 'dsh-phalanx-dsh-linux-arm64.oci.tar').chmod(0o644)
    bundle.chmod(0o755)
    # The operator-only bootstrap link is shown in the local terminal, never in build logs.
    result = json.loads(receipt.read_text())
    if result.get('initializationUrl'): print('Create your local administrator: '+result['initializationUrl'])
    print('Development product: http://127.0.0.1:18080/')
    print('The initial model is a local fixture. Configure real providers in Administration; keys stay in the VM.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['up', 'logs', 'test', 'clock'])
    parser.add_argument('--source', choices=['mainland', 'official'], default='mainland')
    parser.add_argument('--files')
    parser.add_argument('--retry')
    parser.add_argument('--quota-reset-at')
    args = parser.parse_args()
    guard()
    if args.action == 'clock': configure_clock()
    elif args.action == 'up': up(args.source)
    elif args.action == 'logs':
        run(user_command('dsh-phalanx', ['journalctl', '--user', '-u', 'dsh-phalanx.service', '-n', '80', '--no-pager']))
    else:
        acceptance(args)


def retry_files(parent, receipt, plan, quota_reset_at):
    if not parent.get('firstRun') or not parent.get('files'): raise ValueError('No completed file evidence; diagnose and start a new run')
    if parent['status'] == 'passed': raise ValueError('The selected Linux run already passed')
    if plan['rebuild']: raise ValueError('Deliverables changed; start a new run so the bundle is rebuilt')
    if parent['builtSnapshot'] != receipt['snapshotCommit']: raise ValueError('Retry must use the original bundle')
    failed = [row for row in parent['files'] if row['status'] != 'passed']
    if not failed: raise ValueError('No failed files remain to rerun')
    if any(row.get('quotaFailure') for row in failed):
        from datetime import datetime
        if not quota_reset_at: raise ValueError('Quota failure requires an elapsed provider reset (--quota-reset-at ISO8601)')
        reset = datetime.fromisoformat(quota_reset_at.replace('Z', '+00:00')).timestamp()
        if reset <= parent['startedAt'] or reset > time.time(): raise ValueError('Provider reset must follow the failed run and have elapsed')
    return [row['file'] for row in failed]


def reserve_retry(ledger, files, run_id):
    for file in files:
        if ledger['attempts'].get(file, 0) >= 2: raise ValueError('Two failed-file reruns exhausted: '+file)
    for file in files: ledger['attempts'][file] = ledger['attempts'].get(file, 0) + 1
    ledger['runs'].append(run_id)


def verify_bundle(receipt, manifest, archive, platform_archive):
    files = receipt['manifest']['files']
    if file_hash(archive) != files[archive.name] or file_hash(platform_archive) != files[platform_archive.name]:
        raise ValueError('Built bundle archive hash mismatch')
    installed = json.loads(Path('/opt/dsh-phalanx/current/build-info.json').read_text())
    if installed['commit'] != receipt['snapshotCommit'] or installed['platform'] != 'linux/arm64':
        raise ValueError('Installed bundle identity mismatch')
    return {'manifestSha256': file_hash(manifest), 'ociSha256': file_hash(archive), 'platformSha256': file_hash(platform_archive)}


def restore_build_assets(platform_archive):
    """Source-driven cases use the same built assets as the verified platform archive."""
    import tarfile
    with tarfile.open(platform_archive, 'r:gz') as bundle:
        members = [entry for entry in bundle.getmembers() if PurePosixPath(entry.name).parts[:1] == ('dist',)
                   or PurePosixPath(entry.name).parts[:2] == ('admin-ui', 'dist')]
        bundle.extractall(SOURCE, members=members, filter='data')
    for relative in ('dist/composition/cli.js', 'admin-ui/dist/community.html'):
        if not (SOURCE / relative).is_file(): raise ValueError('Verified platform archive lacks '+relative)


def acceptance(args):
    if shutil.disk_usage('/var/tmp').free < 5 * 1024**3:
        raise ValueError('Reserve 5 GiB inside the development VM before T2; remove disposable guest caches first.')
    receipt_path = ROOT / 'build.json'
    receipt = json.loads(receipt_path.read_text())
    results = ROOT / 't2-results' / str(time.time_ns())
    results.mkdir(parents=True)
    started = time.monotonic()
    stopped = threading.Event()
    peak = [shutil.disk_usage('/').used, 0]
    def sample_once():
        peak[0] = max(peak[0], shutil.disk_usage('/').used)
        memory = dict((line.split(':')[0], int(line.split()[1]) * 1024) for line in Path('/proc/meminfo').read_text().splitlines())
        peak[1] = max(peak[1], memory['MemTotal'] - memory['MemAvailable'])
    def sample():
        while not stopped.wait(1): sample_once()
    sample_once()
    sampler = threading.Thread(target=sample, daemon=True)
    sampler.start()
    summary = {'status': 'interrupted', 'runId': results.name, 'results': str(results), 'files': [], 'originalFailureRun': args.retry}
    try:
        built_tree = receipt.setdefault('builtTree', source_tree(SOURCE))
        receipt_path.write_text(json.dumps(receipt, indent=2)+'\n')
        original, harness_commit, stage = snapshot(activate=False)
        before, after = results / 'built-tree.json', results / 'harness-tree.json'
        before.write_text(json.dumps(built_tree)); after.write_text(json.dumps(source_tree(stage)))
        plan = json.loads(output([NODE / 'bin/node', MOUNT / 'scripts/validation/development-plan.mjs', before, after]))
        parent = None
        ledger = None
        selected = args.files
        summary['startedAt'] = time.time()
        if args.retry:
            if not args.retry.isdecimal(): raise ValueError('Retry requires the original numeric run ID')
            parent = json.loads((ROOT / 't2-results' / args.retry / 'summary.json').read_text())
            if plan['rebuild']:
                # A Deliverable fix starts a new byte lineage and rechecks the original selection.
                summary['newBundleAfterFailedRun'] = parent['runId']
                migration = json.loads((stage / 'scripts/validation/t2-selection.json').read_text())['migration']['file']
                selected = None if migration in parent['expectedFiles'] else ','.join(parent['expectedFiles'])
                parent = None
            else:
                files_to_retry = retry_files(parent, receipt, plan, args.quota_reset_at)
                first = parent['firstRun']
                ledger_path = ROOT / 't2-results' / first / 'retry-ledger.json'
                ledger = json.loads(ledger_path.read_text())
                selected = ','.join(files_to_retry)
        if plan['rebuild']:
            summary['rebuildReason'] = plan['reason']
            up(receipt['sourcePreset'])
            receipt = json.loads(receipt_path.read_text())
            original, harness_commit = receipt['originalCommit'], receipt['snapshotCommit']
            before.write_text(json.dumps(receipt['builtTree'])); after.write_text(json.dumps(source_tree(SOURCE)))
            fresh_plan = json.loads(output([NODE / 'bin/node', MOUNT / 'scripts/validation/development-plan.mjs', before, after]))
            plan['fileInputs'] = fresh_plan['fileInputs']
        else:
            activate_snapshot(stage)
        # The bundle's immutable identity never changes merely because Harness was synchronized.
        manifest = ROOT / 'bundle/manifest.json'
        if json.loads(manifest.read_text()) != receipt['manifest']: raise ValueError('Bundle manifest changed since build')
        archive = ROOT / 'bundle' / 'dsh-phalanx-dsh-linux-arm64.oci.tar'
        platform_archive = ROOT / 'bundle' / 'dsh-phalanx-linux-arm64.tar.gz'
        identity = verify_bundle(receipt, manifest, archive, platform_archive)
        restore_build_assets(platform_archive)
        if parent and parent['bundle'] != identity: raise ValueError('Retry bundle bytes differ from the first run')
        selection = json.loads((SOURCE / 'scripts/validation/t2-selection.json').read_text())
        files = selected.split(',') if selected else selection['regular']
        migration_file = selection['migration']['file']
        requested = [file for file in files if file != migration_file]
        migration_only = bool(selected) and not requested and files == [migration_file]
        if len(files) != len(set(files)) or not files or any(file not in selection['regular'] and not (parent and file == migration_file) for file in files):
            raise ValueError('Select distinct regular Linux inventory files')
        summary.update(builtSource=receipt['originalCommit'], builtSnapshot=receipt['snapshotCommit'],
                       harnessSource=original, harnessSnapshot=harness_commit, harnessPlan=plan, bundle=identity,
                       selected=files, full=not selected, firstRun=parent['firstRun'] if parent else results.name,
                       inventorySha256=file_hash(SOURCE / 'scripts/validation/t2-selection.json'))
        if parent and parent['inventorySha256'] != summary['inventorySha256']: raise ValueError('Inventory changed; start a new full run')
        if parent:
            for row in parent['files']:
                if row['status'] == 'passed' and row['inputDigest'] != plan['fileInputs'].get(row['file']):
                    raise ValueError('Shared Harness inputs changed for a passed file; run the affected selection again with the same bundle: '+row['file'])
        if not parent:
            (results / 'retry-ledger.json').write_text(json.dumps({'attempts': {}, 'runs': [results.name]})+'\n')
        settings = runpy.run_path(str(SOURCE / 'scripts/download-sources.py'))
        registry = settings['build_environment'](receipt['sourcePreset'], 'arm64')['NPM_CONFIG_REGISTRY']
        runpy.run_path(str(SOURCE / 'scripts/dev/registry-dns.py'))['registry_dns'](registry)
        command = ['python3', SOURCE / 'scripts/validation/t2-host.py', '--source', SOURCE, '--results', results,
             '--image', receipt['manifest']['image']['reference'], '--commit', receipt['snapshotCommit'],
             '--oci', archive, '--source-preset', receipt['sourcePreset'], '--manual-retries']
        if migration_only: command.append('--migration-only')
        elif selected: command.extend(['--files', ','.join(requested)])
        if parent and migration_file in files and not migration_only: command.append('--with-migration')
        if ledger is not None:
            if args.quota_reset_at: summary['quotaResetAt'] = args.quota_reset_at
            reserve_retry(ledger, files, results.name)
            ledger_path.write_text(json.dumps(ledger, indent=2)+'\n')
        result = subprocess.run([str(part) for part in command], env={**os.environ, 'PATH': str(NODE / 'bin')+':'+os.environ['PATH']})
        executions = []
        for group in ('linux', 'migration'):
            path = results / (group+'-files.json')
            if path.exists(): executions.extend(json.loads(path.read_text()))
        summary['files'] = [dict({key: row[key] for key in ('file', 'status', 'portBase', 'directory', 'elapsedMs', 'report')}, inputDigest=plan.get('fileInputs', {}).get(row['file'])) for row in executions]
        for row in summary['files']:
            report_path = Path(row['report'])
            if report_path.exists():
                report = json.loads(report_path.read_text())
                messages = '\n'.join(message for file in report['testResults'] for case in file['assertionResults'] for message in case.get('failureMessages', []))
                import re
                row['quotaFailure'] = bool(re.search(r'rate.?limit|too many requests|quota|\b429\b', messages, re.I))
        if parent:
            rerun_files = {row['file'] for row in summary['files']}
            summary['files'] = [dict(row, reusedFrom=parent['runId']) for row in parent['files'] if row['file'] not in rerun_files] + summary['files']
        expected_files = parent['expectedFiles'] if parent else files + ([] if selected else [migration_file])
        summary['expectedFiles'] = expected_files
        complete = set(row['file'] for row in summary['files']) == set(expected_files)
        summary['status'] = 'passed' if result.returncode == 0 and complete and all(row['status'] == 'passed' for row in summary['files']) else 'failed'
        if summary['status'] == 'passed':
            (results / 'summary.json').write_text(json.dumps(summary, indent=2)+'\n')
            run([NODE / 'bin/node', SOURCE / 'scripts/validation/verify-development-results.mjs', results / 'summary.json'])
        if summary['status'] != 'passed': raise ValueError('Linux acceptance failed; retained results: '+str(results))
    except Exception as error:
        summary['status'] = 'failed'; summary['error'] = str(error)
        raise
    finally:
        stopped.set(); sampler.join(); sample_once()
        usage = {'peakUsedBytes': peak[0], 'peakUsedGiB': round(peak[0]/1024**3, 2),
                 'sampleSeconds': 1, 'over27GiB': peak[0] > 27*1024**3, 'guestPeakMemoryBytes': peak[1]}
        (results / 'disk-usage.json').write_text(json.dumps(usage)+'\n')
        summary['resources'] = usage
        summary['elapsedSeconds'] = round(time.monotonic()-started, 2)
        (results / 'summary.json').write_text(json.dumps(summary, indent=2)+'\n')
        print('Linux acceptance receipt: '+json.dumps(summary), flush=True)
        if usage['over27GiB']: print('Report to the maintainer: guest disk usage exceeded approximately 27 GiB.', file=sys.stderr)


if __name__ == '__main__':
    try: main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
