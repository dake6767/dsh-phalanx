"""Verified platform-carrier snapshots. Member homes/workspaces are excluded."""
import hashlib
import os
from pathlib import Path
import shutil
import stat
from installer_host import InstallError  # embedded-host

EXCLUDED = {'users','platform-lock.db','platform-lock.db-journal','platform-lock.db-wal','platform-lock.db-shm'}


def facts(path):
    info=path.lstat(); result={'mode':stat.S_IMODE(info.st_mode),'uid':info.st_uid,'gid':info.st_gid}
    if stat.S_ISLNK(info.st_mode):result.update(type='link',link=os.readlink(path))
    elif stat.S_ISDIR(info.st_mode):result.update(type='directory')
    elif stat.S_ISREG(info.st_mode):
        value=hashlib.sha256()
        with path.open('rb') as file:
            for block in iter(lambda:file.read(1024*1024),b''):value.update(block)
        result.update(type='file',sha256=value.hexdigest(),size=info.st_size)
    else:raise InstallError('Platform backup rejects special files')
    return result


def inventory(path,exclude=False):
    rows={}
    def visit(item,key):
        value=facts(item); rows[key]=value
        if value['type']=='directory':
            for child in sorted(item.iterdir()):
                if exclude and key=='.' and child.name in EXCLUDED:continue
                visit(child,child.name if key=='.' else key+'/'+child.name)
    if path.exists() or path.is_symlink():visit(path,'.')
    return rows


def sync_directory(path):
    descriptor=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(descriptor)
    finally:os.close(descriptor)


def copy_carrier(source,destination):
    value=facts(source)
    if value['type']=='link':destination.symlink_to(value['link'])
    elif value['type']=='directory':
        destination.mkdir()
        for child in sorted(source.iterdir()):copy_carrier(child,destination/child.name)
    else:
        shutil.copyfile(source,destination)
    os.chown(destination,value['uid'],value['gid'],follow_symlinks=False)
    if value['type']!='link':destination.chmod(value['mode'])
    if value['type']=='directory':sync_directory(destination)
    elif value['type']=='file':
        with destination.open('rb') as file:os.fsync(file.fileno())
    sync_directory(destination.parent)


def remove_carrier(path):
    if path.is_symlink() or path.is_file():path.unlink()
    elif path.exists():shutil.rmtree(path)


class PlatformBackup:
    def __init__(self,data,directory,carriers):
        self.data=Path(data); self.directory=Path(directory)
        self.carriers={key:Path(value) for key,value in carriers.items()}

    def root_directory(self):
        if self.data.is_symlink() or not self.data.is_dir():raise InstallError('Platform data root must be a real directory')

    def create(self):
        self.root_directory()
        rows=inventory(self.data,exclude=True)
        required=sum(row.get('size',0) for row in rows.values())
        if shutil.disk_usage(self.directory.parent).free<required*2+16*1024*1024:
            raise InstallError('Not enough free disk for a verified platform backup')
        self.directory.mkdir(mode=0o700)
        snapshot=self.directory/'data'; snapshot.mkdir()
        for child in sorted(self.data.iterdir()):
            if child.name not in EXCLUDED:copy_carrier(child,snapshot/child.name)
        root=rows['.']; os.chown(snapshot,root['uid'],root['gid']); snapshot.chmod(root['mode']); sync_directory(snapshot)
        copied=inventory(snapshot)
        if copied!=rows:raise InstallError('Platform backup verification failed')
        files=self.directory/'files'; files.mkdir(mode=0o700)
        saved={}
        for key,path in self.carriers.items():
            source=inventory(path)
            if source:copy_carrier(path,files/key)
            if inventory(files/key)!=source:raise InstallError('Protected configuration backup verification failed')
            saved[key]=source
        sync_directory(files); sync_directory(self.directory); sync_directory(self.directory.parent)
        return {'schema':1,'data':rows,'files':saved}

    def verify(self,receipt):
        if receipt.get('schema')!=1 or set(receipt.get('files',{}))!=set(self.carriers):raise InstallError('Invalid backup receipt')
        if inventory(self.directory/'data')!=receipt['data']:raise InstallError('Platform backup is damaged; recovery stopped before replacing data')
        for key in self.carriers:
            if inventory(self.directory/'files'/key)!=receipt['files'][key]:raise InstallError('Protected configuration backup is damaged')

    def restore(self,receipt):
        self.verify(receipt); self.root_directory()
        for child in sorted(self.data.iterdir()):
            if child.name not in EXCLUDED:remove_carrier(child)
        for child in sorted((self.directory/'data').iterdir()):copy_carrier(child,self.data/child.name)
        root=receipt['data']['.']; os.chown(self.data,root['uid'],root['gid']); self.data.chmod(root['mode'])
        if inventory(self.data,exclude=True)!=receipt['data']:raise InstallError('Restored platform data verification failed')
        for key,path in self.carriers.items():
            remove_carrier(path)
            if receipt['files'][key]:copy_carrier(self.directory/'files'/key,path)
            if inventory(path)!=receipt['files'][key]:raise InstallError('Restored configuration verification failed')
            sync_directory(path.parent)
        sync_directory(self.data)
