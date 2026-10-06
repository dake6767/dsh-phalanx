"""Pure release protocol and source/data compatibility decisions."""
import re
from installer_host import InstallError  # embedded-host

VERSION = r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
CANDIDATE = re.compile('v'+VERSION+r'-rc\.[1-9][0-9]*\Z')
STABLE = re.compile('v'+VERSION+r'\Z')


def version_parts(value):
    if not isinstance(value,str) or not re.fullmatch(VERSION,value):
        raise InstallError('Invalid release version')
    parts=tuple(map(int,value.split('.')))
    if any(part>2**53-1 for part in parts): raise InstallError('Invalid release version')
    return parts


def positive(value):
    return type(value) is int and 0<value<=2**53-1


def validate_contract(manifest):
    if manifest.get('schema')==1 and manifest.get('targetVersion') in ('0.1.0','0.1.1'): return
    value=manifest.get('compatibility'); policy=manifest.get('acceptancePolicy')
    if not isinstance(value,dict) or not isinstance(policy,dict):raise InstallError('Unsupported release compatibility protocol')
    accounts=value.get('accounts')
    if not isinstance(accounts,dict) or not isinstance(value.get('source'),dict):raise InstallError('Unsupported release compatibility protocol')
    checks=policy.get('checks',[])
    if (manifest.get('schema')!=2 or value.get('protocol')!=1 or not positive(value.get('environmentEpoch')) or
            not all(positive(accounts.get(key)) for key in ('sourceMin','sourceMax','target')) or
            accounts['sourceMin']>accounts['sourceMax'] or accounts['target']<accounts['sourceMax'] or
            not positive(policy.get('ticket')) or not isinstance(checks,list) or
            not all(isinstance(key,str) and re.fullmatch('[a-z][A-Za-z]*',key) for key in checks) or
            len(set(checks))!=len(checks) or not {'ci','linux','cleanInstall','upgrade','review'}.issubset(checks)):
        raise InstallError('Unsupported release compatibility protocol')
    source=value.get('source',{})
    if version_parts(source.get('min'))>=version_parts(source.get('maxExclusive')) or version_parts(source['min'])>=version_parts(manifest['targetVersion']):
        raise InstallError('Invalid upgrade source interval')


def compatible(source,target,account_schema):
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
    if not (version_parts(interval['min'])<=current<version_parts(interval['maxExclusive']) and current<selected):
        raise InstallError('Release does not support this source version; historical downgrade is unavailable')
    if source['platform']!=target['platform'] or source['dshRevision']!=target['dshRevision'] or epoch!=value['environmentEpoch']:
        raise InstallError('DSH or user-environment migration is unsupported by this recovery protocol')
    if not accounts['sourceMin']<=account_schema<=accounts['sourceMax']:
        raise InstallError('Account database schema is outside the declared upgrade source range')
