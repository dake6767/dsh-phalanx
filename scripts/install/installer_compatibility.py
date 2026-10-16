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


def validate_contract(manifest):
    if manifest.get('schema')==1 and manifest.get('targetVersion') in ('0.1.0','0.1.1'): return
    value=manifest.get('compatibility'); policy=manifest.get('acceptancePolicy')
    if not isinstance(value,dict) or not isinstance(policy,dict):raise InstallError('Unsupported release compatibility protocol')
    accounts=value.get('accounts')
    if not isinstance(accounts,dict) or not isinstance(value.get('source'),dict):raise InstallError('Unsupported release compatibility protocol')
    checks=policy.get('checks',[])
    if (manifest.get('schema')!=2 or type(value.get('protocol')) is not int or value['protocol'] not in (1,2,3) or not positive(value.get('environmentEpoch')) or
            not all(positive(accounts.get(key)) for key in ('sourceMin','sourceMax','target')) or
            accounts['sourceMin']>accounts['sourceMax'] or accounts['target']<accounts['sourceMax'] or
            not positive(policy.get('ticket')) or not isinstance(checks,list) or
            not all(isinstance(key,str) and re.fullmatch('[a-z][A-Za-z]*',key) for key in checks) or
            len(set(checks))!=len(checks) or not {'ci','linux','cleanInstall','upgrade','review'}.issubset(checks)):
        raise InstallError('Unsupported release compatibility protocol')
    if version_parts(manifest['targetVersion'])>=(0,1,13) and value['protocol']!=3:
        raise InstallError('This release requires capacity-aware upgrade protocol 3')
    if value['protocol']==3:
        sizes=manifest.get('storage',{})
        if not isinstance(sizes,dict) or not all(positive(sizes.get(key)) for key in ('platformArchiveBytes','platformExpandedBytes','imageDownloadBytes','imageExpandedBytes')):
            raise InstallError('Release storage requirements are missing or invalid')
        if not isinstance(manifest.get('updater'),str) or len(manifest['updater'].encode())>16384:
            raise InstallError('Release updater inventory is missing or unbounded')
    revisions=value.get('sourceDshRevisions')
    if value['protocol']==2 or (value['protocol']==3 and 'sourceDshRevisions' in value):
        if (not isinstance(revisions,list) or not revisions or
                not all(isinstance(revision,str) and re.fullmatch('[a-f0-9]{40}',revision) for revision in revisions) or
                len(set(revisions))!=len(revisions)):
            raise InstallError('Runtime transition requires exact source DSH revisions')
    elif revisions is not None:raise InstallError('Protocol 1 cannot declare a runtime transition')
    source=value.get('source',{})
    if version_parts(source.get('min'))>=version_parts(source.get('maxExclusive')) or version_parts(source['min'])>=version_parts(manifest['targetVersion']):
        raise InstallError('Invalid upgrade source interval')


def reuse_rehearsal(source,target,account_schema):
    identity=source.get('imageIdentity')
    return (isinstance(identity,dict) and identity==target.get('imageIdentity') and
            source.get('imageSelection',{}).get('rehearsal') is True and target.get('imageSelection',{}).get('rehearsal') is True and
            all(re.fullmatch(r'run-[1-9][0-9]*',value['tag']) for value in (source,target)) and
            source['runId']!=target['runId'] and source['commit']!=target['commit'] and
            source['targetVersion']==target['targetVersion'] and source['dshRevision']==target['dshRevision'] and
            source['compatibility']['accounts']['target']==target['compatibility']['accounts']['target']==account_schema)


def compatible(source,target,account_schema,*,development_rebuild=False,image_reuse_rehearsal=False):
    validate_contract(target)
    if target.get('schema')!=2: raise InstallError('Upgrade target must declare the release compatibility protocol')
    value=target['compatibility']; old=source.get('compatibility')
    if old is None:
        if source.get('schema')!=1 or source.get('targetVersion')!='0.1.1':
            raise InstallError('This legacy deployment must enter 0.1.1 before a protocol upgrade')
        epoch=1
    else:
        validate_contract(source); epoch=old['environmentEpoch']
    current=version_parts(source['targetVersion']); selected=version_parts(target['targetVersion'])
    interval=value['source']; accounts=value['accounts']
    local_rebuild=(development_rebuild and source['platform']==target['platform']=='linux/arm64' and current==selected)
    if image_reuse_rehearsal and not reuse_rehearsal(source,target,account_schema):
        raise InstallError('Image reuse rehearsal requires distinct marked candidates with the same version, image and account schema')
    if not (local_rebuild or image_reuse_rehearsal) and not (version_parts(interval['min'])<=current<version_parts(interval['maxExclusive']) and current<selected):
        raise InstallError('Release does not support this source version; historical downgrade is unavailable')
    runtime_allowed=(source['dshRevision']==target['dshRevision'] or
                     (value['protocol'] in (2,3) and source['dshRevision'] in value.get('sourceDshRevisions',[])))
    if source['platform']!=target['platform'] or not runtime_allowed or epoch!=value['environmentEpoch']:
        raise InstallError('DSH or user-environment migration is unsupported by this recovery protocol')
    if not accounts['sourceMin']<=account_schema<=accounts['sourceMax']:
        raise InstallError('Account database schema is outside the declared upgrade source range')


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
