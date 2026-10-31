"""Public upgrade command input/output; the transaction is shared with Web."""
from installer_progress import Progress,SYSTEM_UPDATE_CODES,update_phase_code,update_timing,update_diagnostic_path,update_error_code  # embedded-progress
import json
import tempfile
import time
from types import SimpleNamespace
from pathlib import Path
from installer_compatibility import STABLE, CANDIDATE, FreshInstallRequired, ReaderUpdateRequired, upgrade_outcome  # embedded-compatibility
from installer_host import InstallError  # embedded-host
from installer_config import read_configuration,installed_state  # embedded-config
from installer_release import release_channel, installed_channel, candidate_channel, metadata_missing, CANDIDATE_RELEASE_BASE, select_release, digest, asset_names, release_versions, release_notes  # embedded-release
from installer_executor_install import executor_pointer,activate_executor  # embedded-executor-install
from installer_upgrade_core import UpgradeCore  # embedded-upgrade-core
from installer_upgrade_host import UpgradeHost  # embedded-upgrade-host
from installer_executor_bootstrap import bootstrap_executor  # embedded-executor-bootstrap


def load_target(host,args,directory):
    try:location,manifest,version=select_release(host,args,directory)
    except ReaderUpdateRequired as error:
        manifest=json.loads((directory/'manifest.json').read_text())
        error.selected_version='v'+manifest['targetVersion'] if args.version=='latest' else args.version
        raise
    return {'version':version,'channel':release_channel(version),'manifest':manifest,'manifestSha256':digest(location/'manifest.json')}


def bind_channel_target(index,target):
    if (target['version']!=index['candidate'] or target['manifest']['targetVersion']!=index['targetVersion'] or
            target['manifest']['commit']!=index['commit'] or target['manifestSha256']!=index['manifestSha256']):
        raise InstallError('Candidate channel index and published run disagree')


def selected_target(host,args,directory):
    state=installed_state(host)
    explicit=getattr(args,'dev_release_base_url',None)
    current=installed_channel(state) if state else None
    if args.version=='latest' and args.bundle_dir is None and explicit is None and current and current['kind']=='candidate':
        version=UpgradeHost(host).source()['manifest']['targetVersion'] if state['version'].startswith('run-') else state['version'][1:].split('-rc.')[0]
        try:return load_target(host,SimpleNamespace(version='v'+version,bundle_dir=None,dev_release_base_url=None),directory)
        except (OSError,InstallError) as error:
            if not metadata_missing(error) or (directory/'manifest.json').exists():raise
        index=candidate_channel(host)
        try:target=load_target(host,SimpleNamespace(version=index['candidate'],bundle_dir=None,dev_release_base_url=CANDIDATE_RELEASE_BASE),directory)
        except ReaderUpdateRequired:
            bind_channel_target(index,{'version':index['candidate'],'manifest':json.loads((directory/'manifest.json').read_text()),'manifestSha256':digest(directory/'manifest.json')})
            raise
        bind_channel_target(index,target)
        return target
    if args.version.startswith('run-') and args.bundle_dir is None and explicit is None and current and current['kind']=='candidate':
        args=SimpleNamespace(**{**vars(args),'dev_release_base_url':CANDIDATE_RELEASE_BASE})
    return load_target(host,args,directory)


def select_for_check(host,selector,version,directory,dev_release_base_url=None):
    try:
        target=selector(host,SimpleNamespace(version=version,bundle_dir=None,dev_release_base_url=dev_release_base_url),directory)
        if version!='latest' and target['version']!=version:raise InstallError('Release selection identity changed')
        return target
    except ReaderUpdateRequired as error:
        # A refusal grants no install permission. Retain only the unreadable metadata identity for display.
        manifest=json.loads((directory/'manifest.json').read_text())
        selected=error.selected_version or 'v'+manifest['targetVersion']
        if not (STABLE.fullmatch(selected) or selected.startswith('run-') and CANDIDATE.fullmatch(selected)) or (version!='latest' and selected!=version):raise InstallError('Release version listing identity changed')
        return {'version':selected,'channel':release_channel(selected),'manifest':manifest,'manifestSha256':digest(directory/'manifest.json')}


