"""Structured installation events, operator output and private safe diagnostics."""
import contextlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import sys
import threading
import time


# BEGIN GENERATED SYSTEM UPDATE CODES
# Generated from src/domain/system-update-codes.json; do not edit this value.
SYSTEM_UPDATE_CODES = json.loads("{\n  \"phases\": {\n    \"install.preflight\": {\n      \"en\": \"Checking installation requirements\",\n      \"zh-CN\": \"检查安装条件\"\n    },\n    \"install.lock\": {\n      \"en\": \"Acquiring the installation lock\",\n      \"zh-CN\": \"获取安装锁\"\n    },\n    \"install.release-selection\": {\n      \"en\": \"Selecting a verified release\",\n      \"zh-CN\": \"选择已验证版本\"\n    },\n    \"install.configuration\": {\n      \"en\": \"Reading installation configuration\",\n      \"zh-CN\": \"读取安装配置\"\n    },\n    \"install.download\": {\n      \"en\": \"Downloading and verifying assets\",\n      \"zh-CN\": \"下载并校验制品\"\n    },\n    \"install.existing-installation\": {\n      \"en\": \"Checking the installed release\",\n      \"zh-CN\": \"检查已安装版本\"\n    },\n    \"install.dependencies\": {\n      \"en\": \"Preparing host dependencies\",\n      \"zh-CN\": \"准备主机依赖\"\n    },\n    \"install.identity-storage\": {\n      \"en\": \"Preparing service identity and storage\",\n      \"zh-CN\": \"准备服务身份与存储\"\n    },\n    \"install.staging\": {\n      \"en\": \"Staging the verified platform\",\n      \"zh-CN\": \"暂存已验证平台\"\n    },\n    \"install.runtime-image\": {\n      \"en\": \"Preparing the runtime image\",\n      \"zh-CN\": \"准备运行镜像\"\n    },\n    \"install.database\": {\n      \"en\": \"Preparing the platform database\",\n      \"zh-CN\": \"准备平台数据库\"\n    },\n    \"install.executor\": {\n      \"en\": \"Installing the update executor\",\n      \"zh-CN\": \"安装升级执行器\"\n    },\n    \"install.activation\": {\n      \"en\": \"Starting the managed service\",\n      \"zh-CN\": \"启动托管服务\"\n    },\n    \"update.preparing\": {\n      \"en\": \"Downloading and verifying the update\",\n      \"zh-CN\": \"下载并校验更新\"\n    },\n    \"update.prepared\": {\n      \"en\": \"Ready to apply\",\n      \"zh-CN\": \"可以应用更新\"\n    },\n    \"update.prepare-failed\": {\n      \"en\": \"Download or verification failed\",\n      \"zh-CN\": \"下载或校验失败\"\n    },\n    \"update.stopping\": {\n      \"en\": \"Stopping the service and user instances\",\n      \"zh-CN\": \"停止平台与成员实例\",\n      \"step\": 1,\n      \"total\": 6,\n      \"mode\": \"apply\"\n    },\n    \"update.backing-up\": {\n      \"en\": \"Backing up platform data\",\n      \"zh-CN\": \"备份平台数据\",\n      \"step\": 2,\n      \"total\": 6,\n      \"mode\": \"apply\"\n    },\n    \"update.backed-up\": {\n      \"en\": \"Platform backup verified\",\n      \"zh-CN\": \"平台备份已验证\",\n      \"step\": 3,\n      \"total\": 6,\n      \"mode\": \"apply\"\n    },\n    \"update.switching\": {\n      \"en\": \"Switching to the verified version\",\n      \"zh-CN\": \"切换到已验证版本\",\n      \"step\": 4,\n      \"total\": 6,\n      \"mode\": \"apply\"\n    },\n    \"update.validating\": {\n      \"en\": \"Checking the new service\",\n      \"zh-CN\": \"检查新版本服务\",\n      \"step\": 5,\n      \"total\": 6,\n      \"mode\": \"apply\"\n    },\n    \"update.committed\": {\n      \"en\": \"Update verified; reopening the service\",\n      \"zh-CN\": \"更新已验证，正在开放服务\",\n      \"step\": 6,\n      \"total\": 6,\n      \"mode\": \"apply\"\n    },\n    \"update.succeeded\": {\n      \"en\": \"Update completed successfully\",\n      \"zh-CN\": \"升级成功\"\n    },\n    \"update.apply-failed\": {\n      \"en\": \"Update could not be applied\",\n      \"zh-CN\": \"无法应用更新\"\n    },\n    \"update.restoring\": {\n      \"en\": \"Restoring the previous version\",\n      \"zh-CN\": \"正在恢复旧版本\",\n      \"step\": 1,\n      \"total\": 2,\n      \"mode\": \"recovery\"\n    },\n    \"update.restoration-committed\": {\n      \"en\": \"Previous version verified; reopening the service\",\n      \"zh-CN\": \"旧版本已验证，正在开放服务\",\n      \"step\": 2,\n      \"total\": 2,\n      \"mode\": \"recovery\"\n    },\n    \"update.restored\": {\n      \"en\": \"Update failed; the previous version was restored\",\n      \"zh-CN\": \"升级失败，已恢复旧版本\"\n    },\n    \"update.recovery-failed\": {\n      \"en\": \"Recovery failed; operator action is required\",\n      \"zh-CN\": \"恢复失败，需要管理员处理\"\n    },\n    \"update.bootstrap\": {\n      \"en\": \"Updating the small executor\",\n      \"zh-CN\": \"更新小执行器\"\n    },\n    \"update.cleanup\": {\n      \"en\": \"Cleaning unused installation resources\",\n      \"zh-CN\": \"清理无用安装资源\"\n    }\n  },\n  \"outcomes\": {\n    \"update.available\": {\n      \"en\": \"Update available\",\n      \"zh-CN\": \"有可用更新\"\n    },\n    \"update.current\": {\n      \"en\": \"Already up to date\",\n      \"zh-CN\": \"已是最新版本\"\n    },\n    \"update.breakpoint-required\": {\n      \"en\": \"Update to the required intermediate version first\",\n      \"zh-CN\": \"需要先升级到断点版本\"\n    },\n    \"update.below-floor\": {\n      \"en\": \"The installed version is below the upgrade floor\",\n      \"zh-CN\": \"当前版本低于升级下限\"\n    },\n    \"update.channel-switch\": {\n      \"en\": \"A formal release is available for this candidate\",\n      \"zh-CN\": \"此候选版可以转为正式版\"\n    },\n    \"update.reader-update-required\": {\n      \"en\": \"Update the small executor first\",\n      \"zh-CN\": \"需要先更新小执行器\"\n    }\n  },\n  \"errors\": {\n    \"disk.insufficient\": {\n      \"en\": \"There is not enough disk space\",\n      \"zh-CN\": \"磁盘空间不足\"\n    },\n    \"disk.inspection-failed\": {\n      \"en\": \"Disk capacity could not be checked\",\n      \"zh-CN\": \"无法检查磁盘容量\"\n    },\n    \"database.unavailable\": {\n      \"en\": \"The platform database is unavailable\",\n      \"zh-CN\": \"平台数据库不可用\"\n    },\n    \"database.export-failed\": {\n      \"en\": \"The platform database could not be exported\",\n      \"zh-CN\": \"平台数据库导出失败\"\n    },\n    \"database.restore-failed\": {\n      \"en\": \"The platform database could not be restored\",\n      \"zh-CN\": \"平台数据库恢复失败\"\n    },\n    \"download.failed\": {\n      \"en\": \"The release download failed\",\n      \"zh-CN\": \"发布制品下载失败\"\n    },\n    \"release.metadata-invalid\": {\n      \"en\": \"The release declaration is invalid\",\n      \"zh-CN\": \"发布声明无效\"\n    },\n    \"release.checksum-failed\": {\n      \"en\": \"A release asset failed checksum verification\",\n      \"zh-CN\": \"发布制品校验失败\"\n    },\n    \"release.identity-mismatch\": {\n      \"en\": \"The release or running process identity does not match\",\n      \"zh-CN\": \"发布制品或运行进程身份不匹配\"\n    },\n    \"compatibility.unsupported\": {\n      \"en\": \"This release is incompatible with the installed platform\",\n      \"zh-CN\": \"此版本与已安装平台不兼容\"\n    },\n    \"operation.conflict\": {\n      \"en\": \"Another operation must finish or recover first\",\n      \"zh-CN\": \"需先完成或恢复另一个操作\"\n    },\n    \"operation.invalid\": {\n      \"en\": \"The selected operation or release changed\",\n      \"zh-CN\": \"所选操作或发布身份已变化\"\n    },\n    \"backup.failed\": {\n      \"en\": \"The platform backup failed\",\n      \"zh-CN\": \"平台备份失败\"\n    },\n    \"backup.invalid\": {\n      \"en\": \"The recovery backup is incomplete or damaged\",\n      \"zh-CN\": \"恢复备份不完整或已损坏\"\n    },\n    \"service.stop-failed\": {\n      \"en\": \"The managed service could not be stopped\",\n      \"zh-CN\": \"托管服务停止失败\"\n    },\n    \"service.start-failed\": {\n      \"en\": \"The managed service could not become ready\",\n      \"zh-CN\": \"托管服务未能就绪\"\n    },\n    \"admission.failed\": {\n      \"en\": \"The maintenance admission rule could not be changed\",\n      \"zh-CN\": \"维护准入规则切换失败\"\n    },\n    \"migration.failed\": {\n      \"en\": \"The platform database migration failed\",\n      \"zh-CN\": \"平台数据库迁移失败\"\n    },\n    \"recovery.failed\": {\n      \"en\": \"The previous version could not be restored\",\n      \"zh-CN\": \"旧版本恢复失败\"\n    },\n    \"cleanup.failed\": {\n      \"en\": \"Some installation resources could not be cleaned\",\n      \"zh-CN\": \"部分安装资源清理失败\"\n    },\n    \"operation.interrupted\": {\n      \"en\": \"The operation was interrupted before a result was recorded\",\n      \"zh-CN\": \"操作中断，尚未记录结果\"\n    },\n    \"unknown\": {\n      \"en\": \"An unclassified update error occurred\",\n      \"zh-CN\": \"发生未分类的升级错误\"\n    }\n  }\n}\n")
# END GENERATED SYSTEM UPDATE CODES


