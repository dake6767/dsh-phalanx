"""Managed operations at the public Unix protocol and OS/process seam."""
import json
import http.client
import socket
import threading
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from installer_host import Host,InstallError
from installer_executor_protocol import validated_request,ControlError

class ManagedOperations(unittest.TestCase):
    def test_closed_rotation_protocol_never_accepts_commands_or_paths(self):
        self.assertEqual(validated_request({'action':'master-key-rotate'}),{'action':'master-key-rotate'})
        self.assertEqual(validated_request({'action':'database-switch','target':'external'}),{'action':'database-switch','target':'external'})
        with self.assertRaises(ControlError):validated_request({'action':'database-switch','target':'arbitrary'})
        reset={'action':'master-key-reset','confirmation':'RESET ALL PLATFORM SECRETS'}
        self.assertEqual(validated_request(reset),reset)
        with self.assertRaises(ControlError):validated_request({'action':'master-key-reset','confirmation':'wrong phrase'})
        for field in ('path','command','configFile','url'):
            with self.assertRaises(ControlError):validated_request({'action':'master-key-rotate',field:'/arbitrary'})

    def test_root_recovers_exact_operation_and_refuses_replaced_marker(self):
        self.run_recovery_scenario('master-key-rotate')

    def test_root_recovers_lost_key_reset_under_the_same_admission_owner(self):
        self.run_recovery_scenario('master-key-reset')

    def test_managed_recovery_restarts_rate_limited_builtin_unit(self):
        self.run_recovery_scenario('master-key-rotate',limited=True)

    def run_recovery_scenario(self,action,limited=False):
        from installer_operations import PlatformOperations
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);events=[];fail=[True];fail_open=[True];fail_start=[False];starts=[5 if limited else 0]
            config=root/'keys/database.json';config.parent.mkdir()
            config.write_text(json.dumps({'deploymentId':'deployment-fixture'}));config.chmod(0o600)
            source={'uid':os.geteuid(),'gid':os.getegid(),'target':str(root/'release'),'values':{'DSH_PHALANX_DATA_ROOT':'/data','DSH_PHALANX_DATABASE_CONFIG_FILE':'/keys/database.json','DSH_PHALANX_HOST':'127.0.0.1','DSH_PHALANX_PORT':'3080'}}
            def command(args,**kwargs):
                if 'systemctl' in args and 'dsh-phalanx-postgres.service' in args:
                    if 'reset-failed' in args:starts[0]=0
                    elif 'start' in args:
                        if starts[0]>=5:raise InstallError('Start request repeated too quickly')
                        starts[0]+=1
                if action in args:
                    operation=args[args.index('--managed-operation')+1]
                    if fail[0]:raise InstallError('Controlled worker interruption')
                    marker=(root/'etc/dsh-phalanx/maintenance').read_text()
                    (config.parent/'platform-key-operation.json').write_text(json.dumps({'managedOperation':operation,'deploymentId':'deployment-fixture','phase':'prepared','kind':'reset' if action=='master-key-reset' else 'rotate','marker':marker}))
                    (config.parent/'platform-key-operation.json').chmod(0o600)
                    config.write_text(json.dumps({'deploymentId':'deployment-fixture','registry':{'masterFingerprint':'sha256:'+'f'*64}}))
                    events.append('data-complete')
                    return SimpleNamespace(returncode=0,stdout=json.dumps({'operation':operation,'deploymentId':'deployment-fixture','fingerprint':'sha256:'+'f'*64,'status':'reset' if action=='master-key-reset' else 'rotated'}),stderr='')
                events.append('postgres-started');return SimpleNamespace(returncode=0,stdout='',stderr='')
            host=Host(root,command)
            class Port:
                def source(self):return source
                def operation(self):return None
                def stop(self,job):events.append('stopped')
                def start(self,job):
                    if fail_start[0]:raise InstallError('Controlled boot startup failure')
                    events.append('started')
                def verify_source(self,*args):events.append('verified')
                class admission:
                    @staticmethod
                    def preflight(ports):pass
                    @staticmethod
                    def close(ports):events.append('closed')
                    @staticmethod
                    def open():
                        if fail_open[0]:
                            fail_open[0]=False;raise InstallError('Controlled admission release interruption')
                        events.append('opened')
            from installer_executor import UpgradeExecutor
            from installer_executor_server import ControlServer
            service=UpgradeExecutor(lambda:host,port_factory=lambda host:Port())
            address=str(root/'control.sock');server=ControlServer(address,service,os.geteuid(),peer_reader=lambda _:os.geteuid())
            thread=threading.Thread(target=server.serve_forever);thread.start()
            def request(action):
                client=http.client.HTTPConnection('localhost',timeout=5)
                client.sock=socket.socket(socket.AF_UNIX);client.sock.connect(address)
                client.request('POST','/control',body=json.dumps({'action':action,**({'confirmation':'RESET ALL PLATFORM SECRETS'} if action=='master-key-reset' else {})}),headers={'Content-Type':'application/json'})
                response=client.getresponse();body=json.loads(response.read());client.close()
                self.assertEqual(response.status,200,body)
                with service.mutex:pass  # Wait for the accepted worker, without a timing assertion.
                return body
            try:
                job=request(action)['operation']
                owner=PlatformOperations(host,Port())
                marker=root/'etc/dsh-phalanx/maintenance';original=marker.read_text()
                self.assertEqual(json.loads(original)['schema'],1)
                self.assertNotIn('started',events)
                # Reconstruct the owner from protected files; replaced markers remain closed.
                fail[0]=False;marker.write_text('foreign marker')
                request('maintenance-recover')
                self.assertEqual(marker.read_text(),'foreign marker')
                marker.write_text(original)
                service.recover_at_start()
                self.assertEqual(owner.status()['phase'],'opening')
                self.assertFalse(marker.exists())
                fail_start[0]=True;service.recover_at_start()
                self.assertTrue(marker.exists());self.assertNotIn('opened',events)
                fail_start[0]=False;verified=events.count('verified');service.recover_at_start()
                self.assertGreater(events.count('verified'),verified)
                self.assertEqual(events.count('data-complete'),1)
                self.assertFalse(marker.exists());self.assertFalse((config.parent/'platform-key-operation.json').exists())
                self.assertEqual(request('maintenance-status')['operation']['phase'],'succeeded')
                self.assertLess(events.index('data-complete'),events.index('opened'))
                self.assertLess(events.index('verified'),events.index('opened'))
                before=list(events);owner.recover();self.assertEqual(events,before)
            finally:server.shutdown();server.server_close();thread.join()

    def test_database_switch_checks_before_maintenance_and_restores_source_after_worker_failure(self):
        from installer_executor import UpgradeExecutor
        from installer_operations import PlatformOperations
        for scenario in ('success','worker','health','opening-before','opening-after','finalize-before','finalize-after','admission'):
            worker_failure=scenario=='worker'
            with self.subTest(scenario=scenario),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary);events=[];check_failure=[True];injected=[False];running=[False]
                config=root/'keys/database.json';config.parent.mkdir()
                original=json.dumps({'deploymentId':'deployment-fixture','selection':'builtin','registry':{'masterFingerprint':'sha256:'+'a'*64}})
                config.write_text(original);config.chmod(0o600)
                source={'uid':os.geteuid(),'gid':os.getegid(),'target':str(root/'release'),'values':{'DSH_PHALANX_DATA_ROOT':'/data','DSH_PHALANX_DATABASE_CONFIG_FILE':'/keys/database.json','DSH_PHALANX_HOST':'127.0.0.1','DSH_PHALANX_PORT':'3080'}}
                def command(args,**kwargs):
                    marker=root/'etc/dsh-phalanx/maintenance';journal=config.parent/'platform-database-operation.json'
                    if 'database-switch-check' in args:
                        self.assertFalse(marker.exists());self.assertNotIn('stopped',events);events.append('checked')
                        if check_failure[0]:raise InstallError('Controlled preflight refusal')
                        return SimpleNamespace(returncode=0,stdout=json.dumps({'checked':True,'deploymentId':'deployment-fixture','fingerprint':'sha256:'+'a'*64,'selection':'external'}),stderr='')
                    if 'database-switch' in args or 'database-switch-rollback' in args:
                        operation=args[args.index('--managed-operation')+1]
                        if 'database-switch' in args and worker_failure:raise InstallError('Controlled switch failure')
                        restored='database-switch-rollback' in args
                        if restored:config.write_text(original)
                        if not restored:
                            value=json.loads(original);value['selection']='external';config.write_text(json.dumps(value))
                        journal.write_text(json.dumps({'managedOperation':operation,'deploymentId':'deployment-fixture','phase':'rolled-back' if restored else 'committed','kind':'database-switch','marker':marker.read_text()}));journal.chmod(0o600)
                        events.append('restored' if restored else 'copied')
                        return SimpleNamespace(returncode=0,stdout=json.dumps({'operation':operation,'deploymentId':'deployment-fixture','fingerprint':'sha256:'+'a'*64,'status':'rolled-back' if restored else 'switched','selection':'builtin' if restored else 'external'}),stderr='')
                    if 'database-switch-finalize' in args:
                        self.assertFalse(running[0],'The real product holds PlatformLock while running')
                        if scenario=='finalize-before' and not injected[0]:
                            injected[0]=True;raise InstallError('Controlled finalization interruption')
                        if journal.exists():journal.unlink()
                        events.append('acknowledged')
                        if scenario=='finalize-after' and not injected[0]:
                            injected[0]=True;raise InstallError('Controlled finalization interruption')
                    return SimpleNamespace(returncode=0,stdout='{}',stderr='')
                host=Host(root,command)
                class Port:
                    def source(self):return source
                    def operation(self):return None
                    def stop(self,job):running[0]=False;events.append('stopped')
                    def start(self,job):running[0]=True;events.append('started')
                    def verify_source(self,*args):
                        if scenario=='health' and json.loads(config.read_text())['selection']=='external':raise InstallError('Controlled target readiness failure')
                        events.append('verified')
                    class admission:
                        @staticmethod
                        def preflight(ports):pass
                        @staticmethod
                        def close(ports):events.append('closed')
                        @staticmethod
                        def open():
                            if scenario=='admission' and not injected[0]:
                                injected[0]=True;raise InstallError('Controlled admission interruption')
                            events.append('opened')
                service=UpgradeExecutor(lambda:host,port_factory=lambda host:Port())
                value=validated_request({'action':'database-switch','target':'external'})
                with self.assertRaises(ControlError):service.handle(value)
                self.assertFalse((root/'etc/dsh-phalanx/maintenance').exists());self.assertNotIn('stopped',events)
                check_failure[0]=False
                from unittest.mock import patch
                save=PlatformOperations.save
                def uncertain_save(owner,job):
                    if job['phase']=='opening' and scenario in ('opening-before','opening-after') and not injected[0]:
                        injected[0]=True
                        if scenario=='opening-after':save(owner,job)
                        raise InstallError('Controlled uncertain durable decision')
                    save(owner,job)
                with patch.object(PlatformOperations,'save',uncertain_save):
                    service.handle(value)
                    with service.mutex:pass
                if scenario.startswith(('opening-','finalize-')) or scenario=='admission':
                    self.assertNotIn('opened',events)
                    service.recover_at_start()
                job=PlatformOperations(host,Port()).status()
                self.assertEqual(job['phase'],'restored' if scenario in ('worker','health','opening-before') else 'succeeded')
                self.assertFalse((root/'etc/dsh-phalanx/maintenance').exists())
                self.assertLess(events.index('verified'),events.index('opened'))
                if scenario in ('worker','health','opening-before'):self.assertEqual(config.read_text(),original)

if __name__=='__main__':unittest.main()
