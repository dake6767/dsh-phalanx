"""Small, release-bound executor bootstrap before platform/image downloads."""
import hashlib
import json
import re
from pathlib import Path
from installer_host import InstallError  # embedded-host
from installer_release import RELEASE_BASE, CANDIDATE_RELEASE_BASE  # embedded-release
from installer_executor_install import REQUIRED,executor_package,install_executor,activate_executor,BANKS  # embedded-executor-install
from installer_upgrade_core import ACTIVE  # embedded-upgrade-core
from installer_storage import capacity_plan,filesystem_capacity,MIB  # embedded-storage


def bootstrap_executor(host,port,target,temporary):
    port.check_fresh_install(target)
    job=port.operation()
    if job and job['phase'] in (*ACTIVE,'prepared'):raise InstallError('Finish or recover the existing update before executor bootstrap')
    if host.path('/etc/dsh-phalanx/maintenance').exists():raise InstallError('Recover the interrupted update before executor bootstrap')
    source=port.source();manifest=target['manifest']
    port.check_compatibility(source,target)
    if manifest['compatibility']['protocol']!=3:raise InstallError('This release does not support a capacity-aware executor bootstrap')
    port.verify_source(source)
    raw=manifest['updater'];inventory=json.loads(raw)
    files=inventory.get('files')
    if (inventory.get('schema')!=1 or inventory.get('sourceCommit')!=manifest['commit'] or
            not isinstance(files,dict) or set(files)!=REQUIRED or
            any(not isinstance(value,str) or not re.fullmatch('[a-f0-9]{64}',value) for value in files.values())):
        raise InstallError('Release updater inventory is invalid')
    # Bounded source, staging bank and final bank coexist. No runtime image or
    # platform archive is needed; the platform service continues serving.
    plan=capacity_plan([{'path':str(temporary),'purpose':'small updater download','bytes':4*MIB},
                       {'path':str(host.path(BANKS)),'purpose':'small updater bank','bytes':8*MIB}],filesystem_capacity)
    if not plan['sufficient']:raise InstallError('Insufficient disk space for the small updater bootstrap')
    package=Path(temporary)/'bootstrap';updater=package/'updater';updater.mkdir(parents=True)
    asset=manifest.get('updaterAsset')
    if (not isinstance(asset,dict) or asset.get('name')!='updater.json' or
            not isinstance(asset.get('sha256'),str) or not re.fullmatch('[a-f0-9]{64}',asset['sha256'])):
        raise InstallError('Release has no verified updater asset; select a completed release with updater.json')
    base=CANDIDATE_RELEASE_BASE if target['version'].startswith('run-') else RELEASE_BASE
    body=host.request(base+'/download/'+target['version']+'/updater.json',max_bytes=4*MIB)
    if hashlib.sha256(body).hexdigest()!=asset['sha256']:raise InstallError('Release updater asset checksum mismatch')
    sources=json.loads(body)
    if not isinstance(sources,dict) or set(sources)!=set(files):raise InstallError('Release updater asset inventory mismatch')
    received=0
    for name,expected in files.items():
        text=sources[name]
        if not isinstance(text,str):raise InstallError('Release updater source must be text')
        body=text.encode();received+=len(body)
        if len(body)>512*1024 or received>4*MIB or hashlib.sha256(body).hexdigest()!=expected:raise InstallError('Release updater source checksum or size mismatch')
        (updater/name).write_bytes(body)
    (updater/'manifest.json').write_text(raw)
    executor_package(updater,manifest['commit'])
    result=install_executor(host,source['uid'],source['gid'],package,manifest['commit'])
    activate_executor(host,restart=True)
    host.tell('Capacity-aware updater installed. The platform remains running; return to System update to download the selected release.')
    return result
