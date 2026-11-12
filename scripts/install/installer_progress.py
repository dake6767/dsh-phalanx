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
import unicodedata
import time


# BEGIN GENERATED SYSTEM UPDATE CODES
# Generated from src/domain/system-update-codes.json; do not edit this value.
SYSTEM_UPDATE_CODES = json.loads("{\n  \"phases\": {\n    \"install.preflight\": {\n      \"en\": \"Checking installation requirements\",\n      \"zh-CN\": \"检查安装条件\"\n    },\n    \"install.lock\": {\n      \"en\": \"Acquiring the installation lock\",\n      \"zh-CN\": \"获取安装锁\"\n    },\n    \"install.release-selection\": {\n      \"en\": \"Selecting a verified release\",\n      \"zh-CN\": \"选择已验证版本\"\n    },\n    \"install.configuration\": {\n      \"en\": \"Reading installation configuration\",\n      \"zh-CN\": \"读取安装配置\"\n    },\n    \"install.download\": {\n      \"en\": \"Downloading and verifying assets\",\n      \"zh-CN\": \"下载并校验制品\"\n    },\n    \"install.existing-installation\": {\n      \"en\": \"Checking the installed release\",\n      \"zh-CN\": \"检查已安装版本\"\n    },\n    \"install.dependencies\": {\n      \"en\": \"Preparing host dependencies\",\n      \"zh-CN\": \"准备主机依赖\"\n    },\n    \"install.identity-storage\": {\n      \"en\": \"Preparing service identity and storage\",\n      \"zh-CN\": \"准备服务身份与存储\"\n    },\n    \"install.staging\": {\n      \"en\": \"Staging the verified platform\",\n      \"zh-CN\": \"暂存已验证平台\"\n    },\n    \"install.runtime-image\": {\n      \"en\": \"Preparing the runtime image\",\n      \"zh-CN\": \"准备运行镜像\"\n    },\n    \"install.database\": {\n      \"en\": \"Preparing the platform database\",\n      \"zh-CN\": \"准备平台数据库\"\n    },\n    \"install.executor\": {\n      \"en\": \"Installing the update executor\",\n      \"zh-CN\": \"安装升级执行器\"\n    },\n    \"install.activation\": {\n      \"en\": \"Starting the managed service\",\n      \"zh-CN\": \"启动托管服务\"\n    },\n    \"update.preparing\": {\n      \"en\": \"Downloading and verifying the update\",\n      \"zh-CN\": \"下载并校验更新\"\n    },\n    \"update.prepared\": {\n      \"en\": \"Ready to apply\",\n      \"zh-CN\": \"可以应用更新\"\n    },\n    \"update.prepare-failed\": {\n      \"en\": \"Download or verification failed\",\n      \"zh-CN\": \"下载或校验失败\"\n    },\n    \"update.stopping\": {\n      \"en\": \"Stopping the service and user instances\",\n      \"zh-CN\": \"停止平台与成员实例\",\n      \"step\": 1,\n      \"total\": 6,\n      \"mode\": \"apply\"\n    },\n    \"update.backing-up\": {\n      \"en\": \"Backing up platform data\",\n      \"zh-CN\": \"备份平台数据\",\n      \"step\": 2,\n      \"total\": 6,\n      \"mode\": \"apply\"\n    },\n    \"update.backed-up\": {\n      \"en\": \"Platform backup verified\",\n      \"zh-CN\": \"平台备份已验证\",\n      \"step\": 3,\n      \"total\": 6,\n      \"mode\": \"apply\"\n    },\n    \"update.switching\": {\n      \"en\": \"Switching to the verified version\",\n      \"zh-CN\": \"切换到已验证版本\",\n      \"step\": 4,\n      \"total\": 6,\n      \"mode\": \"apply\"\n    },\n    \"update.validating\": {\n      \"en\": \"Checking the new service\",\n      \"zh-CN\": \"检查新版本服务\",\n      \"step\": 5,\n      \"total\": 6,\n      \"mode\": \"apply\"\n    },\n    \"update.committed\": {\n      \"en\": \"Update verified; reopening the service\",\n      \"zh-CN\": \"更新已验证，正在开放服务\",\n      \"step\": 6,\n      \"total\": 6,\n      \"mode\": \"apply\"\n    },\n    \"update.succeeded\": {\n      \"en\": \"Update completed successfully\",\n      \"zh-CN\": \"升级成功\"\n    },\n    \"update.apply-failed\": {\n      \"en\": \"Update could not be applied\",\n      \"zh-CN\": \"无法应用更新\"\n    },\n    \"update.restoring\": {\n      \"en\": \"Restoring the previous version\",\n      \"zh-CN\": \"正在恢复旧版本\",\n      \"step\": 1,\n      \"total\": 2,\n      \"mode\": \"recovery\"\n    },\n    \"update.restoration-committed\": {\n      \"en\": \"Previous version verified; reopening the service\",\n      \"zh-CN\": \"旧版本已验证，正在开放服务\",\n      \"step\": 2,\n      \"total\": 2,\n      \"mode\": \"recovery\"\n    },\n    \"update.restored\": {\n      \"en\": \"Update failed; the previous version was restored\",\n      \"zh-CN\": \"升级失败，已恢复旧版本\"\n    },\n    \"update.recovery-failed\": {\n      \"en\": \"Recovery failed; operator action is required\",\n      \"zh-CN\": \"恢复失败，需要管理员处理\"\n    },\n    \"update.bootstrap\": {\n      \"en\": \"Updating the small executor\",\n      \"zh-CN\": \"更新小执行器\"\n    },\n    \"update.cleanup\": {\n      \"en\": \"Cleaning unused installation resources\",\n      \"zh-CN\": \"清理无用安装资源\"\n    },\n    \"deployment.start\": {\n      \"en\": \"Starting the deployment\",\n      \"zh-CN\": \"启动部署\"\n    },\n    \"deployment.stop\": {\n      \"en\": \"Stopping the deployment\",\n      \"zh-CN\": \"停止部署\"\n    },\n    \"deployment.status\": {\n      \"en\": \"Inspecting deployment status\",\n      \"zh-CN\": \"查询部署状态\"\n    }\n  },\n  \"outcomes\": {\n    \"update.available\": {\n      \"en\": \"Update available\",\n      \"zh-CN\": \"有可用更新\"\n    },\n    \"update.current\": {\n      \"en\": \"Already up to date\",\n      \"zh-CN\": \"已是最新版本\"\n    },\n    \"update.breakpoint-required\": {\n      \"en\": \"Update to the required intermediate version first\",\n      \"zh-CN\": \"需要先升级到断点版本\"\n    },\n    \"update.below-floor\": {\n      \"en\": \"The installed version is below the upgrade floor\",\n      \"zh-CN\": \"当前版本低于升级下限\"\n    },\n    \"update.channel-switch\": {\n      \"en\": \"A formal release is available for this candidate\",\n      \"zh-CN\": \"此候选版可以转为正式版\"\n    },\n    \"update.reader-update-required\": {\n      \"en\": \"Update the small executor first\",\n      \"zh-CN\": \"需要先更新小执行器\"\n    }\n  },\n  \"errors\": {\n    \"disk.insufficient\": {\n      \"en\": \"There is not enough disk space\",\n      \"zh-CN\": \"磁盘空间不足\"\n    },\n    \"disk.inspection-failed\": {\n      \"en\": \"Disk capacity could not be checked\",\n      \"zh-CN\": \"无法检查磁盘容量\"\n    },\n    \"database.unavailable\": {\n      \"en\": \"The platform database is unavailable\",\n      \"zh-CN\": \"平台数据库不可用\"\n    },\n    \"database.export-failed\": {\n      \"en\": \"The platform database could not be exported\",\n      \"zh-CN\": \"平台数据库导出失败\"\n    },\n    \"database.restore-failed\": {\n      \"en\": \"The platform database could not be restored\",\n      \"zh-CN\": \"平台数据库恢复失败\"\n    },\n    \"download.failed\": {\n      \"en\": \"The release download failed\",\n      \"zh-CN\": \"发布制品下载失败\"\n    },\n    \"release.metadata-invalid\": {\n      \"en\": \"The release declaration is invalid\",\n      \"zh-CN\": \"发布声明无效\"\n    },\n    \"release.checksum-failed\": {\n      \"en\": \"A release asset failed checksum verification\",\n      \"zh-CN\": \"发布制品校验失败\"\n    },\n    \"release.identity-mismatch\": {\n      \"en\": \"The release or running process identity does not match\",\n      \"zh-CN\": \"发布制品或运行进程身份不匹配\"\n    },\n    \"compatibility.unsupported\": {\n      \"en\": \"This release is incompatible with the installed platform\",\n      \"zh-CN\": \"此版本与已安装平台不兼容\"\n    },\n    \"operation.conflict\": {\n      \"en\": \"Another operation must finish or recover first\",\n      \"zh-CN\": \"需先完成或恢复另一个操作\"\n    },\n    \"operation.invalid\": {\n      \"en\": \"The selected operation or release changed\",\n      \"zh-CN\": \"所选操作或发布身份已变化\"\n    },\n    \"backup.failed\": {\n      \"en\": \"The platform backup failed\",\n      \"zh-CN\": \"平台备份失败\"\n    },\n    \"backup.invalid\": {\n      \"en\": \"The recovery backup is incomplete or damaged\",\n      \"zh-CN\": \"恢复备份不完整或已损坏\"\n    },\n    \"service.stop-failed\": {\n      \"en\": \"The managed service could not be stopped\",\n      \"zh-CN\": \"托管服务停止失败\"\n    },\n    \"service.start-failed\": {\n      \"en\": \"The managed service could not become ready\",\n      \"zh-CN\": \"托管服务未能就绪\"\n    },\n    \"admission.failed\": {\n      \"en\": \"The maintenance admission rule could not be changed\",\n      \"zh-CN\": \"维护准入规则切换失败\"\n    },\n    \"migration.failed\": {\n      \"en\": \"The platform database migration failed\",\n      \"zh-CN\": \"平台数据库迁移失败\"\n    },\n    \"recovery.failed\": {\n      \"en\": \"The previous version could not be restored\",\n      \"zh-CN\": \"旧版本恢复失败\"\n    },\n    \"cleanup.failed\": {\n      \"en\": \"Some installation resources could not be cleaned\",\n      \"zh-CN\": \"部分安装资源清理失败\"\n    },\n    \"operation.interrupted\": {\n      \"en\": \"The operation was interrupted before a result was recorded\",\n      \"zh-CN\": \"操作中断，尚未记录结果\"\n    },\n    \"unknown\": {\n      \"en\": \"An unclassified update error occurred\",\n      \"zh-CN\": \"发生未分类的升级错误\"\n    }\n  }\n}\n")
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



