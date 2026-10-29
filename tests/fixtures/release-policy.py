"""Validate the shipped policy against the accepted formal upgrade baseline."""
from pathlib import Path
import json
from installer_compatibility import compatible,validate_contract
from installer_host import InstallError

policy=json.loads(Path('release-policy.json').read_text())
version=json.loads(Path('package.json').read_text())['version']
revision=json.loads(Path('runtime-versions.json').read_text())['dsh']['revision']
target={**policy,'schema':2,'targetVersion':version,'platform':'linux/amd64','dshRevision':revision,
        'storage':{'platformArchiveBytes':1,'platformExpandedBytes':1,'imageDownloadBytes':1,'imageExpandedBytes':1},'updater':'{}'}
baseline={'schema':2,'targetVersion':'0.1.24','platform':'linux/amd64','dshRevision':'687f282e8625c6b8d11ff58211a90524be2e4317',
          'compatibility':{'protocol':3,'source':{'min':'0.1.23','maxExclusive':'0.1.24'},
                           'accounts':{'sourceMin':5,'sourceMax':5,'target':5},'environmentEpoch':1},
          'storage':{'platformArchiveBytes':1,'platformExpandedBytes':1,'imageDownloadBytes':1,'imageExpandedBytes':1},'updater':'{}',
          'acceptancePolicy':{'ticket':9,'checks':['ci','linux','cleanInstall','upgrade']}}
try:compatible(baseline,target,5)
except InstallError as error:assert 'requires a fresh installation' in str(error)
else:raise AssertionError('Legacy formal deployment accepted')
for source in [{**baseline,'targetVersion':'0.1.23'},target]:
    try:compatible(source,target,5)
    except InstallError:pass
    else:raise AssertionError('Unqualified or same-version upgrade accepted')
# Fixture capacities do not stand in for the installed-upgrade manifest checks.
# Same-runtime upgrades need no new transition; a different source revision must
# still be explicitly admitted by protocol 3.
assert policy['compatibility']['protocol']==3
assert policy['compatibility']['sourceDshRevisions']==[baseline['dshRevision']]
if baseline['dshRevision'] != revision:
    assert baseline['dshRevision'] in policy['compatibility'].get('sourceDshRevisions',[])
undeclared={**baseline,'dshRevision':'e'*40}
try:compatible(undeclared,target,5)
except InstallError:pass
else:raise AssertionError('Undeclared source DSH revision accepted')
assert policy['compatibility']['freshInstallThrough']=='0.1.24'
# The platform-database predecessor and this version share the account schema; older formal schemas are refused above.
import re
# The newest schema is the last entry of the ordered migration list.
migrations=Path('src/adapters/platform-schema.ts').read_text().split('export const PLATFORM_MIGRATIONS',1)[1].split('\n]',1)[0]
schema=max(int(value) for value in re.findall(r'version: (\d+)',migrations))
# The target is the newest schema; the source range still admits the platform-database predecessor's schema 7.
assert policy['compatibility']['accounts']['sourceMax']==policy['compatibility']['accounts']['target']==schema
assert policy['compatibility']['accounts']['sourceMin']==7
# A same-version development rebuild over any admitted schema succeeds (6..6 once refused every real rebuild).
rebuild={**target,'platform':'linux/arm64'}
for admitted in range(policy['compatibility']['accounts']['sourceMin'],schema+1):compatible(rebuild,rebuild,admitted,development_rebuild=True)
# The range is bounded, not widened: a schema below it is still refused.
try:compatible(rebuild,rebuild,policy['compatibility']['accounts']['sourceMin']-1,development_rebuild=True)
except InstallError as error:assert 'outside the declared upgrade source range' in str(error)
else:raise AssertionError('Older account schema admitted by a development rebuild')
print('Shipped release policy refuses legacy deployments and keeps the pinned runtime contract')

import copy
for boundary in (None,'latest',version,'0.2.0'):
    invalid=copy.deepcopy(target);invalid['compatibility']['freshInstallThrough']=boundary
    try:validate_contract(invalid)
    except InstallError:pass
    else:raise AssertionError('Invalid fresh-install boundary accepted')
