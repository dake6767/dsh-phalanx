"""Run verified candidate programs at the installer account/systemd OS seam.

The fixture owns only its temporary tree and child process group. It borrows the
T2 rootless image without mutating the image store. Product HTTP readiness is real;
admission, account creation and kernel service discovery remain controlled.
"""
import os
from pathlib import Path
import runpy
import shlex
import signal
import socket
import subprocess

UpgradeMachine=runpy.run_path(str(Path(__file__).with_name('upgrade-machine.py')))['UpgradeMachine']

class CandidateMachine(UpgradeMachine):
    def __init__(self,root):
        super().__init__(root);self.process=None;self.log=None
        with socket.socket() as listener:
            listener.bind(('127.0.0.1',0));self.port=listener.getsockname()[1]
        with socket.socket() as listener:
            listener.bind(('127.0.0.1',0));self.gateway=listener.getsockname()[1]
        path=self.root/'proc/net/tcp';path.write_text(path.read_text().replace('46A0',f'{self.port:04X}'))
        (self.root/'model-key').write_text('fixture-model-key');(self.root/'model-key').chmod(0o600)

    def close(self):
        if self.process:
            if self.process.poll() is None:
                os.killpg(self.process.pid,signal.SIGTERM)
                try:self.process.wait(timeout=20)
                except subprocess.TimeoutExpired:os.killpg(self.process.pid,signal.SIGKILL);self.process.wait(timeout=10)
            self.process=None
        if self.log:self.log.close();self.log=None

    def command(self,args,**kwargs):
        nested=args[args.index('--')+1:] if args[0]=='runuser' else []
        if args[0].endswith('/node/bin/node'):
            self.calls.append(args);return subprocess.run(args,capture_output=True,text=True)
        if nested[:1]==['systemctl'] and 'stop' in nested:self.close()
        result=super().command(args,**kwargs)
        if nested[:1]==['systemctl'] and ('start' in nested or 'enable' in nested) and result.returncode==0 and self.process is None:
            target=Path(self.running_target)
            env=dict(os.environ)
            for line in (self.root/'etc/dsh-phalanx/environment').read_text().splitlines():
                if line and not line.startswith('#'):
                    key,value=shlex.split(line)[0].split('=',1)
                    if key in ('DSH_PHALANX_DATA_ROOT','DSH_PHALANX_USER_DATA_ROOT','DSH_PHALANX_MAINTENANCE_FILE'):
                        value=str(self.root/value.lstrip('/'))
                    env[key]=value
            self.log=(self.root/'platform.log').open('a')
            self.process=subprocess.Popen([str(target/'start')],cwd=target,env=env,stdout=self.log,stderr=self.log,start_new_session=True)
            # Read process facts from the actual child; keep the fixture's service PID mapping.
            (self.root/'proc/2000/cwd').unlink();(self.root/'proc/2000/cwd').symlink_to(Path('/proc')/str(self.process.pid)/'cwd')
            (self.root/'proc/2000/exe').unlink();(self.root/'proc/2000/exe').symlink_to(Path('/proc')/str(self.process.pid)/'exe')
        return result
