"""Peak write capacity, grouped by the actual destination filesystem."""
import os
import json
import stat
import re
from pathlib import Path
from installer_host import InstallError  # embedded-host
from installer_release import asset_names  # embedded-release
from installer_upgrade_backup import EXCLUDED, excluded_path, rebuildable_paths  # embedded-upgrade-backup

MIB=1024*1024


def capacity_plan(writes,probe,*,reserve=16*MIB):
    locations={}
    for write in writes:
        size=write['bytes']
        if type(size) is not int or size<0:raise InstallError('Cannot determine required disk capacity',code='disk.inspection-failed')
        device,available=probe(write['path'])
        if device is None or type(available) is not int or available<0:raise InstallError('Cannot determine available disk capacity',code='disk.inspection-failed')
        row=locations.setdefault(device,{'paths':[],'purposes':[],'availableBytes':available,'requiredBytes':0})
        row['availableBytes']=min(row['availableBytes'],available)
        if write['path'] not in row['paths']:row['paths'].append(write['path'])
        if write['purpose'] not in row['purposes']:row['purposes'].append(write['purpose'])
        if size>0 and row['requiredBytes']==0:row['requiredBytes']+=reserve
        row['requiredBytes']+=size
    rows=list(locations.values())
    for row in rows:row['shortfallBytes']=max(0,row['requiredBytes']-row['availableBytes'])
    return {'sufficient':all(row['shortfallBytes']==0 for row in rows),'locations':rows}


def filesystem_capacity(path):
    current=Path(path)
    while not current.exists():
        if current==current.parent:raise InstallError('Capacity destination has no existing parent',code='disk.inspection-failed')
        current=current.parent
    try:
        facts=os.stat(current);space=os.statvfs(current)
        return facts.st_dev,space.f_bavail*space.f_frsize
    except OSError as error:raise InstallError('Cannot inspect destination filesystem capacity',code='disk.inspection-failed') from error


def allocated_files(path):
    """Observe backup occupancy without following links or removing anything."""
    root=Path(path)
    if not root.exists():return 0
    seen=set();total=0
    def visit(item):
        nonlocal total
        info=item.lstat();identity=(info.st_dev,info.st_ino)
        if identity in seen:return
        seen.add(identity);total+=info.st_blocks*512
        if item.is_dir() and not item.is_symlink():
            for child in item.iterdir():visit(child)
    visit(root)
    return total


