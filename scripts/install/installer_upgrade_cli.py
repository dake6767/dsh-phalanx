"""Public upgrade command input/output; the transaction is shared with Web."""
from pathlib import Path
from installer_host import InstallError  # embedded-host
from installer_config import read_configuration  # embedded-config
from installer_release import select_release, digest  # embedded-release
from installer_executor_install import executor_pointer,activate_executor  # embedded-executor-install
from installer_upgrade_core import UpgradeCore  # embedded-upgrade-core
from installer_upgrade_host import UpgradeHost  # embedded-upgrade-host


def selected_target(host,args,directory):
    location,manifest,version=select_release(host,args,directory)
    return {'version':version,'manifest':manifest,'manifestSha256':digest(location/'manifest.json')}


def public_operation(job):
    if job is None:return None
    return {'id':job['id'],'phase':job['phase'],'targetVersion':job['target']['manifest']['targetVersion'],
            'sourceVersion':job['source']['manifest']['targetVersion'],
            'targetCommit':job['target']['manifest']['commit'],
            'platformSha256':job['target']['manifest']['files']['dsh-phalanx-linux-amd64.tar.gz'],
            'imageDigest':job['target']['manifest']['image']['digest'],
            **{key:job[key] for key in ('failure','recoveryFailure','stopFailure','instruction') if key in job}}


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
    return 0 if job is None or job['phase'] in ('prepared','succeeded') or action=='status' else 1
