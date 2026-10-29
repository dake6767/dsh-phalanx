"""Starting a retained VM must not rebuild or install a different product."""
import json,os,subprocess,tempfile
from pathlib import Path
with tempfile.TemporaryDirectory() as temporary:
 root=Path(temporary);bin=root/'bin';bin.mkdir();home=root/'lima';(home/'development').mkdir(parents=True);cache=root/'cache';log=root/'calls'
 source=Path('.').resolve()
 (home/'.dsh-phalanx-checkout').write_text(str(source)+'\n');(home/'.dsh-phalanx-version').write_text(json.loads((source/'package.json').read_text())['version']+'\n');(home/'.dsh-phalanx-image-cache').write_text(str(cache)+'\n');(home/'development/lima.yaml').write_text('owned fixture')
 scripts={'uname':'if [ "$1" = -m ]; then echo arm64; else echo Darwin; fi', 'sysctl':'echo 17179869184','df':'printf "Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 100000000 0 36700160 0%% /\\n"', 'python3':'if [ "$1" = - ]; then exit 0; else exec /usr/bin/python3 "$@"; fi', 'limactl':'''printf '%s\\n' "$*" >> "$FIXTURE_CALLS"
case "$1" in list) echo 'development Stopped';; start) exit 0;; shell) case "${@: -1}" in clock) echo ready;; *) exit 90;; esac;; *) exit 91;; esac'''}
 for name,body in scripts.items():
  p=bin/name;p.write_text('#!/bin/bash\n'+body+'\n');p.chmod(0o755)
 result=subprocess.run(['bash',str(source/'scripts/dev/vm.sh'),'start'],env={**os.environ,'PATH':str(bin)+':'+os.environ['PATH'],'DSH_PHALANX_VM_HOME':str(home),'DSH_PHALANX_IMAGE_CACHE':str(cache),'FIXTURE_CALLS':str(log)},capture_output=True,text=True)
 assert result.returncode==0,result.stderr
 calls=log.read_text().splitlines();assert sum(row.startswith('start ') for row in calls)==1,calls
 assert all(row.startswith(('list ','start ','shell ')) for row in calls),calls
 assert not any('guest.py up' in row or 'guest.py test' in row or row.startswith('create ') for row in calls),calls
 assert not (home/'.operation-lock').exists() and not (cache/'.operation-lock').exists()
 print('Retained VM start preserves product bytes and releases both locks.')
