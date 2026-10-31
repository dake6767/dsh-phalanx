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
import functools
import contextlib
import shutil
import socket
import errno
import selectors
import struct
import signal
import base64
from installer_progress import Progress,update_time_point,update_error_code,update_code  # embedded-progress


from installer_config import HOME_DIR, read_configuration, outbound_proxy_environment  # embedded-config
ACCOUNT = "dsh-phalanx"
def entry_url(port, listen_address):
    address = ipaddress.ip_address(listen_address)
    if address.is_unspecified:
        address = ipaddress.ip_address("127.0.0.1" if address.version == 4 else "::1")
    entry = str(address) if address.version == 4 else f"[{address}]"
    return f"http://{entry}:{port}"



class InstallError(Exception):
    def __init__(self,message,*,code='unknown'):
        super().__init__(message);self.code=code


def install_failure(code):
    """Classify an effect without changing exception types or HTTP fallback status."""
    def decorate(work):
        @functools.wraps(work)
        def perform(*args,**kwargs):
            try:return work(*args,**kwargs)
            except Exception as error:
                if update_error_code(error)!='unknown':raise
                if isinstance(error,InstallError):error.code=code
                else:error.system_update_code=code
                raise
        return perform
    return decorate


def proxy_bypass(address, environment):
    if urllib.request.proxy_bypass_environment(address.netloc, {'no':environment.get('NO_PROXY','')}):return True
    try:return ipaddress.ip_address(address.hostname).is_loopback
    except ValueError:return False


