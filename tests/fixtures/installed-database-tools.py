"""Installed Python/Node archive preparation against a stopped fixture's real TLS database."""
import fcntl
import json
import os
from pathlib import Path
import sys
import uuid

sys.dont_write_bytecode=True
installed=Path(sys.argv[1]).resolve(strict=True)
root=Path(sys.argv[2]).resolve(strict=True)
sys.path.insert(0,str(installed/'updater'))
from installer_executor_install import executor_package
from installer_host import Host
from installer_upgrade_backup import UpgradeDatabaseBackup
from installer_upgrade_host import UpgradeHost

build=json.loads((installed/'build-info.json').read_text())
identity=executor_package(installed/'updater',build['commit'])
host=Host(root)
host.download_sources={'containerMirror':json.loads((root/'request.json').read_text())['mirror']}

port=UpgradeHost(host)
job={'id':str(uuid.uuid4()),'phase':'preparing',
    'source':{'target':str(installed),'uid':os.geteuid(),'manifest':{'targetVersion':json.loads((installed/'package.json').read_text())['version'],'compatibility':{'schemas':[{'name':'dsh_phalanx'}]}},
              'values':{'DSH_PHALANX_DATABASE_CONFIG_FILE':'/config/database.json','DSH_PHALANX_DATA_ROOT':'/data'}},
    'target':{'manifest':{'compatibility':{'schemas':[{'name':'dsh_phalanx'}]}}}}
lock=host.mkdir('/run/lock',mode=None)/'dsh-phalanx-install.lock'
with os.fdopen(os.open(lock,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'w') as lease:
    fcntl.flock(lease,fcntl.LOCK_EX|fcntl.LOCK_NB);host.install_lock_fd=lease.fileno()
    port.save(job)
    database=UpgradeDatabaseBackup(port,job)
    assert port.schema(job['source'])=={'dsh_phalanx':15}
    database.inspect()
    assert 'tool' not in job['database'] and job['database']['facts']['estimatedBytes']>=0
    database.prepare()
    facts=job['database']['facts'];tool=job['database']['tool']
    assert tool['major']==facts['serverMajor'] and facts['selection']=='external'
    schemas=[{key:row[key] for key in ('name','present','version')} for row in facts['schemas']]
    assert schemas==[{'name':'dsh_phalanx','present':True,'version':15}]
print(json.dumps({'status':'passed','source':build['commit'],'executorPackageSha256':identity['packageSha256'],
                 'serverMajor':facts['serverMajor'],'estimatedBytes':facts['estimatedBytes'],'schemas':schemas,'tool':tool}))
