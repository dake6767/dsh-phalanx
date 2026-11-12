"""Shared installation questions and validation; callers own terminal and host effects."""
import ipaddress
import json
from urllib.parse import urlsplit

PROJECT = 'https://github.com/dake6767/dsh-phalanx'
# Existing installer option spellings; synchronized by the preview contract tests.
from installer_config import DOWNLOAD_SOURCE_OPTIONS  # embedded-config

SOURCE_OPTIONS = DOWNLOAD_SOURCE_OPTIONS
PREFIXES = ('containerMirror', 'ghcrMirror', 'githubAssets', 'githubApi')


class Cancelled(ValueError):
    pass


class InstallerQuestions:
    def __init__(self, language, read, write, presets, *, automatic_origin=True, simulation=False):
        self.simulation = simulation
        self.language = language
        self.read = read
        self.write = write
        self.presets = presets
        self.mapping_choice = None
        self.gateway_chosen = False
        self.automatic_origin = automatic_origin

    def tr(self, zh, en):
        return zh if self.language == 'zh-CN' else en

    def tell(self, zh, en):
        self.write(self.tr(zh, en))

    def ask(self, zh, en, default=None, validate=None):
        while True:
            label = self.tr(zh, en).replace(' / ', '\n  / ')
            value = self.read('\n' + label + '\n  >' + (f' [{default}]' if default is not None else '') + ': ').strip()
            if value.lower() == 'cancel':
                raise Cancelled(self.tr('安装已取消；保留已准备的系统依赖和现有数据。', 'Installation cancelled; retain prepared OS dependencies and existing data.'))
            if not value and default is not None:
                value = default
            try:
                return validate(value) if validate else value
            except ValueError:
                self.tell('输入无效，请在此重新填写；其他答案保留。', 'Invalid input; retry here. Other answers are retained.')

    def choose(self, zh, en, choices, default):
        def check(value):
            if value not in choices:
                raise ValueError()
            return value
        return self.ask(zh, en, default, check)

    def project_info(self):
        self.tell('dsh-phalanx：面向小团队的多用户自托管 AI 平台，每位成员拥有独立用户空间。', 'dsh-phalanx: a multi-user, self-hosted AI platform for small teams, with an independent space for each member.')
        self.tell(PROJECT, PROJECT)

    def edit_source(self, config):
        choice = self.choose('下载源：official 官方 / mainland 中国大陆 / custom 自定义（独立于语言）', 'Download source: official / mainland / custom (independent of language)', ('official', 'mainland', 'custom'), config['source'])
        if choice == 'custom':
            config['source'] = self.choose('自定义基础源 official/mainland', 'Custom base official/mainland', ('official', 'mainland'), config['source'])
            while True:
                category = self.choose('覆盖类别或 done：' + ', '.join(SOURCE_OPTIONS.values()), 'Override category or done: ' + ', '.join(SOURCE_OPTIONS.values()), (*SOURCE_OPTIONS.values(), 'done'), 'done')
                if category == 'done':
                    break
                config['overrides'][category] = self.ask('来源 URL（不用真实凭据）', 'Source URL (no real credentials)', config['overrides'].get(category), lambda value: validate_source(category, value))
        else:
            config['source'] = choice
        self.tell('显式逐类覆盖优先于基础源；切换基础源保留显式覆盖。', 'Explicit category overrides take precedence over the base; changing the base preserves explicit overrides.')

    def show_sources(self, config):
        presets = self.presets
        effective = {**presets[config['source']], **config['overrides']}
        self.tell('\n生效下载源：', '\nEffective download sources:')
        for category, address in effective.items():
            self.tell('  ' + category + ': ' + (address or '直连'), '  ' + category + ': ' + (address or 'direct'))
        self.tell('', '')

    def edit_common(self, config, supplied=()):
        if 'server_ip' not in supplied:
            config['server_ip'] = self.ask('服务器访问 IP（内网或公网）', 'Server access IP (LAN or public)', config['server_ip'], validate_ip)
        if 'port' not in supplied:
            config['port'] = self.ask('平台入口端口', 'Platform entry port', config['port'], validate_port)
        suggestion = suggested_origin(config) if config['server_ip'] else config['origin']
        if 'origin' not in supplied:
            config['origin'] = self.ask('完整浏览器访问网址（可填实际 HTTPS 域名；不会部署证书或反向代理）', 'Full browser URL (actual HTTPS domain allowed; no certificate or reverse proxy deployment)', suggestion if self.automatic_origin else config['origin'], validate_origin)
        if 'origin' not in supplied:
            self.automatic_origin = config['origin'] == suggestion
        if 'mapping' in supplied:
            return
        current = self.mapping_choice or ('list' if config['mapping'] else 'none')
        choice = self.choose('是否设置过路由器端口转发或公网 NAT？\n  none 没有 / list 有 / undeclared 不确定（将阻止成员出网）', 'Port forwarding or public NAT?\n  none No / list Yes / undeclared Unsure (blocks member egress)', ('none', 'list', 'undeclared'), current)
        self.mapping_choice = choice
        if choice == 'list':
            config['mapping'] = self.ask('完整公网 IPv4 清单，逗号分隔', 'Complete public IPv4 list, comma separated', config['mapping'] or None, validate_mapping_list)
        else:
            config['mapping'] = '' if choice == 'none' else None

    def edit_advanced(self, config):
        self.gateway_chosen = True
        config['gateway'] = self.ask('内部网关端口', 'Internal gateway port', config['gateway'], validate_port)
        config['data'] = self.ask('成员数据目录' + ('（模拟不创建）' if self.simulation else ''), 'Member data directory' + (' (not created)' if self.simulation else ''), config['data'], validate_optional_path)
        config['mount'] = self.ask('已有数据挂载点' + ('（模拟不检查）' if self.simulation else ''), 'Existing data mount' + (' (not checked)' if self.simulation else ''), config['mount'], validate_optional_path)

    def summary(self, config):
        self.tell('\n── 配置摘要' + ('（模拟）' if self.simulation else '') + ' ──', '\n── Configuration summary' + (' (simulation)' if self.simulation else '') + ' ──')
        self.show_sources(config)
        labels = {'source': ('下载源', 'Download source'), 'server_ip': ('访问 IP', 'Access IP'), 'port': ('入口端口', 'Entry port'),
                  'origin': ('浏览器网址', 'Browser URL'), 'gateway': ('内部网关端口', 'Internal gateway port'),
                  'data': ('成员数据目录', 'Member data directory'), 'mount': ('数据挂载点', 'Data mount')}
        for key, (zh, en) in labels.items():
            self.tell(zh + ': ' + (str(config[key]) if config[key] not in ('', None) else '默认'), en + ': ' + (str(config[key]) if config[key] not in ('', None) else 'default'))
        mapping = config['mapping']
        self.tell('公网映射：' + ('未声明，成员出网被阻止' if mapping is None else mapping or '明确没有额外映射；允许正常公网访问'),
                  'Public mappings: ' + ('undeclared; member egress blocked' if mapping is None else mapping or 'explicitly none; normal public access allowed'))
        self.tell('宿主、私网、回环与已声明映射仍受保护。', 'Host, private, loopback and declared mapping targets remain protected.')


