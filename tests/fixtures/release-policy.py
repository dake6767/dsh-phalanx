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
baseline={'schema':2,'targetVersion':'0.1.12','platform':'linux/amd64','dshRevision':'d743267388641bc76f17c45ce8b4c231aed1d32c',
          'compatibility':{'protocol':1,'source':{'min':'0.1.11','maxExclusive':'0.1.12'},
                           'accounts':{'sourceMin':5,'sourceMax':5,'target':5},'environmentEpoch':1},
          'acceptancePolicy':{'ticket':12,'checks':['ci','linux','cleanInstall','upgrade','review']}}
compatible(baseline,target,5)
for source in [{**baseline,'targetVersion':'0.1.11','compatibility':{**baseline['compatibility'],'source':{'min':'0.1.10','maxExclusive':'0.1.11'}}},target]:
    try:compatible(source,target,5)
    except InstallError:pass
    else:raise AssertionError('Unqualified or same-version upgrade accepted')
print('Shipped release policy accepts formal 0.1.12 and rejects unqualified transitions')
