"""Closed privileged control grammar; no deployment path, URL or command inputs."""
import re
from installer_compatibility import STABLE
from installer_host import InstallError
from installer_upgrade_host import operation_id

SOCKET='/run/dsh-phalanx-updater/control.sock'

class ControlError(Exception):
    def __init__(self,status,message):super().__init__(message);self.status=status


def validated_request(value):
    if not isinstance(value,dict):raise ControlError(400,'Invalid update request')
    action=value.get('action')
    fields={'status':({'action'},{'operation'}),'check':({'action'},set()),
            'prepare':({'action','version','manifestSha256'},set()),
            'apply':({'action','operation'},set()),'recover':({'action'},{'operation'})}
    if not isinstance(action,str) or action not in fields:raise ControlError(400,'Unsupported update action')
    required,optional=fields[action]
    if not required<=set(value)<=required|optional:raise ControlError(400,'Unexpected update input')
    if 'operation' in value:
        try:operation_id(value['operation'])
        except (ValueError,TypeError,InstallError,AttributeError):raise ControlError(400,'Invalid operation identity') from None
    if action=='prepare' and (not isinstance(value['version'],str) or not STABLE.fullmatch(value['version']) or
            not isinstance(value['manifestSha256'],str) or not re.fullmatch('[a-f0-9]{64}',value['manifestSha256'])):
        raise ControlError(400,'A verified formal release identity is required')
    return value
