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

ACCOUNT = "dsh-phalanx"
HOME_DIR = "/var/lib/dsh-phalanx"
CONFIG = "/etc/dsh-phalanx/environment"
STATE = "/etc/dsh-phalanx/install-state.json"
CURRENT = "/opt/dsh-phalanx/current"
UNIT = HOME_DIR+"/.config/systemd/user/dsh-phalanx.service"
PACKAGES = ("podman", "uidmap", "passt", "fuse-overlayfs", "dbus-user-session", "apparmor", "apparmor-utils")

IMAGE = "ghcr.io/dake6767/dsh-phalanx"
ASSETS = ("dsh-phalanx-linux-amd64.tar.gz", "dsh-phalanx-dsh-linux-amd64.oci.tar")
CANDIDATE = re.compile(r"v0\.1\.0-rc\.[1-9][0-9]*\Z")


def entry_url(port, listen_address):
    address = ipaddress.ip_address(listen_address)
    if address.is_unspecified:
        address = ipaddress.ip_address("127.0.0.1" if address.version == 4 else "::1")
    entry = str(address) if address.version == 4 else f"[{address}]"
    return f"http://{entry}:{port}"


class InstallError(Exception):
    pass


class Host:
    def __init__(self, root=Path("/"), command=None, *, system=None, machine=None, uid=None):
        self.root = root.resolve()
        self.command = command or subprocess.run
        self.system = system or platform.system()
        self.machine = machine or platform.machine()
        self.uid = os.geteuid() if uid is None else uid
        self.clock = time.monotonic
        self.pause = time.sleep

    def path(self, path):
        return self.root / str(path).lstrip("/")

    def run(self, arguments, *, check=True, input_file=None, env=None, cwd=None):
        with contextlib.ExitStack() as stack:
            source = stack.enter_context(input_file.open("rb")) if input_file else None
            result = self.command(arguments, capture_output=True, text=True, stdin=source, env=env, cwd=cwd)
        if check and result.returncode != 0:
            raise InstallError(f"{arguments[0]} failed (exit {result.returncode}): {result.stderr[:1500]}")
        return result

    def request(self, url, *, authority=None):
        headers = {"User-Agent": "dsh-phalanx-installer/0.1.0", **({"Host": authority} if authority else {})}
        request = urllib.request.Request(url, headers=headers)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({})) if authority else urllib.request.build_opener()
        with opener.open(request, timeout=60) as response:
            return response.read()

    def mkdir(self, path, mode=0o755):
        destination = self.path(path)
        for parent in (destination, *destination.parents):
            if parent.is_symlink():
                raise InstallError("Installation paths must not contain symbolic links")
            if parent == self.root:
                break
        destination.mkdir(parents=True, mode=0o755 if mode is None else mode, exist_ok=True)
        if mode is not None:
            destination.chmod(mode)
        return destination

    def atomic(self, path, text, mode=0o600):
        destination = self.path(path)
        if destination.is_symlink():
            raise InstallError("Managed configuration must not be a symbolic link")
        self.mkdir(str(Path(path).parent), mode=None)
        descriptor, temporary = tempfile.mkstemp(prefix=".install-", dir=destination.parent)
        try:
            with os.fdopen(descriptor, "w") as file:
                os.fchmod(file.fileno(), mode)
                file.write(text)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, destination)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def user(self, uid, arguments, **kwargs):
        environment = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", "HOME": HOME_DIR, "XDG_RUNTIME_DIR": f"/run/user/{uid}",
                       "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{uid}/bus"}
        return self.run(["runuser", "-u", ACCOUNT, "--", *arguments], env=environment, cwd=self.path(HOME_DIR), **kwargs)

    def prompt(self, label, secret=False):
        try:
            with open("/dev/tty", "r+") as terminal:
                if secret:
                    return getpass.getpass(label, stream=terminal)
                terminal.write(label)
                terminal.flush()
                return terminal.readline().strip()
        except OSError:
            raise InstallError("No terminal available; provide --model-key-file and --host-public-addresses")

    def listener_pid(self, uid, port, address):
        result = self.user(uid, ["systemctl", "--user", "show", "--property=MainPID", "--value", "dsh-phalanx.service"], check=False)
        if result.returncode != 0:
            return 0
        pid = int(result.stdout.strip() or "0")
        try:
            sockets = {os.readlink(file) for file in self.path(f"/proc/{pid}/fd").iterdir()}
            packed = address.packed
            encoded = (packed[::-1] if address.version == 4 else b"".join(packed[index:index+4][::-1] for index in range(0, 16, 4))).hex().upper()
            table = self.path("/proc/net/tcp"+("6" if address.version == 6 else ""))
            for line in table.read_text().splitlines()[1:]:
                fields = line.split()
                local, number = fields[1].split(":")
                if fields[3] == "0A" and int(number, 16) == port and local in (encoded, "0"*len(encoded)) and f"socket:[{fields[9]}]" in sockets:
                    return pid
        except OSError:
            pass
        return 0

    def ready(self, uid, port, listen_address, public_origin):
        entry = entry_url(port, listen_address)
        address = ipaddress.ip_address(urllib.parse.urlparse(entry).hostname)
        public = urllib.parse.urlparse(public_origin)
        hostname = ipaddress.ip_address(public.hostname).compressed if ":" in public.hostname else public.hostname.encode("idna").decode("ascii")
        authority = f"[{hostname}]" if ":" in hostname else hostname
        if public.port is not None and public.port != {"http": 80, "https": 443}[public.scheme]:
            authority += f":{public.port}"
        deadline = self.clock()+90
        while True:
            try:
                pid = self.listener_pid(uid, port, address)
                if pid:
                    self.request(entry+"/login", authority=authority)
                    if self.listener_pid(uid, port, address) == pid:
                        return
            except OSError:
                pass
            if self.clock() >= deadline:
                raise InstallError("Managed service did not own a ready listener; inspect its user-systemd journal")
            self.pause(1)


