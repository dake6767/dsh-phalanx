"""Side-effect-free CLI rehearsal. Never imports the real installer or host adapter."""
import argparse
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from installer_questions import InstallerQuestions, Cancelled, PROJECT, SOURCE_OPTIONS, validate_source, validate_ip, validate_port, validate_origin, validate_mapping, validate_path, validate_optional_path, suggested_origin


class Preview(InstallerQuestions):
    def __init__(self, args):
        self.args = args
        presets = json.loads((Path(__file__).resolve().parents[2] / 'src/domain/download-source-presets.json').read_text())
        super().__init__(args.language or 'zh-CN', input, print, presets, automatic_origin=args.public_origin is None)
        self.interactive = not args.non_interactive and args.output != 'json' and sys.stdin.isatty()
        self.events = []
        self.mapping_choice = None
        self.simulation = True
        self.automatic_origin = args.public_origin is None

    def tell(self, zh, en):
        message = self.tr(zh, en)
        self.events.append(message)
        if self.args.output == 'human':
            print(message)

    def result(self, status, **details):
        result = dict(simulation=True, changed=False, command=self.args.command, status=status, **details)
        if self.args.output == 'json':
            print(json.dumps(result, ensure_ascii=False))
        return 0 if status in ('succeeded', 'cancelled') else 1

    def introduction(self):
        if self.interactive:
            self.tell('操作说明：方括号 [] 内是默认值，直接回车采用；输入 cancel 可取消。\nInput: press Enter to accept the value in []; type cancel to leave.', '操作说明：方括号 [] 内是默认值，直接回车采用；输入 cancel 可取消。\nInput: press Enter to accept the value in []; type cancel to leave.')
        if self.interactive and self.args.language is None:
            self.language = self.choose('语言 / Language: zh-CN 简体中文 / en English', 'Language: zh-CN / en', ('zh-CN', 'en'), 'zh-CN')
        self.tell('【模拟】不下载、不改系统、不操作真实服务或文件；请勿输入真实凭据。', '[SIMULATION] No downloads, system changes, real service or file operations. Do not enter real credentials.')
        self.project_info()

    def install(self):
        args = self.args
        config = dict(source=args.download_source_preset or 'official', server_ip=args.server_ip,
                      port=args.port, origin=args.public_origin, mapping=args.host_public_addresses,
                      gateway=args.gateway_port, data=args.user_data_root, mount=args.user_data_mount,
                      overrides={category: validate_source(category, getattr(args, option)) for option, category in SOURCE_OPTIONS.items() if getattr(args, option) is not None})
        if self.interactive:
            self.edit_source(config)
        self.show_sources(config)
        self.tell('模拟查询版本（使用已选下载源；没有网络请求）', 'Simulating version lookup using the selected source; no network request')
        if args.fail_stage == 'lookup':
            return self.failure('lookup', config)
        if self.interactive:
            self.edit_common(config)
            if self.choose('展开高级设置？y/n', 'Open advanced settings? y/n', ('y', 'n'), 'n') == 'y':
                self.edit_advanced(config)
        else:
            missing = [flag for flag, value in (('--server-ip', config['server_ip']), ('--host-public-addresses', config['mapping'])) if value is None]
            if missing:
                self.tell('非交互缺少参数：' + ', '.join(missing), 'Missing noninteractive options: ' + ', '.join(missing))
                return self.result('failed', code='missing_configuration', missing=missing)
            validate_ip(config['server_ip'])
            validate_port(config['port'])
            validate_port(config['gateway'])
            validate_mapping(config['mapping'])
            config['origin'] = validate_origin(config['origin'] or suggested_origin(config))
            validate_path(config['data'])
            validate_optional_path(config['mount'])
        while True:
            self.summary(config)
            if not self.interactive:
                break
            action = self.choose('摘要：install 安装 / edit 修改 / cancel 取消', 'Summary: install / edit / cancel', ('install', 'edit', 'cancel'), 'install')
            if action == 'cancel':
                raise Cancelled()
            if action == 'install':
                break
            field = self.choose('修改：source 下载源 / common 常用 / advanced 高级', 'Edit: source / common / advanced', ('source', 'common', 'advanced'), 'common')
            if field == 'source':
                self.edit_source(config)
                self.show_sources(config)
                self.tell('模拟按新下载源重新核对版本', 'Simulating version recheck using the new source')
            elif field == 'common':
                self.edit_common(config)
            else:
                self.edit_advanced(config)
        self.tell('\n── 模拟执行 ──', '\n── Simulated execution ──')
        for zh, en, stage in (
            ('1/4 模拟准备系统依赖', '1/4 Simulating OS dependency preparation', 'prepare'),
            ('2/4 模拟下载并核验制品', '2/4 Simulating artifact download and verification', 'download'),
            ('3/4 模拟部署程序与服务', '3/4 Simulating program and service deployment', 'deploy'),
            ('4/4 模拟检查服务就绪', '4/4 Simulating service readiness check', 'ready'),
        ):
            self.tell(zh, en)
            if args.fail_stage == stage:
                return self.failure(stage, config)
        self.tell('\n模拟安装完成。初始化地址：' + config['origin'] + '/bootstrap', '\nSimulated installation complete. Initialization URL: ' + config['origin'] + '/bootstrap')
        self.tell('下一步：在浏览器完成管理员初始化及模型配置，再创建成员。', 'Next: complete administrator setup and model configuration in the browser, then create members.')
        self.tell(PROJECT, PROJECT)
        return self.result('succeeded', configuration=config, initialization_url=config['origin'] + '/bootstrap')

    def failure(self, stage, config=None):
        messages = {
            'lookup': ('版本查询失败；检查下载源后重试，尚未准备系统。', 'Version lookup failed; check the source and retry. OS preparation has not started.'),
            'prepare': ('依赖准备失败；真实执行可能已安装部分系统依赖，修复后用相同配置重试。', 'Dependency preparation failed; real execution may have installed OS packages. Repair and retry with the same configuration.'),
            'download': ('制品下载或核验失败；真实执行已准备依赖，检查来源后重试。', 'Artifact download or verification failed; real execution has prepared dependencies. Check the source and retry.'),
            'deploy': ('部署失败；真实执行可能已写程序和配置，保留数据并修复后重试。', 'Deployment failed; real execution may have written programs and configuration. Preserve data, repair and retry.'),
            'ready': ('服务未就绪；真实执行可能已有运行组件，检查日志及 status 后重试。', 'Service not ready; real execution may have running components. Inspect logs and status, then retry.'),
        }
        self.tell(*messages[stage])
        self.tell('以上均为模拟，本次主机没有发生这些变化。', 'These are simulated outcomes; none of these host changes occurred in this run.')
        return self.result('failed', code='simulated_failure', stage=stage, configuration=config)

    def manage(self):
        args = self.args
        command = args.command
        if command == 'status':
            self.tell('只读模拟状态：' + args.state, 'Read-only simulated status: ' + args.state)
            self.tell('不会拉起服务或清理；query-failed 表示无法查询，不能视为已停止。', 'No service starts or cleanup; query-failed means unavailable observation, never stopped.')
            components = {
                'running': {'platform': 'running', 'members': 'running', 'database': 'running'},
                'stopped': {'platform': 'stopped', 'members': 'stopped', 'database': 'stopped'},
                'partial': {'platform': 'stopped', 'members': 'running', 'database': 'stopped'},
            }.get(args.state, {'platform': 'unknown', 'members': 'unknown', 'database': 'unknown'})
            for component, state in components.items():
                labels = {'platform': '平台', 'members': '成员实例', 'database': '内置数据库'}
                states = {'running': '运行中', 'stopped': '已停止', 'unknown': '未知'}
                self.tell(labels[component] + ': ' + states[state], component + ': ' + state)
            return self.result('failed' if args.state in ('query-failed','partial') else 'succeeded', state=args.state, deployment_state=args.state, components=components)
        if args.state == 'maintenance':
            self.tell('拒绝操作：部署维护锁正由升级占用；等待原操作完成，不强制绕过。', 'Operation refused: upgrade owns the maintenance lock. Wait for it; no forced bypass.')
            return self.result('failed', code='operation_conflict')
        if args.state == 'not-installed' and command == 'stop':
            self.tell('未安装，无需停止；未修改任何数据。', 'Not installed; nothing to stop. No data changed.')
            return self.result('succeeded', state='not-installed', already=True)
        if args.state == 'not-installed':
            self.tell('未安装；无可操作服务。保留数据须通过原安装器重新安装，或明确选择其后续清理入口。', 'Not installed; no service to operate. Reuse retained data with the installer or select its explicit later cleanup entry.')
            return self.result('failed', code='not_installed')
        if args.fail_stage is None and (command, args.state) in (('start', 'running'), ('stop', 'stopped')):
            self.tell('模拟：已经处于目标状态，无需重复执行。', 'Simulation: already in the target state; no repeated work.')
            return self.result('succeeded', already=True)
        if command == 'start':
            self.tell('模拟启动平台、内置数据库及受管组件；启用账户的常驻实例自动启动，非常驻按访问启动。', 'Simulating platform, built-in database and managed components starting; enabled resident members start automatically, others on access.')
            self.tell('保持原开机自启策略；不承诺恢复中断的任务。', 'Preserve the existing boot policy; interrupted tasks are not resumed.')
        else:
            self.tell('影响范围：平台服务、成员实例和受管后台任务、内置数据库及独立受管维护组件；任务会中断。外部数据库不停止。', 'Scope: platform, member instances, managed background tasks, built-in database and separately managed maintenance components. Tasks are interrupted; external databases are not stopped.')
            if command == 'stop':
                self.tell('保留配置、插件、密钥、成员文件、数据库和原开机自启设置。', 'Retain configuration, plugins, keys, member files, database and existing boot policy.')
            else:
                self.uninstall_scope()
            if self.interactive:
                confirmation = 'PURGE' if args.purge else 'yes'
                response = self.ask('输入 ' + confirmation + ' 确认；cancel 取消', 'Type ' + confirmation + ' to confirm; cancel to cancel', 'cancel')
                if response != confirmation:
                    raise Cancelled()
            elif not args.yes:
                self.tell('非交互需要 --yes 确认模拟影响范围。', 'Noninteractive rehearsal requires --yes to confirm the simulated scope.')
                return self.result('failed', code='confirmation_required')
        if args.fail_stage == 'operation':
            if command == 'start':
                self.tell('模拟部分失败：数据库已启动，平台未就绪；数据保留，修复后重试 start。', 'Simulated partial failure: database started, platform not ready; data retained. Repair and retry start.')
                completed, pending = ['database-start'], ['platform-start']
            else:
                self.tell('模拟部分失败：平台已停止，成员实例仍残留；未删除数据。修复后用同一命令重试，status 查看实际分项。', 'Simulated partial failure: platform stopped, member instances remain; data retained. Repair, retry the same command and inspect component status.')
                completed, pending = ['platform-stop'], ['member-stop']
            return self.result('failed', code='simulated_partial_failure', completed=completed, pending=pending, retained=['all-data'])
        self.tell('模拟操作完成；没有操作真实服务。重复调用应报告已达目标或尚未完成，不重复创建实例。', 'Simulated operation complete; no real service was operated. Repeated calls report achieved or incomplete state without duplicating instances.')
        return self.result('succeeded', purge=args.purge if command == 'uninstall' else False)

    def uninstall_scope(self):
        if self.args.purge:
            self.tell('将删除（模拟）：核验归属后的本部署程序、服务、配置、密钥、内置数据库、成员文件，含外置目录中的本部署数据。', 'Delete (simulated): ownership-verified deployment programs, services, configuration, keys, built-in database and member files, including deployment data in external directories.')
        else:
            self.tell('默认卸载（模拟）：只移除本部署程序、服务和全局入口，解除本部署自启。', 'Default uninstall (simulated): remove deployment programs, services and global entry; disable deployment autostart.')
            self.tell('成套保留：数据库、匹配密钥、配置、成员空间与恢复记录；不是仅保留升级回滚备份。', 'Retain together: database, matching keys, configuration, member spaces and recovery records; upgrade rollback backups alone are insufficient.')
            self.tell('后续：用原安装器重新安装同一版本以恢复；入口卸除后用 sudo bash install.sh --uninstall --purge 清理。', 'Later: reinstall the same release to recover; after entry removal use sudo bash install.sh --uninstall --purge.')
        self.tell('始终保留：外部 PostgreSQL、系统账户、系统依赖、共享资源和相邻部署；不清空挂载盘。', 'Always retain: external PostgreSQL, system accounts, OS dependencies, shared resources and adjacent deployments; never empty a mounted volume.')