def check_failure_diagnostic(host,reason,code):
    try:
        report=Progress(host.root,output='json');report.renderer.paused=True
        report.phase='Update check';report.phase_code='unknown';report.emit('failed',reason,errorCode=code)
        return update_diagnostic_path(report.log.name) if report.log else None
    except OSError:return None


def check_releases(host,port,selector=selected_target,version_lister=release_versions,requested_version='latest',dev_release_base_url=None,*,schema_reader=None):
    checked=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
    result={'checkedAt':checked}
    try:
        with tempfile.TemporaryDirectory(prefix='dsh-phalanx-check-') as directory:
            target=select_for_check(host,selector,requested_version,Path(directory),dev_release_base_url)
        if not (STABLE.fullmatch(target['version']) or target['version'].startswith('run-') and CANDIDATE.fullmatch(target['version'])):raise InstallError('Only a verified channel release can be selected')
        notes=release_notes(host,target['version'])
        result.update(version=target['version'],targetVersion=target['manifest']['targetVersion'],manifestSha256=target['manifestSha256'],releaseNotes=notes)
        try:
            port.check_fresh_install(target)
            source=port.source()
        except ReaderUpdateRequired:
            source=port.source()
        except FreshInstallRequired:
            # The verified legacy receipt authorizes refusal only, without importing a missing manifest.
            source={'manifest':{'targetVersion':installed_state(host)['version'][1:]}}
        schemas=None;versions=[]
        for version in version_lister(host,source['manifest']['targetVersion'],target['version'],target['manifest']['targetVersion']):
            with tempfile.TemporaryDirectory(prefix='dsh-phalanx-check-') as directory:
                selected=target if version==target['version'] else select_for_check(host,selector,version,Path(directory))
            if selected['version']!=version:raise InstallError('Release version listing identity changed')
            row={'version':version,'targetVersion':selected['manifest']['targetVersion'],'manifestSha256':selected['manifestSha256']}
            try:
                route=upgrade_outcome(source['manifest'],selected['manifest'],None,inspect_schema=False,source_channel=source.get('channel'),target_channel=selected.get('channel',release_channel(selected['version'])))
                if route['outcomeCode'] in ('update.available','update.channel-switch'):
                    if schemas is None:schemas=(schema_reader or port.schema)(source)
                    route=port.compatibility_outcome(source,selected,schemas)
                row.update(route,status='available' if route['outcomeCode'] in ('update.available','update.channel-switch') else 'current' if route['outcomeCode']=='update.current' else 'incompatible')
                if route['outcomeCode']=='update.reader-update-required':
                    row['reason']='This release requires updater '+route['requiredVersion']+' or newer; update the small executor with the target installer first'
                if route['outcomeCode']=='update.below-floor':
                    row.update(freshInstallRequired=True,reason='This version requires a fresh installation; upgrade floor is '+route['requiredVersion'])
            except InstallError as error:row.update(status='incompatible',outcomeCode='compatibility.unsupported',errorCode=update_error_code(error),reason=host.progress.safe(str(error)))
            versions.append(row)
        result.update(next(row for row in versions if row['version']==target['version']),versions=versions)
        # Reserve room for bounded operation/events in the 128 KiB control response.
        if len(json.dumps(result,ensure_ascii=False).encode())>48*1024:raise InstallError('Release version list exceeds the control response bound')
    except ReaderUpdateRequired as error:
        result.update(status='failed',outcomeCode='update.reader-update-required',requiredVersion=error.required_version,reason=host.progress.safe(str(error)))
    except Exception as error:
        code=update_error_code(error);reason=host.progress.safe(str(error))
        result={'checkedAt':checked,'status':'failed','errorCode':code,'reason':reason}
    code=result.get('errorCode')
    if code and (code=='unknown' or code not in SYSTEM_UPDATE_CODES['errors']):
        diagnostic=check_failure_diagnostic(host,result['reason'],code)
        if diagnostic:result['diagnosticLog']=diagnostic
    return result