def options(arguments):
    parser = argparse.ArgumentParser(description="Install dsh-phalanx on Ubuntu 24.04 amd64")
    parser.add_argument("--version", default="latest")
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
    return parser.parse_args(arguments)


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024*1024), b""):
            result.update(block)
    return result.hexdigest()


def verify_manifest(directory, version, archive=True):
    manifest = json.loads((directory / "manifest.json").read_text())
    image = manifest.get("image", {})
    files = manifest.get("files", {})
    if (manifest.get("schema") != 1 or not CANDIDATE.fullmatch(manifest.get("tag", "")) or
            manifest.get("targetVersion") != "0.1.0" or manifest.get("platform") != "linux/amd64" or
            not re.fullmatch(r"[a-f0-9]{40}", manifest.get("commit", "")) or
            not re.fullmatch(r"[a-f0-9]{40}", manifest.get("dshRevision", "")) or
            not re.fullmatch(r"[1-9][0-9]*", manifest.get("runId", "")) or
            image.get("name") != IMAGE or image.get("tag") != manifest["tag"][1:] or
            not re.fullmatch(r"sha256:[a-f0-9]{64}", image.get("digest", "")) or
            image.get("reference") != IMAGE+"@"+image["digest"] or
            set(files) != set(ASSETS) or
            any(not re.fullmatch(r"[a-f0-9]{64}", value) for value in files.values()) or
            not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", manifest.get("toolchain", {}).get("node", ""))):
        raise InstallError("Invalid release manifest")
    if version != manifest["tag"] and version != "v"+manifest["targetVersion"]:
        raise InstallError("Requested version does not match the manifest")
    expected = "".join(f"{files[name]}  {name}\n" for name in ASSETS)
    if (directory / "SHA256SUMS").read_text() != expected:
        raise InstallError("Checksum inventory mismatch")
    for name in ASSETS if archive else ASSETS[:1]:
        file = directory / name
        if file.is_symlink() or not file.is_file() or digest(file) != files[name]:
            raise InstallError(f"Checksum mismatch: {name}")
    return manifest


def acquire(host, args, destination):
    if args.bundle_dir is not None:
        if not CANDIDATE.fullmatch(args.version):
            raise InstallError("Private archive handoff requires an explicit candidate version")
        return args.bundle_dir, verify_manifest(args.bundle_dir, args.version)
    api = "https://api.github.com/repos/dake6767/dsh-phalanx"
    if args.version != "latest" and args.version != "v0.1.0" and not CANDIDATE.fullmatch(args.version):
        raise InstallError("Specify latest, v0.1.0, or an explicit candidate tag")
    release = json.loads(host.request(api+"/releases/"+("latest" if args.version == "latest" else "tags/"+args.version)))
    version = release.get("tag_name")
    if release.get("draft") or (version == "v0.1.0" and release.get("prerelease")) or (args.version == "latest" and version != "v0.1.0"):
        raise InstallError("Latest installation requires a completed stable release")
    if args.version != "latest" and version != args.version:
        raise InstallError("Release identity mismatch")
    required = {"manifest.json", "SHA256SUMS", *ASSETS}
    if version == "v0.1.0":
        required.update(("acceptance.json", "acceptance.md", "release.json"))
    if len(release["assets"]) != len(required) or {item["name"] for item in release["assets"]} != required:
        raise InstallError("Release asset inventory is incomplete or unexpected")
    base = f"https://github.com/dake6767/dsh-phalanx/releases/download/{version}/"
    for name in ("manifest.json", "SHA256SUMS", ASSETS[0]):
        (destination / name).write_bytes(host.request(base+name))
    manifest = verify_manifest(destination, version, archive=False)
    reference = json.loads(host.request(api+"/git/ref/tags/"+version))["object"]
    for _ in range(4):
        if reference["type"] == "commit":
            break
        if reference["type"] != "tag":
            raise InstallError("Release tag must identify a commit")
        reference = json.loads(host.request(api+"/git/tags/"+reference["sha"]))["object"]
    if reference["type"] != "commit" or reference["sha"] != manifest["commit"]:
        raise InstallError("Release tag and manifest source commit differ")
    return destination, manifest


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


def supply_image(host, uid, directory, manifest, archive):
    reference = manifest["image"]["reference"]
    present = host.user(uid, ["podman", "image", "exists", reference], check=False)
    if present.returncode == 1:
        if archive:
            host.user(uid, ["podman", "load"], input_file=directory / ASSETS[1])
            ids = host.user(uid, ["podman", "images", "--filter", "label=org.opencontainers.image.revision="+manifest["commit"], "--format", "{{.ID}}"]).stdout.splitlines()
            matches = []
            for image_id in set(ids):
                facts = json.loads(host.user(uid, ["podman", "image", "inspect", image_id]).stdout)[0]
                if facts["Digest"] == manifest["image"]["digest"]:
                    matches.append(image_id)
            if len(matches) != 1:
                raise InstallError("Archive did not supply exactly one matching candidate image")
            host.user(uid, ["podman", "tag", matches[0], IMAGE+":"+manifest["image"]["tag"]])
        else:
            host.user(uid, ["podman", "pull", reference])
    elif present.returncode != 0:
        raise InstallError("Cannot inspect rootless image storage")
    image = json.loads(host.user(uid, ["podman", "image", "inspect", reference]).stdout)[0]
    config = image["Config"]
    if (image["Digest"] != manifest["image"]["digest"] or image["Architecture"] != "amd64" or image["Os"] != "linux" or
            config["User"] != "node" or config["Labels"].get("dsh.revision") != manifest["dshRevision"] or
            config["Labels"].get("org.opencontainers.image.revision") != manifest["commit"]):
        raise InstallError("Imported/pulled image identity does not match this platform release")
    command = config.get("Cmd")
    if not isinstance(command, list) or len(command) < 2 or not all(isinstance(part, str) and part for part in command):
        raise InstallError("Image does not declare its official runtime command")
    return command


def stage_platform(host, directory, manifest):
    sha = manifest["files"][ASSETS[0]]
    target = f'/opt/dsh-phalanx/releases/{manifest["tag"]}-{sha[:16]}'
    host.mkdir("/opt/dsh-phalanx")
    releases = host.mkdir("/opt/dsh-phalanx/releases")
    if not host.path(target).exists():
        with tempfile.TemporaryDirectory(prefix=".install-", dir=releases) as temporary:
            with tarfile.open(directory / ASSETS[0], "r:gz") as archive:
                archive.extractall(temporary, filter="data")
            staging = Path(temporary)
            for name in ("start", "node/bin/node", "dist/composition/cli.js", "admin-ui/dist/community.html"):
                if not (staging / name).is_file():
                    raise InstallError("Platform archive lacks required runtime assets")
            build = json.loads((staging / "build-info.json").read_text())
            if build.get("commit") != manifest["commit"] or build.get("platform") != "linux/amd64":
                raise InstallError("Packaged product identity mismatch")
            node = host.run([str(staging / "node/bin/node"), "--version"]).stdout.strip()
            if node != "v"+manifest["toolchain"]["node"]:
                raise InstallError("Bundled Node identity mismatch")
            (staging / ".artifact-sha256").write_text(sha)
            staging.chmod(0o755)
            os.rename(staging, host.path(target))
    if host.path(target+"/.artifact-sha256").read_text() != sha:
        raise InstallError("Existing release directory has a conflicting identity")
    root = host.path(target)
    for path in (root, *root.rglob("*")):
        if not path.is_symlink():
            path.chmod(0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)
    return target


def environment_text(values):
    return "".join(f'{key}="'+value.replace("\\", "\\\\").replace('"', '\\"')+'"\n' for key, value in sorted(values.items()))


def configuration(host, args, manifest):
    exists = host.path(CONFIG).exists()
    values = dict(line.split("=", 1) for line in host.path(CONFIG).read_text().splitlines()) if exists else {}
    if exists:
        values = {key: shlex.split(value)[0] for key, value in values.items()}
    names = {"model_base_url": "MODEL_UPSTREAM_BASE_URL", "model_provider": "ALLOWED_MODEL_PROVIDER", "model": "ALLOWED_MODEL", "listen_address": "HOST", "port": "PORT", "gateway_port": "CONTAINER_GATEWAY_PORT", "public_origin": "PUBLIC_ORIGIN", "host_public_addresses": "HOST_PUBLIC_ADDRESSES"}
    for option, key in names.items():
        value = getattr(args, option)
        if value is not None:
            name = "DSH_PHALANX_"+key
            if exists and values.get(name, "") != str(value):
                raise InstallError("Existing deployment configuration differs; edit its protected file explicitly")
            values[name] = str(value)
    if not exists:
        if args.host_public_addresses is None:
            values["DSH_PHALANX_HOST_PUBLIC_ADDRESSES"] = host.prompt("All public IPv4 host aliases, comma-separated (empty if none): ")
        if args.model_key_file and (args.model_key_file.is_symlink() or not args.model_key_file.is_file() or args.model_key_file.stat().st_mode & 0o077):
            raise InstallError("Model key file must be a regular protected file (mode 0600)")
        key = args.model_key_file.read_text().rstrip("\r\n") if args.model_key_file else host.prompt("Default model upstream API key: ", secret=True)
        if not key or any(ord(char) < 32 or ord(char) > 126 for char in key):
            raise InstallError("A nonempty printable upstream credential is required")
        values.update({"DSH_PHALANX_SESSION_SECRET": secrets.token_hex(32), "DSH_PHALANX_MODEL_UPSTREAM_API_KEY": key,
                       "DSH_PHALANX_DATA_ROOT": HOME_DIR+"/data", "DSH_PHALANX_CONTAINER_RUNTIME": "/usr/bin/podman",
                       "DSH_PHALANX_REGISTRATION_ENABLED": "false"})
        for name, default in {"HOST": "127.0.0.1", "PORT": "18080", "ALLOWED_MODEL_PROVIDER": "deepseek-official", "ALLOWED_MODEL": "deepseek-chat", "MODEL_UPSTREAM_BASE_URL": "https://api.deepseek.com"}.items():
            values.setdefault("DSH_PHALANX_"+name, default)
    for address in filter(None, values["DSH_PHALANX_HOST_PUBLIC_ADDRESSES"].split(",")):
        if not ipaddress.IPv4Address(address).is_global:
            raise InstallError("Host aliases must be public IPv4 literals")
    if not 1 <= int(values["DSH_PHALANX_PORT"]) <= 65535 or any("\n" in value or "\r" in value or "\0" in value for value in values.values()):
        raise InstallError("Invalid deployment configuration")
    if not 1 <= int(values.get("DSH_PHALANX_CONTAINER_GATEWAY_PORT", "3081")) <= 65535:
        raise InstallError("Private gateway port must be between 1 and 65535")
    ipaddress.ip_address(values["DSH_PHALANX_HOST"])
    values.setdefault("DSH_PHALANX_PUBLIC_ORIGIN", entry_url(values["DSH_PHALANX_PORT"], values["DSH_PHALANX_HOST"]))
    origin = urllib.parse.urlparse(values["DSH_PHALANX_PUBLIC_ORIGIN"])
    if origin.scheme not in ("http", "https") or not origin.hostname or origin.username or origin.password or origin.path not in ("", "/") or origin.query or origin.fragment:
        raise InstallError("Public origin must be an HTTP(S) origin without credentials or path")
    _ = origin.port
    upstream = urllib.parse.urlparse(values["DSH_PHALANX_MODEL_UPSTREAM_BASE_URL"])
    if upstream.scheme not in ("http", "https") or not upstream.hostname or upstream.username or upstream.password:
        raise InstallError("Model upstream must be an HTTP(S) URL without embedded credentials")
    values["DSH_PHALANX_CONTAINER_IMAGE"] = manifest["image"]["reference"]
    return values


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
    text = environment_text(values)
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
               "bootstrapCredentialFile": HOME_DIR+"/data/bootstrap-credential", "changed": not unchanged}
    host.atomic(STATE, json.dumps(receipt, indent=2)+"\n")
    print(json.dumps(receipt))


