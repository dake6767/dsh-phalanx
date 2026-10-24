"""Read-only root port ownership service confined to Linux acceptance port ranges."""
import json
import os
from pathlib import Path
import re
import socket
import socketserver
import subprocess
import sys
import threading
import time


def inventory(base):
    if type(base) is not int or base < 20000 or base > 64000 or (base-20000) % 20:
        raise ValueError('Expected an allocated acceptance port range')
    result = subprocess.run(['ss', '-lntup'], capture_output=True, text=True, check=True)
    rows = [line for line in result.stdout.splitlines() if any(re.search(r':'+str(port)+r'(?:\s|$)', line) for port in range(base, base+20))]
    pids = sorted(set(int(pid) for row in rows for pid in re.findall(r'pid=(\d+)', row)))
    processes = []
    for pid in pids:
        row = subprocess.run(['ps', '-p', str(pid), '-o', 'pid=,uid=,user=,args='], capture_output=True, text=True)
        fields = row.stdout.strip().split(None, 3)
        if len(fields) == 4: processes.append(dict(pid=int(fields[0]), uid=int(fields[1]), user=fields[2], command=fields[3]))
    return {'capturedAt': time.time(), 'portBase': base, 'sockets': rows, 'processes': processes}


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.request.settimeout(5)
        try:
            request = json.loads(self.rfile.readline(1024))
            result = inventory(request['portBase'])
        except Exception as error:
            result = {'error': str(error)}
        self.wfile.write(json.dumps(result).encode()+b'\n')


class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


def start(path, uid):
    if os.geteuid() != 0: raise ValueError('Port ownership collection requires the owned root fixture process')
    server = Server(str(path), Handler)
    os.chmod(path, 0o600)
    os.chown(path, uid, -1)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def query(path, base):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(5)
        client.connect(str(path))
        client.sendall(json.dumps({'portBase': int(base)}).encode()+b'\n')
        with client.makefile('rb') as stream: return json.loads(stream.readline(65536))


if __name__ == '__main__':
    if len(sys.argv) != 3: raise ValueError('Usage: port-owners.py SOCKET PORT_BASE')
    print(json.dumps(query(Path(sys.argv[1]), int(sys.argv[2]))))
