"""Narrow root-only readiness admission, including legacy binaries and reboot."""
import ipaddress
import hashlib
import signal
import math
import re
import socket
import threading
import stat
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tempfile
import uuid
import base64
import array
import secrets

TABLE='dsh_phalanx_upgrade'
COMMENT='dsh-phalanx upgrade admission protocol 1'
MARK=0x44534850
MARKER='/etc/dsh-phalanx/maintenance'


def protected_ports(values):
    endpoints=[{'address':values['DSH_PHALANX_HOST'],'port':int(values['DSH_PHALANX_PORT'])},
               {'address':'127.0.0.1','port':int(values.get('DSH_PHALANX_CONTAINER_GATEWAY_PORT','3081'))}]
    if values.get('DSH_PHALANX_PREVIEW_PORT'):
        endpoints.append({'address':values['DSH_PHALANX_HOST'],'port':int(values['DSH_PHALANX_PREVIEW_PORT'])})
    return endpoints


class AdmissionGateError(Exception):
    code='admission.failed'



def maintenance_pages(target):
    target=Path(target)
    if target.is_symlink() or (target/'dist').is_symlink():raise AdmissionGateError('Invalid installed maintenance page directory')
    pages={}
    for locale in ('en','zh-CN'):
        path=target/'dist'/('maintenance.'+locale+'.html')
        try:descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        except FileNotFoundError:continue
        except OSError as error:raise AdmissionGateError('Installed maintenance page is unavailable') from error
        with os.fdopen(descriptor,'rb') as file:
            info=os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid not in (0,os.geteuid()) or info.st_mode&0o022:
                raise AdmissionGateError('Invalid installed maintenance page ownership')
            page=file.read(262145)
            if not page or len(page)>262144:raise AdmissionGateError('Invalid installed maintenance page size')
            try:page.decode('utf-8')
            except UnicodeError as error:raise AdmissionGateError('Invalid installed maintenance page encoding') from error
            pages[locale]=page
    if pages and len(pages)!=2:raise AdmissionGateError('Installed maintenance pages are incomplete')
    return pages or None


def maintenance_locale(value):
    languages=[]
    for part in value.split(','):
        fields=part.strip().split(';');tag=fields[0].lower()
        try:quality=1 if len(fields)==1 else float(fields[1].strip().removeprefix('q='))
        except ValueError:continue
        if math.isfinite(quality) and 0<quality<=1:languages.append((tag,quality))
    languages.sort(key=lambda item:item[1],reverse=True)
    preferred=languages[0][0] if languages else 'en'
    return 'zh-CN' if preferred=='zh' or preferred.startswith('zh-') else 'en'


class MaintenanceListener:
    """Owns only the temporary HTTP socket; close finishes before its port can be handed off."""
    def __init__(self,pages,address,port):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        family=socket.AF_INET6 if ipaddress.ip_address(address).version==6 else socket.AF_INET
        class Handler(BaseHTTPRequestHandler):
            protocol_version='HTTP/1.1'
            def setup(handler):
                super().setup();handler.connection.settimeout(3)
            def log_message(handler,*args):pass
            def respond(handler):
                body=pages[maintenance_locale(handler.headers.get('Accept-Language','en'))]
                handler.send_response_only(503)
                for key,value in [('Content-Type','text/html; charset=utf-8'),('Content-Length',str(len(body))),('Retry-After','3'),('Cache-Control','no-store'),('Connection','close'),('Content-Security-Policy',"frame-ancestors 'none'"),('X-Content-Type-Options','nosniff')]:handler.send_header(key,value)
                handler.end_headers();handler.close_connection=True
                if handler.command!='HEAD':handler.wfile.write(body)
            do_GET=do_HEAD=do_POST=do_PUT=do_PATCH=do_DELETE=do_OPTIONS=do_CONNECT=do_TRACE=respond
        class Server(ThreadingHTTPServer):
            address_family=family;allow_reuse_address=True;daemon_threads=True;block_on_close=False
            def server_bind(server):
                if family==socket.AF_INET6:server.socket.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,0)
                super().server_bind()
        self.server=Server((address,port),Handler);self.port=self.server.server_address[1];self.closed=False
        self.thread=threading.Thread(target=self.server.serve_forever,name='dsh-phalanx-maintenance-http',daemon=True)
        try:self.thread.start()
        except BaseException:self.server.server_close();raise

    def close(self):
        if self.closed:return
        self.server.shutdown();self.thread.join();self.server.server_close();self.closed=True