class ConfiguredProxyHandler(urllib.request.ProxyHandler):
    """Use the saved exclusions even when the invoking shell has different ones."""
    def __init__(self, environment):
        self.environment=environment
        super().__init__({protocol:environment['HTTPS_PROXY'] for protocol in ('http','https')} if environment.get('HTTPS_PROXY') else {})

    def proxy_open(self, request, proxy, protocol):
        if proxy_bypass(urllib.parse.urlsplit(request.full_url),self.environment):return None
        address=urllib.parse.urlsplit(proxy)
        if address.username is not None:
            credentials=urllib.parse.unquote(address.username)+':'+urllib.parse.unquote(address.password or '')
            request.add_unredirected_header('Proxy-Authorization','Basic '+base64.b64encode(credentials.encode()).decode())
        original=request.type
        request.set_proxy(address.netloc.rsplit('@',1)[-1],address.scheme)
        if original not in (address.scheme,'https'):return self.parent.open(request,timeout=request.timeout)
        return None


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
        self.proxy_environment = {}
        self.image_inspector = None

    def configure_proxy(self):
        self.proxy_environment=outbound_proxy_environment(read_configuration(self))
        if self.progress:
            proxy=self.proxy_environment.get('HTTPS_PROXY','')
            parsed=urllib.parse.urlsplit(proxy)
            self.progress.protect(proxy, parsed.username, parsed.password, urllib.parse.unquote(parsed.username or ''), urllib.parse.unquote(parsed.password or ''))

    def path(self, path):
        return self.root / str(path).lstrip("/")

    def run(self, arguments, *, check=True, input_file=None, env=None, cwd=None, pass_fds=()):
        env={**(os.environ if env is None else env),**self.proxy_environment}
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
                result = self.command(arguments, capture_output=True, text=True, stdin=source, env=env, cwd=cwd, **({'pass_fds':pass_fds} if pass_fds else {}))
                if self.progress and streaming:
                    for line in (result.stdout+result.stderr).splitlines(): self.progress.emit('detail', message=line)
            else:
                process = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=source or subprocess.DEVNULL, env=env, cwd=cwd, pass_fds=pass_fds)
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

    def request(self, url, *, authority=None, socket_mark=None, max_bytes=None):
        category = None
        if authority is None:
            address = urllib.parse.urlsplit(url)
            if address.scheme == 'https' and (address.netloc == 'raw.githubusercontent.com' or
                    address.netloc == 'github.com' and ('/releases/download/' in address.path or '/releases/latest/download/' in address.path)):
                category = ('githubAssets', 'GitHub assets', '--github-proxy-prefix')
            if category:
                url = getattr(self, 'download_sources', {}).get(category[0], '') + url
        headers = {'User-Agent':'dsh-phalanx-installer/0.1.2', **({'Host':authority} if authority else {})}
        request=urllib.request.Request(url,headers=headers)
        address=urllib.parse.urlsplit(url)
        bypass=bool(authority) or proxy_bypass(address,self.proxy_environment)
        handlers=[urllib.request.ProxyHandler({}) if authority else ConfiguredProxyHandler(self.proxy_environment)]
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
        try:
            with opener.open(request,timeout=60) as response:
                chunks=[]; received=0; total=int(response.headers.get('Content-Length','0') or '0')
                while True:
                    block=response.read(65536)
                    if not block: break
                    received+=len(block)
                    if max_bytes is not None and received>max_bytes:raise InstallError("Release metadata exceeds its bounded size",code='release.metadata-invalid')
                    chunks.append(block)
                    if self.progress and authority is None: self.progress.emit(message='Downloaded', action='Downloading release data', bytes=received, total=total or None)
                return b''.join(chunks)
        except (OSError, http.client.HTTPException) as error:
            if self.proxy_environment.get('HTTPS_PROXY') and not bypass:
                raise InstallError('HTTPS proxy connection failed; check HTTPS_PROXY, NO_PROXY and the proxy service. '+(self.progress.safe(str(error)) if self.progress else 'Request failed')) from error
            if category:
                raise InstallError(category[1]+' download failed at '+url+'. Change Download sources in System settings, '+category[2]+', or --download-source-preset official. '+str(error)) from error
            raise

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

    def user_environment(self, uid):
        return {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", "HOME": HOME_DIR, "XDG_RUNTIME_DIR": f"/run/user/{uid}",
                "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{uid}/bus"}

    def user(self, uid, arguments, **kwargs):
        return self.run(["runuser", "-u", ACCOUNT, "--", *arguments], env=self.user_environment(uid), cwd=self.path(HOME_DIR), **kwargs)

    def time_point(self):
        point=update_time_point();point['mono']=self.clock()
        try:point['boot']=self.path('/proc/sys/kernel/random/boot_id').read_text().strip() or None
        except OSError:pass
        return point

    def file_identity(self, path):
        path=Path(path);info=path.lstat()
        if path.is_symlink() or not path.is_file():raise InstallError('Facts require an independent protected file')
        return {'path':str(path),'device':str(info.st_dev),'inode':str(info.st_ino),'size':str(info.st_size),
                'modified':str(info.st_mtime_ns),'changed':str(info.st_ctime_ns)}

    def cli_image(self, uid, reference):
        return json.loads(self.user(uid,['podman','image','inspect',reference]).stdout)[0]

    def inspect_image(self, uid, reference):
        return self.image_inspector(self,uid,reference) if self.image_inspector else self.cli_image(uid,reference)

    def open_image_inspector(self, uid):
        return OwnedImageInspector(self,uid)

    def tell(self, text, **facts):
        self.progress.emit('info', message=text, **facts) if self.progress else print(text, file=sys.stderr)

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
        return pid if self.pid_owns_listener(pid, port, address) else 0

    def pid_owns_listener(self, pid, port, address):
        return self.listener_file(pid,port,address) is not None

    def listener_file(self, pid, port, address):
        if not pid: return None
        try:
            sockets = {}
            for file in self.path(f"/proc/{pid}/fd").iterdir():
                try:sockets[os.readlink(file)]=int(file.name)
                except FileNotFoundError:continue
            packed = address.packed
            encoded = (packed[::-1] if address.version == 4 else b"".join(packed[index:index+4][::-1] for index in range(0, 16, 4))).hex().upper()
            table = self.path("/proc/net/tcp"+("6" if address.version == 6 else ""))
            for line in table.read_text().splitlines()[1:]:
                fields = line.split()
                local, number = fields[1].split(":")
                if fields[3] == "0A" and int(number, 16) == port and local in (encoded, "0"*len(encoded)) and f"socket:[{fields[9]}]" in sockets:
                    return {'fd':sockets[f"socket:[{fields[9]}]"],'inode':int(fields[9])}
        except OSError:
            pass
        return None

    @install_failure('service.start-failed')
    def ready(self, uid, port, listen_address, public_origin, *, path="/login", socket_mark=None, timeout=90, on_listener=None):
        entry = entry_url(port, listen_address)
        address = ipaddress.ip_address(urllib.parse.urlparse(entry).hostname)
        public = urllib.parse.urlparse(public_origin)
        hostname = ipaddress.ip_address(public.hostname).compressed if ":" in public.hostname else public.hostname.encode("idna").decode("ascii")
        authority = f"[{hostname}]" if ":" in hostname else hostname
        if public.port is not None and public.port != {"http": 80, "https": 443}[public.scheme]:
            authority += f":{public.port}"
        deadline = self.clock()+timeout
        http_failed = False
        while True:
            pid = 0
            try:
                pid = self.listener_pid(uid, port, address)
                if pid:
                    if on_listener is not None: on_listener(pid)
                    self.request(entry+path, authority=authority, **({"socket_mark":socket_mark} if socket_mark is not None else {}))
                    if self.listener_pid(uid, port, address) == pid:
                        return
            except urllib.error.HTTPError as error:
                try:
                    if path=='/readyz' and error.code==503 and error.headers and error.headers.get('Content-Type','').split(';',1)[0].strip().lower()=='application/json':
                        try:
                            body=error.read(4097)
                            failure=json.loads(body) if len(body)<=4096 else None
                        except (OSError,ValueError,http.client.HTTPException):failure=None
                        if isinstance(failure,dict) and failure.get('code')=='platform-configuration-unavailable':
                            raise InstallError('Managed platform configuration requires recovery; the selected release cannot become ready.',code=update_code(failure.get('errorCode'),'service.start-failed')) from None
                finally:error.close()
                http_failed = bool(pid)
            except OSError:
                http_failed = bool(pid)
            state = self.user(uid, ['systemctl','--user','show','dsh-phalanx.service','--property=ActiveState,SubState'], check=False)
            exited = any(line in ('ActiveState=failed', 'ActiveState=inactive', 'SubState=auto-restart') for line in state.stdout.splitlines())
            if exited or self.clock() >= deadline:
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




