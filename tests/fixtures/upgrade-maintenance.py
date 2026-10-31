"""Installed-page HTTP behavior and socket handoff at the real local transport seam."""
import http.client
import copy
import subprocess
import os
import json
from pathlib import Path
import socket
import tempfile
import unittest
import base64
import stat
from installer_host import InstallError
from installer_progress import update_error_code
from installer_config import environment_text
from installer_upgrade_host import UpgradeHost, MAINTENANCE
from installer_upgrade_gate import protected_ports
from installer_upgrade_gate import AdmissionGateError, LinuxAdmissionGate, MaintenanceListener, MaintenanceUnit, maintenance_pages


class RootPath(type(Path())):
    """Only filesystem ownership is virtualized at this root OS seam; native acceptance uses real owners."""
    def lstat(self):
        fields=list(super().lstat());fields[4]=0;return os.stat_result(fields)


class ServiceHost:
    """The systemd/process I/O seam runs a real listener without adopting host services."""
    def __init__(self,root,pages):
        self.root=Path(root);self.pages=pages;self.fields=None;self.listener=None;self.starts=0;self.stops=0;self.activeSocket=None;self.failStart=False;self.userStops=0;self.events=[]
        self.unit=None;self.managerSocket=None;self.inventory=None;self.heldInode=None;self.collectAfterReset=False
        self.path('/usr/bin').mkdir(parents=True);self.path('/usr/bin/python3').touch()
    def path(self,name):return RootPath(self.root/str(name).lstrip('/'))
    def close(self):
        failures=[]
        for resource in (self.listener,self.activeSocket,self.managerSocket):
            if resource is not None:
                try:resource.close()
                except BaseException as error:failures.append(error)
        if failures:raise ExceptionGroup('Owned fake OS cleanup failed',failures)
    def pid_owns_listener(self,pid,port,address):
        return bool(self.managerSocket and self.fields and self.fields['MainPID']==str(pid) and port==self.managerSocket.getsockname()[1] and str(address)=='127.0.0.1')
    def listener_file(self,pid,port,address):
        if pid!=2222 or port!=self.port or str(address)!='127.0.0.1':return None
        if self.activeSocket is None:
            self.activeSocket=socket.socket();self.activeSocket.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            self.activeSocket.bind(('127.0.0.1',port));self.activeSocket.listen()
        return {'fd':self.activeSocket.fileno(),'inode':8222}
    def run(self,args,check=True):
        if args[:2]==['systemctl','show']:
            return subprocess.CompletedProcess(args,0,'\n'.join(key+'='+value for key,value in self.fields.items()),'') if self.fields and args[2]==self.unit else subprocess.CompletedProcess(args,1,'LoadState=not-found\n','')
        if args[0]=='systemd-run':
            self.events.append('helper-started');self.starts+=1;arguments=args[args.index('--')+1:];unit=next(value.removeprefix('--unit=') for value in args if value.startswith('--unit='));group='/system.slice/'+unit
            self.unit=unit;role='page' if '--serve-page' in arguments else 'listener'
            if role=='page':
                self.listener=MaintenanceListener(self.pages,arguments[-3],int(arguments[-2]));original=self.listener.server.socket;self.heldInode=123456
            else:
                assert '--pin-listener' in arguments and self.activeSocket is not None
                original=self.activeSocket;self.heldInode=json.loads(base64.urlsafe_b64decode(arguments[-2]))['inode']
            self.managerSocket=socket.socket(fileno=os.dup(original.fileno()))
            self.inventory={'fdname':role+'-'+arguments[4]+'-'+arguments[-1],'type':stat.S_IFSOCK|0o777,'inode':self.heldInode,'path':'socket:['+str(self.heldInode)+']'}
            self.fields={'LoadState':'loaded','Transient':'yes','User':'root','Type':'notify','NotifyAccess':'main','KillMode':'control-group','Restart':'no','MainPID':'4321','ControlGroup':group,'ExecStart':'{ path=/usr/bin/python3 ; argv[]='+' '.join(arguments)+' ; ignore_errors=no ; pid=4321 ; }','RemainAfterExit':'yes','FileDescriptorStoreMax':'1','FileDescriptorStorePreserve':'yes','NFileDescriptorStore':'1','CollectMode':'inactive','ActiveState':'active','Job':''}
            process=self.path('/proc/4321');process.mkdir(parents=True,exist_ok=True)
            (process/'cmdline').write_bytes(b'\0'.join(os.fsencode(item) for item in arguments)+b'\0')
            (process/'cgroup').write_text('0::'+group+'\n');(process/'exe').unlink(missing_ok=True);(process/'exe').symlink_to(self.path('/usr/bin/python3'))
            return subprocess.CompletedProcess(args,0,'','')
        if args[:2]==['systemctl','stop']:
            self.stops+=1
            if self.listener:self.listener.close()
            self.fields['MainPID']='0'
            if self.fields['ActiveState']!='failed':self.fields['ActiveState']='inactive'
            return subprocess.CompletedProcess(args,0,'','')
        if args[:2]==['systemctl','reset-failed']:
            self.fields['ActiveState']='inactive'
            if self.collectAfterReset:self.managerSocket.close();self.managerSocket=None;self.fields=None;self.unit=None
            return subprocess.CompletedProcess(args,0,'','')
        if args[:2]==['systemctl','clean']:
            assert self.fields['ActiveState']=='inactive'
            self.managerSocket.close();self.managerSocket=None;self.fields=None;self.unit=None;self.events.append('helper-stopped')
            return subprocess.CompletedProcess(args,0,'','')
        if args[:2]==['systemd-analyze','--json=short']:
            assert args[2:]==['fdstore',self.unit]
            return subprocess.CompletedProcess(args,0,json.dumps([self.inventory]),'')
        if '--inspect-listener' in args:
            inode,address,port=args[-3:]
            assert int(inode)==self.heldInode and self.managerSocket and self.managerSocket.getsockname()==(address,int(port))
            return subprocess.CompletedProcess(args,0,json.dumps({'inode':int(inode),'address':address,'port':int(port)}),'')
        raise AssertionError('Unexpected external command')

    def user(self,uid,args):
        if args==['systemctl','--user','show','dsh-phalanx.service','--property=ControlGroup','--value']:return subprocess.CompletedProcess(args,0,self.platformGroup,'')
        if args[:3]==['podman','ps','--all']:return subprocess.CompletedProcess(args,0,'[]','')
        if args[:3]==['systemctl','--user','stop']:
            self.userStops+=1;self.events.append('platform-stopped')
            if self.activeSocket:self.activeSocket.close();self.activeSocket=None
        elif args[:3]==['systemctl','--user','enable']:
            if self.failStart:self.events.append('platform-start-failed');raise OSError('Injected platform startup failure')
            if self.activeSocket is None:
                self.activeSocket=socket.socket();self.activeSocket.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
                self.activeSocket.bind(('127.0.0.1',self.port));self.activeSocket.listen();self.events.append('platform-started')
        elif args!=['systemctl','--user','daemon-reload']:raise AssertionError('Unexpected product command')
        return subprocess.CompletedProcess(args,0,'','')