def process_started(path):return path.read_text().rsplit(')',1)[1].split()[19]


def maintenance_token(job,key):
    used=job.setdefault('maintenanceTokens',[])
    if not isinstance(used,list) or len(used)>4096 or any(type(value) is not int or not 0<value<2**32 or value==MARK for value in used):
        raise AdmissionGateError('Invalid maintenance connection history')
    previous=job.get(key)
    if isinstance(previous,dict):
        token=previous.get('token')
        if type(token) is not int or not 0<token<2**32 or token==MARK:raise AdmissionGateError('Invalid maintenance connection identity')
        if token not in used:used.append(token)
        return token
    token=secrets.randbits(32)
    while token in (0,MARK) or token in used:token=secrets.randbits(32)
    used.append(token);return token


class ManagedMaintenanceSocket:
    """PID1 keeps the exact listener bound independently of either serving process."""
    def __init__(self,host,job,role,key):
        self.host=host;self.job=job;self.key=key
        if str(uuid.UUID(job['id']))!=job['id']:raise AdmissionGateError('Invalid maintenance operation identity')
        self.unit='dsh-phalanx-upgrade-'+role+'-'+job['id']+'.service';self.cgroup='/system.slice/'+self.unit
        self.endpoint=protected_ports(job['source']['values'])[0]
        self.program=str(host.path('/opt/dsh-phalanx/maintenance/gate.py'));self.role=role

    def fdname(self):return self.role+'-'+self.job['id']+'-'+str(self.intent()['token'])

    def stored(self,fields):
        if fields.get('NFileDescriptorStore')!='1':raise AdmissionGateError('The maintenance listener is not pinned by PID1')
        rows=json.loads(self.host.run(['systemd-analyze','--json=short','fdstore',self.unit]).stdout)
        if not isinstance(rows,list) or len(rows)!=1:raise AdmissionGateError('Unexpected maintenance descriptor inventory')
        row=rows[0];inode=row.get('inode')
        if (type(inode) is not int or inode<=0 or row.get('fdname')!=self.fdname() or
                type(row.get('type')) is not int or not stat.S_ISSOCK(row['type']) or row.get('path')!='socket:['+str(inode)+']'):
            raise AdmissionGateError('Maintenance descriptor differs from its owner')
        expected=self.intent().get('listener',{}).get('inode')
        if expected is not None and expected!=inode:raise AdmissionGateError('A different platform listener was pinned')
        result=self.host.run(['/usr/bin/python3','-I',self.program,'--inspect-listener',str(inode),self.endpoint['address'],str(self.endpoint['port'])])
        if json.loads(result.stdout)!={'inode':inode,'address':self.endpoint['address'],'port':self.endpoint['port']}:
            raise AdmissionGateError('Pinned maintenance endpoint differs from its owner')
        return inode

    def facts(self):
        properties='LoadState,MainPID,Transient,User,Type,NotifyAccess,KillMode,Restart,ExecStart,ControlGroup,RemainAfterExit,FileDescriptorStoreMax,FileDescriptorStorePreserve,NFileDescriptorStore,CollectMode,ActiveState,Job'
        result=self.host.run(['systemctl','show',self.unit,'--property='+properties],check=False)
        fields=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
        if fields.get('LoadState')=='not-found':return None
        if result.returncode!=0 or fields.get('LoadState')!='loaded':raise AdmissionGateError('Maintenance unit state is unavailable')
        return fields

    def verify(self,fields,*,listener=False):
        intent=self.intent()
        if intent is None or self.job.get(self.key)!=intent:raise AdmissionGateError('Maintenance unit is not owned by this operation')
        for key,value in [('Transient','yes'),('User','root'),('Type','notify'),('NotifyAccess','main'),('KillMode','control-group'),('Restart','no'),('RemainAfterExit','yes'),('FileDescriptorStoreMax','1'),('FileDescriptorStorePreserve','yes'),('CollectMode','inactive')]:
            if fields.get(key)!=value:raise AdmissionGateError('Maintenance unit configuration differs from its owner')
        command=re.fullmatch(r'\{ path=([^ ;]+) ; argv\[\]=([^;]+) ; ignore_errors=no ;[^{}]*\}',fields.get('ExecStart',''))
        if command is None or command[1]!='/usr/bin/python3' or command[2].split()!=self.arguments:
            raise AdmissionGateError('Maintenance unit command differs from its owner')
        raw_pid=fields.get('MainPID','')
        if not raw_pid.isdecimal():raise AdmissionGateError('Invalid maintenance listener process')
        pid=int(raw_pid);group=fields.get('ControlGroup','')
        if group not in ('',self.cgroup) or pid and group!=self.cgroup:raise AdmissionGateError('Maintenance unit cgroup differs from its owner')
        if pid:
            process=self.host.path('/proc/'+str(pid))
            actual=[item for item in (process/'cmdline').read_bytes().split(b'\0') if item]
            if (actual!=[os.fsencode(item) for item in self.arguments] or
                    (process/'exe').resolve()!=self.host.path('/usr/bin/python3').resolve() or
                    '0::'+self.cgroup not in (process/'cgroup').read_text().splitlines()):
                raise AdmissionGateError('Maintenance listener process differs from its owner')
        if fields.get('NFileDescriptorStore') not in ('0','1'):raise AdmissionGateError('Invalid maintenance descriptor count')
        if fields['NFileDescriptorStore']=='1':self.stored(fields)
        if listener and (fields['NFileDescriptorStore']!='1' or not pid or not self.host.pid_owns_listener(pid,self.endpoint['port'],ipaddress.ip_address(self.endpoint['address']))):
            raise AdmissionGateError('Maintenance service does not own its expected listener')
        return pid

    def start(self):
        if self.intent() is None:return None
        fields=self.facts()
        if fields is None:
            if self.job.get(self.key)!=self.intent():raise AdmissionGateError('Save maintenance ownership before starting its listener')
            self.host.run(['systemd-run','--unit='+self.unit,'--slice=system.slice',
                           '--property=Type=notify','--property=NotifyAccess=main','--property=User=root',
                           '--property=KillMode=control-group','--property=Restart=no','--property=WorkingDirectory=/',
                           '--property=RemainAfterExit=yes','--property=FileDescriptorStoreMax=1',
                           '--property=FileDescriptorStorePreserve=yes','--property=CollectMode=inactive',
                           '--',*self.arguments])
            fields=self.facts()
        if fields is None:raise AdmissionGateError('Maintenance listener exited before admission could be verified')
        self.verify(fields,listener=True)
        return self.socket_cgroup

    def stop(self):
        fields=self.facts()
        if fields is None:return
        self.verify(fields)
        result=self.host.run(['systemctl','stop',self.unit],check=False)
        after=self.facts()
        if after is not None:
            if result.returncode!=0 or self.verify(after):raise AdmissionGateError('Maintenance listener did not stop')
            if after.get('Job',''):raise AdmissionGateError('Maintenance listener still has a pending job')
            if after.get('ActiveState')=='failed':
                self.host.run(['systemctl','reset-failed',self.unit]);after=self.facts()
            if after is not None:
                self.verify(after)
                if after.get('ActiveState')!='inactive' or after.get('Job',''):raise AdmissionGateError('Maintenance listener is not inactive')
                self.host.run(['systemctl','clean','--what=fdstore',self.unit]);after=self.facts()
                if after is not None and (self.verify(after) or after['NFileDescriptorStore']!='0'):
                    raise AdmissionGateError('Maintenance descriptor was not released')
        events=self.host.path('/sys/fs/cgroup'+self.cgroup+'/cgroup.events')
        if events.exists() and dict(line.split() for line in events.read_text().splitlines()).get('populated')!='0':
            raise AdmissionGateError('Maintenance unit still has active processes')