def operator_text(value, language):
    if language != 'zh-CN':
        return value
    known = {
        'Starting': '开始', 'Step did not complete': '当前步骤未完成',
        'Still working; waiting for this step to finish': '仍在执行，等待当前步骤完成',
        'Fetching instance image': '拉取实例镜像', 'Loading instance image': '载入实例镜像',
        'Verifying release checksums': '核对发布制品校验和', 'Staging verified platform': '暂存已核验的平台程序',
        'Waiting for another installer to release the installation lock': '等待其他安装器释放安装锁',
        'Diagnostic log unavailable; check disk space and permissions.': '诊断日志不可用，请检查磁盘空间和权限。',
        'Installation requires a Linux amd64 host': '安装需要 Linux amd64 主机',
        'Run the installer with sudo': '请使用 sudo 运行安装器',
        'Host aliases must be public IPv4 literals': '公网映射清单必须填写公网 IPv4 地址',
        'Invalid deployment configuration': '部署配置无效',
        'Entry and private gateway ports must differ': '平台入口端口与内部网关端口必须不同',
        'Public origin must be an HTTP(S) origin without credentials or path': '浏览器访问地址必须是HTTP(S)来源地址，不能包含凭据或路径',
        'External user storage requires absolute root and mount paths': '外置成员存储需要同时填写数据目录与挂载点的绝对路径',
        'User storage must be inside the declared independent data mount': '成员数据目录必须位于声明的独立数据挂载点内',
        'Platform and external user storage must not overlap': '平台数据与外置成员存储目录不能重叠',
        'The declared user data volume is not mounted; no directory was created': '声明的数据卷尚未挂载，未创建数据目录',
        'User storage must be a directory, not a symbolic link': '成员存储必须是目录，不能是符号链接',
        'Preview requires a separate listener port': '服务预览需要独立且有效的监听端口',
        'Preview origin must use the same host and scheme on a different public port': '服务预览地址必须与平台地址使用相同主机和协议，以及不同的公开端口',
        'No free private gateway port; specify --gateway-port': '没有可用的内部网关端口，请使用 --gateway-port 指定',
        'Terminal input closed; retry with explicit noninteractive configuration': '终端输入已关闭，请使用明确的非交互参数重试',
        'No terminal available; provide --public-origin and --host-public-addresses': '无可用终端，请提供 --public-origin 与 --host-public-addresses',
        'Deployment host address inventory is required for public networking': '成员联网需要明确声明公网映射',
    }
    if value in known:
        return known[value]
    gateway = re.fullmatch(r'Private gateway port ([0-9]+) is occupied; using ([0-9]+) \(saved in configuration\).', value)
    if gateway:
        return '内部网关端口 '+gateway[1]+' 已占用，改用 '+gateway[2]+'（已保存）。'
    conflict = re.fullmatch(r'(--[a-z-]+) ([0-9]+) is unavailable: (.*)\. No occupying process was stopped\.', value)
    if conflict:
        return conflict[1]+' '+conflict[2]+' 不可用：'+conflict[3]+'。未停止占用进程。'
    retry = re.fullmatch(r'Choose a free (--[a-z-]+) and rerun the installer; (.*)', value)
    if retry:
        return '请选择可用的 '+retry[1]+' 后重新运行安装器；'+retry[2]
    if value.endswith(' must be between 1 and 65535'):
        return value.removesuffix(' must be between 1 and 65535') + ' 必须介于1和65535之间'
    if value.startswith('Running '):
        return '执行 ' + value.removeprefix('Running ')
    return value


