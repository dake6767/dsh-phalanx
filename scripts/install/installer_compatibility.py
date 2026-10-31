"""Pure release protocol and source/data compatibility decisions."""
import re
from installer_host import InstallError  # embedded-host

VERSION = r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
LEGACY_CANDIDATE = re.compile('v'+VERSION+r'-rc\.[1-9][0-9]*\Z')
CANDIDATE = re.compile(r'(?:v'+VERSION+r'-rc\.[1-9][0-9]*|run-[1-9][0-9]*)\Z')
STABLE = re.compile('v'+VERSION+r'\Z')


def version_parts(value):
    if not isinstance(value,str) or not re.fullmatch(VERSION,value):
        raise InstallError('Invalid release version')
    parts=tuple(map(int,value.split('.')))
    if any(part>2**53-1 for part in parts): raise InstallError('Invalid release version')
    return parts


def candidate_image_tag(tag):
    if not isinstance(tag,str) or not CANDIDATE.fullmatch(tag):raise InstallError('Invalid candidate identity')
    return tag[1:] if LEGACY_CANDIDATE.fullmatch(tag) else tag


def candidate_identity(manifest):
    tag=manifest.get('tag'); run=manifest.get('runId')
    if not isinstance(tag,str) or not CANDIDATE.fullmatch(tag):return False
    try:version_parts(manifest.get('targetVersion'))
    except InstallError:return False
    if LEGACY_CANDIDATE.fullmatch(tag):return manifest['targetVersion']==tag.split('-rc.')[0][1:]
    return manifest.get('schema')==2 and isinstance(run,str) and re.fullmatch(r'[1-9][0-9]*',run) is not None and tag=='run-'+run


def positive(value):
    return type(value) is int and 0<value<=2**53-1


# Capability version: raise only when older executors cannot perform the transaction.
# Ordinary target releases do not increase this version.
READER_VERSION = '0.1.27'

class ReaderUpdateRequired(InstallError):
    def __init__(self,version):
        self.required_version=version
        self.selected_version=None
        super().__init__('This release requires updater '+version+' or newer; update the small executor with the target installer first')


def require_reader(manifest,reader_version=READER_VERSION):
    value=manifest.get('compatibility',{})
    minimum=value.get('minimumReader') if isinstance(value,dict) else None
    if minimum is not None:
        if version_parts(reader_version)<version_parts(minimum):raise ReaderUpdateRequired(minimum)
        return True
    return False


def supports_capacity(manifest):
    protocol=manifest.get('compatibility',{}).get('protocol')
    return type(protocol) is int and protocol>=3


