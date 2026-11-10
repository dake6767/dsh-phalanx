"""Installed executor coordination with real bundled Node, PostgreSQL and service processes.

The isolated OS port substitutes only systemd/nft, which the rootless test identity
cannot own. Configuration, key operations, readiness HTTP and restart are real.
"""
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import socket
import subprocess
import sys
import uuid
from types import SimpleNamespace

sys.dont_write_bytecode=True
installed=Path(sys.argv[1]).resolve(strict=True);config=Path(sys.argv[2]);data=Path(sys.argv[3]);root=Path(sys.argv[4]);root.mkdir(mode=0o700)
sys.path.insert(0,str(installed/'updater'))
from installer_host import Host,InstallError
from installer_operations import PlatformOperations,JOURNAL,MARKER
from installer_executor_install import executor_package

build=json.loads((installed/'build-info.json').read_text());package=executor_package(installed/'updater',build['commit'])
builtin=config.parent/'builtin-database.json';assert not builtin.exists();builtin.write_bytes(config.read_bytes());builtin.chmod(0o600)
with socket.socket() as listener:
    listener.bind(('127.0.0.1',0));port=listener.getsockname()[1]
values={'DSH_PHALANX_DATA_ROOT':str(data),'DSH_PHALANX_DATABASE_CONFIG_FILE':str(config),'DSH_PHALANX_HOST':'127.0.0.1','DSH_PHALANX_PORT':str(port)}
source={'uid':os.geteuid(),'gid':os.getegid(),'target':str(installed),'values':values}
events=[];process=None;owned_groups=[]
groups=Path(os.environ['DSH_PHALANX_PROCESS_GROUPS_FILE'])

class IsolatedHost(Host):
    def path(self,path):
        return Path(path) if str(path) in (str(config),str(data)) else super().path(path)
    def tell(self,message):print(message,file=sys.stderr)
    def listener_pid(self,*args):return process.pid if process is not None and process.poll() is None else 0
    def user(self,uid,args,**kwargs):
        assert uid==os.geteuid()
        if 'systemctl' in args:return SimpleNamespace(returncode=0,stdout='',stderr='')
        return self.run(args,**kwargs)

host=IsolatedHost(root)
environment={key:value for key,value in os.environ.items() if not key.startswith('DSH_PHALANX_')}
environment.update(values,DSH_PHALANX_MAINTENANCE_FILE=str(host.path(MARKER)),DSH_PHALANX_RUNTIME_COMMAND='/unavailable-dsh',DSH_PHALANX_RUNTIME_ARGS_JSON='[]',DSH_PHALANX_ALLOWED_MODEL_PROVIDER='deepseek-official',DSH_PHALANX_ALLOWED_MODEL='fixture',DSH_PHALANX_MODEL_UPSTREAM_BASE_URL='http://127.0.0.1:1')

class Port:
    def source(self):return source
    def operation(self):return None
    def stop(self,job):
        global process
        if process is not None:
            if process.poll() is None:os.killpg(process.pid,signal.SIGTERM)
            try:process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=5)
            process.stdout.close();process=None
        events.append('stopped')
    def start(self,job):
        global process
        assert process is None
        with (root/'service.stderr').open('ab') as error:
            process=subprocess.Popen([str(installed/'start')],env=environment,stdout=subprocess.PIPE,stderr=error,start_new_session=True)
        with groups.open('a') as registry:registry.write(json.dumps({'pid':process.pid})+'\n')
        owned_groups.append(process.pid)
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout,selectors.EVENT_READ)
            output=b''
            while b'dsh-phalanx listening at ' not in output:
                assert selector.select(30),'Installed service did not report readiness'
                chunk=os.read(process.stdout.fileno(),8192)
                assert chunk,'Installed service stopped before readiness'
                output+=chunk
        events.append('started')
    def verify_source(self,source,path):
        host.ready(os.geteuid(),port,'127.0.0.1','http://127.0.0.1:'+str(port),path=path,timeout=30)
        events.append('verified')
    class admission:
        @staticmethod
        def preflight(ports):assert ports==[{'address':'127.0.0.1','port':port},{'address':'127.0.0.1','port':3081}]
        @staticmethod
        def close(ports):events.append('closed')
        @staticmethod
        def open():events.append('opened')

