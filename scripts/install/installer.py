"""Ubuntu installation command. Host owns filesystem and operating-system I/O."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import re
import shlex
import tempfile
import tarfile
import secrets
import time
import getpass
import ipaddress
import urllib.request
import urllib.error
import urllib.parse
import fcntl
import contextlib
import shutil
import socket
import errno
from installer_config import configuration, installed_state, validate_storage, environment_text  # embedded-config
from installer_host import Host, InstallError, entry_url  # embedded-host
from installer_progress import Progress  # embedded-progress
from installer_upgrade_cli import upgrade_command, selected_target  # embedded-upgrade-cli

ACCOUNT = "dsh-phalanx"
HOME_DIR = "/var/lib/dsh-phalanx"
CONFIG = "/etc/dsh-phalanx/environment"
STATE = "/etc/dsh-phalanx/install-state.json"
CURRENT = "/opt/dsh-phalanx/current"
UNIT = HOME_DIR+"/.config/systemd/user/dsh-phalanx.service"
PACKAGES = ("podman", "uidmap", "passt", "fuse-overlayfs", "dbus-user-session", "apparmor", "apparmor-utils")

from installer_release import IMAGE, ASSETS, acquire, digest, verify_manifest, supply_image, stage_platform  # embedded-release



def access_candidate(host, values):
    address = ipaddress.ip_address(values['DSH_PHALANX_HOST'])
    if not address.is_unspecified:
        return entry_url(values['DSH_PHALANX_PORT'], str(address))
    aliases = values['DSH_PHALANX_HOST_PUBLIC_ADDRESSES'].split(',')
    candidates = [value.strip() for value in aliases if value.strip()]
    if not candidates:
        candidates = host.run(['hostname', '-I']).stdout.split()
    for candidate in candidates:
        parsed = ipaddress.ip_address(candidate)
        if not parsed.is_loopback and not parsed.is_link_local and not parsed.is_unspecified:
            return entry_url(values['DSH_PHALANX_PORT'], str(parsed))
    return entry_url(values['DSH_PHALANX_PORT'], str(address))



def options(arguments):
    class Parser(argparse.ArgumentParser):
        def error(self, message): raise InstallError(message)
    parser = Parser(description="Install dsh-phalanx on Ubuntu 24.04 amd64")
    parser.add_argument("--version", default="latest")
    parser.add_argument("--upgrade", choices=("prepare","apply","status","recover"))
    parser.add_argument("--operation", help="Exact prepared upgrade operation identity")
    parser.add_argument("--yes", action="store_true", help="Accept immediate service/task interruption for an upgrade")
    parser.add_argument("--output", choices=("human", "json"), default="human")
    parser.add_argument("--verbose", action="store_true", help="Show sanitized commands and identity details")
    parser.add_argument("--bundle-dir", type=Path, help="Explicit private candidate archive handoff")
    parser.add_argument("--model-key-file", type=Path, help="Read deployer credential from a protected file")
    parser.add_argument("--host-public-addresses", help="Complete public IPv4 aliases; pass an empty string only if none")
    parser.add_argument("--model-base-url")
    parser.add_argument("--model-provider")
    parser.add_argument("--model")
    parser.add_argument("--listen-address")
    parser.add_argument("--port", type=int)
    parser.add_argument("--gateway-port", type=int, help="Private loopback model/network gateway port")
    parser.add_argument("--public-origin")
    parser.add_argument('--user-data-root', help='User home/workspace directory on an existing mounted data volume')
    parser.add_argument('--user-data-mount', help='Exact expected mount point containing the user data directory')
    return parser.parse_args(arguments)




def dependencies(host):
    installed = host.run(["dpkg-query", "-W", "-f=${db:Status-Abbrev}\\n", *PACKAGES], check=False)
    if installed.returncode != 0 or installed.stdout.splitlines() != ["ii "]*len(PACKAGES):
        env = {**os.environ, "DEBIAN_FRONTEND": "noninteractive"}
        host.run(["apt-get", "-o", "DPkg::Lock::Timeout=600", "update"], env=env)
        host.run(["apt-get", "-o", "DPkg::Lock::Timeout=600", "install", "-y", "--no-install-recommends", *PACKAGES], env=env)
    sysctl = []
    for key, value in (("kernel.unprivileged_userns_clone", "1"), ("user.max_user_namespaces", "65536")):
        path = host.path("/proc/sys/"+key.replace(".", "/"))
        if path.exists() and path.read_text().strip() == "0":
            sysctl.append(key+"="+value)
    if sysctl:
        host.atomic("/etc/sysctl.d/90-dsh-phalanx.conf", "\n".join(sysctl)+"\n", 0o644)
        host.run(["sysctl", "--load", str(host.path("/etc/sysctl.d/90-dsh-phalanx.conf"))])
    restricted = host.path("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
    if restricted.exists() and restricted.read_text().strip() == "1":
        for binary in ("podman", "pasta"):
            profile = "/etc/apparmor.d/"+binary
            if not host.path(profile).exists():
                profile = "/etc/apparmor.d/dsh-phalanx-"+binary
                host.atomic(profile, "abi <abi/4.0>,\ninclude <tunables/global>\n"+
                            f"profile dsh-phalanx-{binary} /usr/bin/{binary} flags=(unconfined) {{\n  userns,\n}}\n", 0o644)
            host.run(["apparmor_parser", "-r", str(host.path(profile))])


def identity(host):
    existing = host.run(["getent", "passwd", ACCOUNT], check=False)
    if existing.returncode == 2:
        host.run(["useradd", "--create-home", "--user-group", "--home-dir", HOME_DIR, "--shell", "/usr/sbin/nologin", ACCOUNT])
        existing = host.run(["getent", "passwd", ACCOUNT])
    elif existing.returncode != 0:
        raise InstallError("Cannot inspect the service identity")
    row = existing.stdout.strip().split(":")
    if len(row) != 7 or row[5] != HOME_DIR or row[6] != "/usr/sbin/nologin" or int(row[2]) == 0 or int(row[3]) == 0:
        raise InstallError("Reserved service account has incompatible identity or home")
    uid, gid = int(row[2]), int(row[3])
    for table, flag in (("subuid", "--add-subuids"), ("subgid", "--add-subgids")):
        rows = [line.split(":") for line in host.path("/etc/"+table).read_text().splitlines() if line]
        own = [item for item in rows if item[0] in (ACCOUNT, str(uid))]
        if own and not any(int(item[2]) >= 65536 for item in own):
            raise InstallError("Service identity needs a contiguous 65536-entry subordinate-ID range")
        for selected in own:
            start, end = int(selected[1]), int(selected[1])+int(selected[2])
            if start < 65536 or end > 2**32 or any(other is not selected and start < int(other[1])+int(other[2]) and int(other[1]) < end for other in rows):
                raise InstallError("Service subordinate-ID ranges must be unprivileged and nonoverlapping")
        if not own:
            start = max([100000, *(int(item[1])+int(item[2]) for item in rows)])
            if start+65535 >= 2**32:
                raise InstallError("No subordinate-ID range is available")
            host.run(["usermod", flag, f"{start}-{start+65535}", ACCOUNT])
    host.mkdir(HOME_DIR, 0o700)
    host.run(["chown", f"{uid}:{gid}", str(host.path(HOME_DIR))])
    storage = HOME_DIR+"/.config/containers/storage.conf"
    if not host.path(storage).exists():
        host.atomic(storage, '[storage]\ndriver = "overlay"\n[storage.options.overlay]\nmount_program = "/usr/bin/fuse-overlayfs"\n', 0o600)
    host.run(["chown", "-R", f"{uid}:{gid}", str(host.path(HOME_DIR+"/.config"))])
    host.run(["loginctl", "enable-linger", ACCOUNT])
    host.run(["systemctl", "start", f"user@{uid}.service"])
    info = json.loads(host.user(uid, ["podman", "info", "--format", "json"]).stdout)
    if info["host"]["security"]["rootless"] is not True or info["host"]["cgroupVersion"] != "v2":
        raise InstallError("Rootless Podman and cgroup v2 are required")
    return uid, gid






def prepare_user_storage(host, uid, gid, values):
    root_value, mount_value = (values.get('DSH_PHALANX_'+name) for name in ('USER_DATA_ROOT', 'USER_DATA_MOUNT'))
    if root_value is None and mount_value is None:
        return
    if not root_value or not mount_value or not Path(root_value).is_absolute() or not Path(mount_value).is_absolute():
        raise InstallError('External user storage requires absolute root and mount paths')
    validate_storage(host, values)
    root = host.path(root_value)
    if not root.exists() or not any(root.iterdir()):
        host.mkdir(root_value, 0o700)
        host.run(['chown', f'{uid}:{gid}', str(root)])
    # Existing nonempty directories and their ownership are left for runtime
    # identity validation; adoption and migration are never implicit here.


def activate(host, uid, gid, target, values, manifest, version):
    unit = ('[Unit]\nDescription=dsh-phalanx community platform\nAfter=network-online.target\n\n[Service]\nType=simple\n'+
            f'EnvironmentFile={CONFIG}\nWorkingDirectory={HOME_DIR}\nExecStart={CURRENT}/start\n'+
            'Restart=on-failure\nRestartSec=2\nTimeoutStopSec=45\nKillMode=control-group\nDelegate=yes\nUMask=0077\n\n[Install]\nWantedBy=default.target\n')
    old_config = host.path(CONFIG).read_text() if host.path(CONFIG).exists() else None
    old_unit = host.path(UNIT).read_text() if host.path(UNIT).exists() else None
    current = host.path(CURRENT)
    if current.exists() and not current.is_symlink():
        raise InstallError("Current release path must be an installer-managed symlink")
    previous = os.readlink(current) if current.is_symlink() else None
    persisted = dict(values)
    if old_config is not None and 'DSH_PHALANX_CONTAINER_GATEWAY_PORT=' not in old_config and installed_state(host) and values['DSH_PHALANX_CONTAINER_GATEWAY_PORT'] == '3081':
        persisted.pop('DSH_PHALANX_CONTAINER_GATEWAY_PORT')
    text = environment_text(persisted)
    active = host.user(uid, ["systemctl", "--user", "is-active", "--quiet", "dsh-phalanx.service"], check=False).returncode == 0
    unchanged = previous == str(host.path(target)) and old_config == text and old_unit == unit
    if not unchanged or not active:
        host.mkdir("/etc/dsh-phalanx", 0o750)
        host.atomic(CONFIG, text, 0o640)
        host.run(["chown", f"0:{gid}", str(host.path("/etc/dsh-phalanx")), str(host.path(CONFIG))])
        host.atomic(UNIT, unit, 0o644)
        host.run(["chown", "-R", f"{uid}:{gid}", str(host.path(HOME_DIR+"/.config/systemd"))])
        replacement = host.path(CURRENT+".next")
        replacement.unlink(missing_ok=True)
        replacement.symlink_to(host.path(target))
        try:
            host.user(uid, ["systemctl", "--user", "daemon-reload"])
            host.user(uid, ["systemctl", "--user", "stop", "dsh-phalanx.service"])
            os.replace(replacement, current)
            host.user(uid, ["systemctl", "--user", "enable", "--now", "dsh-phalanx.service"])
            host.ready(uid, int(values["DSH_PHALANX_PORT"]), values["DSH_PHALANX_HOST"], values["DSH_PHALANX_PUBLIC_ORIGIN"])
        except (InstallError, OSError):
            replacement.unlink(missing_ok=True)
            host.user(uid, ["systemctl", "--user", "stop", "dsh-phalanx.service"])
            if previous is not None:
                current.unlink(missing_ok=True)
                current.symlink_to(previous)
                if old_config is not None:
                    host.atomic(CONFIG, old_config, 0o640)
                    host.run(["chown", f"0:{gid}", str(host.path(CONFIG))])
                if old_unit is not None:
                    host.atomic(UNIT, old_unit, 0o644)
                host.user(uid, ["systemctl", "--user", "daemon-reload"])
                host.user(uid, ["systemctl", "--user", "start", "dsh-phalanx.service"])
            else:
                host.user(uid, ["systemctl", "--user", "disable", "dsh-phalanx.service"], check=False)
                current.unlink(missing_ok=True)
            raise
    else:
        host.ready(uid, int(values["DSH_PHALANX_PORT"]), values["DSH_PHALANX_HOST"], values["DSH_PHALANX_PUBLIC_ORIGIN"])
    receipt = {"status": "installed", "version": version, "candidate": manifest["tag"], "commit": manifest["commit"],
               "platformSha256": manifest["files"][ASSETS[0]], "imageDigest": manifest["image"]["digest"], "serviceUser": ACCOUNT,
               "configuration": CONFIG, "entry": values["DSH_PHALANX_PUBLIC_ORIGIN"],
               "adminUrl": values["DSH_PHALANX_PUBLIC_ORIGIN"].rstrip('/')+'/admin',
               "bootstrapCredentialFile": HOME_DIR+"/data/bootstrap-credential", "changed": not unchanged}
    link = ''
    if manifest['targetVersion'] != '0.1.0':
        link = host.user(uid, [str(host.path(CURRENT+'/start')), 'bootstrap-link',
                          '--data-root', str(host.path(values['DSH_PHALANX_DATA_ROOT'])),
                          '--origin', values['DSH_PHALANX_PUBLIC_ORIGIN']]).stdout.strip()
    host.atomic(STATE, json.dumps(receipt, indent=2)+"\n")
    host.atomic("/etc/dsh-phalanx/installed-manifest.json", json.dumps(manifest)+"\n")
    host.path('/etc/dsh-phalanx/install-draft').unlink(missing_ok=True)
    # The invitation is operator output only; never persist it in the receipt.
    output = {**receipt, **({'initializationUrl': link} if urllib.parse.urlparse(link).path == '/bootstrap' else {})}
    return output


def main(arguments=None, host=None):
    host = host or Host()
    arguments = sys.argv[1:] if arguments is None else arguments
    output = 'json' if '--output=json' in arguments or any(arguments[i:i+2] == ['--output','json'] for i in range(len(arguments))) else 'human'
    try:
        report = Progress(host.root, output=output, verbose='--verbose' in arguments, persist=host.uid == 0 and host.system == 'Linux' and host.machine == 'x86_64')
    except OSError as error:
        report = Progress(host.root, output=output, persist=False)
        report.failure(error)
        return 1
    host.progress = report
    try:
        with report.stage('Preflight'):
            args = options(arguments)
            if host.system != 'Linux' or host.machine != 'x86_64':
                raise InstallError('Installation supports only Ubuntu 24.04 LTS amd64')
            if host.uid != 0: raise InstallError('Run the installer with sudo')
            release = dict(line.split('=',1) for line in host.path('/etc/os-release').read_text().splitlines() if '=' in line)
            if shlex.split(release.get('ID','')) != ['ubuntu'] or shlex.split(release.get('VERSION_ID','')) != ['24.04']:
                raise InstallError('Installation supports only Ubuntu 24.04 LTS amd64')
        lock = host.mkdir('/run/lock', mode=None)/'dsh-phalanx-install.lock'
        descriptor = os.open(lock, os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor,'w') as file, tempfile.TemporaryDirectory(prefix='dsh-phalanx-download-') as temporary:
            with report.stage('Installation lock'):
                while True:
                    try: fcntl.flock(file, fcntl.LOCK_EX|fcntl.LOCK_NB); break
                    except BlockingIOError:
                        report.emit(message='Waiting for another installer to release the installation lock')
                        host.pause(1)
            if args.upgrade:return upgrade_command(host,args,temporary)
            if host.path('/etc/dsh-phalanx/maintenance').exists():raise InstallError('Interrupted system upgrade; run --upgrade recover before installation')
            with report.stage('Configuration'):
                values=configuration(host,args,entry_url=entry_url,access_candidate=access_candidate)
                report.protect(*(value for key,value in values.items() if key.endswith(('_KEY','_SECRET'))))
            state=installed_state(host)
            if state:
                with report.stage('Release selection'):selected=selected_target(host,args,Path(temporary))
                proposed=selected['manifest']
                if (state['candidate'],state['commit'],state['imageDigest'],state['platformSha256']) != (proposed['tag'],proposed['commit'],proposed['image']['digest'],proposed['files'][ASSETS[0]]):
                    return upgrade_command(host,args,temporary,selected)
            with report.stage('Download and verification'):
                directory,manifest=acquire(host,args,Path(temporary))
            if manifest.get('schema')==2:values['DSH_PHALANX_MAINTENANCE_FILE']='/etc/dsh-phalanx/maintenance'
            values['DSH_PHALANX_CONTAINER_IMAGE']=manifest['image']['reference']
            if state and state['candidate']==manifest['tag'] and state['commit']==manifest['commit'] and state['imageDigest']==manifest['image']['digest']:
                with report.stage('Existing installation'):
                    account=host.run(['getent','passwd',ACCOUNT]).stdout.split(':'); uid,gid=int(account[2]),int(account[3])
                    active=host.user(uid,['systemctl','--user','is-active','--quiet','dsh-phalanx.service'],check=False).returncode==0
                    if not active: raise InstallError('Existing service is not active; inspect or restart its user-systemd unit before retrying')
                    previous='/'+str(host.path(CURRENT).resolve().relative_to(host.root))
                    if host.path(CURRENT+'/.artifact-sha256').read_text()!=state['platformSha256']:
                        raise InstallError('Installed platform identity differs from the successful receipt')
                    command=supply_image(host,uid,directory,manifest,args.bundle_dir is not None)
                    values['DSH_PHALANX_RUNTIME_COMMAND']=command[0]
                    values['DSH_PHALANX_RUNTIME_ARGS_JSON']=json.dumps(command[1:],separators=(',',':'))
                    host.tell('Installed '+state['version']+'; service active; configuration unchanged. Verifying readiness.')
                    receipt=activate(host,uid,gid,previous,values,manifest,state['version'])
            else:
                if state is None: host.atomic('/etc/dsh-phalanx/install-draft',environment_text(values))
                with report.stage('Dependencies'): dependencies(host)
                with report.stage('Identity and directories'):
                    uid,gid=identity(host); prepare_user_storage(host,uid,gid,values)
                with report.stage('Platform verification and staging'): target=stage_platform(host,directory,manifest)
                with report.stage('Runtime image'):
                    command=supply_image(host,uid,directory,manifest,args.bundle_dir is not None)
                    values['DSH_PHALANX_RUNTIME_COMMAND']=command[0]
                    values['DSH_PHALANX_RUNTIME_ARGS_JSON']=json.dumps(command[1:],separators=(',',':'))
                with report.stage('Service activation'):
                    receipt=activate(host,uid,gid,target,values,manifest,args.version if args.version!='latest' else 'v'+manifest['targetVersion'])
            report.result(receipt,port=values['DSH_PHALANX_PORT'])
        return 0
    except (InstallError,OSError,ValueError,KeyError,TypeError,tarfile.TarError) as error:
        report.failure(error)
        return 1


if __name__ == '__main__': sys.exit(main())