def public_cleanup(value):
    # Detailed receipts remain in the root journal. Keep status/retry usable even
    # after years of retained backups or unknown resources.
    result={key:value[key] for key in ('status','reclaimedBytes')}
    if 'failure' in value:result['failure']=value['failure'][:1024]
    if 'errorCode' in value:result['errorCode']=value['errorCode']
    items=[];size=0
    rows=value.get('items',[])
    for row in rows:
        item={key:str(row.get(key,''))[:512] for key in ('kind','name','status','reason')}
        item['reclaimedBytes']=row.get('reclaimedBytes',0)
        length=len(json.dumps(item).encode())
        if size+length>24*1024 or len(items)>=100:break
        items.append(item);size+=length
    return {**result,'items':items,'omittedItems':len(rows)-len(items)}


def public_operation(job,point=None):
    if job is None:return None
    timing=update_timing(job,point);diagnostic=update_diagnostic_path(job.get('diagnostic'))
    return {'id':job['id'],'phase':job['phase'],'phaseCode':update_phase_code(job['phase']),'targetVersion':job['target']['manifest']['targetVersion'],
            'sourceVersion':job['source']['manifest']['targetVersion'],
            'targetCommit':job['target']['manifest']['commit'],
            'platformSha256':job['target']['manifest']['files'][asset_names(job['target']['manifest'])[0]],
            'imageDigest':job['target']['manifest']['image']['digest'],
            **({'diagnosticLog':diagnostic} if diagnostic else {}),
            **({'timing':timing} if timing is not None else {}),
            **({'previousDowntimeSeconds':job['previousDowntimeSeconds']} if 'previousDowntimeSeconds' in job else {}),
            **({'cleanup':public_cleanup(job['cleanup'])} if 'cleanup' in job else {}),
            **{key:job[key] for key in ('failure','failurePhase','errorCode','recoveryFailure','recoveryErrorCode','stopFailure','stopErrorCode','instruction','space') if key in job}}


def confirm_apply(host,args):
    host.tell('Applying this update immediately restarts the service, interrupts every running task, and may lose unsaved content.')
    if args.yes:return
    if not host.terminal_available() or host.prompt('Apply this update now? [y/N]: ').lower() not in ('y','yes'):
        raise InstallError('Update was not applied. Rerun with --yes only after accepting the task interruption risk.')


def upgrade_command(host,args,temporary,target=None):
    pointer=executor_pointer(host)
    report=host.progress; values=read_configuration(host)
    report.protect(*(value for key,value in values.items() if key.endswith(('_KEY','_SECRET'))))
    port=UpgradeHost(host,args.bundle_dir,dev_release_base_url=getattr(args,'dev_release_base_url',None)); core=UpgradeCore(port)
    action=args.upgrade or 'install'
    if action=='check':
        result=check_releases(host,port,requested_version=args.version,dev_release_base_url=getattr(args,'dev_release_base_url',None))
        report.upgrade_result({'check':result})
        return 1 if result['status']=='failed' else 0
    if action=='bootstrap':
        target=target or selected_target(host,args,Path(temporary))
        port.check_fresh_install(target)
        with report.stage('Update executor bootstrap',phase_code='update.bootstrap'):
            result=bootstrap_executor(host,port,target,Path(temporary))
        report.upgrade_result({'status':'updater-ready','executor':result,'operation':None})
        return 0
    if action in ('prepare','install'):
        target=target or selected_target(host,args,Path(temporary))
        port.check_fresh_install(target)
        if action=='install':confirm_apply(host,args)
        with report.stage('Upgrade preparation',phase_code='update.preparing'):
            port.import_legacy_manifest()
            job=core.prepare(target)
        if action=='install' and job['phase']=='prepared':
            with report.stage('Upgrade application',phase_code='update.stopping'):job=core.apply(job['id'])
    elif action=='apply':
        if not args.operation:raise InstallError('Apply requires the exact prepared --operation identity')
        confirm_apply(host,args)
        with report.stage('Upgrade application',phase_code='update.stopping'):job=core.apply(args.operation)
    elif action=='cleanup':
        with report.stage('Owned resource cleanup',phase_code='update.cleanup'):job=core.cleanup(args.operation)
    elif action=='recover':
        with report.stage('Upgrade recovery',phase_code='update.restoring'):
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
