"""Prepare owned Linux fixtures and run the same T2 command in Lima and CI."""
import argparse
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import pwd
import runpy
import platform
import shutil
import subprocess
import tempfile
import uuid


def run(args, **options):
    return subprocess.run([str(value) for value in args], check=True, **options)


def user(account, args, extra=None):
    row = pwd.getpwnam(account)
    environment = {'HOME': row.pw_dir, 'USER': account, 'LOGNAME': account, 'LANG': 'C.UTF-8',
                   'XDG_RUNTIME_DIR': '/run/user/'+str(row.pw_uid), 'XDG_CONFIG_HOME': row.pw_dir+'/.config',
                   'PATH': os.environ['PATH'], 'CI': 'true'}
    environment.update(extra or {})
    return ['runuser', '-u', account, '--', 'env', '-i', *[key+'='+value for key, value in environment.items()], *args]


def execute(args, temporary):
    account = 'dsh-phalanx'
    identity = pwd.getpwnam(account)
    source = Path(args.source).resolve()
    settings = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'download-sources.py'))
    downloads = settings['build_environment'](getattr(args, 'source_preset', 'official'), 'arm64' if platform.machine() == 'aarch64' else 'amd64')
    result = Path(args.results).resolve()
    result.mkdir(parents=True, exist_ok=True)
    run(['chown', str(identity.pw_uid)+':'+str(identity.pw_gid), result])
    work = temporary / 'source'
    shutil.copytree(source, work, symlinks=True, ignore=shutil.ignore_patterns('.git', '__pycache__'))
    run(['chown', '-R', account+':'+account, work])
    suffix = uuid.uuid4().hex[:8]
    peer = 'dsh-t2-'+suffix
    namespace, host_link, peer_link = peer, 't2h'+suffix, 't2p'+suffix
    peer_created = namespace_created = link_created = trust_created = primary_created = False
    fixture = None
    try:
        run(['useradd', '--create-home', '--user-group', '--home-dir', temporary / 'peer', '--shell', '/usr/sbin/nologin', peer])
        peer_created = True
        peer_id = pwd.getpwnam(peer)
        storage = Path(peer_id.pw_dir) / '.config/containers'
        storage.mkdir(parents=True)
        shutil.copyfile(Path(identity.pw_dir) / '.config/containers/storage.conf', storage / 'storage.conf')
        run(['chown', '-R', peer+':'+peer, peer_id.pw_dir])
        run(['loginctl', 'enable-linger', peer])
        run(['systemctl', 'start', 'user@'+str(peer_id.pw_uid)+'.service'])
        # Use the verified native bundle, never rebuild or substitute the image.
        run(user(peer, ['podman', 'load', '-i', str(Path(args.oci).resolve())]), stdout=subprocess.DEVNULL)
        marker = 't2-isolation-'+suffix
        run(user(peer, ['podman', 'create', '--name', marker, '--network=none', args.image, 'true']), stdout=subprocess.DEVNULL)
        absent = subprocess.run(user(account, ['podman', 'container', 'exists', marker])).returncode
        if absent != 1: raise ValueError('The primary identity can see the peer container store')
        run(user(peer, ['podman', 'rm', marker]), stdout=subprocess.DEVNULL)
        run(user(account, ['podman', 'create', '--name', marker, '--network=none', args.image, 'true']), stdout=subprocess.DEVNULL)
        primary_created = True
        try:
            absent = subprocess.run(user(peer, ['podman', 'container', 'exists', marker])).returncode
            if absent != 1: raise ValueError('The peer identity can see the primary container store')
        finally:
            run(user(account, ['podman', 'rm', marker]), stdout=subprocess.DEVNULL)
            primary_created = False
        for name in (account, peer):
            row = pwd.getpwnam(name)
            actual = run(user(name, ['podman', 'run', '--rm', '--network=none', '--userns=keep-id',
                         '--user', str(row.pw_uid)+':'+str(row.pw_gid), args.image, 'sh', '-c', 'id -u; id -g']),
                         capture_output=True, text=True).stdout.splitlines()
            if actual != [str(row.pw_uid), str(row.pw_gid)]: raise ValueError('Rootless keep-id mapping failed')
        (result / 'isolation.json').write_text(json.dumps({'result': 'passed', 'identities': 2, 'keepId': True, 'mutualStoreIsolation': True})+'\n')
        browsers = Path('/var/cache/dsh-phalanx-t2-browsers')
        run(['node', 'node_modules/playwright/cli.js', 'install-deps', 'chromium'], cwd=work)
        run(['node', 'node_modules/playwright/cli.js', 'install', 'chromium'], cwd=work,
            env={**os.environ, **downloads, 'PLAYWRIGHT_BROWSERS_PATH': str(browsers)})
        environment = {**downloads, 'DSH_PHALANX_CONTAINER_IMAGE': args.image, 'DSH_PHALANX_PRECHECK_IMAGE': args.image,
                       'DSH_PHALANX_INSTALL_ROOT': '/opt/dsh-phalanx/current', 'DSH_PHALANX_CANDIDATE_SHA': args.commit,
                       'PLAYWRIGHT_BROWSERS_PATH': str(browsers)}
        if bool(args.reuse_baseline)!=bool(args.reuse_target):raise ValueError('Both rehearsal candidate paths are required')
        if args.reuse_baseline:
            environment.update(DSH_PHALANX_REUSE_SOURCE=str(Path(args.reuse_baseline).resolve()),DSH_PHALANX_REUSE_TARGET=str(Path(args.reuse_target).resolve()))
        if args.source_preset == 'mainland': environment['DSH_PHALANX_E2E_NPM_MIRROR'] = '1'
        if not args.smoke:
            tls = temporary / 'tls'
            tls.mkdir()
            run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', tls / 'key.pem',
                 '-out', tls / 'cert.pem', '-subj', '/CN=T2-preview', '-addext', 'subjectAltName=IP:127.0.0.1',
                 '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'extendedKeyUsage=serverAuth'], capture_output=True)
            run(['chown', '-R', account+':'+account, tls])
            nss = Path(identity.pw_dir) / '.pki/nssdb'
            nss.mkdir(parents=True, exist_ok=True)
            run(['chown', '-R', account+':'+account, nss.parent])
            if not (nss / 'cert9.db').exists(): run(user(account, ['certutil', '-N', '--empty-password', '-d', 'sql:'+str(nss)]))
            run(user(account, ['certutil', '-A', '-d', 'sql:'+str(nss), '-n', peer, '-t', 'C,,', '-i', str(tls / 'cert.pem')]))
            trust_created = True
            run(['ip', 'netns', 'add', namespace]); namespace_created = True
            run(['ip', 'link', 'add', host_link, 'type', 'veth', 'peer', 'name', peer_link]); link_created = True
            run(['ip', 'link', 'set', peer_link, 'netns', namespace])
            run(['ip', 'addr', 'add', '10.253.16.1/30', 'dev', host_link])
            run(['ip', 'link', 'set', host_link, 'up'])
            run(['ip', '-n', namespace, 'addr', 'add', '10.253.16.2/30', 'dev', peer_link])
            run(['ip', '-n', namespace, 'link', 'set', peer_link, 'up'])
            run(['ip', '-n', namespace, 'link', 'set', 'lo', 'up'])
            run(['ip', '-n', namespace, 'addr', 'add', '11.254.254.254/32', 'dev', 'lo'])
            run(['ip', 'route', 'add', '11.254.254.254/32', 'via', '10.253.16.2', 'dev', host_link])
            # The namespace has no default route. This fixture cannot forward traffic.
            with (result / 'fixture.log').open('w') as log:
                fixture = subprocess.Popen(['ip', 'netns', 'exec', namespace, *user(account,
                    ['python3', str(work / 'tests/fixtures/personal-upstream.py'), '--host', '11.254.254.254'])], stdout=log, stderr=log)
            run(['curl', '--noproxy', '*', '--fail', '--silent', '--retry', '20', '--retry-connrefused', '--retry-delay', '1',
                 'http://11.254.254.254:18443/fixture/health'], stdout=subprocess.DEVNULL)
            address = run(['curl', '--fail', '--silent', '--show-error', '--retry', '2', 'https://api.ipify.org'], capture_output=True, text=True).stdout.strip()
            if not ipaddress.ip_address(address).is_global or ipaddress.ip_address(address).version != 4:
                raise ValueError('Could not measure the host public IPv4 inventory')
            environment.update({'DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES': address,
                'DSH_PHALANX_E2E_PERSONAL_UPSTREAM': 'http://11.254.254.254:18443/fixture',
                'DSH_PHALANX_PREVIEW_TEST_CERT': str(tls / 'cert.pem'), 'DSH_PHALANX_PREVIEW_TEST_KEY': str(tls / 'key.pem'),
                'NODE_EXTRA_CA_CERTS': str(tls / 'cert.pem')})
        run(user(account, ['node', 'scripts/validation/t2.mjs', *(['--smoke'] if args.smoke else []), str(result)], environment), cwd=work)
    finally:
        errors = []
        def attempt(label, action):
            try: action()
            except Exception as error: errors.append(label+': '+str(error))
        def containers():
            with (result / 'containers.json').open('w') as file:
                run(user(account, ['podman', 'ps', '-a', '--format', 'json']), stdout=file)
        def stop_fixture():
            fixture.terminate()
            try: fixture.wait(timeout=15)
            except subprocess.TimeoutExpired:
                fixture.kill()
                fixture.wait(timeout=15)
        attempt('container diagnostics', containers)
        if primary_created: attempt('primary isolation container', lambda: run(user(account, ['podman', 'rm', marker]), stdout=subprocess.DEVNULL))
        if fixture: attempt('fixture process', stop_fixture)
        if link_created: attempt('fixture link', lambda: run(['ip', 'link', 'delete', host_link]))
        if namespace_created: attempt('fixture namespace', lambda: run(['ip', 'netns', 'delete', namespace]))
        if trust_created: attempt('temporary CA', lambda: run(user(account, ['certutil', '-D', '-d', 'sql:'+str(nss), '-n', peer])))
        if peer_created:
            attempt('peer storage', lambda: run(user(peer, ['podman', 'system', 'reset', '--force']), stdout=subprocess.DEVNULL))
            attempt('peer linger', lambda: run(['loginctl', 'disable-linger', peer]))
            attempt('peer sessions', lambda: run(['loginctl', 'terminate-user', peer]))
            attempt('peer service', lambda: run(['systemctl', 'stop', 'user@'+str(pwd.getpwnam(peer).pw_uid)+'.service']))
            attempt('peer account', lambda: run(['userdel', '--remove', peer]))
        (result / 'cleanup.json').write_text(json.dumps({'result': 'failed' if errors else 'passed', 'errors': errors})+'\n')
        if errors: raise RuntimeError('T2 cleanup incomplete: '+'; '.join(errors))


def main():
    parser = argparse.ArgumentParser()
    for name in ('source', 'results', 'image', 'oci', 'commit'): parser.add_argument('--'+name, required=True)
    parser.add_argument('--source-preset', choices=['official', 'mainland'], default='official')
    parser.add_argument('--smoke', action='store_true')
    parser.add_argument('--reuse-baseline')
    parser.add_argument('--reuse-target')
    args = parser.parse_args()
    if os.geteuid() != 0: raise ValueError('T2 fixture preparation requires root on an owned Linux validation host')
    with open('/run/lock/dsh-phalanx-t2.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with tempfile.TemporaryDirectory(prefix='dsh-phalanx-t2-', dir='/var/tmp') as temporary:
            path = Path(temporary)
            path.chmod(0o755)
            execute(args, path)


if __name__ == '__main__': main()
