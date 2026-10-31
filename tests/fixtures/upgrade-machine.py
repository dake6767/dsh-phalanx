"""Installation OS seam with multiple image identities and packaged process facts."""
import json
import hashlib
import subprocess
from pathlib import Path
from installer_contract_support import InstallationMachine

class UpgradeMachine(InstallationMachine):
    def __init__(self,root):
        super().__init__(root); self.images={}; self.after_start=None
        self.data_root_layout={'artifacts':[],'projections':[],'runtime':[],'files':['fixture-state']}

    def command(self,args,**kwargs):
        nested=args[args.index('--')+1:] if args[0]=='runuser' else []
        if '-e' in args and '/dist/domain/data-root-layout.js' in args[args.index('-e')+1]:
            self.calls.append(args)
            return subprocess.CompletedProcess(args,0,json.dumps(self.data_root_layout),'')
        if args[:2]==['podman','ps']:
            self.calls.append(args);return subprocess.CompletedProcess(args,0,'[]','')
        if nested[:1]==['systemctl'] and 'dsh-phalanx-postgres.service' in nested:
            self.calls.append(args);return subprocess.CompletedProcess(args,0,'','')
        if len(args)>1 and Path(args[1]).name=='database-adapter.mjs':
            self.calls.append(args);request=json.load(kwargs['stdin'])
            facts={'configurationSha256':'a'*64,'serverMajor':17,'selection':'builtin','estimatedBytes':8192,
                   'schemas':[{'name':name,'present':name=='dsh_phalanx','version':15 if name=='dsh_phalanx' else 0} for name in request.get('schemas',['dsh_phalanx'])]}
            action=request['action']
            if action=='prepare-tools':value={'tool':{'image':'sha256:'+'b'*64,'digest':'sha256:'+'c'*64,'major':17}}
            elif action=='inspect':value=facts
            elif action=='backup':
                archive=Path(request['directory'])/'platform.pgdump';archive.write_bytes(b'fixture-postgresql-archive');archive.chmod(0o600)
                value={'schema':1,'facts':request['facts'],'sha256':hashlib.sha256(archive.read_bytes()).hexdigest()}
            elif action=='restore':value={'restored':True}
            else:raise AssertionError(action)
            return subprocess.CompletedProcess(args,0,json.dumps(value),'')
        if nested[:2]==['podman','ps']:
            self.calls.append(args); return subprocess.CompletedProcess(args,0,'[]','')
        if nested[:3]==['podman','image','exists']:
            self.calls.append(args); return subprocess.CompletedProcess(args,0 if nested[-1] in self.images else 1,'','')
        if nested[:3]==['podman','image','inspect'] and nested[-1] in self.images:
            self.calls.append(args); return subprocess.CompletedProcess(args,0,json.dumps([self.images[nested[-1]]]),'')
        result=super().command(args,**kwargs)
        if nested[:2] in (['podman','load'],['podman','pull']):
            self.images['ghcr.io/dake6767/dsh-phalanx@'+self.image['Digest']]=self.image
        if nested[:1]==['systemctl'] and ('start' in nested or 'enable' in nested) and result.returncode==0:
            target=Path(self.running_target)
            for name,destination in (('cwd',target),('exe',target/'node/bin/node')):
                path=self.root/'proc/2000'/name; path.unlink(missing_ok=True); path.symlink_to(destination)
            if self.after_start:self.after_start(target)
        return result