def update_phase_code(phase):
    code='update.'+phase
    return code if code in SYSTEM_UPDATE_CODES['phases'] else 'unknown'


def update_code(value,default='unknown'):
    return value if isinstance(value,str) and re.fullmatch(r'[a-z][a-z0-9.-]{0,127}',value) else default


def update_error_code(error,default='unknown'):
    code=update_code(getattr(error,'system_update_code',getattr(error,'code',default)),default)
    return default if code=='unknown' else code


def update_diagnostic_path(name):
    return '/var/log/dsh-phalanx/'+name if isinstance(name,str) and re.fullmatch(r'[0-9]{8}T[0-9]{6}-[a-f0-9]{8}\.jsonl',name) else None


def update_time_point():
    return {'wall':time.time(),'mono':time.monotonic(),'boot':None}


def update_seconds(start,end):
    if not isinstance(start,dict) or not isinstance(end,dict):return 0
    key='mono' if start.get('boot') and start.get('boot')==end.get('boot') else 'wall'
    values=[start.get(key),end.get(key)]
    if any(type(value) not in (int,float) or not math.isfinite(value) for value in values):return 0
    return round(max(0,values[1]-values[0]),3)


def update_timing(job,point=None):
    timing=(job or {}).get('timing')
    if not isinstance(timing,dict) or not isinstance(timing.get('started'),dict):return None
    point=point or update_time_point();phase=timing['phase'];elapsed=update_seconds(timing['started'],timing.get('phaseEnded',point))
    durations={key:value for key,value in timing.get('phaseSeconds',{}).items()
               if 'update.'+key in SYSTEM_UPDATE_CODES['phases'] and type(value) in (int,float) and math.isfinite(value) and value>=0}
    durations[phase]=round(durations.get(phase,0)+elapsed,3)
    result={'phaseSeconds':durations,'phaseElapsedSeconds':elapsed,'downtimeActive':False}
    if isinstance(timing.get('downtimeStarted'),dict):
        result.update(downtimeSeconds=update_seconds(timing['downtimeStarted'],timing.get('downtimeEnded',point)),downtimeActive='downtimeEnded' not in timing)
    return result


