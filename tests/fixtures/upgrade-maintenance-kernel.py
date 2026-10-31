"""Explicit root Linux acceptance of the installed maintenance socket boundary.

Run only against a registered, idle validation installation. This is a manual
fixture, not a release gate. Its evidence directory must already be owned by root.
"""
import argparse
import errno
import fcntl
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import select
import signal
import socket
import stat
import subprocess
import sys
import threading
import time
import uuid

sys.dont_write_bytecode=True


def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def server_child(group, address, ports):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    (Path(group)/'cgroup.procs').write_text(str(os.getpid()))
    class Handler(BaseHTTPRequestHandler):
        protocol_version='HTTP/1.1'
        def log_message(self,*args):pass
        def do_GET(self):
            body=b'owned kernel fixture'
            self.send_response(503);self.send_header('Content-Length',str(len(body)))
            self.end_headers();self.wfile.write(body)
    servers=[];stopped=threading.Event()
    for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,lambda *_:stopped.set())
    try:
        for index,port in enumerate(ports):
            host='127.0.0.1' if index==1 else address
            class Server(ThreadingHTTPServer):
                address_family=socket.AF_INET6 if ':' in host else socket.AF_INET
                allow_reuse_address=True;daemon_threads=True;block_on_close=False
                def server_bind(self):
                    if self.address_family==socket.AF_INET6:self.socket.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,0)
                    super().server_bind()
            server=Server((host,port),Handler);servers.append(server);server.socket.setblocking(False)
            threading.Thread(target=server.serve_forever,daemon=True).start()
        print(json.dumps({'ready':True,'pid':os.getpid()}),flush=True);stopped.wait()
    finally:
        for server in servers:server.shutdown();server.server_close()


def page_actor(modules, program, job_file):
    sys.path.insert(0,modules)
    from installer_host import Host
    from installer_upgrade_gate import MaintenanceUnit,LinuxAdmissionGate,protected_ports
    class ProbeHost(Host):
        def path(self,value):
            return Path(program) if value=='/opt/dsh-phalanx/maintenance/gate.py' else super().path(value)
    job=json.loads(Path(job_file).read_text());unit=MaintenanceUnit(ProbeHost(),job)
    group=unit.start();LinuxAdmissionGate().show_page(protected_ports(job['source']['values']),group,job['maintenancePage']['token'])
    print(json.dumps({'ready':True,'pid':os.getpid()}),flush=True)
    signal.pause()


