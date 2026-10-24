"""Explicit real-Linux proof: preserve a root listener while the rootless next file passes."""
import json
import os
from pathlib import Path
import pwd
import runpy
import socket
import subprocess
import sys
import time

if __name__ == '__main__':
    if sys.argv[1:] != ['--real'] or os.geteuid() != 0:
        raise ValueError('Run explicitly as root inside the owned development VM with --real')
    source = Path(__file__).resolve().parents[2]
    account = pwd.getpwnam('dsh-phalanx')
    directory = Path('/var/lib/dsh-phalanx-dev/file-isolation-proof') / str(time.time_ns())
    directory.mkdir(parents=True)
    directory.chmod(0o755)
    result = directory / 'results'; result.mkdir(); os.chown(result, account.pw_uid, account.pw_gid)
    service = runpy.run_path(str(source / 'scripts/validation/port-owners.py'))['start'](directory / 'owners.sock', account.pw_uid)
    listener = socket.socket(); listener.bind(('127.0.0.1', 23001)); listener.listen()
    try:
        script = 'import {runFile} from '+json.dumps((source / 'scripts/validation/file-runner.mjs').as_uri())+';'
        script += 'const directory='+json.dumps(str(result))+';'
        script += "const first=await runFile({file:'foreign-root-port',index:150,directory:directory+'/first',command:[process.execPath,'-e','process.exit(9)']});"
        script += "const next=await runFile({file:'next',index:151,directory:directory+'/next',command:[process.execPath,'-e','process.exit(0)']});console.log(JSON.stringify({first,next}));"
        environment = {'HOME':account.pw_dir,'USER':account.pw_name,'LOGNAME':account.pw_name,
            'PATH':'/opt/dsh-phalanx-development-node/bin:/usr/bin:/bin','XDG_RUNTIME_DIR':'/run/user/'+str(account.pw_uid),
            'XDG_CONFIG_HOME':account.pw_dir+'/.config','DSH_PHALANX_PORT_OWNERS_SOCKET':str(directory / 'owners.sock')}
        run = subprocess.run(['runuser','-u',account.pw_name,'--','env','-i',*[key+'='+value for key,value in environment.items()],
            '/opt/dsh-phalanx-development-node/bin/node','--input-type=module','-e',script],capture_output=True,text=True,check=True)
        proof = json.loads(run.stdout)
        assert proof['first']['status'] == 'environment-failed'
        owners = json.loads(proof['first']['ownerDetails'])['processes']
        assert any(row['pid'] == os.getpid() and row['uid'] == 0 for row in owners), owners
        assert proof['next']['status'] == 'passed', proof['next']
        assert listener.fileno() >= 0
        proof.update(result='passed', rootOwnerPid=os.getpid(), rootlessUid=account.pw_uid, directory=str(directory))
        (directory / 'proof.json').write_text(json.dumps(proof,indent=2)+'\n')
        print(json.dumps({key:proof[key] for key in ('result','rootOwnerPid','rootlessUid','directory')}))
    finally:
        listener.close(); service.shutdown(); service.server_close()
        (directory / 'owners.sock').unlink()