class MaintenanceUnit(ManagedMaintenanceSocket):
    def __init__(self,host,job):
        super().__init__(host,job,'page','maintenancePage');self.target=Path(job['source']['target']);self.token=None
        self.socket_cgroup=self.cgroup
    def intent(self):
        pages=maintenance_pages(self.target)
        if pages is None:return None
        if self.token is None:self.token=maintenance_token(self.job,self.key)
        return {'unit':self.unit,'source':str(self.target),'pages':{locale:hashlib.sha256(body).hexdigest() for locale,body in pages.items()},'token':self.token}
    @property
    def arguments(self):
        return ['/usr/bin/python3','-I',self.program,'--serve-page',self.job['id'],str(self.target),self.endpoint['address'],str(self.endpoint['port']),str(self.intent()['token'])]


class ListenerPinUnit(ManagedMaintenanceSocket):
    def __init__(self,host,job):
        super().__init__(host,job,'listener','maintenanceListener')
    def intent(self):
        value=self.job.get(self.key)
        if value is None:return None
        if not isinstance(value,dict) or value.get('unit')!=self.unit or not isinstance(value.get('listener'),dict):
            raise AdmissionGateError('Invalid platform listener ownership')
        maintenance_token(self.job,self.key)
        return {'unit':self.unit,'listener':value['listener'],'token':value['token']}
    @property
    def arguments(self):
        value=self.intent();encoded=base64.urlsafe_b64encode(json.dumps(value['listener'],sort_keys=True,separators=(',',':')).encode()).decode()
        return ['/usr/bin/python3','-I',self.program,'--pin-listener',self.job['id'],encoded,str(value['token'])]
    @property
    def socket_cgroup(self):return self.intent()['listener']['cgroup']


