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
baseline={'schema':2,'targetVersion':'0.1.17','platform':'linux/amd64','dshRevision':'1517a4dbca0a2789ff1d41ba439600f8547d23fa',
          'compatibility':{'protocol':3,'source':{'min':'0.1.16','maxExclusive':'0.1.17'},
                           'accounts':{'sourceMin':5,'sourceMax':5,'target':5},'environmentEpoch':1},
          'storage':{'platformArchiveBytes':59888950,'platformExpandedBytes':253304832,'imageDownloadBytes':1209371136,'imageExpandedBytes':9064603648},'updater':'{}',
          'acceptancePolicy':{'ticket':8,'checks':['ci','linux','cleanInstall','upgrade','review']}}
compatible(baseline,target,5)
for source in [{**baseline,'targetVersion':'0.1.16'},target]:
    try:compatible(source,target,5)
    except InstallError:pass
    else:raise AssertionError('Unqualified or same-version upgrade accepted')
# The pinned runtime is a declared transition: the formal source revision left
# the previous release with a different DSH commit, so protocol 3 must name that
# exact revision and refuse one it does not name.
transitions=policy['compatibility'].get('sourceDshRevisions')
assert policy['compatibility']['protocol']==3, 'A runtime transition requires protocol 3'
assert isinstance(transitions,list) and transitions, 'Runtime transition requires exact source DSH revisions'
undeclared={**baseline,'dshRevision':'e'*40}
try:compatible(undeclared,target,5)
except InstallError:pass
else:raise AssertionError('Undeclared source DSH revision accepted')
print('Shipped release policy accepts formal 0.1.17, the declared runtime transition, and rejects undeclared source revisions')
