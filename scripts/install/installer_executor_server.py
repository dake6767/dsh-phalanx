"""Unix HTTP I/O exit with kernel peer identity and bounded closed JSON requests."""
import json
import os
import socket
import socketserver
import struct
from http.server import BaseHTTPRequestHandler
from installer_executor_protocol import ControlError,validated_request


def peer_uid(connection):return struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]

class ControlHandler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass

    def send_value(self,status,value):
        body=json.dumps(value).encode()
        self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)))
        self.send_header('Connection','close')
        try:self.end_headers();self.wfile.write(body)
        except (BrokenPipeError,ConnectionResetError):pass
        self.close_connection=True

    def do_POST(self):
        try:
            self.connection.settimeout(10)
            if self.server.peer_reader(self.connection) not in (0,self.server.uid):raise ControlError(403,'Update control access denied')
            if self.path!='/control':raise ControlError(404,'Unknown update control endpoint')
            if self.headers.get('Transfer-Encoding') or self.headers.get('Content-Type','').split(';')[0]!='application/json':
                raise ControlError(400,'A bounded JSON update request is required')
            size=int(self.headers.get('Content-Length','0'))
            if not 0<size<=4096:raise ControlError(400,'Invalid update request size')
            value=validated_request(json.loads(self.rfile.read(size)))
            result=self.server.service.handle(value)
            self.send_value(200,result)
        except ControlError as error:
            self.send_value(error.status,{'error':str(error)})
        except (ValueError,TimeoutError):self.send_value(400,{'error':'Invalid update request'})
        except (BrokenPipeError,ConnectionResetError):pass  # Disconnect never cancels the accepted worker.
        except Exception:self.send_value(503,{'error':'Update executor unavailable; use server recovery and inspect its journal.'})

class ControlServer(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):
    daemon_threads=True
    def __init__(self,path,service,uid,peer_reader=peer_uid):
        self.service=service;self.uid=uid;self.peer_reader=peer_reader
        super().__init__(path,ControlHandler);os.chmod(path,0o660)