def localized_error(code, phase, language):
    if language != 'zh-CN' or code == 'unknown':
        return None
    if code == 'compatibility.unsupported' and phase == 'install.preflight':
        return '当前主机环境不受支持'
    return SYSTEM_UPDATE_CODES['errors'].get(code, {}).get('zh-CN')


def display_width(value):
    return sum(0 if unicodedata.combining(character) else 2 if unicodedata.east_asian_width(character) in ('W', 'F') else 1 for character in value)


def fit_terminal(value, width):
    result = ''
    for character in value:
        if display_width(result + character) > width:
            break
        result += character
    return result


class HumanProgressRenderer:
    """One transient line on capable terminals; bounded milestones on redirected output."""
    def __init__(self, verbose=False, language='en'):
        self.verbose = verbose
        self.language = language
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
        if self.language == 'zh-CN':
            phase = SYSTEM_UPDATE_CODES['phases'].get(event.get('phaseCode'), {}).get('zh-CN', event['phase'])
            status = {'running':'进行中', 'completed':'完成', 'warning':'警告', 'failed':'失败', 'info':'信息', 'detail':'详情'}.get(event['status'], event['status'])
            detail = phase if detail == event['phase'] else operator_text(detail, self.language)
            translated_error = localized_error(event.get('errorCode'), event.get('phaseCode'), self.language)
            if translated_error:
                detail = translated_error
            line = f"[{phase}] {status} · {detail} · 本阶段 {event['phaseElapsed']:.1f}s / 总计 {event['elapsed']:.1f}s"
        else:
            line = f"[{event['phase']}] {event['status']} · {detail} · phase {event['phaseElapsed']:.1f}s / total {event['elapsed']:.1f}s"
        line = ' '.join(line.split())
        if terminal:
            try: width = os.get_terminal_size(sys.stderr.fileno()).columns
            except (OSError, ValueError): width = 80
            # A current line must not wrap: finalized milestones can wrap normally.
            if not final and display_width(line) >= width:
                # Keep facts at the right on narrow terminals; truncating the full
                # line would erase both the changing progress and waiting time.
                quantity = ''
                if 'bytes' in event:
                    quantity = f"{event['bytes']}B "
                    if event.get('total', 0) and event['total'] >= event['bytes']:
                        quantity = f"{event['bytes'] * 100 / event['total']:.0f}% "
                suffix = f"{quantity}阶段{event['phaseElapsed']:.0f}s 总计{event['elapsed']:.0f}s" if self.language == 'zh-CN' else f"{quantity}phase{event['phaseElapsed']:.0f}s total{event['elapsed']:.0f}s"
                action = operator_text(event.get('action') or event['message'], self.language)
                budget = max(0, width-2-display_width(suffix))
                line = fit_terminal(action, budget) + ' ' + suffix
            if not final: line = fit_terminal(line, max(1, width-1))
            sys.stderr.write(('\r\x1b[2K' if self.line else '') + line + ('\n' if final else ''))
            sys.stderr.flush(); self.line = not final
        else:
            self.finish(); print(line, file=sys.stderr, flush=True)


