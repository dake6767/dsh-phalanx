"""Digest-pinned rootless PostgreSQL and local-key bootstrap for new installations."""
import json
import re
import urllib.parse
from installer_host import InstallError  # embedded-host
from installer_config import HOME_DIR, default_storage_root  # embedded-config

DATABASE_UNIT = HOME_DIR+'/.config/systemd/user/dsh-phalanx-postgres.service'


def unit_argument(value):
    return '"'+str(value).replace('\\','\\\\').replace('"','\\"').replace('%','%%')+'"'


def database_backup_notice(host, info):
    if info:
        host.tell('Keep an offline backup of the master-key file at '+info['masterKeyPath']+'. Losing this file loses access to encrypted platform secrets.')
        host.tell('Master fingerprint '+info['fingerprint'])


def prepare_builtin_database(host, uid, gid, target, values, manifest):
    build=json.loads(host.path(target+'/build-info.json').read_text())
    pin=build.get('versions',{}).get('postgres')
    # Older verified packages do not implement the local database bootstrap commands.
    if pin is None:return None
    if (not isinstance(pin,dict) or not re.fullmatch(r'docker.io/library/postgres:[0-9][a-zA-Z0-9.-]*',pin.get('image','')) or
            not re.fullmatch(r'sha256:[a-f0-9]{64}',pin.get('digest',''))):
        raise InstallError('Invalid built-in PostgreSQL image identity')
    canonical=pin['image'].rsplit(':',1)[0]+'@'+pin['digest']
    present=host.user(uid,['podman','image','exists',canonical],check=False)
    if present.returncode==1:
        mirror=getattr(host,'download_sources',{}).get('containerMirror','')
        address=urllib.parse.urlsplit(mirror)
        transport=address.netloc+address.path+canonical.removeprefix('docker.io/') if mirror else canonical
        host.user(uid,['podman','pull',transport])
        if mirror:host.user(uid,['podman','tag',transport,pin['image']])
    elif present.returncode!=0:raise InstallError('Cannot inspect rootless PostgreSQL image storage')
    image=json.loads(host.user(uid,['podman','image','inspect',canonical]).stdout)[0]
    if image.get('Digest')!=pin['digest'] or image.get('Os')!='linux' or image.get('Architecture')!=manifest['platform'].split('/')[1]:
        raise InstallError('Built-in PostgreSQL image digest or architecture mismatch')
    keys=HOME_DIR+'/keys';data=values['DSH_PHALANX_DATA_ROOT']
    durable=default_storage_root(data);postgres=durable+'/postgres'
    if host.path(durable).exists() and host.user(uid,['test','-O',str(host.path(durable))],check=False).returncode!=0:
        raise InstallError('The durable storage directory must belong to the service account')
    config=keys+'/database.json';master=keys+'/master.key'
    for directory in (keys,data,durable,postgres):
        host.mkdir(directory,0o700)
    # PostgreSQL owns the contents after initialization; never recursively chown its data.
    host.run(['chown',f'{uid}:{gid}',str(host.path(keys)),str(host.path(data)),str(host.path(durable))])
    if not any(host.path(postgres).iterdir()):host.run(['chown',f'{uid}:{gid}',str(host.path(postgres))])
    port=25433 if '25432' in (values.get('DSH_PHALANX_PORT'),values.get('DSH_PHALANX_CONTAINER_GATEWAY_PORT'),values.get('DSH_PHALANX_PREVIEW_PORT')) else 25432
    entry=str(host.path(target+'/start'));configuration=str(host.path(config));storage=str(host.path(data))
    info=json.loads(host.user(uid,[entry,'database-initialize','--config-file',configuration,'--master-key-file',str(host.path(master)),'--data-root',storage,'--port',str(port)]).stdout)
    if not isinstance(info,dict) or not isinstance(info.get('port'),int) or not 1024<=info['port']<=65535 or not re.fullmatch(r'sha256:[a-f0-9]{64}',info.get('fingerprint','')) or info.get('masterKeyPath')!=str(host.path(master)):
        raise InstallError('Invalid database bootstrap receipt')
    port=info['port']
    if str(port) in (values.get('DSH_PHALANX_PORT'),values.get('DSH_PHALANX_CONTAINER_GATEWAY_PORT'),values.get('DSH_PHALANX_PREVIEW_PORT')):raise InstallError('Entry, gateway, preview and database ports must differ')
    current=unit_argument(str(host.path('/opt/dsh-phalanx/current/start')))
    builtin_configuration=str(host.path(keys+'/builtin-database.json'))
    common=' --config-file '+unit_argument(builtin_configuration)+' --data-root '+unit_argument(storage)+' --maintenance-file '+unit_argument(str(host.path('/etc/dsh-phalanx/maintenance')))
    runtime='%t/dsh-phalanx-database/password'
    run=['/usr/bin/podman','run','--rm','--replace','--name','dsh-phalanx-postgres','--sdnotify=conmon','--network=pasta','--label','dsh.phalanx.database=builtin',
         '-p',f'127.0.0.1:{port}:5432','-v',str(host.path(postgres))+':/var/lib/postgresql/data',
         '-v',runtime+':/run/secrets/postgres-password:ro','-e','POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password','-e','POSTGRES_USER=phalanx','-e','POSTGRES_DB=dsh_phalanx',canonical,
         '-c','shared_buffers=32MB','-c','max_connections=20','-c','work_mem=2MB','-c','maintenance_work_mem=32MB']
    command=' '.join(unit_argument(argument) if '%t/' not in argument else '"'+argument+'"' for argument in run)
    unit=('[Unit]\nDescription=Built-in platform PostgreSQL\nPartOf=dsh-phalanx.service\nBefore=dsh-phalanx.service\nAfter=network-online.target\n\n'
          '[Service]\nType=notify\nNotifyAccess=all\nEnvironment=PODMAN_SYSTEMD_UNIT=%n XDG_RUNTIME_DIR=/run/user/'+str(uid)+' XDG_CONFIG_HOME='+HOME_DIR+'/.config\nRuntimeDirectory=dsh-phalanx-database\nRuntimeDirectoryMode=0700\nUMask=0077\n'+
          'ExecStartPre='+current+' database-password-file'+common+' --output '+runtime+'\nExecStart='+command+'\n'+
          'ExecStartPost='+current+' database-wait'+common+'\nExecStop=/usr/bin/podman stop --ignore --time 20 dsh-phalanx-postgres\n'
          'ExecStopPost=/usr/bin/podman rm --ignore --force dsh-phalanx-postgres\nRestart=on-failure\nRestartSec=2\nTimeoutStartSec=90\nTimeoutStopSec=45\nKillMode=mixed\n')
    info['unitChanged']=not host.path(DATABASE_UNIT).exists() or host.path(DATABASE_UNIT).read_text()!=unit
    if info['unitChanged']:host.atomic(DATABASE_UNIT,unit,0o644)
    host.run(['chown',f'{uid}:{gid}',str(host.path(DATABASE_UNIT))])
    values['DSH_PHALANX_DATABASE_CONFIG_FILE']=config
    return info