def duplicate_listener(value):
    if sys.platform!='linux' or os.uname().machine not in ('x86_64','aarch64'):raise AdmissionGateError('Listener pinning requires the supported Linux host')
    import ctypes,fcntl
    pid=value['pid'];process=Path('/proc')/str(pid)
    if process_started(process/'stat')!=value['started']:raise AdmissionGateError('Listener process identity changed')
    descriptor=os.pidfd_open(pid)
    try:
        library=ctypes.CDLL(None,use_errno=True);copied=library.syscall(438,descriptor,value['fd'],0)
        if copied<0:raise OSError(ctypes.get_errno(),'pidfd_getfd')
    finally:os.close(descriptor)
    try:
        if os.fstat(copied).st_ino!=value['inode']:raise AdmissionGateError('Listener descriptor identity changed')
        flags=fcntl.fcntl(copied,fcntl.F_GETFL);listener=socket.socket(fileno=copied);copied=None
        try:
            if fcntl.fcntl(listener.fileno(),fcntl.F_GETFL)!=flags:
                fcntl.fcntl(listener.fileno(),fcntl.F_SETFL,flags);raise AdmissionGateError('Listener status flags must remain unchanged')
            actual=listener.getsockname();address=ipaddress.ip_address(value['address'])
            valid=(ipaddress.ip_address(actual[0])==address and actual[1]==value['port'] and
                listener.getsockopt(socket.SOL_SOCKET,socket.SO_TYPE)==socket.SOCK_STREAM and
                listener.getsockopt(socket.SOL_SOCKET,socket.SO_ACCEPTCONN)==1 and
                listener.getsockopt(socket.SOL_SOCKET,socket.SO_REUSEPORT)==0 and
                not (address.version==6 and address.is_unspecified and listener.getsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY)!=0))
            if not valid:raise AdmissionGateError('Invalid exclusive maintenance listener')
        except BaseException:listener.close();raise
        return listener
    finally:
        if copied is not None:os.close(copied)


