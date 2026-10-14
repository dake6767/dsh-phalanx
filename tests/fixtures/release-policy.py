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
baseline={'schema':2,'targetVersion':'0.1.13','platform':'linux/amd64','dshRevision':'d743267388641bc76f17c45ce8b4c231aed1d32c',
          'compatibility':{'protocol':3,'source':{'min':'0.1.12','maxExclusive':'0.1.13'},
                           'accounts':{'sourceMin':5,'sourceMax':5,'target':5},'environmentEpoch':1},
          'storage':{'platformArchiveBytes':59915006,'platformExpandedBytes':251731968,'imageDownloadBytes':1209375232,'imageExpandedBytes':9064603648},'updater':'{}',
          'acceptancePolicy':{'ticket':12,'checks':['ci','linux','cleanInstall','upgrade','review']}}
compatible(baseline,target,5)
for source in [{**baseline,'targetVersion':'0.1.12','compatibility':{**baseline['compatibility'],'protocol':1,'source':{'min':'0.1.11','maxExclusive':'0.1.12'}}},target]:
    try:compatible(source,target,5)
    except InstallError:pass
    else:raise AssertionError('Unqualified or same-version upgrade accepted')
print('Shipped release policy accepts formal 0.1.13 and rejects unqualified transitions')
