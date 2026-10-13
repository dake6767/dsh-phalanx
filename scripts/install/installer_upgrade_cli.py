"""Public upgrade command input/output; the transaction is shared with Web."""
import json
from pathlib import Path
from installer_host import InstallError  # embedded-host
from installer_config import read_configuration  # embedded-config
from installer_release import select_release, digest  # embedded-release
from installer_executor_install import executor_pointer,activate_executor  # embedded-executor-install
from installer_upgrade_core import UpgradeCore  # embedded-upgrade-core
from installer_upgrade_host import UpgradeHost  # embedded-upgrade-host
from installer_executor_bootstrap import bootstrap_executor  # embedded-executor-bootstrap


def selected_target(host,args,directory):
    location,manifest,version=select_release(host,args,directory)
    return {'version':version,'manifest':manifest,'manifestSha256':digest(location/'manifest.json')}


def public_cleanup(value):
    # Detailed receipts remain in the root journal. Keep status/retry usable even
    # after years of retained backups or unknown resources.
    result={key:value[key] for key in ('status','reclaimedBytes')}
    if 'failure' in value:result['failure']=value['failure'][:1024]
    items=[];size=0
    rows=value.get('items',[])
    for row in rows:
        item={key:str(row.get(key,''))[:512] for key in ('kind','name','status','reason')}
        item['reclaimedBytes']=row.get('reclaimedBytes',0)
        length=len(json.dumps(item).encode())
        if size+length>24*1024 or len(items)>=100:break
        items.append(item);size+=length
    return {**result,'items':items,'omittedItems':len(rows)-len(items)}


def public_operation(job):
    if job is None:return None
    return {'id':job['id'],'phase':job['phase'],'targetVersion':job['target']['manifest']['targetVersion'],
            'sourceVersion':job['source']['manifest']['targetVersion'],
            'targetCommit':job['target']['manifest']['commit'],
            'platformSha256':job['target']['manifest']['files']['dsh-phalanx-linux-amd64.tar.gz'],
            'imageDigest':job['target']['manifest']['image']['digest'],
            **({'cleanup':public_cleanup(job['cleanup'])} if 'cleanup' in job else {}),
            **{key:job[key] for key in ('failure','recoveryFailure','stopFailure','instruction','space') if key in job}}


def confirm_apply(host,args):
    host.tell('Applying this update immediately restarts the service, interrupts every running task, and may lose unsaved content.')
    if args.yes:return
    if not host.terminal_available() or host.prompt('Apply this update now? [y/N]: ').lower() not in ('y','yes'):
        raise InstallError('Update was not applied. Rerun with --yes only after accepting the task interruption risk.')


def upgrade_command(host,args,temporary,target=None):
    pointer=executor_pointer(host)
    report=host.progress; values=read_configuration(host)
    report.protect(*(value for key,value in values.items() if key.endswith(('_KEY','_SECRET'))))
    port=UpgradeHost(host,args.bundle_dir); core=UpgradeCore(port)
    action=args.upgrade or 'install'
    if action=='bootstrap':
        target=target or selected_target(host,args,Path(temporary))
        with report.stage('Update executor bootstrap'):
            result=bootstrap_executor(host,port,target,Path(temporary))
        report.upgrade_result({'status':'updater-ready','executor':result,'operation':None})
        return 0
    if action in ('prepare','install'):
        target=target or selected_target(host,args,Path(temporary))
        if action=='install':confirm_apply(host,args)
        with report.stage('Upgrade preparation'):
            port.import_legacy_manifest()
            job=core.prepare(target)
        if action=='install' and job['phase']=='prepared':
            with report.stage('Upgrade application'):job=core.apply(job['id'])
    elif action=='apply':
        if not args.operation:raise InstallError('Apply requires the exact prepared --operation identity')
        confirm_apply(host,args)
        with report.stage('Upgrade application'):job=core.apply(args.operation)
    elif action=='cleanup':
        with report.stage('Owned resource cleanup'):job=core.cleanup(args.operation)
    elif action=='recover':
        with report.stage('Upgrade recovery'):
            job=core.recover(args.operation)
            if job['phase'] in ('prepared','succeeded','restored') and 'executor' in job.get('prepared',{}) and port.operation()['id']==job['id']:
                port.verify(job,old=job['phase']!='succeeded')
    else:job=core.status(args.operation)
    if job and job['phase'] in ('prepared','succeeded','restored') and executor_pointer(host)!=pointer:activate_executor(host,restart=True)
    result={'status':'upgrade','operation':public_operation(job),
            'diagnosticLog':'/var/log/dsh-phalanx/'+report.log.name if report.log else None}
    report.upgrade_result(result)
    if action=='cleanup':return 0 if job and job.get('cleanup',{}).get('status')=='succeeded' else 1
    return 0 if job is None or job['phase'] in ('prepared','succeeded') or action=='status' else 1