def options():
    parser = argparse.ArgumentParser(add_help=False, description='dsh-phalanx CLI SIMULATION / CLI 模拟 — ' + PROJECT)
    parser.add_argument('--help', action='store_true')
    parser.add_argument('command', choices=('install', 'start', 'stop', 'status', 'uninstall'), nargs='?', default='install')
    parser.add_argument('--language', choices=('zh-CN', 'en'))
    parser.add_argument('--output', choices=('human', 'json'), default='human')
    parser.add_argument('--non-interactive', action='store_true')
    parser.add_argument('--server-ip')
    parser.add_argument('--port', default='18080')
    parser.add_argument('--public-origin')
    parser.add_argument('--host-public-addresses', help='Empty means explicitly none / 空字符串表示明确没有')
    parser.add_argument('--download-source-preset', choices=('official', 'mainland'))
    for option in SOURCE_OPTIONS:
        parser.add_argument('--' + option.replace('_', '-'))
    parser.add_argument('--gateway-port', default='3081')
    parser.add_argument('--user-data-root', default='/var/lib/dsh-phalanx/data.durable/users')
    parser.add_argument('--user-data-mount', default='')
    parser.add_argument('--yes', action='store_true')
    parser.add_argument('--purge', action='store_true')
    parser.add_argument('--state', choices=('running', 'stopped', 'partial', 'maintenance', 'not-installed', 'query-failed'), default='running')
    parser.add_argument('--fail-stage', choices=('lookup', 'prepare', 'download', 'deploy', 'ready', 'operation'))
    args = parser.parse_args()
    if args.help:
        preview = Preview(args)
        if args.output == 'json':
            print(json.dumps(dict(simulation=True, changed=False, command=args.command, status='help', options=[option for action in parser._actions for option in action.option_strings], commands=['install', 'start', 'stop', 'status', 'uninstall'])))
        else:
            print(preview.tr('CLI 模拟帮助：默认中文；不会执行真实安装或管理。', 'CLI simulation help: no real installation or management.'))
            parser.print_help()
        sys.exit(0)
    return args


def main():
    args = options()
    preview = Preview(args)
    try:
        preview.introduction()
        return preview.install() if args.command == 'install' else preview.manage()
    except (Cancelled, EOFError, KeyboardInterrupt):
        preview.tell('模拟已取消；未操作主机。', 'Simulation cancelled; no host operations.')
        return preview.result('cancelled')
    except ValueError:
        preview.tell('配置无效；检查参数后重试。未操作主机。', 'Invalid configuration; check arguments and retry. No host operations.')
        return preview.result('failed', code='invalid_configuration')


if __name__ == '__main__':
    sys.exit(main())
