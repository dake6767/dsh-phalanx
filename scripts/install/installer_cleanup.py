"""Conservative disposal of release resources with protected installation receipts."""
import json
import os
from pathlib import Path
import re
import shutil
import stat
import uuid
from installer_host import InstallError  # embedded-host
from installer_release import asset_names,IMAGE,digest  # embedded-release
from installer_upgrade_core import ACTIVE,TERMINAL  # embedded-upgrade-core


def release_identity(manifest):return (manifest['commit'],manifest['files'][asset_names(manifest)[0]],manifest['image']['digest'])


def known_manifest(value):
    if not isinstance(value,dict):return False
    try:
        return (re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+',value['tag']) and
                re.fullmatch('[a-f0-9]{40}',value['commit']) and re.fullmatch('[a-f0-9]{40}',value['dshRevision']) and
                re.fullmatch('[a-f0-9]{64}',value['files'][asset_names(value)[0]]) and
                re.fullmatch('sha256:[a-f0-9]{64}',value['image']['digest']) and
                value['image']['reference']==IMAGE+'@'+value['image']['digest'] and
                value['image']['name']==IMAGE and value['image']['tag']==value['tag'][1:] and
                value['tag'].startswith('v'+value['targetVersion']+'-rc.'))
    except (KeyError,TypeError,InstallError):return False


def receipt_manifest(source):
    if not isinstance(source,dict) or not known_manifest(source.get('manifest')):return None
    manifest=source['manifest'];receipt=source.get('receipt',{})
    if (receipt.get('version') in (manifest['tag'],'v'+manifest['targetVersion']) and receipt.get('candidate')==manifest['tag'] and receipt.get('commit')==manifest['commit'] and
            receipt.get('platformSha256')==manifest['files'][asset_names(manifest)[0]] and receipt.get('imageDigest')==manifest['image']['digest']):return manifest
    return None


def allocation(paths):
    """Only candidate inodes, deduplicated across shared image layers and links."""
    entries={}
    def visit(path):
        try:info=path.lstat()
        except FileNotFoundError:return
        key=(info.st_dev,info.st_ino)
        if key in entries:entries[key]['paths'].add(str(path));return
        entries[key]={'paths':{str(path)},'bytes':info.st_blocks*512,'links':info.st_nlink,'directory':stat.S_ISDIR(info.st_mode)}
        if stat.S_ISDIR(info.st_mode):
            for child in path.iterdir():visit(child)
    for path in paths:visit(Path(path))
    return entries


def released(before):
    total=0
    for (device,inode),entry in before.items():
        if not entry['directory'] and entry['links']>len(entry['paths']):continue
        retained=False
        for name in entry['paths']:
            try:
                info=Path(name).lstat()
                if (info.st_dev,info.st_ino)==(device,inode):retained=True;break
            except FileNotFoundError:pass
        if not retained:total+=entry['bytes']
    return total