class ImageConnection(http.client.HTTPConnection):
    def __init__(self,path,authorize):
        super().__init__('localhost',timeout=3);self.path=path;self.authorize=authorize
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX);self.sock.settimeout(3)
        try:self.sock.connect(self.path);self.authorize(self.sock)
        except BaseException:self.close();raise


class UnixImageInspector:
    """Transport reuse only: every request obtains a fresh official Libpod inspect result."""
    def __init__(self,path,authorize):self.connection=ImageConnection(path,authorize)
    def inspect(self,reference):
        try:
            if self.connection.sock:self.connection.authorize(self.connection.sock)
            self.connection.request('GET','/v4.0.0/libpod/images/'+urllib.parse.quote(reference,safe='')+'/json')
            response=self.connection.getresponse();body=response.read(2*1024*1024+1)
            if response.status!=200 or len(body)>2*1024*1024:raise InstallError('The instance image is unavailable from its owned inspection service')
            value=json.loads(body)
            if not isinstance(value,dict):raise ValueError('Invalid image inspection result')
            return value
        except BaseException:self.close();raise
    def close(self):self.connection.close()


class OwnedImageInspector:
    """One executor owns this independent rootless service, peer proof and runtime directory."""
    def __init__(self,host,uid):
        self.host=host;self.uid=uid;self.process=None;self.directory=None;self.reader=None;self.peer=None;self.socket_inode=None;self.context=None;self.path=None
    def stamp(self,pid):return self.host.path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()[19]
    def configuration(self):
        roots=[self.host.path(p) for p in ('/usr/share/containers','/etc/containers',HOME_DIR+'/.config/containers')]
        paths=[p/name for p in roots for name in ('storage.conf','containers.conf')]+[p for root in roots for p in (root/'containers.conf.d').glob('*.conf')]
        result=[]
        for path in sorted(paths):
            try:
                info=path.stat();fact=(info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns)
            except FileNotFoundError:fact=None
            result.append((str(path),fact))
        return result
    def authorize(self,connection):
        pid,uid,gid=struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
        proof=(pid,self.stamp(pid),uid,gid)
        if (uid!=self.uid or gid!=self.gid or os.getpgid(pid)!=self.process.pid or
                self.host.path('/proc/'+str(pid)+'/exe').resolve()!=Path('/usr/bin/podman').resolve() or
                self.host.path('/proc/'+str(pid)+'/cmdline').read_bytes().split(b'\0')[-2]!=os.fsencode(self.uri) or
                self.process.poll() is not None or self.stamp(self.process.pid)!=self.wrapper_started or
                self.peer is not None and self.peer!=proof):
            raise InstallError('The owned image inspection peer identity changed')
        self.peer=proof
    def start(self):
        account=self.host.run(['getent','passwd',ACCOUNT]).stdout.strip().split(':')
        if len(account)!=7 or int(account[2])!=self.uid or account[5]!=HOME_DIR:raise InstallError('Invalid image inspection identity')
        self.gid=int(account[3]);parent=self.host.path('/run/dsh-phalanx-updater');info=parent.lstat()
        if parent.is_symlink() or not parent.is_dir() or info.st_uid!=0 or info.st_gid!=self.gid or info.st_mode&0o027:
            raise InstallError('Invalid owned image inspection runtime')
        self.context=self.configuration();self.directory=Path(tempfile.mkdtemp(prefix='image-',dir=parent));self.directory_inode=self.directory.stat().st_ino
        self.directory.chmod(0o700);os.chown(self.directory,self.uid,self.gid);self.path=self.directory/'api.sock';self.uri='unix://'+str(self.path)
        self.process=subprocess.Popen(['runuser','-u',ACCOUNT,'--','podman','system','service','--time','0',self.uri],
            env=self.host.user_environment(self.uid),cwd=self.host.path(HOME_DIR),stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
        self.wrapper_started=self.stamp(self.process.pid);self.reader=UnixImageInspector(str(self.path),self.authorize)
        deadline=self.host.clock()+10
        while True:
            if self.path.exists():self.socket_inode=self.path.lstat().st_ino
            try:self.reader.connection.connect();break
            except (ConnectionRefusedError,FileNotFoundError):
                if self.process.poll() is not None or self.host.clock()>=deadline:raise InstallError('The owned image inspection service did not start') from None
                self.host.pause(.02)
        if self.context!=self.configuration():raise InstallError('Image inspection configuration changed during startup')
    def inspect(self,reference):
        if self.process is not None and (self.process.poll() is not None or self.context!=self.configuration()):self.close()
        if self.process is None:self.start()
        return self.reader.inspect(reference)
    def close(self):
        if self.reader:self.reader.close()
        if self.process:
            if self.process.poll() is None:self.process.terminate()
            try:self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if self.peer:
                    pid,ticks,_,_=self.peer
                    try:
                        if self.stamp(pid)==ticks and os.getpgid(pid)==self.process.pid:os.kill(pid,signal.SIGKILL)
                    except (ProcessLookupError,FileNotFoundError):pass
                self.process.kill();self.process.wait(timeout=5)
            if self.peer:
                try:
                    if self.stamp(self.peer[0])==self.peer[1]:raise InstallError('The owned image inspection peer did not stop')
                except FileNotFoundError:pass
        if self.directory:
            if self.path is not None and self.path.exists():
                with socket.socket(socket.AF_UNIX) as probe:
                    try:probe.connect(str(self.path))
                    except (ConnectionRefusedError,FileNotFoundError):pass
                    else:raise InstallError('The image inspection socket is still active')
                info=self.path.lstat()
                if self.path.is_symlink() or info.st_ino!=self.socket_inode or info.st_uid!=self.uid:raise InstallError('The owned image inspection socket changed')
                self.path.unlink()
            if self.directory.is_symlink() or self.directory.stat().st_ino!=self.directory_inode:raise InstallError('The owned image inspection directory changed')
            self.directory.rmdir()
        self.process=None;self.directory=None;self.reader=None;self.peer=None;self.socket_inode=None;self.context=None;self.path=None