def validate_contract(manifest):
    if manifest.get('schema')==1 and manifest.get('targetVersion') in ('0.1.0','0.1.1'): return
    declared_reader=require_reader(manifest)
    value=manifest.get('compatibility'); policy=manifest.get('acceptancePolicy')
    if not isinstance(value,dict) or not isinstance(policy,dict):raise InstallError('Unsupported release compatibility protocol')
    accounts=value.get('accounts')
    if not isinstance(accounts,dict) or not isinstance(value.get('source'),dict):raise InstallError('Unsupported release compatibility protocol')
    checks=policy.get('checks',[])
    required={'ci','linux','upgrade'} if version_parts(manifest.get('targetVersion'))>=(0,1,24) else {'ci','linux','cleanInstall','upgrade','review'}
    if (manifest.get('schema')!=2 or not positive(value.get('protocol')) or (value['protocol']>3 and not declared_reader) or not positive(value.get('environmentEpoch')) or
            not all(positive(accounts.get(key)) for key in ('sourceMin','sourceMax','target')) or
            accounts['sourceMin']>accounts['sourceMax'] or accounts['target']<accounts['sourceMax'] or
            not positive(policy.get('ticket')) or not isinstance(checks,list) or
            not all(isinstance(key,str) and re.fullmatch('[a-z][A-Za-z]*',key) for key in checks) or
            len(set(checks))!=len(checks) or not required.issubset(checks) or
            version_parts(manifest['targetVersion'])>=(0,1,24) and not set(checks).issubset({'ci','linux','upgrade','cleanInstall'})):
        raise InstallError('Unsupported release compatibility protocol')
    if version_parts(manifest['targetVersion'])>=(0,1,13) and value['protocol']<3:
        raise InstallError('This release requires capacity-aware upgrade protocol 3')
    if value['protocol']>=3:
        sizes=manifest.get('storage',{})
        if not isinstance(sizes,dict) or not all(positive(sizes.get(key)) for key in ('platformArchiveBytes','platformExpandedBytes','imageDownloadBytes','imageExpandedBytes')):
            raise InstallError('Release storage requirements are missing or invalid')
        if not isinstance(manifest.get('updater'),str) or len(manifest['updater'].encode())>16384:
            raise InstallError('Release updater inventory is missing or unbounded')
    revisions=value.get('sourceDshRevisions')
    if value['protocol']==2 or (value['protocol']>=3 and 'sourceDshRevisions' in value):
        if (not isinstance(revisions,list) or not revisions or
                not all(isinstance(revision,str) and re.fullmatch('[a-f0-9]{40}',revision) for revision in revisions) or
                len(set(revisions))!=len(revisions)):
            raise InstallError('Runtime transition requires exact source DSH revisions')
    elif revisions is not None:raise InstallError('Protocol 1 cannot declare a runtime transition')
    through=value.get('freshInstallThrough')
    if 'freshInstallThrough' in value and (value['protocol']<3 or version_parts(through)>=version_parts(manifest['targetVersion']) or accounts['sourceMin']<6):
        raise InstallError('Invalid fresh-install compatibility boundary')
    if 'schemas' in value:
        rows=value['schemas']; names=set()
        if not isinstance(rows,list) or not rows or not isinstance(rows[0],dict) or rows[0].get('name')!='dsh_phalanx':
            raise InstallError('Registered schema compatibility must begin with the platform core')
        for row in rows:
            name=row.get('name') if isinstance(row,dict) else None
            if (not isinstance(name,str) or not re.fullmatch('[a-z_][a-z0-9_]{0,62}',name) or
                    name.startswith('pg_') or name in ('public','information_schema') or name in names or
                    type(row.get('sourceMin')) is not int or not 0<=row['sourceMin']<=2**53-1 or
                    type(row.get('sourceMax')) is not int or not row['sourceMin']<=row['sourceMax']<=2**53-1 or
                    not positive(row.get('target')) or row['target']<row['sourceMax']):
                raise InstallError('Invalid registered schema compatibility range')
            names.add(name)
        if any(rows[0][key]!=accounts[key] for key in ('sourceMin','sourceMax','target')):
            raise InstallError('Legacy accounts must match the platform core compatibility range')
    floor=value.get('upgradeFloor')
    if 'upgradeFloor' in value and version_parts(floor)>=version_parts(manifest['targetVersion']):
        raise InstallError('Invalid upgrade floor')
    if 'breakpoints' in value:
        points=value['breakpoints'];previous=None;previous_epoch=0
        if not isinstance(points,list):raise InstallError('Invalid upgrade breakpoints')
        for point in points:
            if not isinstance(point,dict):raise InstallError('Invalid upgrade breakpoint')
            version=version_parts(point.get('version'));epoch=point.get('environmentEpoch')
            if (version>version_parts(manifest['targetVersion']) or (floor is not None and version<version_parts(floor)) or
                    (previous is not None and version<=previous) or not positive(epoch) or epoch<previous_epoch or epoch>value['environmentEpoch']):
                raise InstallError('Invalid ordered upgrade breakpoints')
            previous=version;previous_epoch=epoch
    source=value.get('source',{})
    if version_parts(source.get('min'))>=version_parts(source.get('maxExclusive')) or version_parts(source['min'])>=version_parts(manifest['targetVersion']):
        raise InstallError('Invalid upgrade source interval')


class FreshInstallRequired(InstallError):
    pass


def upgrade_source_boundary(source,target):
    """The single source-version boundary, usable before invoking any source CLI."""
    validate_contract(target)
    value=target.get('compatibility',{});floor=value.get('upgradeFloor');through=value.get('freshInstallThrough')
    if floor is not None and version_parts(source['targetVersion'])<version_parts(floor):
        return {'outcomeCode':'update.below-floor','requiredVersion':floor}
    if through is not None and version_parts(source['targetVersion'])<=version_parts(through):
        return {'outcomeCode':'update.below-floor','requiredVersion':floor or value['source']['min']}
    return None


def require_upgrade_source(source,target):
    boundary=upgrade_source_boundary(source,target)
    if boundary is not None:
        raise FreshInstallRequired('This version requires a fresh installation; upgrade floor is '+boundary['requiredVersion']+'. Back up the existing deployment and follow https://github.com/dake6767/dsh-phalanx/blob/main/docs/install.md#recoverable-system-updates')


def reuse_rehearsal(source,target,account_schema):
    if isinstance(account_schema,dict):account_schema=account_schema.get('dsh_phalanx')
    identity=source.get('imageIdentity')
    return (isinstance(identity,dict) and identity==target.get('imageIdentity') and
            source.get('imageSelection',{}).get('rehearsal') is True and target.get('imageSelection',{}).get('rehearsal') is True and
            all(re.fullmatch(r'run-[1-9][0-9]*',value['tag']) for value in (source,target)) and
            source['runId']!=target['runId'] and source['commit']!=target['commit'] and
            source['targetVersion']==target['targetVersion'] and source['dshRevision']==target['dshRevision'] and
            source['compatibility']['accounts']['target']==target['compatibility']['accounts']['target']==account_schema)