def inspect_listener(inode,address,port):
    if not inode.isdecimal() or not port.isdecimal():raise AdmissionGateError('Invalid stored listener')
    for path in Path('/proc/1/fd').iterdir():
        try:link=os.readlink(path)
        except FileNotFoundError:continue
        if link=='socket:['+inode+']':
            with duplicate_listener({'pid':1,'fd':int(path.name),'inode':int(inode),'started':process_started(Path('/proc/1/stat')),'address':address,'port':int(port)}):
                print(json.dumps({'inode':int(inode),'address':address,'port':int(port)}));return
    raise AdmissionGateError('PID1 no longer holds the listener')


def notify_listener(descriptor,name):
    path=os.environ.get('NOTIFY_SOCKET')
    if not path:raise AdmissionGateError('Maintenance listener requires its managed unit')
    with socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM) as notification:
        notification.connect('\0'+path[1:] if path.startswith('@') else path)
        notification.sendmsg([('FDSTORE=1\nFDPOLL=0\nFDNAME='+name+'\nREADY=1').encode()],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[descriptor]))])


def stopped_event():
    stopped=threading.Event()
    for name in (signal.SIGTERM,signal.SIGINT):signal.signal(name,lambda *_:stopped.set())
    return stopped


def pin_listener(operation,encoded,token):
    if str(uuid.UUID(operation))!=operation or not token.isdecimal() or not 0<int(token)<2**32 or int(token)==MARK:
        raise AdmissionGateError('Invalid listener pin request')
    value=json.loads(base64.urlsafe_b64decode(encoded));process=Path('/proc')/str(value['pid'])
    uid=int(next(line for line in (process/'status').read_text().splitlines() if line.startswith('Uid:')).split()[1])
    if (uid!=value['uid'] or (process/'exe').resolve()!=Path(value['executable']).resolve() or
            (process/'cwd').resolve()!=Path(value['directory']) or '0::'+value['cgroup'] not in (process/'cgroup').read_text().splitlines()):
        raise AdmissionGateError('Platform listener differs from its verified source')
    stopped=stopped_event()
    with duplicate_listener(value) as listener:
        notify_listener(listener.fileno(),'listener-'+operation+'-'+token);stopped.wait()


def maintenance_serve(operation,target,address,port,token):
    if str(uuid.UUID(operation))!=operation or not port.isdecimal() or not 1<=int(port)<=65535 or not token.isdecimal() or not 0<int(token)<2**32 or int(token)==MARK:
        raise AdmissionGateError('Invalid maintenance listener request')
    pages=maintenance_pages(Path(target))
    if pages is None:raise AdmissionGateError('Installed source has no maintenance pages')
    stopped=stopped_event()
    listener=MaintenanceListener(pages,address,int(port))
    try:
        notify_listener(listener.server.socket.fileno(),'page-'+operation+'-'+token)
        stopped.wait()
    finally:listener.close()

