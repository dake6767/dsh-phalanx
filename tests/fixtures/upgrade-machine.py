"""Installation OS seam with multiple image identities and packaged process facts."""
import json
import subprocess
from pathlib import Path
from installer_contract_support import InstallationMachine

class UpgradeMachine(InstallationMachine):
    def __init__(self,root):
        super().__init__(root); self.images={}; self.after_start=None

    def command(self,args,**kwargs):
        nested=args[args.index('--')+1:] if args[0]=='runuser' else []
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