def previous_downtime(job,point=None):
    if not job:return None
    timing=update_timing(job,point)
    value=timing.get('downtimeSeconds') if timing and not timing['downtimeActive'] and job['phase'] in ('succeeded','restored') else job.get('previousDowntimeSeconds')
    return value if type(value) in (int,float) and math.isfinite(value) and value>=0 else None


class HumanProgressRenderer:
    """One transient line on capable terminals; bounded milestones on redirected output."""
    def __init__(self, verbose=False):
        self.verbose = verbose
        self.last = float('-inf')
        self.line = False
        self.paused = False

    def terminal(self):
        return sys.stderr.isatty() and os.environ.get('TERM', '') not in ('', 'dumb')

    def finish(self):
        if self.line:
            print(file=sys.stderr, flush=True)
            self.line = False

    def render(self, event, *, milestone=False):
        if self.paused or event['status'] == 'detail' and not self.verbose: return
        terminal = self.terminal()
        final = event['status'] in ('completed', 'warning', 'failed', 'info', 'detail')
        if not final and not milestone and event['elapsed'] - self.last < (1 if terminal else 30): return
        self.last = event['elapsed']
        detail = event.get('action') or event['message']
        if event['status'] == 'detail': detail = event['message']
        if 'bytes' in event:
            detail += f" · {event['bytes']} bytes"
            if event.get('total', 0) and event['total'] >= event['bytes']:
                detail += f" / {event['total']} bytes ({event['bytes'] * 100 / event['total']:.0f}%)"
        line = f"[{event['phase']}] {event['status']} · {detail} · phase {event['phaseElapsed']:.1f}s / total {event['elapsed']:.1f}s"
        line = ' '.join(line.split())
        if terminal:
            try: width = os.get_terminal_size(sys.stderr.fileno()).columns
            except (OSError, ValueError): width = 80
            # A current line must not wrap: finalized milestones can wrap normally.
            if not final and len(line) >= width:
                # Keep facts at the right on narrow terminals; truncating the full
                # line would erase both the changing progress and waiting time.
                quantity = ''
                if 'bytes' in event:
                    quantity = f"{event['bytes']}B "
                    if event.get('total', 0) and event['total'] >= event['bytes']:
                        quantity = f"{event['bytes'] * 100 / event['total']:.0f}% "
                suffix = f"{quantity}phase{event['phaseElapsed']:.0f}s total{event['elapsed']:.0f}s"
                action = event.get('action') or event['message']
                budget = max(0, width-2-len(suffix))
                line = action[:budget] + ' ' + suffix
            if not final: line = line.encode('ascii', errors='replace').decode()[:max(1, width-1)]
            sys.stderr.write(('\r\x1b[2K' if self.line else '') + line + ('\n' if final else ''))
            sys.stderr.flush(); self.line = not final
        else:
            self.finish(); print(line, file=sys.stderr, flush=True)


