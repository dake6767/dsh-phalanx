"""The installer filesystem, terminal, socket and operating-system exit."""
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


from installer_config import HOME_DIR  # embedded-config
ACCOUNT = "dsh-phalanx"
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
        headers = {"User-Agent": "dsh-phalanx-installer/0.1.1", **({"Host": authority} if authority else {})}
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

    def tell(self, text):
        print(text, file=sys.stderr)

    def terminal_available(self):
        try:
            with open('/dev/tty', 'r') as terminal:
                return terminal.isatty()
        except OSError:
            return False

    def port_conflict(self, address, port, *, allow_managed=False):
        parsed = ipaddress.ip_address(address)
        if allow_managed:
            account = self.run(['getent', 'passwd', ACCOUNT], check=False)
            if account.returncode == 0:
                uid = int(account.stdout.split(':')[2])
                probe = ipaddress.ip_address('127.0.0.1' if parsed.version == 4 else '::1') if parsed.is_unspecified else parsed
                if self.listener_pid(uid, port, probe):
                    return None
        with socket.socket(socket.AF_INET if parsed.version == 4 else socket.AF_INET6) as listener:
            try:
                listener.bind((address, port))
            except OSError as error:
                if error.errno == errno.EADDRINUSE:
                    info = self.run(['ss', '-ltnp', f'sport = :{port}'], check=False)
                    return 'port occupied; '+info.stdout.strip()[:1000]
                return 'cannot bind requested address/port (errno '+str(error.errno)+')'
        return None

    def prompt(self, label, secret=False):
        try:
            with open("/dev/tty", "r") as terminal, open("/dev/tty", "w") as display:
                if secret:
                    return getpass.getpass(label, stream=display)
                display.write(label)
                display.flush()
                return terminal.readline().strip()
        except OSError:
            raise InstallError("No terminal available; provide --public-origin and --host-public-addresses")

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