class Probe:
    def __init__(self,args):
        self.args=args;self.root=args.evidence.resolve();self.children=[];self.groups=[];self.reservations=[]
        self.results=[];self.unit=None;self.units=[];self.owns_table=False;self.active_ports=None
        sys.path.insert(0,str(args.modules.resolve()))
        from installer_host import Host
        from installer_upgrade_gate import LinuxAdmissionGate,MaintenanceUnit,ListenerPinUnit,maintenance_token,process_started,protected_ports,TABLE
        self.gate=LinuxAdmissionGate();self.unit_type=MaintenanceUnit;self.pin_type=ListenerPinUnit;self.token=maintenance_token;self.started=process_started;self.ports_for=protected_ports;self.table=TABLE
        program=args.program.resolve()
        class ProbeHost(Host):
            def path(self,value):return program if value=='/opt/dsh-phalanx/maintenance/gate.py' else super().path(value)
        self.host=ProbeHost()
        self.group_root=Path('/sys/fs/cgroup')/('dsh-phalanx-maintenance-probe-'+args.nonce)

    def record(self,name,**facts):self.results.append({'name':name,'passed':True,**facts})

    def start(self,arguments):
        process=subprocess.Popen([sys.executable,'-B',str(Path(__file__).resolve()),*arguments],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        self.children.append(process)
        if not select.select([process.stdout],[],[],15)[0]:raise RuntimeError('Owned fixture did not announce readiness')
        line=process.stdout.readline()
        if not line or json.loads(line)!={'ready':True,'pid':process.pid}:raise RuntimeError('Owned fixture failed before readiness')
        return process

    def stop(self,process):
        if process.poll() is None:
            process.terminate()
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
        if process in self.children:self.children.remove(process)

    def group(self,name):
        path=self.group_root/name;path.mkdir();self.groups.append(path);return path

    def spawn_server(self,group,address,ports):
        process=self.start(['--server',str(group),address,*map(str,ports)])
        for index,port in enumerate(ports):
            host=ipaddress.ip_address('127.0.0.1' if index==1 else address)
            if not self.host.pid_owns_listener(process.pid,port,host):raise RuntimeError('Owned server has no expected kernel listener')
        return process

    def request(self,address,port,*,allowed,locale='en',body=None):
        connection=http.client.HTTPConnection(address,port,timeout=2)
        try:
            try:
                connection.request('GET','/kernel-maintenance-probe',headers={'Accept-Language':locale})
                response=connection.getresponse();data=response.read()
            except (OSError,http.client.HTTPException):
                if allowed:raise
                return
            if not allowed:raise AssertionError('A fenced listener accepted an unmarked connection')
            if response.status!=503:raise AssertionError('Expected maintenance status')
            if body is not None and (data!=body or response.getheader('Retry-After')!='3'):raise AssertionError('Installed maintenance response differs')
        finally:connection.close()

    def close(self,ports):self.gate.close(ports);self.owns_table=True;self.active_ports=ports

    def pin_server(self,process,address,ports,group):
        descriptor=self.host.listener_file(process.pid,ports[0],ipaddress.ip_address(address))
        if descriptor is None:raise RuntimeError('Source lost its exact listener before pinning')
        path=Path('/proc')/str(process.pid)
        source={**descriptor,'pid':process.pid,'started':self.started(path/'stat'),'cgroup':str(group).removeprefix('/sys/fs/cgroup'),
                'address':address,'port':ports[0],'uid':0,'executable':str((path/'exe').resolve()),'directory':str((path/'cwd').resolve())}
        job={'id':str(uuid.uuid4()),'source':{'values':{'DSH_PHALANX_HOST':address,'DSH_PHALANX_PORT':str(ports[0]),'DSH_PHALANX_CONTAINER_GATEWAY_PORT':str(ports[1])}}}
        pin=self.pin_type(self.host,job)
        job['maintenanceListener']={'unit':pin.unit,'listener':source,'token':self.token(job,'maintenanceListener')}
        write_json(self.root/('pin-'+job['id']+'.json'),job);self.units.append(pin);pin.start()
        return pin

    def release_pin(self,pin):
        self.close(self.active_ports);pin.stop();self.units.remove(pin)

    def assert_pinned(self,address,port):
        family=socket.AF_INET6 if ':' in address else socket.AF_INET
        with socket.socket(family) as candidate:
            candidate.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            if family==socket.AF_INET6:candidate.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,0)
            try:candidate.bind((address,port))
            except OSError as error:
                if error.errno!=errno.EADDRINUSE:raise
            else:raise AssertionError('An unknown listener could replace the pinned endpoint')

    def exercise_sockets(self,address):
        ports=[]
        for _ in range(3):
            with socket.socket() as candidate:candidate.bind(('127.0.0.1',0));ports.append(candidate.getsockname()[1])
        if len(set(ports))!=3:raise RuntimeError('Port allocation collided; retain this attempt')
        values={'DSH_PHALANX_HOST':address,'DSH_PHALANX_PORT':str(ports[0]),'DSH_PHALANX_CONTAINER_GATEWAY_PORT':str(ports[1]),'DSH_PHALANX_PREVIEW_PORT':str(ports[2])}
        endpoints=self.ports_for(values);targets=['127.0.0.1','::1'] if address=='::' else ['127.0.0.1']
        owner=self.group('owner-'+str(len(self.results)));child=owner/'descendant';child.mkdir();self.groups.append(child)
        foreign=self.group('foreign-'+str(len(self.results)))
        process=self.spawn_server(owner,address,ports)
        for target in targets:self.request(target,ports[0],allowed=True)
        self.close(endpoints)
        for target in targets:self.request(target,ports[0],allowed=False)
        pin=self.pin_server(process,address,ports,owner)
        self.gate.show_page(endpoints,str(owner).removeprefix('/sys/fs/cgroup'),pin.intent()['token'])
        for target in targets:
            self.request(target,ports[0],allowed=True)
            self.request(target,ports[2],allowed=False)
        self.request('127.0.0.1',ports[1],allowed=False)
        connection=http.client.HTTPConnection(targets[0],ports[0],timeout=2)
        connection.request('GET','/');response=connection.getresponse();response.read()
        self.close(endpoints)
        try:
            connection.request('GET','/');response=connection.getresponse();response.read()
        except (OSError,http.client.HTTPException):pass
        else:raise AssertionError('An established unmarked connection survived closing admission')
        finally:connection.close()
        self.gate.show_page(endpoints,str(owner).removeprefix('/sys/fs/cgroup'),pin.intent()['token'])
        for target in targets:self.request(target,ports[0],allowed=True)
        self.stop(process)
        fields=pin.facts();keeper=pin.verify(fields,listener=True);descriptor=os.pidfd_open(keeper)
        try:
            pin.verify(pin.facts(),listener=True);signal.pidfd_send_signal(descriptor,signal.SIGKILL)
        finally:os.close(descriptor)
        deadline=time.monotonic()+10
        while (pin.facts() or {}).get('MainPID')!='0':
            if time.monotonic()>deadline:raise RuntimeError('The owned keeper did not exit')
            time.sleep(.05)
        pin.stored(pin.facts());self.assert_pinned(address,ports[0]);self.release_pin(pin)
        for group in (child,foreign):
            process=self.spawn_server(group,address,ports)
            pin=self.pin_server(process,address,ports,group)
            self.gate.show_page(endpoints,str(owner).removeprefix('/sys/fs/cgroup'),pin.intent()['token'])
            for target in targets:self.request(target,ports[0],allowed=False)
            self.close(endpoints);self.stop(process);self.release_pin(pin)
        self.record('socket-cgroup-boundary',address=address,ports=ports,descendantRejected=True,foreignRejected=True,establishedRevoked=True,sourceAndKeeperCrashPinned=True)
        self.gate.open();self.owns_table=False

    def exercise_unit(self):
        from installer_upgrade_gate import maintenance_pages
        reservations=[]
        try:
            for _ in range(3):
                candidate=socket.socket(socket.AF_INET6);reservations.append(candidate);self.reservations.append(candidate)
                candidate.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,0);candidate.bind(('::',0))
            ports=[candidate.getsockname()[1] for candidate in reservations];port=ports[0]
            job={'id':str(uuid.uuid4()),'source':{'target':str(self.args.pages.resolve()),'values':{'DSH_PHALANX_HOST':'::','DSH_PHALANX_PORT':str(port),'DSH_PHALANX_CONTAINER_GATEWAY_PORT':str(ports[1]),'DSH_PHALANX_PREVIEW_PORT':str(ports[2])}}}
        except BaseException:
            for candidate in reservations:candidate.close()
            raise
        unit=self.unit_type(self.host,job);self.unit=unit;job['maintenancePage']=unit.intent()
        if job['maintenancePage'] is None:raise RuntimeError('The validation source requires both installed pages')
        job_file=self.root/'operation.json';write_json(job_file,job)
        endpoints=self.ports_for(job['source']['values'])
        try:self.close(endpoints)
        finally:
            for candidate in reservations:candidate.close()
        actor=self.start(['--actor',str(self.args.modules.resolve()),str(self.args.program.resolve()),str(job_file)])
        pages=maintenance_pages(self.args.pages)
        for target in ('127.0.0.1','::1'):
            for locale,body in pages.items():self.request(target,port,allowed=True,locale=locale,body=body)
        # The executor disappears, while the independently managed unit still owns the page.
        actor.kill();actor.wait(timeout=5);self.children.remove(actor)
        fields=unit.facts();pid=unit.verify(fields,listener=True)
        for target in ('127.0.0.1','::1'):self.request(target,port,allowed=True,body=pages['en'])
        descriptor=os.pidfd_open(pid)
        try:
            unit.verify(unit.facts(),listener=True);signal.pidfd_send_signal(descriptor,signal.SIGKILL)
        finally:os.close(descriptor)
        deadline=time.monotonic()+10
        while (unit.facts() or {}).get('MainPID')!='0':
            if time.monotonic()>deadline:raise RuntimeError('Killed transient unit did not exit')
            time.sleep(.05)
        unit.stored(unit.facts());self.assert_pinned('::',port)
        self.close(endpoints);unit.stop();self.unit=None
        group=self.group('replacement')
        process=self.spawn_server(group,'::',ports)
        for target in ('127.0.0.1','::1'):self.request(target,port,allowed=False)
        self.stop(process)
        self.record('managed-page-crashes',operation=job['id'],executorIndependent=True,helperCrashPinned=True,foreignReplacementRejected=True,languages=list(pages))

    def cleanup(self):
        failures=[]
        for candidate in self.reservations:candidate.close()
        closed=not self.owns_table
        if self.owns_table:
            try:self.close(self.active_ports);closed=True
            except Exception as error:failures.append(str(error))
        for process in list(reversed(self.children)):
            try:self.stop(process)
            except Exception as error:failures.append(str(error))
        if closed:
            for unit in [*reversed(self.units),*([self.unit] if self.unit is not None else [])]:
                try:unit.stop()
                except Exception as error:failures.append(str(error))
        for path in [*reversed(self.groups),self.group_root]:
            try:path.rmdir()
            except FileNotFoundError:pass
            except OSError as error:failures.append(str(error))
        if self.owns_table and not failures:
            try:self.gate.open();self.owns_table=False
            except Exception as error:failures.append(str(error))
        return failures