port_owner=Port();owner=PlatformOperations(host,port_owner)
def reject_before_maintenance():
    try:owner.begin('master-key-rotate')
    except InstallError as error:assert 'initialized' in str(error)
    else:raise AssertionError('Pre-initialization rotation was accepted')
    assert owner.status() is None and not host.path(MARKER).exists()

def legacy_recovery():
    identity=str(uuid.uuid4());saved=json.loads(config.read_text())
    marker=json.dumps({'schema':1,'ports':[{'address':'127.0.0.1','port':port},{'address':'127.0.0.1','port':3081}],'operation':identity,'operationKind':'master-key-rotate','deploymentId':saved['deploymentId']})+'\n'
    job={'schema':1,'id':identity,'action':'master-key-rotate','phase':'working','source':source,'deploymentId':saved['deploymentId'],'configFile':str(config),'marker':marker}
    host.atomic(JOURNAL,json.dumps(job)+'\n');host.atomic(MARKER,marker,0o644)
    before={path:hashlib.sha256(path.read_bytes()).hexdigest() for path in (config,builtin,Path(saved['masterKeyPath']))}
    assert owner.bootstrap_recovery_proof(source)['proof']['initializationPending'] is True
    assert owner.recover()['phase']=='restored'
    assert all(hashlib.sha256(path.read_bytes()).hexdigest()==digest for path,digest in before.items())
    assert not host.path(MARKER).exists()
    port_owner.stop(job)
    host.path(JOURNAL).unlink()

try:
    reject_before_maintenance();legacy_recovery()
    # The source adapter selects the database without preparing schema or accounts.
    program="""import { pathToFileURL } from 'node:url';
const { FilePlatformDatabaseConfig: C }=await import(pathToFileURL(process.argv[1]+'/dist/adapters/platform-database-config.js'));
const saved=C.open(process.argv[2],process.argv[3]);C.select(process.argv[2],process.argv[3],saved.connection,'builtin');
"""
    connection=subprocess.run([str(installed/'node/bin/node'),'--input-type=module','-e',program.replace("C.select(process.argv[2],process.argv[3],saved.connection,'builtin');","console.log(JSON.stringify(saved.connection));C.select(process.argv[2],process.argv[3],saved.connection,'builtin');"),str(installed),str(config),str(data)],check=True,capture_output=True,text=True).stdout.strip()
    reject_before_maintenance();legacy_recovery()
    # Recovery's real service startup initialized schema, but no administrator exists.
    original=json.loads(config.read_text());job=owner.begin('master-key-rotate')
    assert owner.run(job['id'])['phase']=='succeeded'
    changed=json.loads(config.read_text())
    assert changed['deploymentId']==original['deploymentId']
    # The old connection envelope is re-encrypted; the source owner authenticates its plaintext below.
    subprocess.run([str(installed/'node/bin/node'),'--input-type=module','-e',program.replace("C.select(process.argv[2],process.argv[3],saved.connection,'builtin');","if (JSON.stringify(saved.connection)!==(await import('node:fs')).readFileSync(0,'utf8')) throw Error('Connection changed');"),str(installed),str(config),str(data)],input=connection,text=True,check=True,capture_output=True)
    assert changed['registry']['masterFingerprint']!=original['registry']['masterFingerprint']
    assert events.index('verified')<events.index('opened')
    registered={row['pid'] for row in map(json.loads,groups.read_text().splitlines())}
    assert set(owned_groups)<=registered
    print(json.dumps({'processGroupsRegistered':True,'status':'passed','source':build['commit'],'executorPackageSha256':package['packageSha256'],'preInitializationRejected':True,'legacyRecovery':['unselected','empty-schema'],'initializedWithoutAdminRotation':True,'identitiesPreserved':True}))
finally:
    port_owner.stop(None)