class Progress:
    def __init__(self, root=Path('/'), *, output='human', verbose=False, persist=True, clock=time.monotonic):
        self.output, self.verbose = output, verbose
        self.clock = clock
        self.started = self.phase_started = clock()
        self.current = {}
        self.renderer = HumanProgressRenderer(verbose)
        self.phase = 'Preflight'; self.phase_code='install.preflight'
        self.secrets = set()
        self.observers = []
        self.lock = threading.RLock()
        self.log = None
        if persist:
            directory = root/'var/log/dsh-phalanx'
            for parent in (directory, *directory.parents):
                if parent.is_symlink(): raise OSError('Diagnostic paths must not be symbolic links')
                if parent == root: break
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            directory.chmod(0o700)
            self.log = directory/(time.strftime('%Y%m%dT%H%M%S')+'-'+secrets.token_hex(4)+'.jsonl')
            descriptor = os.open(self.log, os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW, 0o600)
            os.close(descriptor)

    def protect(self, *values):
        with self.lock: self.secrets.update(str(value) for value in values if value)

    def safe(self, text):
        text = re.sub(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)', '', str(text))
        text = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', text)
        text = re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', '', text)
        with self.lock:
            for value in sorted(self.secrets, key=len, reverse=True): text = text.replace(value, '[REDACTED]')
        # Diagnostic carriers are untrusted: discard whole sensitive lines,
        # including quoted JSON fields and future environment/CLI key names.
        text = re.sub(r'https?://[^\s\"\']*/bootstrap[^\s\"\']*', '[REDACTED initialization link]', text, flags=re.I)
        text = re.sub(r'https?://[^\s\"\']*[?#][^\s\"\']*', '[REDACTED URL parameters]', text, flags=re.I)
        text = re.sub(r'(?im)^.*(?:authorization|(?:set[-_ ]?)?cookie|[a-z0-9_ -]*(?:key|secret|credential|password|token)[a-z0-9_ -]*)[\"\']?\s*[:=].*$', '[REDACTED sensitive line]', text)
        text = re.sub(r'(?im)^.*--[^\s]*(?:key|secret|credential|password|token)[^\s]*(?:=|\s+).*$', '[REDACTED sensitive command]', text)
        text = re.sub(r'(?i)(https?://)[^\s/@]+:[^\s/@]+@', r'\1[REDACTED]@', text)
        return text

    def subscribe(self, observer):
        self.observers.append(observer)


    def emit(self, status='running', message='', *, milestone=False, **facts):
        with self.lock:
            now = self.clock()
            if status != 'detail':
                if message and not facts.get('heartbeat'):
                    if 'bytes' not in facts: self.current = {}
                    self.current['action'] = self.safe(facts.get('action', message))
                self.current.update({key: value for key, value in facts.items() if key in ('bytes', 'total')})
            self.phase_code=update_code(facts.get('phaseCode',self.phase_code))
            event = {'phase': self.phase, 'phaseCode':self.phase_code, 'status': status, 'elapsed': round(now-self.started, 1),
                     'phaseElapsed': round(now-self.phase_started, 1), 'message': self.safe(message), **self.current,
                     **({'errorCode':update_code(facts['errorCode'])} if 'errorCode' in facts else {})}
            if self.log:
                try:
                    with self.log.open('a') as file: file.write(json.dumps(event)+'\n')
                except OSError:
                    self.log = None
                    self.renderer.finish()
                    print('Diagnostic log unavailable; check disk space and permissions.', file=sys.stderr, flush=True)
            self.renderer.render(event, milestone=milestone)
            for observer in self.observers: observer(dict(event))

    def heartbeat(self):
        self.emit(message='Still working; waiting for this step to finish', heartbeat=True)

    @contextlib.contextmanager
    def input(self):
        with self.lock:
            self.renderer.finish(); self.renderer.paused = True
        try: yield
        finally:
            with self.lock: self.renderer.paused = False

    @contextlib.contextmanager
    def stage(self, name, *, phase_code=None):
        with self.lock:
            self.phase = name; self.phase_code=update_code(phase_code); self.phase_started = self.clock(); self.current = {}
            self.emit(message='Starting', action=name, milestone=True)
        stop = threading.Event()
        def pulse():
            while not stop.wait(1): self.heartbeat()
        thread = threading.Thread(target=pulse, daemon=True); thread.start()
        try:
            yield
        except BaseException as error:
            self.emit('failed', 'Step did not complete',errorCode=update_error_code(error))
            raise
        else: self.emit('completed', heartbeat=True)
        finally:
            stop.set(); thread.join()
            with self.lock: self.renderer.finish()

    def result(self, receipt, *, port=None):
        self.renderer.finish()
        if self.output == 'json': print(json.dumps(receipt, indent=2))
        elif receipt['status'] == 'failed':
            print('Installation failed during '+receipt['phase']+': '+receipt['reason'])
            if receipt.get('diagnosticLog'): print('Diagnostic log: '+receipt['diagnosticLog'])
        else:
            print(f"dsh-phalanx {receipt['version']} installed · {self.clock()-self.started:.1f}s\n")
            if receipt.get('initializationUrl'):
                print('Next: open this link to create your administrator account\n'+receipt['initializationUrl']+'\n')
            print('Admin: '+receipt['adminUrl']+'\nService: ready on this host')
            print('External access: not verified; check browser access'+(f' to entry port {port}' if port else ''))
            print('If using an HTTPS reverse proxy, check its route to this entry.\nAfter signup, configure shared models in the admin page.')
            if self.verbose:
                detail = {key:value for key,value in receipt.items() if key != 'initializationUrl'}
                print(self.safe(json.dumps(detail, indent=2)), file=sys.stderr)

    def upgrade_result(self,result):
        self.renderer.finish()
        if self.output=='json':print(json.dumps(result,indent=2)); return
        if 'check' in result:
            check=result['check']
            print('System update: '+self.safe(check.get('outcomeCode',check['status'])))
            if check.get('version'):print('Release: '+self.safe(check['version']))
            if check.get('requiredVersion'):print('Required version: '+self.safe(check['requiredVersion']))
            if check.get('reason'):print(self.safe(check['reason']))
            return
        job=result['operation']
        if job is None:print('No upgrade operation has been recorded.'); return
        print('System update '+job['id']+': '+job['phase'])
        print('Release: '+job['sourceVersion']+' → '+job['targetVersion'])
        if job['phase']=='prepared':print('Download verified; current service is unchanged. Apply with --upgrade apply --operation '+job['id']+'.')
        elif job['phase']=='succeeded':print('Selected release identity and readiness verified; work is open.')
        elif job['phase']=='restored':print('Update failed. Previous data and service were restored and verified.')
        elif job['phase']=='recovery-failed':print('Recovery failed; follow the server recovery instruction before resuming work.')
        for key in ('failure','recoveryFailure','stopFailure','instruction'):
            if job.get(key):print(self.safe(job[key]))
        if result.get('diagnosticLog'):print('Diagnostic log: '+result['diagnosticLog'])

    def failure(self, error):
        reason = self.safe(str(error))
        self.emit('failed', reason,errorCode=update_error_code(error))
        log = '/var/log/dsh-phalanx/'+self.log.name if self.log else None
        print('Inspect the managed user service: sudo journalctl _SYSTEMD_USER_UNIT=dsh-phalanx.service _UID="$(id -u dsh-phalanx)" -n 80 --no-pager', file=sys.stderr)
        print('Retry with sudo bash install.sh and corrected deployment flags; preserve the data directory.', file=sys.stderr)
        if log: print('Diagnostic log: '+log, file=sys.stderr)
        receipt = {'status':'failed', 'phase':self.phase, 'phaseCode':self.phase_code,'errorCode':update_error_code(error),'reason':reason, 'diagnosticLog':log}
        self.result(receipt)
