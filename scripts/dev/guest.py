"""Owned Lima guest lifecycle; installation and upgrades use the product CLI."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import runpy
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


def snapshot():
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
    if SOURCE.exists():
        for relative in ('node_modules', 'admin-ui/node_modules'):
            old, new = SOURCE / relative, stage / relative
            if old.exists():
                new.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(old, new)
        shutil.rmtree(SOURCE)
    stage.rename(SOURCE)
    return original, output(['git', '-C', SOURCE, 'rev-parse', 'HEAD'])


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
    required = (12 if (ROOT / 'build.json').exists() else 24) * 1024**3
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
    build_args = ['--build-arg', 'NPM_REGISTRY='+env['NPM_CONFIG_REGISTRY'],
                  '--build-arg', 'NODE_IMAGE='+env['DSH_PHALANX_BUILD_NODE_IMAGE']]
    inputs=json.loads(run(user_command(BUILDER,['node','scripts/release/image-inputs.mjs','--platform','linux/arm64','--node-image',env['DSH_PHALANX_BUILD_NODE_IMAGE']],env),cwd=SOURCE,capture_output=True,text=True).stdout)
    command(['podman', 'build', '--format', 'oci', '--label', 'dsh.input.sha256='+inputs['inputHash'], '--label', 'org.opencontainers.image.revision='+commit,
             '--label', 'org.opencontainers.image.source=https://github.com/dake6767/dsh-phalanx',
             *build_args, '-t', 'localhost/dsh-development:current', '-f', 'containers/dsh/Containerfile', 'containers/dsh'])
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
    run(user_command(BUILDER, ['node', 'scripts/release/manifest.mjs', str(bundle), '--dev-arm64'],
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
        'sourcePreset': preset, 'registryDns': dns, 'manifest': manifest, 'stepSeconds': timings, 'elapsedSeconds': round(time.monotonic()-started, 2)}, indent=2)+'\n')
    # The operator-only bootstrap link is shown in the local terminal, never in build logs.
    result = json.loads(receipt.read_text())
    if result.get('initializationUrl'): print('Create your local administrator: '+result['initializationUrl'])
    print('Development product: http://127.0.0.1:18080/')
    print('The initial model is a local fixture. Configure real providers in Administration; keys stay in the VM.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['up', 'logs', 'test', 'clock'])
    parser.add_argument('--source', choices=['mainland', 'official'], default='mainland')
    args = parser.parse_args()
    guard()
    if args.action == 'clock': configure_clock()
    elif args.action == 'up': up(args.source)
    elif args.action == 'logs':
        run(user_command('dsh-phalanx', ['journalctl', '--user', '-u', 'dsh-phalanx.service', '-n', '80', '--no-pager']))
    else:
        if shutil.disk_usage('/var/tmp').free < 12 * 1024**3:
            raise ValueError('Reserve 12 GiB inside the development VM before T2; remove disposable guest caches first.')
        receipt = json.loads((ROOT / 'build.json').read_text())
        settings = runpy.run_path(str(SOURCE / 'scripts/download-sources.py'))
        registry = settings['build_environment'](receipt['sourcePreset'], 'arm64')['NPM_CONFIG_REGISTRY']
        runpy.run_path(str(SOURCE / 'scripts/dev/registry-dns.py'))['registry_dns'](registry)
        run(['python3', SOURCE / 'scripts/validation/t2-host.py', '--source', SOURCE, '--results', ROOT / 't2-results',
             '--image', receipt['manifest']['image']['reference'], '--commit', receipt['snapshotCommit'],
             '--oci', ROOT / 'bundle/dsh-phalanx-dsh-linux-arm64.oci.tar', '--source-preset', receipt['sourcePreset']],
            env={**os.environ, 'PATH': str(NODE / 'bin')+':'+os.environ['PATH']})


if __name__ == '__main__':
    try: main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