class UpgradeCleanup:
    def __init__(self,host,journal):self.host=host;self.journal=Path(journal)

    def inventory(self,source):
        current=receipt_manifest(source)
        if current is None:raise InstallError('Cannot verify current installation ownership')
        known={release_identity(current):current};protected={release_identity(current):'current version'};successes=[];records=[]
        owner=self.journal.stat().st_uid
        for directory in self.journal.iterdir():
            if not directory.is_dir() and not directory.is_symlink():continue
            if directory.is_symlink():raise InstallError('Unverified update journal; keep resources for recovery')
            file=directory/'operation.json'
            if file.is_symlink() or not file.is_file():raise InstallError('Incomplete update journal; keep resources for recovery')
            info=file.stat()
            if info.st_uid!=owner or info.st_mode & 0o022:raise InstallError('Unverified update journal ownership')
            try:record=json.loads(file.read_text())
            except (OSError,ValueError) as error:raise InstallError('Unreadable update journal; keep resources for recovery') from error
            if not isinstance(record,dict) or record.get('id')!=directory.name:raise InstallError('Inconsistent update journal identity')
            records.append((info.st_mtime_ns,record))
        for _,record in sorted(records,key=lambda row:row[0]):
            old=receipt_manifest(record.get('source'));new=record.get('target',{}).get('manifest')
            if old is None or record.get('source',{}).get('uid')!=source['uid']:raise InstallError('Unverified historical installation receipt')
            known[release_identity(old)]=old;successes.append(old)
            if known_manifest(new):
                known[release_identity(new)]=new
                if record.get('committed') or record.get('phase')=='succeeded':successes.append(new)
            if record.get('phase') not in TERMINAL or record.get('phase')=='recovery-failed':
                protected[release_identity(old)]='unfinished update or recovery'
                if known_manifest(new):protected[release_identity(new)]='prepared or unfinished target'
        for manifest in reversed(successes):
            if release_identity(manifest)!=release_identity(current):protected.setdefault(release_identity(manifest),'most recent successful previous version');break
        return known,protected

    def container_references(self,uid):
        rows=json.loads(self.host.user(uid,['podman','ps','--all','--format','json']).stdout)
        if not isinstance(rows,list):raise InstallError('Cannot inspect all container references')
        refs=set();mounts=set()
        for row in rows:
            container=row.get('Id',row.get('ID'))
            if not isinstance(container,str) or not re.fullmatch('[a-f0-9]{12,64}',container):raise InstallError('Container identity is unavailable')
            facts=json.loads(self.host.user(uid,['podman','container','inspect',container]).stdout)
            if not isinstance(facts,list) or len(facts)!=1:raise InstallError('Container references are unavailable')
            value=facts[0].get('Image')
            if not isinstance(value,str) or not re.fullmatch('(sha256:)?[a-f0-9]{64}',value):raise InstallError('Container image reference is unavailable')
            refs.add(value.removeprefix('sha256:'))
            for mount in facts[0].get('Mounts',[]):
                if mount.get('Source'):mounts.add(Path(mount['Source']).resolve())
        return {'images':refs,'mounts':mounts}

    def mounted(self,path,uid):
        return any(path.is_relative_to(mount) or mount.is_relative_to(path) for mount in self.container_references(uid)['mounts'])

    def process_reference(self,path):
        # Root reads all processes; disappearing processes are harmless, unreadable
        # process state is not evidence that a program is unused.
        for process in self.host.path('/proc').iterdir():
            if not process.name.isdecimal():continue
            try:
                links=[process/'cwd',process/'exe']
                descriptors=process/'fd'
                if descriptors.exists():links.extend(descriptors.iterdir())
                for link in links:
                    if link.is_symlink() and link.resolve().is_relative_to(path):return True
                maps=process/'maps'
                if maps.exists():
                    for line in maps.read_text().splitlines():
                        parts=line.split(None,5)
                        if len(parts)==6 and parts[5].startswith('/') and Path(parts[5].removesuffix(' (deleted)')).is_relative_to(path):return True
            except FileNotFoundError:continue
        return False

    def remove_image(self,uid,image_id,facts):
        tags=facts.get('RepoTags') or []
        if len(tags)>1:
            # Untag only already-verified owned aliases; rmi never forces past a
            # container reference or recursively prunes a parent/shared layer.
            self.host.user(uid,['podman','untag',image_id,*tags])
            changed=json.loads(self.host.user(uid,['podman','image','inspect',image_id]).stdout)[0]
            if changed.get('RepoTags') or changed.get('Digest')!=facts.get('Digest'):raise InstallError('Image names changed during cleanup')
        if image_id in self.container_references(uid)['images']:raise InstallError('A container now references this image')
        self.host.user(uid,['podman','rmi','--no-prune',image_id])

    def image_paths(self,facts,graph):
        driver=facts.get('GraphDriver',{});data=driver.get('Data',{})
        values=[data.get('UpperDir',''),*data.get('LowerDir','').split(':')]
        paths=[]
        if driver.get('Name')!='overlay':raise InstallError('Cannot measure this image storage driver safely')
        for value in filter(None,values):
            path=self.host.path(value).resolve()
            if not path.is_relative_to(graph) or path==graph:raise InstallError('Image layer is outside managed storage')
            if path not in paths:paths.append(path)
        if not paths:raise InstallError('Image layer allocation is unavailable')
        return paths

    def run(self,source,job,persist):
        save=persist
        receipt=self.journal/job['id']/('cleanup-'+uuid.uuid4().hex+'.json')
        def persist():
            self.host.atomic(str(receipt.relative_to(self.host.root)),json.dumps(result)+'\n')
            self.host.sync_directory(receipt.parent)
            save()
        uid=source['uid']
        data_roots=[self.host.path(value).resolve() for key,value in source['values'].items() if key in ('DSH_PHALANX_DATA_ROOT','DSH_PHALANX_USER_DATA_ROOT')]
        data_roots.extend([self.journal.resolve(),self.host.path('/opt/dsh-phalanx/updaters').resolve()])
        previous=job.get('cleanup',{})
        result={'status':'running','reclaimedBytes':previous.get('reclaimedBytes',0),'items':[]}
        job['cleanup']=result;persist()
        try:
            def record(kind,name,status,reason,bytes_=0):
                result['items']=[item for item in result['items'] if (item['kind'],item['name'])!=(kind,name)]
                result['items'].append({'kind':kind,'name':name,'status':status,'reason':reason,'reclaimedBytes':bytes_})
                result['reclaimedBytes']+=bytes_;persist()
            def dispose(kind,name,paths,check,remove):
                if any(Path(path).resolve().is_relative_to(root) or root.is_relative_to(Path(path).resolve()) for path in paths for root in data_roots):
                    record(kind,name,'retained','user and platform data');return
                record(kind,name,'pending','verified owned resource')
                try:
                    check();before=allocation(paths)
                    devices={}
                    for path in paths:
                        path=Path(path);device=path.stat().st_dev
                        devices.setdefault(device,(path.parent,shutil.disk_usage(path).free))
                    remove()
                    observed=0
                    for parent,free in devices.values():
                        while not parent.exists():parent=parent.parent
                        observed+=max(0,shutil.disk_usage(parent).free-free)
                    record(kind,name,'removed','unused owned resource',min(released(before),observed))
                except Exception as error:record(kind,name,'failed',self.host.progress.safe(str(error)) if self.host.progress else 'Cleanup failed; retry')
            try:known,protected=self.inventory(source)
            except Exception as error:
                record('journal','update history','failed',self.host.progress.safe(str(error)) if self.host.progress else 'Cannot verify installation history')
                result['status']='failed';persist();return result
            releases=self.host.path('/opt/dsh-phalanx/releases');cache=self.host.path('/var/cache/dsh-phalanx')
            by_name={manifest['tag']+'-'+manifest['files'][asset_names(manifest)[0]][:16]:(key,manifest) for key,manifest in known.items()}
            for path in releases.iterdir():
                pair=by_name.get(path.name)
                if path.is_symlink() or not path.is_dir() or pair is None:record('program',str(path),'retained','ownership is unknown');continue
                key,manifest=pair
                if key in protected:record('program',str(path),'retained',protected[key]);continue
                if self.process_reference(path):record('program',str(path),'retained','referenced by a running process');continue
                if self.mounted(path,uid):record('program',str(path),'retained','referenced by a container mount');continue
                def verified(path=path,manifest=manifest):
                    if path.is_symlink() or not path.is_dir() or (path/'.artifact-sha256').read_text()!=manifest['files'][asset_names(manifest)[0]] or json.loads((path/'build-info.json').read_text())['commit']!=manifest['commit']:raise InstallError('Program ownership changed')
                    if path.resolve()==self.host.path('/opt/dsh-phalanx/current').resolve():raise InstallError('Program is now current')
                    if self.process_reference(path):raise InstallError('A process now references this program')
                    if self.mounted(path,uid):raise InstallError('A container now references this program')
                dispose('program',str(path),[path],verified,lambda path=path:shutil.rmtree(path))
            by_sha={manifest['files'][asset_names(manifest)[0]]:(key,manifest) for key,manifest in known.items()}
            if cache.exists():
                for path in cache.iterdir():
                    pair=by_sha.get(path.name.removesuffix('.tar.gz')) if path.name.endswith('.tar.gz') else None
                    if path.is_symlink() or not path.is_file() or pair is None:record('cache',str(path),'retained','ownership is unknown');continue
                    key,manifest=pair
                    if key in protected:record('cache',str(path),'retained',protected[key]);continue
                    if self.mounted(path,uid):record('cache',str(path),'retained','referenced by a container mount');continue
                    if self.process_reference(path):record('cache',str(path),'retained','referenced by a running process');continue
                    def verified(path=path,manifest=manifest):
                        if path.is_symlink() or not path.is_file() or digest(path)!=manifest['files'][asset_names(manifest)[0]]:raise InstallError('Cached archive ownership changed')
                        if self.mounted(path,uid) or self.process_reference(path):raise InstallError('The cached archive is now referenced')
                    dispose('cache',str(path),[path],verified,lambda path=path:path.unlink())
            try:
                store=json.loads(self.host.user(uid,['podman','info','--format','json']).stdout)['store'];graph=self.host.path(store['graphRoot']).resolve()
                ids={value.removeprefix('sha256:') for value in self.host.user(uid,['podman','images','--no-trunc','--format','{{.ID}}']).stdout.split()}
                for image_id in sorted(ids):
                    if not re.fullmatch('[a-f0-9]{64}',image_id):raise InstallError('Image identity is unavailable')
                    facts=json.loads(self.host.user(uid,['podman','image','inspect',image_id]).stdout)[0]
                    matches=[(key,manifest) for key,manifest in known.items() if facts.get('Digest')==manifest['image']['digest'] and facts.get('Config',{}).get('Labels',{}).get('org.opencontainers.image.revision')==manifest['commit'] and facts['Config']['Labels'].get('dsh.revision')==manifest['dshRevision']]
                    if not matches:record('image',image_id,'retained','ownership is unknown');continue
                    reason=next((protected[key] for key,_ in matches if key in protected),None)
                    if image_id in self.container_references(uid)['images']:reason='referenced by a running or stopped container'
                    tags=facts.get('RepoTags') or []
                    allowed={IMAGE+':'+value for _,manifest in matches for value in (manifest['tag'][1:],manifest['targetVersion'])}
                    if any(tag not in allowed for tag in tags):reason='has an unowned image name'
                    if reason:record('image',image_id,'retained',reason);continue
                    paths=self.image_paths(facts,graph)
                    def verified(image_id=image_id,facts=facts):
                        if image_id in self.container_references(uid)['images']:raise InstallError('A container now references this image')
                        if json.loads(self.host.user(uid,['podman','image','inspect',image_id]).stdout)[0]!=facts:raise InstallError('Image references or identity changed')
                    dispose('image',image_id,paths,verified,lambda image_id=image_id,facts=facts:self.remove_image(uid,image_id,facts))
            except Exception as error:record('image','rootless storage','failed',self.host.progress.safe(str(error)) if self.host.progress else 'Cannot inspect image ownership')
            for path in self.journal.iterdir():
                if path.is_dir() and not path.is_symlink() and (path/'backup').exists():record('backup',str(path/'backup'),'retained','historical data backup')
            record('data',source['values']['DSH_PHALANX_DATA_ROOT'],'retained','user and platform data')
            result['status']='failed' if any(item['status']=='failed' for item in result['items']) else 'succeeded';persist()
            return result
        except Exception as error:
            result['status']='failed'
            result['failure']=self.host.progress.safe(str(error)) if self.host.progress else 'Cannot inspect owned resources; retry cleanup'
            persist()
            return result
