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
import http.client
import urllib.request
import urllib.error
import urllib.parse
import fcntl
import contextlib
import shutil
import socket
import errno
import selectors
from installer_progress import Progress  # embedded-progress


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
        self.injected_command = command is not None
        self.progress = None
        self.system = system or platform.system()
        self.machine = machine or platform.machine()
        self.uid = os.geteuid() if uid is None else uid
        self.clock = time.monotonic
        self.pause = time.sleep

    def path(self, path):
        return self.root / str(path).lstrip("/")

    def run(self, arguments, *, check=True, input_file=None, env=None, cwd=None):
        sensitive = 'bootstrap-link' in arguments
        streaming = not sensitive and (arguments[0] == 'apt-get' or 'pull' in arguments or 'load' in arguments or (self.progress and self.progress.verbose))
        if self.progress and self.progress.verbose:
            self.progress.emit('detail', message='Command: '+shlex.join(arguments))
        if self.progress and not sensitive:
            action = 'Fetching instance image' if 'pull' in arguments else 'Loading instance image' if 'load' in arguments else 'Running '+Path(arguments[0]).name
            self.progress.emit(message=action, action=action)
        with contextlib.ExitStack() as stack:
            source = stack.enter_context(input_file.open('rb')) if input_file else None
            if self.injected_command:
                result = self.command(arguments, capture_output=True, text=True, stdin=source, env=env, cwd=cwd)
                if self.progress and streaming:
                    for line in (result.stdout+result.stderr).splitlines(): self.progress.emit('detail', message=line)
            else:
                process = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=source or subprocess.DEVNULL, env=env, cwd=cwd)
                captured = {'out':[], 'err':[]}; pending = {'out':b'', 'err':b''}
                try:
                    with selectors.DefaultSelector() as selector:
                        for stream,key in ((process.stdout,'out'),(process.stderr,'err')): selector.register(stream, selectors.EVENT_READ, key)
                        while selector.get_map():
                            for selected,_ in selector.select(1):
                                key=selected.data; chunk=os.read(selected.fileobj.fileno(), 65536)
                                if not chunk:
                                    selector.unregister(selected.fileobj)
                                    if pending[key] and streaming and self.progress: self.progress.emit('detail', message=pending[key].decode(errors='replace'))
                                    continue
                                captured[key].append(chunk); pending[key]+=chunk
                                while b'\n' in pending[key] or b'\r' in pending[key]:
                                    match=re.search(b'[\r\n]',pending[key]); line=pending[key][:match.start()]; pending[key]=pending[key][match.end():]
                                    if streaming and self.progress: self.progress.emit('detail', message=line.decode(errors='replace'))
                    result=subprocess.CompletedProcess(arguments, process.wait(), b''.join(captured['out']).decode(errors='replace'), b''.join(captured['err']).decode(errors='replace'))
                finally:
                    if process.poll() is None: process.terminate(); process.wait()
                    process.stdout.close(); process.stderr.close()
        if check and result.returncode != 0:
            raise InstallError(f"{arguments[0]} failed (exit {result.returncode}): {result.stderr[:1500]}")
        return result

    def request(self, url, *, authority=None, socket_mark=None):
        headers = {'User-Agent':'dsh-phalanx-installer/0.1.2', **({'Host':authority} if authority else {})}
        request=urllib.request.Request(url,headers=headers)
        handlers=[urllib.request.ProxyHandler({})] if authority else []
        if socket_mark is not None:
            class ReadinessConnection(http.client.HTTPConnection):
                def connect(connection):
                    address=ipaddress.ip_address(connection.host)
                    connection.sock=socket.socket(socket.AF_INET if address.version==4 else socket.AF_INET6,socket.SOCK_STREAM)
                    connection.sock.settimeout(connection.timeout)
                    connection.sock.setsockopt(socket.SOL_SOCKET,36,socket_mark)  # Linux SO_MARK; root-owned probe only
                    connection.sock.connect((str(address),connection.port))
            class ReadinessHandler(urllib.request.HTTPHandler):
                def http_open(handler,request):return handler.do_open(ReadinessConnection,request)
            handlers.append(ReadinessHandler())
        opener=urllib.request.build_opener(*handlers)
        with opener.open(request,timeout=60) as response:
            chunks=[]; received=0; total=int(response.headers.get('Content-Length','0') or '0')
            while True:
                block=response.read(65536)
                if not block: break
                chunks.append(block); received+=len(block)
                if self.progress and authority is None: self.progress.emit(message='Downloaded', action='Downloading release data', bytes=received, total=total or None)
            return b''.join(chunks)

    def mkdir(self, path, mode=0o755):
        destination = self.path(path)
        for parent in (destination, *destination.parents):
            if parent.is_symlink():
                raise InstallError("Installation paths must not contain symbolic links")
            if parent == self.root:
                break
        missing=[]; cursor=destination
        while not cursor.exists():missing.append(cursor); cursor=cursor.parent
        destination.mkdir(parents=True, mode=0o755 if mode is None else mode, exist_ok=True)
        for created in reversed(missing):self.sync_directory(created.parent)
        if mode is not None:
            destination.chmod(mode)
        return destination

    def sync_directory(self,path):
        descriptor=os.open(path,os.O_RDONLY | getattr(os,'O_DIRECTORY',0))
        try:os.fsync(descriptor)
        finally:os.close(descriptor)

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
            self.sync_directory(destination.parent)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def user(self, uid, arguments, **kwargs):
        environment = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", "HOME": HOME_DIR, "XDG_RUNTIME_DIR": f"/run/user/{uid}",
                       "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{uid}/bus"}
        return self.run(["runuser", "-u", ACCOUNT, "--", *arguments], env=environment, cwd=self.path(HOME_DIR), **kwargs)

    def tell(self, text):
        self.progress.emit('info', message=text) if self.progress else print(text, file=sys.stderr)

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
            # Match the managed TCP server: closed connections in TIME_WAIT
            # do not reserve a port; an active unrelated listener still does.
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
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
            with (self.progress.input() if self.progress else contextlib.nullcontext()), open("/dev/tty", "r") as terminal, open("/dev/tty", "w") as display:
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

    def ready(self, uid, port, listen_address, public_origin, *, path="/login", socket_mark=None):
        entry = entry_url(port, listen_address)
        address = ipaddress.ip_address(urllib.parse.urlparse(entry).hostname)
        public = urllib.parse.urlparse(public_origin)
        hostname = ipaddress.ip_address(public.hostname).compressed if ":" in public.hostname else public.hostname.encode("idna").decode("ascii")
        authority = f"[{hostname}]" if ":" in hostname else hostname
        if public.port is not None and public.port != {"http": 80, "https": 443}[public.scheme]:
            authority += f":{public.port}"
        deadline = self.clock()+90
        http_failed = False
        while True:
            pid = 0
            try:
                pid = self.listener_pid(uid, port, address)
                if pid:
                    self.request(entry+path, authority=authority, **({"socket_mark":socket_mark} if socket_mark is not None else {}))
                    if self.listener_pid(uid, port, address) == pid:
                        return
            except OSError:
                http_failed = bool(pid)
            if self.clock() >= deadline:
                details=self.user(uid, ['systemctl','--user','show','dsh-phalanx.service','--property=ActiveState,SubState,ExecMainStatus,MainPID'], check=False)
                journal=self.run(['journalctl','_SYSTEMD_USER_UNIT=dsh-phalanx.service',f'_UID={uid}','-n','40','--no-pager'], check=False)
                if self.progress:
                    self.progress.emit(message='Service facts: '+details.stdout)
                    for line in journal.stdout.splitlines(): self.progress.emit('detail', message=line)
                conflict = self.port_conflict(listen_address, port, allow_managed=True)
                if conflict:
                    raise InstallError(f'Entry port {port} cannot be bound by the managed service: {conflict}. No occupying process was stopped.')
                status = self.user(uid, ['systemctl','--user','show','--property=ExecMainStatus','--value','dsh-phalanx.service'],check=False)
                exit_status = int(status.stdout.strip() or '0') if status.returncode == 0 else 0
                if exit_status:
                    raise InstallError(f'Managed service process exited with status {exit_status}; inspect the service journal above.')
                if http_failed:
                    raise InstallError('Managed listener was found but HTTP readiness failed; inspect the service journal above.')
                raise InstallError('Managed service did not own a ready listener; root cause is unknown. Inspect service facts and journal above.')
            if self.progress: self.progress.emit(message="Waiting for the managed process to own a ready HTTP listener")
            self.pause(1)


