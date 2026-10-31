"""Real Unix image HTTP transport beneath the public update status seam."""
import contextlib,io,json,os,runpy,socket,socketserver,tempfile,threading,unittest
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from installer_contract_support import installer
from installer_executor import UpgradeExecutor
from installer_host import UnixImageInspector
Machine=runpy.run_path(str(Path(__file__).with_name('upgrade-machine.py')))['UpgradeMachine']

class ImageInspection(unittest.TestCase):
 def test_each_poll_reads_image_facts_without_a_cli_and_keeps_process_checks(self):
  with tempfile.TemporaryDirectory() as directory:
   machine=Machine(directory);requests=[];peers=[];reply=[200]
   class Handler(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(self,*args):pass
    def do_GET(self):
     requests.append(self.path);body=json.dumps(machine.image).encode()
     self.send_response(reply[0]);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
   class Server(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):daemon_threads=True
   path=str(machine.root/'image.sock');server=Server(path,Handler);thread=threading.Thread(target=server.serve_forever);thread.start()
   class Host(installer.Host):
    def open_image_inspector(self,uid):
     def authorize(connection):self_test.assertEqual(connection.family,socket.AF_UNIX);peers.append(uid)
     return UnixImageInspector(path,authorize)
   self_test=self
   def host():return Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0)
   with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
    h=host();h.request=lambda *a,**k:b'login';self.assertEqual(installer.main(machine.make_bundle('v0.1.1-rc.4'),h),0)
   service=UpgradeExecutor(host);machine.calls.clear()
   try:
    self.assertEqual(service.handle({'action':'status'})['runningVersion'],'v0.1.1-rc.4')
    original=machine.image['Digest'];machine.image['Digest']='sha256:'+'f'*64
    self.assertIsNone(service.handle({'action':'status'})['runningVersion'])
    machine.image['Digest']=original
    executable=machine.root/'proc/2000/exe';original_executable=executable.readlink();executable.unlink();executable.symlink_to('/foreign/node')
    self.assertIsNone(service.handle({'action':'status'})['runningVersion'])
    executable.unlink();executable.symlink_to(original_executable)
    reply[0]=404;self.assertIsNone(service.handle({'action':'status'})['runningVersion'])
    reply[0]=200;self.assertEqual(service.handle({'action':'status'})['runningVersion'],'v0.1.1-rc.4')
    self.assertEqual(len(requests),5);self.assertGreaterEqual(len(peers),2)
    service.close();self.assertIsNone(service.handle({'action':'status'})['runningVersion']);self.assertEqual(len(requests),5)
    self.assertTrue(all(path.startswith('/v4.0.0/libpod/images/') and path.endswith('/json') for path in requests))
    self.assertFalse(any('podman' in call for call in machine.calls),machine.calls)
   finally:service.close();server.shutdown();server.server_close();thread.join()

if __name__=='__main__':unittest.main()