class LinuxAdmissionGate:
    def run(self,args,**kwargs):
        result=subprocess.run(['nft',*args],capture_output=True,text=True,**kwargs)
        if result.returncode!=0:raise AdmissionGateError('Scoped upgrade admission could not be configured (nft exit '+str(result.returncode)+')')
        return result.stdout

    def table_exists(self):
        tables=json.loads(self.run(['-j','list','tables']))['nftables']
        found=any(row.get('table',{}).get('family')=='inet' and row['table'].get('name')==TABLE for row in tables)
        if found:
            rows=json.loads(self.run(['-j','list','table','inet',TABLE]))['nftables']
            if not any(row.get('table',{}).get('comment')==COMMENT for row in rows):
                raise AdmissionGateError('The reserved upgrade admission table is owned by another configuration')
        return found

    def rules(self,ports,existing,*,page_cgroup=None,page_token=None):
        if not isinstance(ports,list) or len(ports) not in (2,3):raise AdmissionGateError('Invalid protected admission inventory')
        selectors=[];public=[]
        for index,endpoint in enumerate(ports):
            if not isinstance(endpoint,dict) or type(endpoint.get('port')) is not int or not 1<=endpoint['port']<=65535:
                raise AdmissionGateError('Invalid protected admission port')
            address=ipaddress.ip_address(endpoint['address'])
            family='ip' if address.version==4 else 'ip6'
            destination=('meta nfproto ipv4' if address.version==4 else 'meta nfproto ipv6') if address.is_unspecified else family+' daddr '+str(address)
            selected=[destination+' tcp dport '+str(endpoint['port'])]
            # A wildcard IPv6 listener can accept mapped IPv4 sockets.
            if address.version==6 and address.is_unspecified:selected.append('meta nfproto ipv4 tcp dport '+str(endpoint['port']))
            selectors.extend(selected)
            if index==0:public=selected
        outgoing='\n'.join('  '+selected+' meta mark '+str(MARK)+' ct mark set '+str(MARK) for selected in selectors)
        incoming='\n'.join('  '+selected+' ct mark != '+str(MARK)+' counter reject with tcp reset' for selected in selectors)
        pages=''
        if page_cgroup is not None:
            if type(page_token) is not int or not 0<page_token<2**32 or page_token==MARK:raise AdmissionGateError('Invalid maintenance connection identity')
            if (not isinstance(page_cgroup,str) or page_cgroup=='/' or not re.fullmatch(r'/[a-zA-Z0-9_@./-]+',page_cgroup) or
                    str(PurePosixPath(page_cgroup))!=page_cgroup or any(part in ('.','..') for part in page_cgroup.split('/')[1:])):
                raise AdmissionGateError('Invalid maintenance socket cgroup')
            group=page_cgroup[1:];level=len(group.split('/'))
            if level>=255:raise AdmissionGateError('Maintenance socket cgroup is too deep')
            for selected in public:
                pages+='  '+selected+' ct mark != '+str(MARK)+' tcp flags & (syn | ack) == syn ct mark set 0\n'
                owner=selected+' ct mark != '+str(MARK)+' socket cgroupv2 level '+str(level)+' '+json.dumps(group)
                # Missing next ancestors break this rule; existing descendants cannot be the root cgroup.
                pages+='  '+owner+' socket cgroupv2 level '+str(level+1)+' != "/" counter reject with tcp reset\n'
                pages+='  '+owner+' tcp flags & (syn | ack) == syn ct mark set '+str(page_token)+' counter accept\n'
                pages+='  '+selected+' ct mark '+str(page_token)+' counter accept\n'
        return (('delete table inet '+TABLE+'\n') if existing else '')+f'''table inet {TABLE} {{
 comment "{COMMENT}"
 chain readiness {{
  type filter hook output priority -150; policy accept;
{outgoing}
 }}
 chain work_admission {{
  type filter hook input priority -150; policy accept;
{pages}{incoming}
 }}
}}
'''

    def batch(self,text,check=False):
        with tempfile.NamedTemporaryFile(mode='w',prefix='dsh-phalanx-admission-',delete=True) as file:
            os.fchmod(file.fileno(),0o600); file.write(text); file.flush()
            self.run((['--check'] if check else [])+['-f',file.name])

    def preflight(self,ports):
        existing=self.table_exists()
        self.batch(self.rules(ports,existing),check=True)
        # Validate the supported socket expression without granting a live exception.
        self.batch(self.rules(ports,existing,page_cgroup='/system.slice',page_token=1),check=True)
    def close(self,ports):self.batch(self.rules(ports,self.table_exists()))
    def show_page(self,ports,cgroup,token):self.batch(self.rules(ports,self.table_exists(),page_cgroup=cgroup,page_token=token))
    def open(self):
        if self.table_exists():self.batch('delete table inet '+TABLE+'\n')

    def install(self,host,uid,program=None):
        if program is None:program=globals().get('UPGRADE_GATE_SOURCE')
        if program is None:program=Path(__file__).read_text()
        host.atomic('/opt/dsh-phalanx/maintenance/gate.py',program,0o644)
        unit='[Unit]\nDescription=dsh-phalanx upgrade admission\nBefore=user@'+str(uid)+'.service\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/bin/python3 /opt/dsh-phalanx/maintenance/gate.py\n'
        host.atomic('/etc/systemd/system/dsh-phalanx-maintenance.service',unit,0o644)
        host.atomic('/etc/systemd/system/user@'+str(uid)+'.service.d/dsh-phalanx-maintenance.conf',
                    '[Unit]\nRequires=dsh-phalanx-maintenance.service\nAfter=dsh-phalanx-maintenance.service\n',0o644)
        host.run(['systemctl','daemon-reload'])
        host.run(['systemctl','start','dsh-phalanx-maintenance.service'])