def validate_source(category, value):
    if value == '' and category in PREFIXES:
        return value
    url = urlsplit(value)
    if len(value) > 2048 or any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in value) or '\\' in value:
        raise ValueError()
    if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError()
    if category in ('containerMirror', 'ghcrMirror') and url.scheme != 'https':
        raise ValueError()
    if url.port is not None and not 0 < url.port <= 65535:
        raise ValueError()
    return value.rstrip('/') + ('/' if category in PREFIXES else '')


def validate_ip(value):
    address = ipaddress.ip_address(value)
    if address.is_unspecified or address.is_multicast:
        raise ValueError()
    return str(address)


def validate_port(value):
    if not value.isascii() or not value.isdigit() or not 1 <= int(value) <= 65535:
        raise ValueError()
    return str(int(value))


def validate_mapping(value):
    if value:
        for item in value.split(','):
            if ipaddress.ip_address(item.strip()).version != 4 or not ipaddress.ip_address(item.strip()).is_global:
                raise ValueError()
    return value


def validate_mapping_list(value):
    if not value:
        raise ValueError()
    return validate_mapping(value)


def validate_path(value):
    if not value.startswith('/') or '\x00' in value:
        raise ValueError()
    return value


def validate_origin(value):
    url = urlsplit(value)
    if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
        raise ValueError()
    if url.port is not None and not 0 < url.port <= 65535:
        raise ValueError()
    return value.rstrip('/')


def suggested_origin(config):
    address = config['server_ip']
    if ':' in address:
        address = '[' + address + ']'
    return f"http://{address}:{config['port']}"



def validate_optional_path(value):
    return validate_path(value) if value else ''


def apply_source_choice(args, config):
    args.download_source_preset = config['source']
    for option, category in SOURCE_OPTIONS.items():
        setattr(args, option, config['overrides'].get(category))
