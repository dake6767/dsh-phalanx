"""The installer filesystem, terminal, socket and operating-system exit."""
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import re
import shlex
import tempfile
import secrets
import time
import getpass
import ipaddress
import http.client
import urllib.request
import urllib.error
import urllib.parse
import functools
import contextlib
import shutil
import socket
import errno
import selectors
import base64
from installer_progress import Progress,update_time_point,update_error_code,update_code  # embedded-progress


from installer_config import HOME_DIR, read_configuration, outbound_proxy_environment, distribution_facts, host_version_failure, passt_version_date, entry_url  # embedded-config
ACCOUNT = "dsh-phalanx"
PACKAGES = ("git", "nftables", "podman", "uidmap", "passt", "fuse-overlayfs", "dbus-user-session", "apparmor", "apparmor-utils")
class InstallError(Exception):
    def __init__(self,message,*,code='unknown'):
        super().__init__(message);self.code=code


def origin_authority(value):
    public=urllib.parse.urlsplit(value)
    hostname=ipaddress.ip_address(public.hostname).compressed if ':' in public.hostname else public.hostname.encode('idna').decode('ascii')
    authority='['+hostname+']' if ':' in hostname else hostname
    if public.port is not None and public.port!={'http':80,'https':443}[public.scheme]:authority+=':'+str(public.port)
    return authority


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
    def dependencies(self):
        installed = self.run(["dpkg-query", "-W", "-f=${db:Status-Abbrev}\\n", *PACKAGES], check=False)
        if installed.returncode != 0 or installed.stdout.splitlines() != ["ii "]*len(PACKAGES):
            env = {**os.environ, "DEBIAN_FRONTEND": "noninteractive"}
            self.run(["apt-get", "-o", "DPkg::Lock::Timeout=600", "update"], env=env)
            self.run(["apt-get", "-o", "DPkg::Lock::Timeout=600", "install", "-y", "--no-install-recommends", *PACKAGES], env=env)
        sysctl = []
        for key, value in (("kernel.unprivileged_userns_clone", "1"), ("user.max_user_namespaces", "65536")):
            path = self.path("/proc/sys/"+key.replace(".", "/"))
            if path.exists() and path.read_text().strip() == "0":
                sysctl.append(key+"="+value)
        if sysctl:
            self.atomic("/etc/sysctl.d/90-dsh-phalanx.conf", "\n".join(sysctl)+"\n", 0o644)
            self.run(["sysctl", "--load", str(self.path("/etc/sysctl.d/90-dsh-phalanx.conf"))])
        restricted = self.path("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
        if restricted.exists() and restricted.read_text().strip() == "1":
            for binary in ("podman", "pasta"):
                profile = "/etc/apparmor.d/"+binary
                if not self.path(profile).exists():
                    profile = "/etc/apparmor.d/dsh-phalanx-"+binary
                    self.atomic(profile, "abi <abi/4.0>,\ninclude <tunables/global>\n"+
                                f"profile dsh-phalanx-{binary} /usr/bin/{binary} flags=(unconfined) {{\n  userns,\n}}\n", 0o644)
                self.run(["apparmor_parser", "-r", str(self.path(profile))])

    def check_capabilities(self, uid=None):
        podman = self.run(['/usr/bin/podman', '--version']).stdout.strip()
        pasta = self.run(['/usr/bin/pasta', '--version']).stdout.strip()
        if passt_version_date(pasta) is None:
            package = self.run(['dpkg-query', '-W', '-f=${db:Status-Status} ${Version}\\n', 'passt'], check=False)
            if package.returncode == 0 and re.fullmatch(r'installed \S+\n?', package.stdout): pasta = package.stdout.strip()
        failure = host_version_failure(podman, pasta)
        if failure: raise InstallError(failure, code='compatibility.unsupported')
        init = self.path('/proc/1/comm')
        if not init.is_file() or init.read_text().strip() != 'systemd':
            raise InstallError('systemd must be the host init system', code='compatibility.unsupported')
        if not self.path('/sys/fs/cgroup/cgroup.controllers').is_file():
            raise InstallError('cgroup v2 is required (actual: cgroup v2 controllers unavailable)', code='compatibility.unsupported')
        if uid is None:
            info = self.rootless_probe()
        else:
            def command(arguments):
                return self.user(uid, ['timeout', '--signal=TERM', '--kill-after=5s', '30s', *arguments])
            try: command(['systemctl', '--user', 'is-active', '--quiet', 'default.target'])
            except InstallError:
                raise InstallError('A systemd user manager must be available for rootless containers', code='compatibility.unsupported') from None
            info = self.rootless_info(command)
        if info.get('host', {}).get('security', {}).get('rootless') is not True:
            raise InstallError('Rootless Podman is required (actual rootless: false or unavailable)', code='compatibility.unsupported')
        if info['host'].get('cgroupVersion') != 'v2':
            raise InstallError('cgroup v2 is required (actual: '+str(info['host'].get('cgroupVersion'))+')', code='compatibility.unsupported')

    def rootless_probe(self):
        account = 'dsh-probe-'+secrets.token_hex(6)
        home = '/run/'+account
        directory = self.path(home)
        directory.mkdir(mode=0o700)
        inode = directory.stat().st_ino
        attempted = False; created = False; linger_attempted = False; podman_attempted = False
        identity = None; failure = None; cleanup = []; info = None
        def owned(row):
            return bool(row and len(row) == 7 and row[0] == account and row[5:] == [home, '/usr/sbin/nologin'] and
                        row[2].isdecimal() and row[3].isdecimal() and min(int(row[2]), int(row[3])) > 0)
        def command(arguments, **options):
            uid = int(identity[2])
            environment = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'HOME': home,
                           'XDG_RUNTIME_DIR': '/run/user/'+str(uid), 'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/'+str(uid)+'/bus'}
            return self.run(['runuser', '-u', account, '--', 'timeout', '--signal=TERM', '--kill-after=5s', '30s', *arguments],
                            env=environment, cwd=directory, use_proxy=False, **options)
        try:
            if self.run(['getent', 'passwd', account], check=False).returncode != 2:
                raise InstallError('Temporary rootless probe identity is already occupied')
            attempted = True
            added = self.run(['useradd', '--system', '--no-create-home', '--user-group', '--home-dir', home, '--shell', '/usr/sbin/nologin', account], check=False)
            found = self.run(['getent', 'passwd', account], check=False)
            created = found.returncode == 0
            identity = found.stdout.strip().split(':') if created else None
            if created and not owned(identity):
                raise InstallError('Temporary rootless probe identity does not match its owner')
            if added.returncode != 0 or not created: raise InstallError('Cannot create the temporary rootless probe identity')
            for table, flag in (('subuid', '--add-subuids'), ('subgid', '--add-subgids')):
                rows = [row.split(':') for row in self.path('/etc/'+table).read_text().splitlines() if row]
                start = max([100000, *(int(row[1])+int(row[2]) for row in rows)])
                if start+65535 >= 2**32: raise InstallError('No subordinate-ID range is available for the rootless probe')
                self.run(['usermod', flag, str(start)+'-'+str(start+65535), account])
            self.atomic(home+'/.config/containers/storage.conf', '[storage]\ndriver = "overlay"\n[storage.options.overlay]\nmount_program = "/usr/bin/fuse-overlayfs"\n')
            self.run(['chown', '-R', identity[2]+':'+identity[3], str(directory)])
            try:
                linger_attempted = True
                self.run(['loginctl', 'enable-linger', account])
                self.run(['systemctl', 'start', 'user@'+identity[2]+'.service'])
                command(['systemctl', '--user', 'is-active', '--quiet', 'default.target'])
            except InstallError:
                raise InstallError('A systemd user manager must be available for rootless containers', code='compatibility.unsupported') from None
            podman_attempted = True
            info = self.rootless_info(command)
        except BaseException as error: failure = error
        if attempted and not created:
            found = self.run(['getent', 'passwd', account], check=False)
            if found.returncode not in (0, 2):
                raise InstallError('Cannot verify temporary rootless probe ownership; retained '+account+' at '+home) from failure
            created = found.returncode == 0
            identity = found.stdout.strip().split(':') if created else None
        if created:
            current = self.run(['getent', 'passwd', account], check=False).stdout.strip().split(':')
            if not owned(identity) or current != identity:
                raise InstallError('Temporary rootless probe ownership changed; retained '+account+' at '+home) from failure
            actions = []
            if podman_attempted: actions.append(lambda: command(['/usr/bin/podman', 'system', 'migrate']))
            if linger_attempted: actions.append(lambda: self.run(['loginctl', 'disable-linger', account]))
            for action in actions:
                try: action()
                except BaseException as error: cleanup.append(error)
            quiesced = not linger_attempted
            if linger_attempted:
                units = ['user@'+identity[2]+'.service', 'user-runtime-dir@'+identity[2]+'.service']
                for arguments in (['loginctl', 'terminate-user', account], ['systemctl', 'stop', *units]):
                    try: self.run(arguments, check=False)
                    except BaseException as error: cleanup.append(error)
                try:
                    states = self.run(['systemctl', 'show', *units, '--property=ActiveState', '--value']).stdout.splitlines()
                    carriers = (self.path('/run/user/'+identity[2]), self.path('/var/lib/systemd/linger/'+account))
                    if [state for state in states if state] != ['inactive', 'inactive']: raise InstallError('Temporary rootless probe session remains')
                    for path in carriers:
                        try: path.lstat()
                        except FileNotFoundError: continue
                        raise InstallError('Temporary rootless probe runtime or linger state remains')
                    quiesced = True
                except BaseException as error: cleanup.append(error)
            if quiesced:
                try: self.run(['userdel', account])
                except BaseException as error: cleanup.append(error)
        if not cleanup:
            try:
                if directory.is_symlink() or directory.stat().st_ino != inode: raise InstallError('Temporary rootless probe directory changed')
                shutil.rmtree(directory)
            except BaseException as error: cleanup.append(error)
        if cleanup:
            raise InstallError((str(failure)+'; ' if failure else '')+'Temporary rootless probe cleanup failed: '+str(cleanup[0])) from None
        if failure is not None: raise failure
        return info

    def rootless_info(self, command):
        try:
            info = json.loads(command(['/usr/bin/podman', 'info', '--format', 'json']).stdout)
            if not isinstance(info, dict) or not isinstance(info.get('host'), dict) or not isinstance(info['host'].get('security'), dict):
                raise ValueError('Invalid rootless Podman facts')
            return info
        except (InstallError, ValueError):
            raise InstallError('Cannot inspect rootless Podman capabilities', code='compatibility.unsupported') from None

    def distribution(self):
        release = self.path('/etc/os-release')
        facts = distribution_facts(release.read_text() if release.is_file() else '')
        previous = self.progress.host_admission if self.progress else None
        if self.progress: self.progress.host_admission = facts
        if facts['family'] != 'debian':
            raise InstallError('Installation supports only Debian-family Linux hosts (Ubuntu, Debian and derivatives)', code='compatibility.unsupported')
        if not facts['verified'] and facts != previous:
            self.tell('WARNING: This Debian-family distribution is unverified: '+facts['distribution']+' '+facts['version']+'. Installation continues if host capabilities pass.')
        return facts

    def __init__(self, root=Path("/"), command=None, *, system=None, machine=None, uid=None):
        self.root = root.resolve()
        self.command = command or subprocess.run
        self.injected_command = command is not None
        self.progress = None
        self.non_interactive = False
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

    def run(self, arguments, *, check=True, input_file=None, env=None, cwd=None, pass_fds=(), use_proxy=True):
        env={**(os.environ if env is None else env),**(self.proxy_environment if use_proxy else {})}
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

    def request(self, url, *, authority=None, socket_mark=None, max_bytes=None, timeout=60):
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
            with opener.open(request,timeout=timeout) as response:
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
        from installer_release import OwnedImageInspector  # embedded-release
        return OwnedImageInspector(self,uid)

    def operator(self, text):
        if self.progress:
            with self.progress.input():
                print(self.progress.safe(text), file=sys.stderr)
        else:
            print(text, file=sys.stderr)

    def tell(self, text, **facts):
        self.progress.emit('info', message=text, **facts) if self.progress else print(text, file=sys.stderr)

    def terminal_available(self):
        if self.non_interactive:
            return False
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
        if self.non_interactive:
            raise InstallError('Noninteractive input requires explicit configuration and confirmation flags')
        try:
            with (self.progress.input() if self.progress else contextlib.nullcontext()), open("/dev/tty", "r") as terminal, open("/dev/tty", "w") as display:
                if secret:
                    return getpass.getpass(label, stream=display)
                display.write(label)
                display.flush()
                answer = terminal.readline()
                if not answer:
                    raise InstallError('Terminal input closed; retry with explicit noninteractive configuration')
                return answer.strip()
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
        authority = origin_authority(public_origin)
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
