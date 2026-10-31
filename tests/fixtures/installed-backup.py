"""Exercise the verified installed executor and its source-owned data layout on real files."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from types import SimpleNamespace

sys.dont_write_bytecode=True
installed=Path(sys.argv[1]).resolve(strict=True)
root=Path(sys.argv[2]);root.mkdir(mode=0o700)
build=json.loads((installed/'build-info.json').read_text())
sys.path.insert(0,str(installed/'updater'))
from installer_executor_install import executor_package
from installer_host import InstallError
from installer_progress import Progress
from installer_upgrade_backup import PlatformBackup
from installer_upgrade_host import UpgradeHost

identity=executor_package(installed/'updater',build['commit'])
upgrade=UpgradeHost.__new__(UpgradeHost)
upgrade.host=SimpleNamespace(run=lambda args:subprocess.run(args,check=True,capture_output=True,text=True))
job={'source':{'target':str(installed),'manifest':{'targetVersion':json.loads((installed/'package.json').read_text())['version']}}}
layout=upgrade.data_layout(job)
assert layout,'The installed data layout must declare rebuildable roots'
results=[];structured_progress=None
for missing in (False,True):
    scenario=root/('missing-tree' if missing else 'restore');scenario.mkdir(mode=0o700)
    data=scenario/'data';data.mkdir(mode=0o700)
    mutable=data/'mutable-index';mutable.write_text('before')
    user=data/'users/member/home/project';user.parent.mkdir(parents=True);user.write_text('member file')
    configuration=scenario/'configuration';configuration.write_text('protected before');configuration.chmod(0o600)
    retained={}
    for relative in layout:
        tree=data/relative/'old-retained';tree.mkdir(parents=True)
        (tree/'value').write_text('original artifact')
        retained[relative]=tree.stat().st_ino
    backup=PlatformBackup(data,scenario/'backup',{'configuration':configuration},rebuildable=layout)
    receipt=backup.create()
    assert receipt['schema']==2 and not (backup.directory/'data/users').exists()
    assert all(not (backup.directory/'data'/relative).exists() for relative in layout)
    mutable.write_text('after');configuration.write_text('protected after');user.write_text('retained member file')
    if missing:
        relative=layout[0]+'/old-retained';shutil.rmtree(data/relative)
        report=Progress(scenario);events=[];report.subscribe(events.append)
        with contextlib.redirect_stderr(io.StringIO()):
            try:
                with report.stage('Upgrade recovery',phase_code='update.restoring'):backup.restore(receipt)
            except InstallError as error:assert relative in str(error) and error.code=='backup.invalid'
            else:raise AssertionError('Missing retained tree was accepted')
        failed=events[-1];assert failed['status']=='failed' and failed['phaseCode']=='update.restoring' and failed['errorCode']=='backup.invalid'
        structured_progress={key:failed[key] for key in ('phaseCode','errorCode')}
        assert mutable.read_text()=='after' and configuration.read_text()=='protected after' and backup.directory.is_dir()
    else:
        added=data/layout[0]/'new-retained';added.mkdir();(added/'value').write_text('new artifact')
        backup.restore(receipt)
        assert mutable.read_text()=='before' and configuration.read_text()=='protected before'
        assert all((data/relative/'old-retained').stat().st_ino==inode for relative,inode in retained.items())
        assert (added/'value').read_text()=='new artifact'
    assert user.read_text()=='retained member file'
    results.append({'missingTree':missing,'status':'passed','retainedDirectories':len(receipt['retainedDirectories'])})
print(json.dumps({'status':'passed','source':build['commit'],'executorPackageSha256':identity['packageSha256'],'layoutEntries':len(layout),'scenarios':results,'structuredProgress':structured_progress}))