class Progress:
    def __init__(self, root=Path('/'), *, output='human', verbose=False, persist=True, clock=time.monotonic, language='en'):
        self.output, self.verbose = output, verbose
        self.language = language
        self.clock = clock
        self.started = self.phase_started = clock()
        self.current = {}
        self.renderer = HumanProgressRenderer(verbose, language)
        self.phase = 'Preflight'; self.phase_code='install.preflight'
        self.secrets = set()
        self.observers = []
        self.lock = threading.RLock()
        self.log = None
        self.host_admission = None
        self.root = root
        if persist: self.start_log()

    def start_log(self):
        if self.log is not None: return
        directory = self.root/'var/log/dsh-phalanx'
        for parent in (directory, *directory.parents):
            if parent.is_symlink(): raise OSError('Diagnostic paths must not be symbolic links')
            if parent == self.root: break
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
        if self.host_admission is not None: receipt = {**receipt, 'hostAdmission': self.host_admission}
        self.renderer.finish()
        if self.output == 'json': print(json.dumps(receipt, indent=2))
        elif receipt['status'] == 'failed':
            self.host_status()
            if self.language == 'zh-CN':
                phase = SYSTEM_UPDATE_CODES['phases'].get(receipt.get('phaseCode'), {}).get('zh-CN', receipt['phase'])
                error = localized_error(receipt.get('errorCode'), receipt.get('phaseCode'), self.language)
                reason = operator_text(receipt['reason'], self.language)
                print('安装失败，阶段 '+phase+'：'+(error or reason))
                if error and error != reason:
                    print('详细信息：'+reason)
            else:
                print('Installation failed during '+receipt['phase']+': '+receipt['reason'])
            if receipt.get('diagnosticLog'):
                print(('诊断日志：' if self.language == 'zh-CN' else 'Diagnostic log: ') + receipt['diagnosticLog'])
        else:
            print(f"dsh-phalanx {receipt['version']} " + ('安装完成' if self.language == 'zh-CN' else 'installed') + f" · {self.clock()-self.started:.1f}s\n")
            self.host_status()
            if receipt.get('initializationUrl'):
                print(('下一步：打开此链接创建管理员账户' if self.language == 'zh-CN' else 'Next: open this link to create your administrator account') + '\n' + receipt['initializationUrl'] + '\n')
            print(('管理入口：' if self.language == 'zh-CN' else 'Admin: ') + receipt['adminUrl'])
            if self.language == 'zh-CN':
                print('服务已在本机就绪；外部访问尚未验证，请检查浏览器访问地址与入口端口。')
                print('使用HTTPS反向代理时请核对路由；注册后在管理页面配置共享模型。')
            else:
                print('Service: ready on this host')
                print('External access: not verified; check browser access'+(f' to entry port {port}' if port else ''))
                print('If using an HTTPS reverse proxy, check its route to this entry.\nAfter signup, configure shared models in the admin page.')
            print('https://github.com/dake6767/dsh-phalanx')
            if self.verbose:
                detail = {key:value for key,value in receipt.items() if key != 'initializationUrl'}
                print(self.safe(json.dumps(detail, indent=2)), file=sys.stderr)

    def host_status(self):
        if self.host_admission is not None:
            facts = self.host_admission
            status = 'unsupported' if facts['family'] != 'debian' else 'verified' if facts['verified'] else 'unverified'
            if self.language == 'zh-CN':
                label = {'verified':'已验证', 'unverified':'未验证', 'unsupported':'不支持'}[status]
                print('主机：'+facts['distribution']+' '+facts['version']+'（'+label+'）')
            else:
                print('Host: '+facts['distribution']+' '+facts['version']+' ('+status+')')

    def upgrade_result(self,result):
        self.renderer.finish()
        if self.host_admission is not None: result = {**result, 'hostAdmission': self.host_admission}
        if self.output=='json':print(json.dumps(result,indent=2)); return
        self.host_status()
        if 'check' in result:
            check=result['check']
            outcome = check.get('outcomeCode', check['status'])
            label = SYSTEM_UPDATE_CODES['outcomes'].get(outcome, {}).get(self.language, outcome)
            print(('系统更新：' if self.language == 'zh-CN' else 'System update: ')+self.safe(label)+(' ('+outcome+')' if label != outcome else ''))
            if check.get('version'):print(('版本：' if self.language == 'zh-CN' else 'Release: ')+self.safe(check['version']))
            if check.get('requiredVersion'):print(('所需版本：' if self.language == 'zh-CN' else 'Required version: ')+self.safe(check['requiredVersion']))
            if check.get('reason'):print(self.safe(check['reason']))
            return
        job=result['operation']
        if job is None:print('尚无升级操作记录。' if self.language == 'zh-CN' else 'No upgrade operation has been recorded.'); return
        phase = SYSTEM_UPDATE_CODES['phases'].get(update_phase_code(job['phase']), {}).get(self.language, job['phase'])
        print(('系统更新 ' if self.language == 'zh-CN' else 'System update ')+job['id']+': '+phase)
        print(('版本：' if self.language == 'zh-CN' else 'Release: ')+job['sourceVersion']+' → '+job['targetVersion'])
        if job['phase']=='prepared':print(('下载已核验，当前服务保持运行。应用命令：' if self.language == 'zh-CN' else 'Download verified; current service is unchanged. Apply with ')+'--upgrade apply --operation '+job['id']+'.')
        elif job['phase']=='succeeded':print('所选版本身份和就绪状态已核验，服务已开放。' if self.language == 'zh-CN' else 'Selected release identity and readiness verified; work is open.')
        elif job['phase']=='restored':print('更新失败，已恢复并核验原数据和服务。' if self.language == 'zh-CN' else 'Update failed. Previous data and service were restored and verified.')
        elif job['phase']=='recovery-failed':print('恢复失败，请按服务端恢复指引处理后再继续。' if self.language == 'zh-CN' else 'Recovery failed; follow the server recovery instruction before resuming work.')
        for key in ('failure','recoveryFailure','stopFailure','instruction'):
            if job.get(key):print(self.safe(job[key]))
        if result.get('diagnosticLog'):print(('诊断日志：' if self.language == 'zh-CN' else 'Diagnostic log: ')+result['diagnosticLog'])

    def cancel(self, reason):
        self.renderer.finish()
        if self.output == 'json':
            print(json.dumps({'status':'cancelled', 'phase':self.phase, 'phaseCode':self.phase_code, 'reason':self.safe(reason)}))
        else:
            print(self.safe(reason))

    def failure(self, error):
        reason = self.safe(str(error))
        self.emit('failed', reason,errorCode=update_error_code(error))
        log = '/var/log/dsh-phalanx/'+self.log.name if self.log else None
        print(('查看托管用户服务日志：' if self.language == 'zh-CN' else 'Inspect the managed user service: ')+'sudo journalctl _SYSTEMD_USER_UNIT=dsh-phalanx.service _UID="$(id -u dsh-phalanx)" -n 80 --no-pager', file=sys.stderr)
        print('请保留数据目录，修正配置后用 sudo bash install.sh 重试。已准备的系统依赖不会自动撤销。' if self.language == 'zh-CN' else 'Retry with sudo bash install.sh and corrected deployment flags; preserve the data directory. Prepared OS packages are not automatically removed.', file=sys.stderr)
        if log: print(('诊断日志：' if self.language == 'zh-CN' else 'Diagnostic log: ')+log, file=sys.stderr)
        receipt = {'status':'failed', 'phase':self.phase, 'phaseCode':self.phase_code,'errorCode':update_error_code(error),'reason':reason, 'diagnosticLog':log}
        self.result(receipt)