def main(arguments=None, host=None):
    host = host or Host()
    if host.system != "Linux" or host.machine != "x86_64":
        print("Installation supports only Ubuntu 24.04 LTS amd64", file=sys.stderr)
        return 1
    try:
        if host.uid != 0:
            raise InstallError("Run the installer with sudo")
        release = dict(line.split("=", 1) for line in host.path("/etc/os-release").read_text().splitlines() if "=" in line)
        if shlex.split(release.get("ID", "")) != ["ubuntu"] or shlex.split(release.get("VERSION_ID", "")) != ["24.04"]:
            raise InstallError("Installation supports only Ubuntu 24.04 LTS amd64")
        args = options(arguments)
        lock = host.mkdir("/run/lock", mode=None) / "dsh-phalanx-install.lock"
        descriptor = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w") as file, tempfile.TemporaryDirectory(prefix="dsh-phalanx-download-") as temporary:
            fcntl.flock(file, fcntl.LOCK_EX)
            directory, manifest = acquire(host, args, Path(temporary))
            values = configuration(host, args, manifest)
            dependencies(host)
            uid, gid = identity(host)
            target = stage_platform(host, directory, manifest)
            command = supply_image(host, uid, directory, manifest, args.bundle_dir is not None)
            values["DSH_PHALANX_RUNTIME_COMMAND"] = command[0]
            values["DSH_PHALANX_RUNTIME_ARGS_JSON"] = json.dumps(command[1:], separators=(",", ":"))
            activate(host, uid, gid, target, values, manifest, args.version if args.version != "latest" else "v0.1.0")
        return 0
    except (InstallError, OSError, ValueError, KeyError, TypeError, tarfile.TarError) as error:
        print(f"Installation failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
