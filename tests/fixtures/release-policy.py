"""Validate the shipped policy against the accepted formal upgrade baseline."""
from pathlib import Path
import json
from installer_compatibility import compatible
from installer_host import InstallError

policy=json.loads(Path('release-policy.json').read_text())
version=json.loads(Path('package.json').read_text())['version']
revision=json.loads(Path('runtime-versions.json').read_text())['dsh']['revision']
target={**policy,'schema':2,'targetVersion':version,'platform':'linux/amd64','dshRevision':revision,
        'storage':{'platformArchiveBytes':1,'platformExpandedBytes':1,'imageDownloadBytes':1,'imageExpandedBytes':1},'updater':'{}'}
baseline={'schema':2,'targetVersion':'0.1.23','platform':'linux/amd64','dshRevision':'687f282e8625c6b8d11ff58211a90524be2e4317',
          'compatibility':{'protocol':3,'source':{'min':'0.1.22','maxExclusive':'0.1.23'},
                           'accounts':{'sourceMin':5,'sourceMax':5,'target':5},'environmentEpoch':1},
          'storage':{'platformArchiveBytes':1,'platformExpandedBytes':1,'imageDownloadBytes':1,'imageExpandedBytes':1},'updater':'{}',
          'acceptancePolicy':{'ticket':8,'checks':['ci','linux','cleanInstall','upgrade','review']}}
compatible(baseline,target,5)
for source in [{**baseline,'targetVersion':'0.1.22'},target]:
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
print('Shipped release policy accepts formal 0.1.23 with the pinned runtime and rejects older, same-version and undeclared-runtime sources')
