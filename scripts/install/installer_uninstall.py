"""Remove the installed program and service files for a verified deployment."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys
from installer_cleanup import UpgradeCleanup  # embedded-cleanup
from installer_config import default_storage_root, effective_user_data_root, uninstall_record, UNINSTALL_STATE, platform_facts, validate_storage  # embedded-config
from installer_deployment import Deployment, deployment_lease, DATABASE, UPDATER, FENCE  # embedded-deployment
from installer_executor_install import BANKS, EXECUTOR, EXECUTOR_UNIT, GLOBAL_CLI, executor_package, verify_global_cli_path  # embedded-executor-install
from installer_host import InstallError  # embedded-host
from installer_progress import Progress  # embedded-progress
from installer_questions import Cancelled, InstallerQuestions  # embedded-questions
from installer_release import asset_names  # embedded-release
from installer_upgrade_gate import AdmissionGateError, LinuxAdmissionGate  # embedded-upgrade-gate
from installer_upgrade_host import CONFIG, CURRENT, MANIFEST, STATE, UNIT, UPGRADE_ROOT, installed_source  # embedded-upgrade-host


def uninstall_data_paths(values):
    data = values['DSH_PHALANX_DATA_ROOT']
    return list(dict.fromkeys([
        CONFIG, MANIFEST, data, default_storage_root(data), effective_user_data_root(values),
        '/var/lib/dsh-phalanx/keys', UPGRADE_ROOT,
    ]))


class Uninstall:
    def __init__(self, host):
        self.host = host
        self.deployment = Deployment(host)
        self.cleanup = UpgradeCleanup(host, host.path(UPGRADE_ROOT))

    def path(self, name):
        relative = Path(name)
        if not relative.is_absolute() or relative == Path('/') or '..' in relative.parts or str(relative) != name:
            raise InstallError('Invalid uninstall path')
        path = self.host.path(name)
        for parent in path.parents:
            if parent == self.host.root:
                break
            if parent.is_symlink():
                raise InstallError('Uninstall path has a symbolic-link parent: '+name)
        return path

    def signature(self, name):
        path = self.path(name)
        try:
            info = path.lstat()
        except FileNotFoundError:
            return None
        result = {'device': info.st_dev, 'inode': info.st_ino, 'mode': info.st_mode, 'owner': info.st_uid}
        if stat.S_ISLNK(info.st_mode):
            result['target'] = os.readlink(path)
        elif stat.S_ISREG(info.st_mode):
            with path.open('rb') as file:
                result['sha256'] = hashlib.file_digest(file, 'sha256').hexdigest()
        elif not stat.S_ISDIR(info.st_mode):
            raise InstallError('Unsupported uninstall resource type: '+name)
        return result

    def named(self, path):
        return '/'+str(path.relative_to(self.host.root))

    def program_paths(self, source):
        self.deployment.verify_service_files(source)
        verify_global_cli_path(self.host)
        result = [UNIT, '/var/lib/dsh-phalanx/.config/systemd/user/'+DATABASE, EXECUTOR_UNIT]
        drop_in = '/etc/systemd/system/user@'+str(source['uid'])+'.service.d/dsh-phalanx-maintenance.conf'
        gate = '/opt/dsh-phalanx/maintenance/gate.py'
        fence = '/etc/systemd/system/'+FENCE
        owner = os.geteuid()
        for name, expected in [
            (drop_in, '[Unit]\nRequires=dsh-phalanx-maintenance.service\nAfter=dsh-phalanx-maintenance.service\n'),
            (fence, '[Unit]\nDescription=dsh-phalanx upgrade admission\nBefore=user@'+str(source['uid'])+'.service\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/bin/python3 /opt/dsh-phalanx/maintenance/gate.py\n'),
        ]:
            path = self.path(name)
            if path.is_symlink() or not path.is_file() or path.stat().st_uid != owner or path.stat().st_mode & 0o022 or path.read_text() != expected:
                raise InstallError('Unverified deployment service definition: '+name)
        executor = self.path(EXECUTOR)
        bank = executor.resolve()
        if not executor.is_symlink() or bank.parent != self.path(BANKS):
            raise InstallError('Unverified deployment executor link')
        executor_package(bank, source['receipt']['commit'])
        gate_file = self.path(gate)
        if gate_file.is_symlink() or not gate_file.is_file() or gate_file.stat().st_uid != owner or gate_file.read_bytes() != (bank/'installer_upgrade_gate.py').read_bytes():
            raise InstallError('Unverified deployment admission program')
        result.extend([drop_in, fence, GLOBAL_CLI, CURRENT, EXECUTOR, gate])
        manifests = [source['manifest']]
        journal = self.path(UPGRADE_ROOT)
        if journal.exists():
            known, _ = self.cleanup.inventory(source)
            manifests.extend(known.values())
        for manifest in manifests:
            sha = manifest['files'][asset_names(manifest)[0]]
            name = '/opt/dsh-phalanx/releases/'+manifest['tag']+'-'+sha[:16]
            path = self.path(name)
            if not path.exists() and not path.is_symlink():
                continue
            if path.is_symlink() or not path.is_dir() or path.stat().st_uid != owner or (path/'.artifact-sha256').read_text() != sha:
                raise InstallError('Unverified deployment release directory: '+name)
            result.append(name)
        if self.named(Path(source['target'])) not in result:
            raise InstallError('The current release is outside the verified inventory')
        commits = {manifest['commit'] for manifest in manifests}
        for candidate in self.path(BANKS).iterdir():
            if not any(candidate.name.startswith(commit+'-') for commit in commits):
                continue
            identity = executor_package(candidate)
            if candidate.stat().st_uid != owner or identity['sourceCommit'] not in commits or not candidate.name.startswith(identity['sourceCommit']+'-'+identity['packageSha256'][:16]+'-'):
                raise InstallError('Unverified deployment executor bank')
            result.append(self.named(candidate))
        result.append(STATE)
        return list(dict.fromkeys(result))

    def data_paths(self, source):
        values = source['values']
        data_root = values['DSH_PHALANX_DATA_ROOT']
        if data_root != '/var/lib/dsh-phalanx/data':
            raise InstallError('Cannot verify the configured platform data root for uninstall')
        if values.get('DSH_PHALANX_DATABASE_CONFIG_FILE') not in (None, '/var/lib/dsh-phalanx/keys/database.json'):
            raise InstallError('Cannot verify the configured database key directory for uninstall')
        names = [data_root, default_storage_root(data_root), '/var/lib/dsh-phalanx/keys', UPGRADE_ROOT,
                 CONFIG, MANIFEST, '/etc/dsh-phalanx/install-draft']
        entries = {name: self.signature(name) for name in names}
        for name in (CONFIG, MANIFEST, STATE):
            entry = self.signature(name)
            if entry is None or not stat.S_ISREG(entry['mode']) or entry['owner'] != os.geteuid() or entry['mode'] & 0o022:
                raise InstallError('Unverified deployment metadata: '+name)
        for name in (data_root, default_storage_root(data_root), '/var/lib/dsh-phalanx/keys'):
            if entries[name] is None:
                continue
            path = self.path(name)
            if (not stat.S_ISDIR(entries[name]['mode']) or entries[name]['mode'] & 0o022
                    or self.host.user(source['uid'], ['test', '-O', str(path)], check=False).returncode):
                raise InstallError('Unverified local deployment data: '+name)
        self.deployment.journal_root()
        return entries

    def mount_record(self, path):
        rows = json.loads(self.host.run(['findmnt', '--json', '--target', str(path), '--output', 'TARGET,MAJ:MIN,SOURCE,FSTYPE']).stdout)['filesystems']
        if not isinstance(rows, list) or len(rows) != 1:
            raise InstallError('Cannot verify the retained storage mount')
        return rows[0]

    def external_proof(self, source):
        values = source['values']
        name = values['DSH_PHALANX_USER_DATA_ROOT']
        mount_name = values['DSH_PHALANX_USER_DATA_MOUNT']
        path = self.path(name)
        mount = self.path(mount_name)
        if path == mount or not path.is_relative_to(mount) or path.is_symlink():
            raise InstallError('External member data must be a dedicated directory below its mounted volume')
        validate_storage(self.host, values)
        facts = platform_facts(self.host, values, 'user-storage')
        if not isinstance(facts, dict) or not isinstance(facts.get('binding'), dict):
            raise InstallError('Cannot verify external member storage against the deployment database')
        binding = facts['binding']
        marker_name = name+'/.dsh-phalanx-storage.json'
        marker = self.signature(marker_name)
        if (binding['path'] != name or marker is None or not stat.S_ISREG(marker['mode'])
                or json.loads(self.path(marker_name).read_text()) != {'id': binding['id'], 'owner': facts['owner']}):
            raise InstallError('External member storage marker does not match the deployment')
        entry = self.signature(name)
        if entry is None or not stat.S_ISDIR(entry['mode']):
            raise InstallError('External member storage is unavailable')
        mounted = self.mount_record(path)
        if mounted.get('target') != str(mount):
            raise InstallError('External member storage mount changed')
        return {'root': name, 'entry': entry, 'marker': marker, 'mount': mounted}

    def retained_keys(self):
        root = '/var/lib/dsh-phalanx/keys'
        return {name: self.signature(name) for name in [
            root+'/database.json', root+'/builtin-database.json', root+'/master.key',
        ]}

    def verify_reinstall(self, plan):
        if self.signature(CONFIG) != plan['data'][CONFIG]:
            raise InstallError('The retained deployment configuration changed')
        for name, expected in plan['keys'].items():
            if self.signature(name) != expected:
                raise InstallError('The retained database configuration or key changed: '+name)
        for name in (plan['dataRoot'], default_storage_root(plan['dataRoot']), '/var/lib/dsh-phalanx/keys'):
            if self.signature(name) != plan['data'][name]:
                raise InstallError('The retained data directory changed: '+name)
        if plan['externalProof']:
            self.purge_paths(plan)

    def plan(self, source):
        external_root = source['values'].get('DSH_PHALANX_USER_DATA_ROOT')
        proof = None
        if external_root:
            try:
                proof = self.external_proof(source)
            except (OSError, ValueError, KeyError, TypeError, InstallError):
                # Unavailable external ownership does not prevent retaining those files.
                pass
        return {
            'schema': 1, 'phase': 'removing', 'uid': source['uid'],
            'dataRoot': source['values']['DSH_PHALANX_DATA_ROOT'],
            'release': {key: source['receipt'][key] for key in ('version', 'candidate', 'commit', 'platformSha256', 'imageDigest')},
            'externalRoot': external_root, 'externalProof': proof,
            'data': self.data_paths(source),
            'keys': self.retained_keys(),
            'retained': uninstall_data_paths(source['values']),
            'programs': {name: self.signature(name) for name in self.program_paths(source)},
            'completed': [],
        }

    def write(self, plan):
        self.host.atomic(UNINSTALL_STATE, json.dumps(plan, ensure_ascii=False)+'\n')

    def verify_quiet(self, plan, *, fence_stopped=False):
        account = self.host.run(['getent', 'passwd', 'dsh-phalanx']).stdout.strip().split(':')
        if len(account) != 7 or account[2] != str(plan['uid']) or account[5:] != ['/var/lib/dsh-phalanx', '/usr/sbin/nologin']:
            raise InstallError('The managed service identity changed')
        source = {'uid': plan['uid'], 'values': {'DSH_PHALANX_DATA_ROOT': plan['dataRoot']}}
        units = [('dsh-phalanx.service', False), (DATABASE, False), (UPDATER, True)]
        if fence_stopped:
            units.append((FENCE, True))
        for unit, system in units:
            args = ['systemctl', *(['--user'] if not system else []), 'show', unit,
                    '--property=LoadState,ActiveState,SubState,MainPID,ControlPID,ControlGroup,UnitFileState']
            response = self.host.run(args, check=False) if system else self.host.user(plan['uid'], args, check=False)
            values = dict(line.split('=', 1) for line in response.stdout.splitlines() if '=' in line)
            loaded = values.get('LoadState') == 'loaded'
            stopped = values.get('ActiveState') in ('inactive', 'failed')
            valid = (response.returncode == 0 and loaded and values.get('MainPID') == '0' and values.get('ControlPID') == '0'
                     or values.get('LoadState') == 'not-found' and values.get('MainPID', '0') == '0' and values.get('ControlPID', '0') == '0')
            if not valid or not stopped or self.deployment.task_count(values.get('ControlGroup', ''), active=False):
                raise InstallError('Managed service has not stopped: '+unit)
        if self.deployment.member_containers(source) or self.deployment.builtin_containers(source) or self.deployment.maintenance_workers(source) or self.deployment.archive_containers(source):
            raise InstallError('Managed workloads remain after stopping')

    def remove(self, name, expected, uid):
        current = self.signature(name)
        if current is None:
            return
        if current != expected:
            raise InstallError('Uninstall resource changed after ownership verification: '+name)
        path = self.path(name)
        if stat.S_ISDIR(current['mode']):
            mounts = json.loads(self.host.run(['findmnt', '--json', '--list', '--output', 'TARGET']).stdout)['filesystems']
            if any(Path(row['target']).is_relative_to(path) for row in mounts):
                raise InstallError('Uninstall resource contains a mount: '+name)
            if self.cleanup.mounted(path, uid) or self.cleanup.process_reference(path):
                raise InstallError('A process or container is using '+name)
            shutil.rmtree(path)
        else:
            path.unlink()
        self.host.sync_directory(path.parent)

    def remove_programs(self, plan, result):
        self.verify_quiet(plan)
        uid = plan['uid']
        LinuxAdmissionGate(self.host).open()
        for unit, name, system in [('dsh-phalanx.service', UNIT, False), (UPDATER, EXECUTOR_UNIT, True)]:
            if self.signature(name) is None:
                continue
            if self.signature(name) != plan['programs'][name]:
                raise InstallError('Autostart definition changed: '+name)
            if system:
                self.host.run(['systemctl', 'disable', unit])
            else:
                self.host.user(uid, ['systemctl', '--user', 'disable', unit])
        drop_in = '/etc/systemd/system/user@'+str(uid)+'.service.d/dsh-phalanx-maintenance.conf'
        self.remove(drop_in, plan['programs'][drop_in], uid)
        self.host.run(['systemctl', 'daemon-reload'])
        fence = '/etc/systemd/system/'+FENCE
        if self.signature(fence) is not None:
            if self.signature(fence) != plan['programs'][fence]:
                raise InstallError('Maintenance service definition changed')
            self.host.run(['systemctl', 'stop', FENCE])
        self.verify_quiet(plan, fence_stopped=True)
        for name, expected in plan['programs'].items():
            self.remove(name, expected, uid)
            if name not in plan['completed']:
                plan['completed'].append(name)
                self.write(plan)
            result['changed'] = True
        self.host.user(uid, ['systemctl', '--user', 'daemon-reload'])
        self.host.run(['systemctl', 'daemon-reload'])
        self.verify_quiet(plan, fence_stopped=True)
        plan['phase'] = 'retained'
        self.write(plan)

    def verify_retained(self, plan):
        if any(self.signature(name) is not None for name in plan['programs']):
            raise InstallError('A reinstall has started; complete it before managing retained data')
        self.verify_quiet(plan, fence_stopped=True)

    def verify_absent(self):
        paths = (
            STATE, CONFIG, MANIFEST, CURRENT, UNIT, EXECUTOR, EXECUTOR_UNIT, GLOBAL_CLI, UPGRADE_ROOT,
            '/etc/dsh-phalanx/install-draft', '/etc/dsh-phalanx/maintenance', '/etc/systemd/system/'+FENCE,
            '/opt/dsh-phalanx/maintenance/gate.py', '/var/lib/dsh-phalanx/.config/systemd/user/'+DATABASE,
            '/var/lib/dsh-phalanx/.config/systemd/user/default.target.wants/dsh-phalanx.service',
            '/etc/systemd/system/multi-user.target.wants/'+UPDATER,
            '/var/lib/dsh-phalanx/data', '/var/lib/dsh-phalanx/data.durable', '/var/lib/dsh-phalanx/keys',
        )
        if any(self.signature(name) is not None for name in paths):
            raise InstallError('Cannot verify ownership of incomplete installation or retained data')
        for name in (BANKS, '/opt/dsh-phalanx/releases'):
            path = self.path(name)
            if path.is_symlink() or (path.exists() and (not path.is_dir() or any(path.iterdir()))):
                raise InstallError('Cannot verify ownership of incomplete installation or retained data')
        for path in self.path('/etc/systemd/system').glob('user@*.service.d/dsh-phalanx-maintenance.conf'):
            if self.signature(self.named(path)) is not None:
                raise InstallError('Cannot verify ownership of incomplete installation or retained data')

    def purge_paths(self, plan):
        entries = dict(plan['data'])
        if plan['externalRoot']:
            proof = plan['externalProof']
            if not proof or proof['root'] != plan['externalRoot']:
                raise InstallError('Cannot verify retained external storage. Reinstall and start the retained deployment to verify it before purging.')
            name = proof['root']
            current = self.signature(name)
            if self.mount_record(self.path(name).parent) != proof['mount']:
                raise InstallError('The retained external storage mount changed')
            if current is None and plan['phase'] != 'purging':
                raise InstallError('The retained external member directory is missing')
            if current is not None:
                marker = self.signature(name+'/.dsh-phalanx-storage.json')
                if marker != proof['marker'] and (plan['phase'] != 'purging' or marker is not None):
                    raise InstallError('The retained external storage marker changed')
            entries = {name: proof['entry'], **entries}
        return entries

    def purge_data(self, plan, result):
        self.verify_retained(plan)
        entries = self.purge_paths(plan)
        for name, expected in entries.items():
            current = self.signature(name)
            if current is not None and current != expected:
                raise InstallError('Retained data changed after ownership verification: '+name)
        plan['phase'] = 'purging'
        self.write(plan)
        for name, expected in entries.items():
            self.remove(name, expected, plan['uid'])
            if name not in plan['completed']:
                plan['completed'].append(name)
                self.write(plan)
            result['changed'] = True
        self.path(UNINSTALL_STATE).unlink()
        plan['completed'].append(UNINSTALL_STATE)
        self.host.sync_directory(self.path(UNINSTALL_STATE).parent)
        result['retained'] = []
        result['state'] = 'purged'

    def execute(self, args, result):
        with deployment_lease(self.host) as acquired:
            if not acquired:
                result['conflict'] = True
                raise InstallError('Another installation or maintenance operation owns the deployment lock')
            record = uninstall_record(self.host)
            if record is None and self.signature(STATE) is None:
                self.verify_absent()
                result['state'] = 'purged' if args.purge else 'uninstalled'
                return
            if record is None:
                source = installed_source(self.host)
                if self.deployment.pending():
                    result['conflict'] = True
                    raise InstallError('Complete or recover the existing maintenance operation first')
                plan = self.plan(source)
            else:
                plan = record
                if self.deployment.pending():
                    result['conflict'] = True
                    raise InstallError('Complete or recover the existing maintenance operation first')
            result['retained'] = [*plan['retained'], UNINSTALL_STATE]
            result['remove'] = list(plan['programs'])
            result['completed'] = plan['completed']
            result['release'] = plan['release']['version']
            if args.purge:
                if plan['externalRoot']:
                    result['remove'].append(plan['externalRoot'])
                result['remove'].extend(plan['data'])
                result['remove'].append(UNINSTALL_STATE)
                self.purge_paths(plan)
            elif plan['phase'] == 'retained':
                self.verify_retained(plan)
                result['state'] = 'uninstalled'
                return
            elif plan['phase'] == 'purging':
                raise InstallError('Repeat the explicit purge to complete the recorded removal')
            if not self.confirm(args, result):
                return
            if record is None:
                stopped = self.deployment.change_locked('stop', confirmed=True)
                result['changed'] = stopped['changed']
                if stopped['state'] != 'stopped' or stopped['errors']:
                    result['errors'].extend(stopped['errors'])
                    raise InstallError('The deployment must stop before uninstalling')
                self.write(plan)
            if plan['phase'] == 'removing':
                self.remove_programs(plan, result)
            if args.purge:
                self.purge_data(plan, result)
            else:
                result['state'] = 'uninstalled'

    def confirm(self, args, result):
        interactive = args.output == 'human' and not getattr(args, 'non_interactive', False) and self.host.terminal_available()
        if args.output == 'human':
            render_scope(result, args)
        elif args.yes:
            render_scope(result, args, file=sys.stderr)
        if args.yes:
            return True
        if not interactive:
            result['confirmationRequired'] = True
            raise InstallError('Uninstall requires explicit confirmation with --yes')
        question = InstallerQuestions(args.language, self.host.prompt, self.host.operator, {})
        word = 'PURGE' if args.purge else 'yes'
        try:
            answer = question.ask('输入 '+word+' 确认；cancel 取消', 'Type '+word+' to confirm; cancel to cancel', 'cancel')
            if answer == word:
                return True
        except Cancelled:
            pass
        result['cancelled'] = True
        return False


def render_scope(result, args, *, file=None):
    def line(text):
        print(text, file=file, flush=True)
    zh = args.language == 'zh-CN'
    line('将移除' if zh else 'Remove')
    for name in result['remove']:
        line('  '+name)
    line('保留' if zh else 'Retain')
    removed = [Path(name) for name in result['remove']]
    for name in result['retained']:
        if not any(Path(name).is_relative_to(path) for path in removed):
            line('  '+name)
    line('  外部 PostgreSQL、系统账户、依赖、共享资源和挂载卷' if zh else '  External PostgreSQL, OS accounts and dependencies, shared resources and mounted volumes')
    line('运行中的任务会中断。' if zh else 'Running tasks will be interrupted.')


def uninstall_command(host, args):
    result = {
        'schema': 1, 'command': 'uninstall', 'phaseCode': 'deployment.uninstall', 'state': 'partial',
        'status': 'failed', 'changed': False, 'retained': [], 'remove': [], 'completed': [], 'errors': [],
        'preservedResources': ['external-postgresql', 'system-accounts', 'system-dependencies', 'shared-resources', 'mounted-volumes'],
    }
    try:
        if host.uid != 0 or host.system != 'Linux':
            raise InstallError('Use sudo on the installed Linux host')
        Uninstall(host).execute(args, result)
        result['status'] = 'cancelled' if result.get('cancelled') else 'succeeded'
    except (OSError, ValueError, KeyError, TypeError, InstallError, AdmissionGateError) as error:
        result['errors'].append({'component': 'deployment', 'reason': str(error)})
    safe = Progress(host.root, persist=False, language=args.language).safe
    for error in result['errors']:
        error['reason'] = safe(error['reason'])
    result['retained'] = [name for name in result['retained'] if os.path.lexists(host.path(name))]
    result['pending'] = [name for name in result['remove'] if name not in result['completed']]
    if args.output == 'json':
        print(json.dumps(result, ensure_ascii=False))
    else:
        zh = args.language == 'zh-CN'
        if result['status'] == 'cancelled':
            print('已取消。' if zh else 'Cancelled.')
        elif result['status'] == 'succeeded':
            if not result['changed'] and not result.get('release'):
                print('未发现本部署的程序或数据。' if zh else 'No deployment programs or data were found.')
            elif result['state'] == 'purged':
                print('已清理本部署本地数据。' if zh else 'Local deployment data removed.')
            else:
                print('已卸载，保留数据与恢复记录。' if zh else 'Uninstalled. Data and the recovery receipt are retained.')
                if result.get('release'):
                    print(('重新安装同一版本以恢复：' if zh else 'Reinstall the same release to recover: ')+result['release'])
                    print(('清理保留数据：' if zh else 'Purge retained data: ')+'sudo bash install.sh --uninstall --purge')
        else:
            print('卸载未完成，检查分项后重试同一命令。' if zh else 'Uninstall is incomplete. Review the result and retry the same command.')
            for error in result['errors']:
                print(error['reason'])
            for key, label in [
                ('completed', '已完成' if zh else 'Completed'),
                ('pending', '待完成' if zh else 'Pending'),
                ('retained', '仍保留' if zh else 'Still present'),
            ]:
                if result[key]:
                    print(label)
                    for name in result[key]:
                        print('  '+name)
    return 1 if result['status'] == 'failed' else 0
