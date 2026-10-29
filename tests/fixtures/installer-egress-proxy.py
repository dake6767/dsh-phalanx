"""Installation/update HTTP and product-user pulls cross an authenticated CONNECT proxy."""
import base64
import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import runpy
import select
import socket
import ssl
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.request
from unittest.mock import patch
from installer_contract_support import installer, InstallationMachine
from release_asset_support import stable_assets
from installer_executor import UpgradeExecutor

run_bundle=runpy.run_path(str(Path(__file__).with_name('installer-development.py')))['run_bundle']


@contextlib.contextmanager
def connect_fixture(root, bundle):
    cert=root/'proxy-ca.pem'; key=root/'proxy-key.pem'; config=root/'cert.cnf'
    config.write_text('[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=github.com\n[ext]\nsubjectAltName=DNS:github.com,DNS:registry.fixture.test,DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n')
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',str(config),'-keyout',str(key),'-out',str(cert)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    requests=[]; connects=[]; forwarded=[]; unavailable=[]
    class Assets(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_GET(self):
            requests.append(self.path)
            name=self.path.rsplit('/',1)[-1]
            if self.path=='/v2/':body=b'{}'
            elif (bundle/name).is_file():body=(bundle/name).read_bytes()
            else:self.send_error(404);return
            self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    target=ThreadingHTTPServer(('127.0.0.1',0),Assets)
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(cert,key);target.socket=context.wrap_socket(target.socket,server_side=True)
    class Proxy(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_GET(self):
            if self.headers.get('Proxy-Authorization')!='Basic '+base64.b64encode(b'fixture-user:fixture-proxy-password').decode():self.send_error(407);return
            if self.path!='http://packages.fixture.test/index':self.send_error(403);return
            forwarded.append(self.path);body=b'package-index';self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        def do_CONNECT(self):
            if unavailable:self.send_error(503);return
            if self.headers.get('Proxy-Authorization')!='Basic '+base64.b64encode(b'fixture-user:fixture-proxy-password').decode():self.send_error(407);return
            connects.append(self.path)
            if self.path not in ('github.com:443','registry.fixture.test:443'):self.send_error(403);return
            with socket.create_connection(('127.0.0.1',target.server_port)) as upstream:
                self.send_response(200);self.end_headers()
                while True:
                    ready,_,_=select.select([self.connection,upstream],[],[],5)
                    if not ready:return
                    for source in ready:
                        data=source.recv(65536)
                        if not data:return
                        (upstream if source is self.connection else self.connection).sendall(data)
    proxy=ThreadingHTTPServer(('127.0.0.1',0),Proxy)
    threads=[threading.Thread(target=s.serve_forever,daemon=True) for s in (target,proxy)]
    for thread in threads:thread.start()
    try:yield {'url':f'http://fixture-user:fixture-proxy-password@127.0.0.1:{proxy.server_port}', 'cert':str(cert),'direct':f'https://localhost:{target.server_port}/v2/','connects':connects,'requests':requests,'forwarded':forwarded,'fail':lambda:unavailable.append(True)}
    finally:
        for server in (proxy,target):server.shutdown();server.server_close()
        for thread in threads:thread.join()


class EgressProxy(unittest.TestCase):
    def test_install_upgrade_web_check_and_pull_reuse_protected_proxy_without_disclosing_it(self):
        for case in ('install','upgrade'):
            with self.subTest(case=case),tempfile.TemporaryDirectory() as directory:
                support=runpy.run_path(str(Path(__file__).with_name('upgrade-cleanup.py')))
                machine=support['CleanupMachine'](directory) if case=='upgrade' else InstallationMachine(directory)
                args,bundle,manifest=run_bundle(machine);stable_assets(bundle,manifest)
                host=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0)
                if case=='upgrade':
                    image=machine.image_facts;before=machine.make_bundle('v0.1.15-rc.1','f','f')
                    file=Path(before[3])/'manifest.json';prior=json.loads(file.read_text());prior.update({k:manifest[k] for k in ('schema','compatibility','acceptancePolicy','storage','updater')});file.write_text(json.dumps(prior))
                    host.request=lambda *a,**k:b'login'
                    with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):self.assertEqual(installer.main(before,host),0)
                    data=machine.root/'var/lib/dsh-phalanx/data';data.mkdir()
                    with contextlib.closing(sqlite3.connect(data/'community-accounts.db')) as connection:connection.execute('PRAGMA user_version=5')
                    machine.database_schema=5
                    machine.image_facts=image
                with connect_fixture(Path(directory),bundle) as proxy:
                    inherited={k:v for k,v in os.environ.items() if k.lower() not in ('http_proxy','https_proxy','all_proxy','no_proxy')}
                    inherited['SSL_CERT_FILE']=proxy['cert']
                    if case=='install':inherited.update(https_proxy=proxy['url'],no_proxy='localhost,.internal.test')
                    else:
                        inherited['no_proxy']='*'  # Saved exclusions must win over the invoking shell.
                        config=host.path('/etc/dsh-phalanx/environment');config.write_text(config.read_text()+'HTTPS_PROXY="'+proxy['url']+'"\nNO_PROXY="localhost,.internal.test"\n')
                    host=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0);wire=host.request
                    host.request=lambda url,**kw:wire(url,**kw) if url.startswith('https://') else b'login'
                    pulls=[]
                    def command(argv,**kw):
                        if argv[0]=='apt-get':
                            env=kw['env'];self.assertEqual(env.get('http_proxy'),proxy['url'])
                            response=subprocess.run([sys.executable,'-c',"import urllib.request; print(urllib.request.urlopen('http://packages.fixture.test/index',timeout=3).read().decode())"],env=env,capture_output=True,text=True,check=True)
                            self.assertEqual(response.stdout.strip(),'package-index')
                        if 'podman' in argv and 'pull' in argv:
                            env=kw['env'];self.assertEqual(env.get('HTTPS_PROXY'),proxy['url']);self.assertEqual(env.get('https_proxy'),proxy['url'])
                            response=subprocess.run([sys.executable,'-c',"import urllib.request; print(urllib.request.urlopen('https://registry.fixture.test/v2/',timeout=3).read().decode())"],env={**env,'SSL_CERT_FILE':proxy['cert']},capture_output=True,text=True,check=True)
                            self.assertEqual(response.stdout.strip(),'{}')
                            pulls.append(True)
                        return machine.command(argv,**kw)
                    host.command=command
                    with patch.dict(os.environ,inherited,clear=True),patch('installer_upgrade_host.LinuxAdmissionGate',support['GATE']),contextlib.redirect_stdout(out:=io.StringIO()),contextlib.redirect_stderr(err:=io.StringIO()):
                        result=installer.main([*args[:2],*args[4:],'--dev-release-base-url','https://github.com/dake6767/dsh-phalanx-candidates/releases','--yes','--verbose','--output','json'],host)
                        self.assertEqual(result,0,out.getvalue())
                        saved=installer.read_configuration(host);self.assertEqual(saved['HTTPS_PROXY'],proxy['url']);self.assertIn('.internal.test',saved['NO_PROXY'])
                        self.assertEqual(host.path('/etc/dsh-phalanx/environment').stat().st_mode&0o007,0)
                        self.assertTrue(pulls);self.assertIn('registry.fixture.test:443',proxy['connects'])
                        executor=UpgradeExecutor(host_factory=lambda:host)
                        self.assertEqual(executor.check()['check']['status'],'current')
                        count=len(proxy['connects']);self.assertEqual(wire(proxy['direct']),b'{}');self.assertEqual(len(proxy['connects']),count)
                        proxy['fail']()
                        failed=executor.check()['check'];self.assertEqual(failed['status'],'failed');self.assertIn('HTTPS_PROXY',failed['reason']);self.assertNotIn('fixture-proxy-password',failed['reason'])
                    visible=out.getvalue()+err.getvalue()+host.path('/etc/dsh-phalanx/install-state.json').read_text()+''.join(p.read_text() for p in host.path('/var/log/dsh-phalanx').glob('*'))
                    self.assertNotIn('fixture-proxy-password',visible);self.assertNotIn(proxy['url'],visible)
                    self.assertTrue(all('api.github.com' not in row for row in proxy['connects']))


if __name__=='__main__':unittest.main()