def protected_json(path):
    info=path.lstat()
    if path.is_symlink() or info.st_uid!=0 or info.st_mode & 0o022:raise AdmissionGateError('Invalid persistent admission carrier')
    return json.loads(path.read_text())


def restore_boot_admission():
    path=Path(MARKER); gate=LinuxAdmissionGate()
    if path.exists() or path.is_symlink():
        value=protected_json(path)
        if value.get('schema')!=1:raise AdmissionGateError('Unknown persistent maintenance admission protocol')
        gate.close(value['ports']); return
    # Platform operations share the same admission owner and survive the window
    # between durable intent and marker publication.
    operations=Path('/var/lib/dsh-phalanx-updater/maintenance-operation.json')
    if operations.exists() or operations.is_symlink():
        root=operations.parent
        info=root.lstat()
        if root.is_symlink() or info.st_uid!=0 or info.st_mode & 0o077:raise AdmissionGateError('Invalid platform operation owner')
        job=protected_json(operations)
        if job.get('schema')!=1 or job.get('action') not in ('master-key-rotate','master-key-reset','database-switch') or str(uuid.UUID(job['id']))!=job['id'] or job.get('phase') not in ('prepared','working','data-complete','validating','opening','succeeded','restored'):
            raise AdmissionGateError('Unknown platform operation admission protocol')
        if job['phase'] not in ('succeeded','restored'):
            value=json.loads(job['marker'])
            if value.get('schema')!=1 or value.get('operation')!=job['id']:raise AdmissionGateError('Invalid platform operation marker')
            gate.close(value['ports']);return
    # The journal precedes the marker and all stop/switch effects. A crash in
    # that window must still restore admission before the managed user starts.
    root=Path('/var/lib/dsh-phalanx-updater'); pointer=root/'current'
    if pointer.exists():
        for carrier in (root,pointer):
            info=carrier.lstat()
            if carrier.is_symlink() or info.st_uid!=0 or info.st_mode & 0o022:raise AdmissionGateError('Invalid admission journal owner')
        operation=pointer.read_text().strip()
        if str(uuid.UUID(operation))!=operation:raise AdmissionGateError('Invalid admission operation identity')
        directory=root/operation
        info=directory.lstat()
        if directory.is_symlink() or info.st_uid!=0 or info.st_mode & 0o077:raise AdmissionGateError('Invalid admission operation owner')
        job=protected_json(directory/'operation.json')
        if job['phase'] in ('stopping','backing-up','backed-up','switching','validating','restoring','committed','restoration-committed','recovery-failed'):
            values=job['source']['values']
            gate.close(protected_ports(values)); return
        if job['phase'] not in ('preparing','prepared','prepare-failed','apply-failed','succeeded','restored'):
            raise AdmissionGateError('Unknown admission operation phase')
    gate.open()


if __name__=='__main__' and Path(sys.argv[0]).name=='gate.py':
    try:
        if len(sys.argv)==1:restore_boot_admission()
        elif len(sys.argv)==7 and sys.argv[1]=='--serve-page':maintenance_serve(*sys.argv[2:])
        elif len(sys.argv)==5 and sys.argv[1]=='--inspect-listener':inspect_listener(*sys.argv[2:])
        elif len(sys.argv)==5 and sys.argv[1]=='--pin-listener':pin_listener(*sys.argv[2:])
        else:raise AdmissionGateError('Unknown maintenance entry request')
    except Exception:
        print('Upgrade admission could not be restored; the managed user service must remain stopped.',file=sys.stderr)
        sys.exit(1)