def write_json(path,value):
    descriptor=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(descriptor,'w') as file:json.dump(value,file);file.write('\n')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('evidence','modules','program','pages'):parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--nonce',required=True);args=parser.parse_args()
    if os.geteuid()!=0 or sys.platform!='linux' or str(uuid.UUID(args.nonce))!=args.nonce:raise RuntimeError('Requires a registered root Linux probe')
    root=args.evidence.resolve();info=root.lstat()
    if args.evidence.is_symlink() or info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o700:raise RuntimeError('Invalid evidence owner')
    owner_path=root/'OWNER.json';details=owner_path.lstat()
    if owner_path.is_symlink() or not stat.S_ISREG(details.st_mode) or details.st_uid!=0 or stat.S_IMODE(details.st_mode)!=0o600:raise RuntimeError('Invalid probe registration file')
    owner=json.loads(owner_path.read_text())
    if owner.get('nonce')!=args.nonce or owner.get('purpose')!='maintenance-kernel-acceptance':raise RuntimeError('Evidence registration differs')
    if owner.get('mode') not in ('source','installed') or any(not re.fullmatch('[a-f0-9]{40}',owner.get(key,'')) for key in ('productSource','harnessSource')):raise RuntimeError('Missing source identity')
    for path in [Path(__file__).resolve(),args.program.resolve(),*args.modules.glob('installer_*.py')]:
        details=path.lstat()
        if details.st_uid!=0 or details.st_mode&0o022 or owner['files'].get(str(path))!=digest(path):raise RuntimeError('Probe input ownership or bytes differ')
    marker=Path('/etc/dsh-phalanx/maintenance')
    if marker.exists() or marker.is_symlink():raise RuntimeError('An upgrade is already active')
    pointer=Path('/var/lib/dsh-phalanx-updater/current')
    if pointer.exists() or pointer.is_symlink():raise RuntimeError('An upgrade journal is already active')
    probe=Probe(args)
    if owner['mode']=='installed':
        from installer_executor_install import executor_package
        executor_package(args.modules,owner['productSource'])
        if json.loads((args.pages/'build-info.json').read_text())['commit']!=owner['productSource']:raise RuntimeError('Installed platform source differs')
        if digest(args.program)!=digest(args.modules/'installer_upgrade_gate.py'):raise RuntimeError('Installed gate program differs from its verified package')
    descriptor=os.open('/run/lock/dsh-phalanx-install.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    with os.fdopen(descriptor,'w') as lease:
        fcntl.flock(lease,fcntl.LOCK_EX|fcntl.LOCK_NB)
        details=os.fstat(lease.fileno())
        if not stat.S_ISREG(details.st_mode) or details.st_uid!=0 or stat.S_IMODE(details.st_mode)!=0o600:raise RuntimeError('Invalid shared installation lease')
        if probe.gate.table_exists():raise RuntimeError('Reserved admission table already exists')
        probe.group_root.mkdir();failure=None
        try:
            for address in ('0.0.0.0','::'):probe.exercise_sockets(address)
            probe.exercise_unit()
        except BaseException as error:failure=error
        cleanup=probe.cleanup()
        write_json(root/'result.json',{'passed':failure is None and not cleanup,'artifactVerified':owner['mode']=='installed','checks':probe.results,'cleanupErrors':cleanup,'error':None if failure is None else str(failure),'nonce':args.nonce,'owner':owner})
        if failure is not None:raise failure
        if cleanup:raise RuntimeError('Owned cleanup did not finish')


if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--server':server_child(sys.argv[2],sys.argv[3],list(map(int,sys.argv[4:])))
    elif len(sys.argv)>1 and sys.argv[1]=='--actor':page_actor(*sys.argv[2:])
    else:main()
