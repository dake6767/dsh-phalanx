"""Verified immutable root executor banks and their fixed systemd installation."""
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import uuid
from installer_host import InstallError  # embedded-host
from installer_upgrade_gate import LinuxAdmissionGate  # embedded-upgrade-gate

EXECUTOR='/opt/dsh-phalanx/updater'
BANKS='/opt/dsh-phalanx/updaters'
EXECUTOR_UNIT='/etc/systemd/system/dsh-phalanx-updater.service'
MODULES=globals().get('EXECUTOR_MODULES') or json.loads(Path(__file__).with_name('executor-files.json').read_text())
REQUIRED=set(MODULES)|{'updater.service.in','executor-files.json'}


def executor_package(directory,commit=None):
    directory=Path(directory)
    if directory.is_symlink() or not directory.is_dir():raise InstallError('Executor package must be an independent verified directory')
    file=directory/'manifest.json'
    if file.is_symlink() or not file.is_file():raise InstallError('Executor package inventory is missing')
    raw=file.read_bytes();value=json.loads(raw)
    if not isinstance(value,dict) or value.get('schema')!=1 or not isinstance(value.get('sourceCommit'),str) or not re.fullmatch('[a-f0-9]{40}',value['sourceCommit']):
        raise InstallError('Unsupported executor package protocol')
    if commit is not None and value['sourceCommit']!=commit:raise InstallError('Executor and selected platform source differ')
    files=value.get('files')
    if not isinstance(files,dict) or REQUIRED!=set(files) or len(files)>32 or set(path.name for path in directory.iterdir())!=set(files)|{'manifest.json'}:
        raise InstallError('Executor package inventory is incomplete or unexpected')
    if json.loads((directory/'executor-files.json').read_text())!=MODULES:raise InstallError('Executor dependency inventory differs from its protocol')
    for name,digest in files.items():
        if name not in ('updater.py','updater.service.in','executor-files.json') and not re.fullmatch(r'installer_[a-z_]+\.py',name):raise InstallError('Unsupported executor module name')
        path=directory/name
        if not isinstance(digest,str) or not re.fullmatch('[a-f0-9]{64}',digest) or path.is_symlink() or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=digest:
            raise InstallError('Executor package checksum mismatch')
        if name.endswith('.py'):compile(path.read_bytes(),name,'exec')
    return {'sourceCommit':value['sourceCommit'],'packageSha256':hashlib.sha256(raw).hexdigest()}


def installed_executor(host):
    current=host.path(EXECUTOR)
    if not current.exists() and not current.is_symlink():return None
    if not current.is_symlink() or current.resolve().parent!=host.path(BANKS):raise InstallError('Executor path is not a managed immutable bank')
    return executor_package(current.resolve())


def executor_pointer(host):
    path=host.path(EXECUTOR)
    return os.readlink(path) if path.is_symlink() else None


def install_executor(host,uid,gid,target,commit,*,initial_only=False,activate=False,repair=False):
    source=Path(target)/'updater';identity=executor_package(source,commit)
    try:current=installed_executor(host)
    except (InstallError,OSError,ValueError,SyntaxError):
        pointer=host.path(EXECUTOR)
        if not repair or not pointer.is_symlink() or pointer.resolve().parent!=host.path(BANKS):raise
        current=None
    if initial_only and current is not None:return current
    host.mkdir(BANKS)
    if current!=identity:
        parent=host.path(BANKS)
        with tempfile.TemporaryDirectory(prefix='.prepare-',dir=parent) as temporary:
            for path in source.iterdir():host.atomic(str((Path(temporary)/path.name).relative_to(host.root)),path.read_text(),0o644)
            executor_package(temporary,commit)
            destination=parent/(identity['sourceCommit']+'-'+identity['packageSha256'][:16]+'-'+uuid.uuid4().hex[:8])
            Path(temporary).chmod(0o755);host.sync_directory(temporary);os.rename(temporary,destination);host.sync_directory(parent)
        replacement=host.path(EXECUTOR+'.next');replacement.unlink(missing_ok=True);replacement.symlink_to(destination)
        os.replace(replacement,host.path(EXECUTOR));host.sync_directory(host.path('/opt/dsh-phalanx'))
    LinuxAdmissionGate().install(host,uid,program=(source/'installer_upgrade_gate.py').read_text())
    unit=(source/'updater.service.in').read_text().replace('@UID@',str(uid)).replace('@GID@',str(gid))
    if '@UID@' in unit or '@GID@' in unit:raise InstallError('Executor unit identity could not be bound')
    host.atomic(EXECUTOR_UNIT,unit,0o644);host.run(['systemctl','daemon-reload']);host.run(['systemctl','enable','dsh-phalanx-updater.service'])
    if activate:activate_executor(host)
    return identity


def activate_executor(host,*,restart=False):
    host.run(['systemctl','reset-failed','dsh-phalanx-updater.service'],check=False)
    if restart:host.run(['systemctl','restart','--no-block','dsh-phalanx-updater.service'])
    else:host.run(['systemctl','start','dsh-phalanx-updater.service'])


def ensure_executor_identity(host,uid,gid,expected,packages):
    try:
        if installed_executor(host)==expected:return
    except (InstallError,OSError,ValueError,SyntaxError):pass
    # Only already selected, checksum-verified release packages can repair a
    # damaged bank. The expected prior identity is recorded with its backup.
    for target,commit in packages:
        try:identity=executor_package(Path(target)/'updater',commit)
        except (InstallError,OSError,ValueError,SyntaxError):continue
        if identity==expected:
            # Preserve damaged banks and the old pointer until publication.
            install_executor(host,uid,gid,target,commit,repair=True);return
    raise InstallError('Verified executor package unavailable; keep maintenance closed and repair the recorded release package before recovery')