class Admission:
    def __init__(self,host):self.host=host;self.role=None;self.failClose=False
    def close(self,ports):
        if self.failClose:raise OSError('Injected fence failure')
        self.role=None;self.host.events.append('fence-closed')
    def show_page(self,ports,cgroup,token):self.role=cgroup;self.host.events.append('page-opened')


class Maintenance(unittest.TestCase):
    def pages(self, root):
        target=Path(root)/'release';(target/'dist').mkdir(parents=True)
        for locale,text in [('en','System upgrade in progress'),('zh-CN','系统升级中')]:
            (target/'dist'/('maintenance.'+locale+'.html')).write_text('<!doctype html><html lang="'+locale+'"><body>'+text+'</body></html>')
        return target

    def read(self, port, language='en', method='GET', address='127.0.0.1'):
        connection=http.client.HTTPConnection(address,port,timeout=3)
        try:
            connection.request(method,'/readyz?member=waiting',headers={'Accept-Language':language})
            response=connection.getresponse();return response.status,dict(response.getheaders()),response.read()
        finally:connection.close()

    def test_bilingual_all_paths_and_methods_close_before_rebinding(self):
        with tempfile.TemporaryDirectory() as directory:
            target=self.pages(directory);pages=maintenance_pages(target)
            listener=MaintenanceListener(pages,'127.0.0.1',0);port=listener.port
            try:
                for language,locale in [('en','en'),('en;q=0.2,zh-CN;q=0.9','zh-CN'),('zh-CN;q=0,en;q=1','en')]:
                    for method in ['GET','POST','DELETE']:
                        status,headers,body=self.read(port,language,method)
                        self.assertEqual(status,503);self.assertEqual(headers['Retry-After'],'3')
                        self.assertEqual(headers['Connection'],'close');self.assertEqual(headers['Cache-Control'],'no-store')
                        self.assertEqual(body,pages[locale])
                status,headers,body=self.read(port,method='HEAD');self.assertEqual(status,503);self.assertEqual(body,b'')
            finally:listener.close()
            listener.close()
            self.assertFalse(listener.thread.is_alive())
            with socket.socket() as replacement:
                replacement.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);replacement.bind(('127.0.0.1',port));replacement.listen()
                with self.assertRaises(OSError):MaintenanceListener(pages,'127.0.0.1',port)
                with socket.create_connection(('127.0.0.1',port),timeout=3) as client:self.assertEqual(client.getpeername(),('127.0.0.1',port))
            self.assertEqual(maintenance_pages(target),pages)

    def test_ipv6_wildcard_has_the_same_handoff(self):
        with tempfile.TemporaryDirectory() as directory:
            pages=maintenance_pages(self.pages(directory));listener=MaintenanceListener(pages,'::',0)
            try:
                self.assertEqual(self.read(listener.port,'zh-CN',address='::1')[2],pages['zh-CN'])
                self.assertEqual(self.read(listener.port,address='127.0.0.1')[2],pages['en'])
                port=listener.port
            finally:listener.close()
            with socket.socket(socket.AF_INET6) as replacement:
                replacement.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);replacement.bind(('::',port));replacement.listen()

    def service(self,directory):
        target=self.pages(directory).resolve();pages=maintenance_pages(target);host=ServiceHost(Path(directory)/'os',pages);self.addCleanup(host.close)
        with socket.socket() as allocation:allocation.bind(('127.0.0.1',0));port=allocation.getsockname()[1]
        job={'id':'11111111-1111-4111-8111-111111111111','source':{'target':str(target),'values':{'DSH_PHALANX_HOST':'127.0.0.1','DSH_PHALANX_PORT':str(port),'DSH_PHALANX_DATA_ROOT':'/var/lib/dsh-phalanx/data'},'uid':1001,'gid':1001}}
        host.port=port
        return host,job,MaintenanceUnit(host,job),port

    def test_transient_unit_requires_journal_ownership_and_recovery_joins_the_exact_listener(self):
        with tempfile.TemporaryDirectory() as directory:
            host,job,unit,port=self.service(directory)
            with self.assertRaises(AdmissionGateError):unit.start()
            self.assertEqual(host.starts,0)
            job['maintenancePage']=unit.intent()
            try:
                group=unit.start();self.assertEqual(group,'/system.slice/'+unit.unit)
                self.assertEqual(self.read(port)[2],host.pages['en'])
                recovered=MaintenanceUnit(host,copy.deepcopy(job));self.assertEqual(recovered.start(),group);self.assertEqual(host.starts,1)
                recovered.stop();recovered.stop();self.assertEqual(host.stops,1)
                with socket.socket() as target:
                    target.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);target.bind(('127.0.0.1',port));target.listen()
            finally:
                if host.listener:host.listener.close()

    def test_unknown_or_changed_unit_and_source_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            host,job,unit,port=self.service(directory);job['maintenancePage']=unit.intent();unit.start()
            original=copy.deepcopy(host.fields)
            try:
                for field,value in [('Transient','no'),('User','foreign'),('Restart','always'),('ControlGroup','/system.slice/foreign.service'),('ExecStart','{ path=/bin/false ; argv[]=/bin/false ; ignore_errors=no ; }')]:
                    host.fields={**original,field:value}
                    with self.assertRaises(AdmissionGateError):unit.stop()
                    self.assertEqual(host.stops,0);self.assertEqual(self.read(port)[0],503)
                host.fields=original
                unknown=copy.deepcopy(job);unknown.pop('maintenancePage')
                with self.assertRaises(AdmissionGateError):MaintenanceUnit(host,unknown).stop()
                page=Path(job['source']['target'])/'dist/maintenance.en.html';before=page.read_bytes();page.write_bytes(b'changed')
                try:
                    with self.assertRaises(AdmissionGateError):unit.stop()
                finally:page.write_bytes(before)
                self.assertEqual(host.stops,0)
                unit.stop();self.assertEqual(host.stops,1)
            finally:host.listener.close()

    def upgrade(self,host):
        port=UpgradeHost.__new__(UpgradeHost);port.host=host;port.admission=Admission(host)
        port.save=lambda job:host.events.append('ownership-saved')
        return port

    def test_start_failure_and_recovery_handoff_revoke_the_page_before_rebinding(self):
        with tempfile.TemporaryDirectory() as directory:
            host,job,unit,number=self.service(directory);port=self.upgrade(host)
            try:
                port.stop(job)
                self.assertEqual(host.events[:5],['fence-closed','platform-stopped','ownership-saved','helper-started','page-opened'])
                self.assertEqual(self.read(number,'zh-CN')[2],host.pages['zh-CN'])
                self.assertEqual(port.admission.role,unit.cgroup)
                host.failStart=True
                with self.assertRaises(OSError) as failed:port.start(job)
                self.assertEqual(update_error_code(failed.exception),'service.start-failed')
                self.assertIsNone(port.admission.role);self.assertTrue(host.listener.closed)
                self.assertEqual(host.events[-4:],['fence-closed','helper-stopped','ownership-saved','platform-start-failed'])
                port.stop(job);self.assertEqual(self.read(number)[2],host.pages['en'])
                host.failStart=False;port.start(job);port.start(job)
                self.assertIsNone(port.admission.role);self.assertTrue(host.listener.closed)
                with socket.create_connection(('127.0.0.1',number),timeout=3) as connection:self.assertEqual(connection.getpeername(),('127.0.0.1',number))
                self.assertEqual(host.stops,2)
            finally:
                if host.listener:host.listener.close()
                if host.activeSocket:host.activeSocket.close()

    def test_failed_exception_revocation_preserves_the_page_and_does_not_start_the_platform(self):
        with tempfile.TemporaryDirectory() as directory:
            host,job,unit,number=self.service(directory);port=self.upgrade(host);port.stop(job)
            try:
                port.admission.failClose=True
                with self.assertRaises(OSError) as failed:port.start(job)
                self.assertEqual(update_error_code(failed.exception),'admission.failed')
                self.assertEqual(host.stops,0);self.assertIsNone(host.activeSocket)
                self.assertEqual(self.read(number)[2],host.pages['en'])
            finally:port.admission.failClose=False;unit.stop()

    def test_fence_failure_still_stops_the_legacy_platform_without_starting_a_page(self):
        with tempfile.TemporaryDirectory() as directory:
            host,job,unit,number=self.service(directory);port=self.upgrade(host)
            for page in (Path(job['source']['target'])/'dist').iterdir():page.unlink()
            port.admission.failClose=True
            with self.assertRaises(OSError) as failed:port.stop(job)
            self.assertEqual(update_error_code(failed.exception),'admission.failed')
            self.assertEqual(host.userStops,1);self.assertEqual(host.starts,0)

    def test_unknown_recovery_unit_is_never_stopped_and_admission_is_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            host,job,unit,number=self.service(directory);port=self.upgrade(host)
            job['maintenancePage']=unit.intent();unit.start();proof=job.pop('maintenancePage')
            try:
                with self.assertRaises(AdmissionGateError) as failed:port.stop(job)
                self.assertEqual(update_error_code(failed.exception),'admission.failed')
                self.assertEqual(host.stops,0);self.assertIsNone(port.admission.role)
                self.assertEqual(host.userStops,1);self.assertEqual(self.read(number)[2],host.pages['en'])
            finally:job['maintenancePage']=proof;unit.stop()

    def test_public_target_requires_the_packaged_process_marker_and_exact_service_group(self):
        with tempfile.TemporaryDirectory() as directory:
            host,job,unit,number=self.service(directory);port=self.upgrade(host);source=job['source'];target=Path(source['target'])
            source['manifest']={'platform':'linux/amd64','commit':'a'*40,'files':{'dsh-phalanx-linux-amd64.tar.gz':'c'*64}}
            source['values'].update(DSH_PHALANX_MAINTENANCE_FILE=MAINTENANCE,DSH_PHALANX_PUBLIC_ORIGIN='http://127.0.0.1:'+str(number))
            (target/'node/bin').mkdir(parents=True);(target/'node/bin/node').touch();(target/'.artifact-sha256').write_text('c'*64);(target/'build-info.json').write_text(json.dumps({'commit':'a'*40}))
            process=host.path('/proc/2222');process.mkdir(parents=True);(process/'cwd').symlink_to(target);(process/'exe').symlink_to(target/'node/bin/node')
            host.platformGroup='/user.slice/user-1001.slice/user@1001.service/app.slice/dsh-phalanx.service'
            (process/'cgroup').write_text('0::'+host.platformGroup+'\n')
            (process/'stat').write_text('2222 (node) S '+'0 '*18+'12345 0\n')
            configuration=host.path('/etc/dsh-phalanx/environment');configuration.parent.mkdir(parents=True);configuration.write_text(environment_text(source['values']))
            marker=host.path(MAINTENANCE);original={'schema':1,'ports':protected_ports(source['values'])};marker.write_text(json.dumps(original));marker.chmod(0o644)
            port.show_platform_page(source,2222,job);self.assertEqual(port.admission.role,host.platformGroup)
            for group in ('/user.slice/user-1002.slice/user@1002.service/app.slice/dsh-phalanx.service',host.platformGroup.removesuffix('dsh-phalanx.service')+'foreign.service'):
                port.admission.close(original['ports']);host.platformGroup=group
                with self.assertRaises(InstallError):port.show_platform_page(source,2222,job)
                self.assertIsNone(port.admission.role)
            host.platformGroup='/user.slice/user-1001.slice/user@1001.service/app.slice/dsh-phalanx.service'
            marker.chmod(0o666)
            with self.assertRaises(AdmissionGateError):port.show_platform_page(source,2222,job)
            marker.chmod(0o644);marker.write_text(json.dumps({**original,'ports':[]}))
            with self.assertRaises(InstallError):port.show_platform_page(source,2222,job)
            marker.write_text(json.dumps(original));(target/'.artifact-sha256').write_text('changed')
            with self.assertRaises(InstallError):port.show_platform_page(source,2222,job)
            (target/'.artifact-sha256').write_text('c'*64)
            configuration.write_text(environment_text({**source['values'],'DSH_PHALANX_MAINTENANCE_FILE':'/tmp/foreign-marker'}))
            with self.assertRaises(InstallError):port.show_platform_page(source,2222,job)
            self.assertIsNone(port.admission.role)
            port.stop_maintenance(job);host.activeSocket.close()

    def test_pid1_store_remains_exclusive_after_a_helper_dies_and_both_release_paths_finish(self):
        for collected in (False,True):
            with self.subTest(collected=collected),tempfile.TemporaryDirectory() as directory:
                host,job,unit,number=self.service(directory);job['maintenancePage']=unit.intent();unit.start()
                host.listener.close();host.fields.update(MainPID='0',ActiveState='failed');host.collectAfterReset=collected
                try:
                    with socket.socket() as foreign:
                        foreign.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
                        with self.assertRaises(OSError):foreign.bind(('127.0.0.1',number))
                    unit.stop()
                    with socket.socket() as replacement:
                        replacement.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);replacement.bind(('127.0.0.1',number))
                finally:
                    if host.managerSocket:host.managerSocket.close()

    def test_an_unknown_descriptor_inventory_never_authorizes_or_releases_a_listener(self):
        with tempfile.TemporaryDirectory() as directory:
            host,job,unit,number=self.service(directory);job['maintenancePage']=unit.intent();unit.start()
            original=copy.deepcopy(host.inventory)
            try:
                for fields in ({'fdname':'foreign'},{'type':stat.S_IFREG},{'path':'socket:[foreign]'}):
                    host.inventory={**original,**fields}
                    with self.assertRaises(AdmissionGateError):unit.stop()
                    self.assertEqual(host.stops,0)
                host.inventory=original;previous=job['maintenancePage']['token'];unit.stop();job.pop('maintenancePage')
                next_unit=MaintenanceUnit(host,job);job['maintenancePage']=next_unit.intent()
                self.assertNotEqual(previous,job['maintenancePage']['token']);next_unit.start();next_unit.stop()
            finally:
                if host.listener:host.listener.close()
                if host.managerSocket:host.managerSocket.close()

    def test_public_page_rules_limit_the_socket_owner_to_the_primary_endpoint(self):
        ports=[{'address':'::','port':18080},{'address':'127.0.0.1','port':3081},{'address':'::','port':18081}]
        gate=LinuxAdmissionGate();group='/system.slice/maintenance-fixture.service'
        rules=gate.rules(ports,True,page_cgroup=group,page_token=1234567)
        scoped=[line for line in rules.splitlines() if 'socket cgroupv2' in line]
        self.assertEqual(len(scoped),4)
        self.assertTrue(all('tcp dport 18080 ' in line for line in scoped))
        self.assertTrue(any('meta nfproto ipv4' in line for line in scoped))
        self.assertTrue(any('meta nfproto ipv6' in line for line in scoped))
        self.assertTrue(all('ct mark != ' in line for line in scoped))
        self.assertTrue(all('level 2 "system.slice/maintenance-fixture.service"' in line for line in scoped))
        self.assertEqual(sum('level 3 != "/"' in line and 'reject with tcp reset' in line for line in scoped),2)
        self.assertEqual(sum(line.endswith('counter accept') for line in scoped),2)
        grants=[line for line in rules.splitlines() if 'ct mark set 1234567' in line]
        self.assertEqual(len(grants),2)
        self.assertTrue(all('tcp flags & (syn | ack) == syn' in line for line in grants))
        continuations=[line for line in rules.splitlines() if 'ct mark 1234567 counter accept' in line]
        self.assertEqual(len(continuations),2)
        self.assertTrue(all('tcp dport 18080 ' in line for line in continuations))
        self.assertEqual(rules.count('tcp flags & (syn | ack) == syn ct mark set 0'),2)
        self.assertTrue(rules.startswith('delete table inet dsh_phalanx_upgrade\n'))
        self.assertNotIn('socket cgroupv2',gate.rules(ports,False))
        for invalid in ('/','/system.slice/../other','/system.slice//other','/system.slice/"other',None):
            if invalid is None:continue
            with self.assertRaises(AdmissionGateError):gate.rules(ports,False,page_cgroup=invalid,page_token=1234567)

    def test_old_absence_is_closed_and_partial_or_untrusted_pages_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'old';target.mkdir();self.assertIsNone(maintenance_pages(target))
            target=self.pages(directory);page=target/'dist/maintenance.zh-CN.html';page.unlink()
            with self.assertRaises(AdmissionGateError):maintenance_pages(target)
            page.symlink_to(target/'dist/maintenance.en.html')
            with self.assertRaises(AdmissionGateError):maintenance_pages(target)
            page.unlink();page.write_text('page');page.chmod(0o666)
            with self.assertRaises(AdmissionGateError):maintenance_pages(target)
            page.unlink();os.mkfifo(page,0o600)
            with self.assertRaises(AdmissionGateError):maintenance_pages(target)


if __name__=='__main__':unittest.main()