def upgrade_outcome(source,target,account_schema,*,development_rebuild=False,image_reuse_rehearsal=False,inspect_schema=True,source_channel=None,target_channel=None):
    try:boundary=upgrade_source_boundary(source,target)
    except ReaderUpdateRequired as error:return {'outcomeCode':'update.reader-update-required','requiredVersion':error.required_version}
    if boundary is not None:return boundary
    if target.get('schema')!=2: raise InstallError('Upgrade target must declare the release compatibility protocol',code='compatibility.unsupported')
    value=target['compatibility']; old=source.get('compatibility')
    if old is None:
        if source.get('schema')!=1 or source.get('targetVersion')!='0.1.1':
            raise InstallError('This legacy deployment must enter 0.1.1 before a protocol upgrade',code='compatibility.unsupported')
        epoch=1
    else:
        validate_contract(source); epoch=old['environmentEpoch']
    current=version_parts(source['targetVersion']); selected=version_parts(target['targetVersion'])
    interval=value['source']; accounts=value['accounts']
    for point in value.get('breakpoints',[]):
        if current<version_parts(point['version'])<selected:
            return {'outcomeCode':'update.breakpoint-required','requiredVersion':point['version']}
    local_rebuild=(development_rebuild and source['platform']==target['platform']=='linux/arm64' and current==selected)
    if image_reuse_rehearsal and not reuse_rehearsal(source,target,account_schema):
        raise InstallError('Image reuse rehearsal requires distinct marked candidates with the same version, image and account schema',code='compatibility.unsupported')
    channel_switch=(current==selected and (source_channel or source.get('channel',{})).get('kind')=='candidate' and (target_channel or target.get('channel',{})).get('kind')=='formal')
    if current>=selected and not (local_rebuild or image_reuse_rehearsal or channel_switch):return {'outcomeCode':'update.current'}
    if not (local_rebuild or image_reuse_rehearsal or channel_switch) and not (version_parts(interval['min'])<=current<version_parts(interval['maxExclusive']) and current<selected):
        raise InstallError('Release does not support this source version; historical downgrade is unavailable',code='compatibility.unsupported')
    runtime_allowed=(source['dshRevision']==target['dshRevision'] or
                     (value['protocol']>=2 and source['dshRevision'] in value.get('sourceDshRevisions',[])))
    epoch_entry=any(version_parts(point['version'])==selected and point['environmentEpoch']==value['environmentEpoch'] and epoch<point['environmentEpoch'] for point in value.get('breakpoints',[]))
    if source['platform']!=target['platform'] or not runtime_allowed or (epoch!=value['environmentEpoch'] and not epoch_entry):
        raise InstallError('DSH or user-environment migration is unsupported by this recovery protocol',code='compatibility.unsupported')
    if not inspect_schema:return {'outcomeCode':'update.channel-switch' if channel_switch else 'update.available'}
    schemas=value.get('schemas')
    if schemas is None:
        recorded=account_schema.get('dsh_phalanx') if isinstance(account_schema,dict) else account_schema
        if type(recorded) is not int or not accounts['sourceMin']<=recorded<=accounts['sourceMax']:
            raise InstallError('Account database schema is outside the declared upgrade source range',code='compatibility.unsupported')
    else:
        recorded=account_schema if isinstance(account_schema,dict) else {'dsh_phalanx':account_schema}
        for row in schemas:
            version=recorded.get(row['name'],0)
            if type(version) is not int or not row['sourceMin']<=version<=row['sourceMax']:
                raise InstallError('Database schema '+row['name']+' is outside the declared upgrade source range',code='compatibility.unsupported')
    return {'outcomeCode':'update.channel-switch' if channel_switch else 'update.available'}


def compatible(source,target,account_schema,*,development_rebuild=False,image_reuse_rehearsal=False,source_channel=None,target_channel=None):
    outcome=upgrade_outcome(source,target,account_schema,development_rebuild=development_rebuild,image_reuse_rehearsal=image_reuse_rehearsal,source_channel=source_channel,target_channel=target_channel)
    if outcome['outcomeCode']=='update.reader-update-required':raise ReaderUpdateRequired(outcome['requiredVersion'])
    if outcome['outcomeCode']=='update.below-floor':raise FreshInstallRequired('This version requires a fresh installation; upgrade floor is '+outcome['requiredVersion'])
    if outcome['outcomeCode']=='update.breakpoint-required':raise InstallError('Upgrade to '+outcome['requiredVersion']+' before this release',code='compatibility.unsupported')
    if outcome['outcomeCode']=='update.current':raise InstallError('Release does not support this source version; historical downgrade is unavailable',code='compatibility.unsupported')


def plugin_readiness_budget(library, target):
    """Four bounded preparation stages, cleanup and startup/recovery allowance."""
    if not isinstance(library,dict) or library.get('schema')!=1 or not isinstance(library.get('plugins'),list):
        raise InstallError('Invalid plugin library for startup budget')
    count=0
    for row in library['plugins']:
        if not isinstance(row,dict):raise InstallError('Invalid plugin library record')
        if not row.get('removing') and row.get('checkedFor')!=target:
            count+=1+int(bool(row.get('replacement')))
    return 90+2700*count