def backup_capacity(root,rebuildable=(),*,exclude=True):
    total=0
    excluded=(*EXCLUDED,*rebuildable_paths(rebuildable)) if exclude else ()
    def visit(path,relative='.'):
        nonlocal total
        info=path.lstat()
        if stat.S_ISREG(info.st_mode):total+=((info.st_size+4095)//4096)*4096
        elif stat.S_ISDIR(info.st_mode):
            total+=4096
            for child in path.iterdir():
                key=child.name if relative=='.' else relative+'/'+child.name
                if not excluded_path(key,excluded):visit(child,key)
        elif stat.S_ISLNK(info.st_mode):total+=4096
        else:raise InstallError('Platform backup rejects special files',code='disk.inspection-failed')
    visit(root)
    return total


def missing_image_capacity(layers,known_chains):
    if not isinstance(layers,list) or not layers:raise InstallError('Image layer capacity facts are missing',code='disk.inspection-failed')
    for layer in layers:
        if (not isinstance(layer,dict) or not isinstance(layer.get('diffId'),str) or
                not re.fullmatch('sha256:[a-f0-9]{64}',layer['diffId']) or
                any(type(layer.get(key)) is not int or not 0<layer[key]<=2**53-1 for key in ('downloadBytes','expandedBytes'))):
            raise InstallError('Image layer capacity facts are invalid',code='disk.inspection-failed')
    reused=0
    for chain in known_chains:
        if not isinstance(chain,list) or not all(isinstance(value,str) for value in chain):raise InstallError('Cannot inspect installed image layers',code='disk.inspection-failed')
        count=0
        for layer,known in zip(layers,chain):
            if layer['diffId']!=known:break
            count+=1
        reused=max(reused,count)
    missing=layers[reused:]
    return sum(layer['downloadBytes'] for layer in missing),sum(layer['expandedBytes'] for layer in missing)*2


class UpgradeStorage:
    def __init__(self,host,probe=filesystem_capacity):self.host=host;self.probe=probe

    def plan(self,job,directory,bundle=None,*,carriers=()):
        target=job['target']['manifest'];sizes=target.get('storage')
        keys=('platformArchiveBytes','platformExpandedBytes','imageDownloadBytes','imageExpandedBytes')
        if not isinstance(sizes,dict) or any(type(sizes.get(key)) is not int or not 0<sizes[key]<=2**53-1 for key in keys):
            raise InstallError('Release does not declare verified storage requirements',code='disk.inspection-failed')
        source=job['source'];uid=source['uid']
        store=json.loads(self.host.user(uid,['podman','info','--format','json']).stdout).get('store',{})
        graph=store.get('graphRoot');image_tmp=store.get('imageCopyTmpDir')
        if any(not isinstance(path,str) or not Path(path).is_absolute() for path in (graph,image_tmp)):
            raise InstallError('Cannot determine rootless image storage locations',code='disk.inspection-failed')
        exists=self.host.user(uid,['podman','image','exists',target['image']['reference']],check=False).returncode
        if exists not in (0,1):raise InstallError('Cannot inspect image reuse for capacity planning',code='disk.inspection-failed')
        download,expanded=(0,0) if exists==0 else (sizes['imageDownloadBytes'],sizes['imageExpandedBytes'])
        if exists==1 and 'imageLayers' in sizes:
            installed=json.loads(self.host.user(uid,['podman','image','inspect',source['manifest']['image']['reference']]).stdout)
            if not isinstance(installed,list) or len(installed)!=1:raise InstallError('Cannot inspect installed image layers',code='disk.inspection-failed')
            download,expanded=missing_image_capacity(sizes['imageLayers'],[installed[0].get('RootFS',{}).get('Layers')])
            if bundle:download=sizes['imageDownloadBytes']

        cache=self.host.path('/var/cache/dsh-phalanx')
        staged=self.host.path('/opt/dsh-phalanx/releases/'+target['tag']+'-'+target['files'][asset_names(target)[0]][:16])
        marker=staged/'.artifact-sha256'
        prepared=marker.is_file() and not staged.is_symlink() and marker.read_text()==target['files'][asset_names(target)[0]]
        data=self.host.path(source['values']['DSH_PHALANX_DATA_ROOT'])
        estimated=(backup_capacity(data,job.get('dataLayout',()))+
                   sum(backup_capacity(path,exclude=False) for path in carriers if path.exists() or path.is_symlink())+
                   job.get('database',{}).get('facts',{}).get('estimatedBytes',0))
        backup=estimated*2+16*MIB
        writes=[{'path':str(directory),'purpose':'platform backup and recovery','bytes':backup},
                {'path':str(cache),'purpose':'download cache','bytes':0 if 'prepared' in job or bundle else sizes['platformArchiveBytes']},
                {'path':str(directory),'purpose':'temporary platform download','bytes':0 if 'prepared' in job or bundle else sizes['platformArchiveBytes']},
                {'path':str(staged.parent),'purpose':'platform extraction','bytes':0 if prepared else sizes['platformExpandedBytes']},
                {'path':str(self.host.path(graph)),'purpose':'rootless image layers and import','bytes':expanded},
                {'path':str(self.host.path(image_tmp)),'purpose':'image download staging','bytes':download},
                {'path':str(data),'purpose':'platform migration and recovery reserve','bytes':backup}]
        result=capacity_plan(writes,self.probe)
        result['backupBytes']=estimated+sum(allocated_files(path/'backup') for path in Path(directory).parent.iterdir() if path.is_dir() and not path.is_symlink())
        return result

    def check(self,job,directory,bundle=None,*,carriers=()):
        result=self.plan(job,directory,bundle,carriers=carriers);job['space']=result
        for row in result['locations']:
            self.host.tell('Disk capacity '+', '.join(row['paths'])+': required '+str(row['requiredBytes'])+' bytes; available '+str(row['availableBytes'])+' bytes')
        if not result['sufficient']:raise InstallError('Insufficient disk space before download or service stop; inspect the capacity report',code='disk.insufficient')
        return result
