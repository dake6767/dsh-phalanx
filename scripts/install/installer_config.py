"""Deployment facts and read-only checks before large downloads or host changes."""
import ipaddress
import os
import json
import re
from pathlib import Path
import secrets
import shlex
import urllib.parse

# BEGIN GENERATED DOWNLOAD SOURCE PRESETS
# Generated from src/domain/download-source-presets.json; do not edit this value.
DOWNLOAD_SOURCE_PRESETS = json.loads("{\n  \"official\": {\n    \"npm\": \"https://registry.npmjs.org\",\n    \"pypi\": \"https://pypi.org/simple\",\n    \"containerMirror\": \"\",\n    \"ghcrMirror\": \"\",\n    \"githubAssets\": \"\",\n    \"browser\": \"https://cdn.playwright.dev\",\n    \"browserChromiumArm64\": \"https://cdn.playwright.dev\",\n    \"githubApi\": \"\"\n  },\n  \"mainland\": {\n    \"npm\": \"https://registry.npmmirror.com\",\n    \"pypi\": \"https://pypi.tuna.tsinghua.edu.cn/simple\",\n    \"containerMirror\": \"https://docker.m.daocloud.io/\",\n    \"ghcrMirror\": \"https://ghcr.nju.edu.cn/\",\n    \"githubAssets\": \"https://ghfast.top/\",\n    \"browser\": \"https://registry.npmmirror.com/-/binary/playwright\",\n    \"browserChromiumArm64\": \"https://cdn.playwright.dev\",\n    \"githubApi\": \"https://gh-proxy.org/\"\n  },\n  \"bootstrap\": {\n    \"official\": {\n      \"nodePrefix\": \"https://nodejs.org/dist/\",\n      \"ubuntuPrefix\": \"https://cloud-images.ubuntu.com/\"\n    },\n    \"mainland\": {\n      \"nodePrefix\": \"https://npmmirror.com/mirrors/node/\",\n      \"ubuntuPrefix\": \"https://mirrors.nju.edu.cn/ubuntu-cloud-images/\"\n    }\n  }\n}\n")
# END GENERATED DOWNLOAD SOURCE PRESETS

DOWNLOAD_SOURCE_OPTIONS = {
    'npm_registry': 'npm', 'pypi_index': 'pypi', 'container_mirror': 'containerMirror', 'ghcr_mirror': 'ghcrMirror',
    'github_proxy_prefix': 'githubAssets', 'github_api_proxy_prefix': 'githubApi',
    'browser_download_host': 'browser', 'chromium_arm64_download_host': 'browserChromiumArm64',
}
DOWNLOAD_SOURCE_PREFIXES = ('containerMirror', 'ghcrMirror', 'githubAssets', 'githubApi')


def download_source_selection(value):
    failure = 'Choose a download preset and HTTP(S) addresses without credentials, queries or fragments.'
    if not isinstance(value, dict) or set(value) - {'preset', 'overrides'} or value.get('preset') not in ('official', 'mainland'):
        raise ValueError(failure)
    overrides = value.get('overrides', {})
    if not isinstance(overrides, dict): raise ValueError(failure)
    normalized = {}
    for key, address in overrides.items():
        if key not in DOWNLOAD_SOURCE_PRESETS['official'] or not isinstance(address, str) or len(address) > 2048 or re.search(r'[\s\x00-\x1f\x7f]', address):
            raise ValueError(failure)
        if address == '' and key in DOWNLOAD_SOURCE_PREFIXES:
            normalized[key] = ''; continue
        parsed = urllib.parse.urlsplit(address)
        if (key in ('containerMirror', 'ghcrMirror') and parsed.scheme != 'https') or not re.match(r'^https?://', address, re.I) or parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or '\\' in address:
            raise ValueError(failure)
        if parsed.port is not None and not 0 < parsed.port < 65536: raise ValueError(failure)
        normalized[key] = address.rstrip('/') + ('/' if key in DOWNLOAD_SOURCE_PREFIXES else '')
    return {'preset': value['preset'], **({'overrides': normalized} if normalized else {})}


def resolve_download_sources(selection):
    selected = download_source_selection(selection)
    return {**DOWNLOAD_SOURCE_PRESETS[selected['preset']], **selected.get('overrides', {})}


def platform_facts(host, values, fact):
    """Read a fact through the installed platform CLI; None when no platform is installed or its database cannot answer."""
    start = host.path('/opt/dsh-phalanx/current/start')
    database = host.path(values.get('DSH_PHALANX_DATABASE_CONFIG_FILE', HOME_DIR + '/keys/database.json'))
    # No selected database yet (for example an interrupted installation): nothing can have been saved there.
    if 'DSH_PHALANX_DATA_ROOT' not in values or not start.exists() or not database.exists():
        return None
    account = host.run(['getent', 'passwd', 'dsh-phalanx'], check=False)
    if account.returncode != 0:
        return None
    uid = int(account.stdout.split(':')[2])
    result = host.user(uid, ['timeout', '--signal=TERM', '--kill-after=5s', '30s', str(start), 'platform-facts', fact,
                             '--config-file', values.get('DSH_PHALANX_DATABASE_CONFIG_FILE', HOME_DIR + '/keys/database.json'),
                             '--data-root', values['DSH_PHALANX_DATA_ROOT']], check=False)
    if result.returncode == 2:
        host.tell('The platform database did not answer; using the local record instead of ' + fact)
        return None
    if result.returncode != 0:
        raise ValueError('The installed platform could not report ' + fact)
    return json.loads(result.stdout)


def configured_download_sources(host, values, args=None, *, platform_running=False):
    # Two stages: the installer's recorded choice applies until an administrator saves one in the platform database.
    # Before the built-in database starts only the local configuration is read; a running platform answers through its CLI.
    selection = json.loads(values.get('DSH_PHALANX_DOWNLOAD_SOURCES', '{"preset":"official"}'))
    saved = platform_facts(host, values, 'download-sources') if platform_running else None
    if saved is not None and saved.get('selection') is not None:
        selection = saved['selection']
    selection = download_source_selection(selection)
    if args is not None:
        preset = getattr(args, 'download_source_preset', None)
        if preset is not None: selection = {'preset': preset}
        overrides = {**selection.get('overrides', {})}
        for option, category in DOWNLOAD_SOURCE_OPTIONS.items():
            value = getattr(args, option, None)
            if value is not None: overrides[category] = value
        selection = download_source_selection({**selection, 'overrides': overrides})
    return selection


def download_source_environment(sources, architecture):
    return {'NPM_CONFIG_REGISTRY': sources['npm'], 'PNPM_CONFIG_REGISTRY': sources['npm'], 'COREPACK_NPM_REGISTRY': sources['npm'],
            'PIP_INDEX_URL': sources['pypi'], 'UV_DEFAULT_INDEX': sources['pypi'],
            'PLAYWRIGHT_DOWNLOAD_HOST': sources['browser'],
            **({'PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST': sources['browserChromiumArm64']} if architecture == 'arm64' else {})}


CONFIG = '/etc/dsh-phalanx/environment'
STATE = '/etc/dsh-phalanx/install-state.json'
HOME_DIR = '/var/lib/dsh-phalanx'


def default_storage_root(data_root):
    return os.path.abspath(data_root)+'.durable'


def effective_user_data_root(values):
    return values.get('DSH_PHALANX_USER_DATA_ROOT') or default_storage_root(values['DSH_PHALANX_DATA_ROOT'])+'/users'


class ConfigurationError(ValueError):
    pass


OPTIONS = {
    'model_base_url': 'MODEL_UPSTREAM_BASE_URL', 'model_provider': 'ALLOWED_MODEL_PROVIDER',
    'model': 'ALLOWED_MODEL', 'listen_address': 'HOST', 'port': 'PORT',
    'preview_port': 'PREVIEW_PORT', 'preview_origin': 'PREVIEW_ORIGIN',
    'gateway_port': 'CONTAINER_GATEWAY_PORT', 'public_origin': 'PUBLIC_ORIGIN',
    'host_public_addresses': 'HOST_PUBLIC_ADDRESSES', 'user_data_root': 'USER_DATA_ROOT',
    'user_data_mount': 'USER_DATA_MOUNT',
}


def environment_text(values):
    return "".join(f'{key}="'+value.replace("\\", "\\\\").replace('"', '\\"')+'"\n' for key, value in sorted(values.items()))


def installed_state(host):
    path = host.path(STATE)
    if path.is_symlink():
        raise ConfigurationError('Installation receipt must not be a symbolic link')
    if not path.exists():
        return None
    state = json.loads(path.read_text())
    if state.get('status') != 'installed':
        return None
    if not host.path('/opt/dsh-phalanx/current').is_symlink() or not host.path(CONFIG).is_file():
        raise ConfigurationError('Successful installation receipt has missing managed files; inspect the existing installation')
    return state


def outbound_proxy_environment(values, environment=None):
    environment=os.environ if environment is None else environment
    def selected(upper, lower):
        source=values if upper in values or lower in values else environment
        return source.get(lower,source.get(upper,''))
    proxy=selected('HTTPS_PROXY','https_proxy')
    bypass=selected('NO_PROXY','no_proxy')
    if not isinstance(proxy,str) or len(proxy)>8192 or re.search(r'[\s\x00-\x1f\x7f]',proxy):
        raise ConfigurationError('HTTPS_PROXY must be an HTTP(S) proxy URL without whitespace')
    if proxy:
        try:
            url=urllib.parse.urlsplit(proxy)
            if url.scheme not in ('http','https') or not url.hostname or url.path not in ('','/') or url.query or url.fragment or url.port==0:raise ValueError()
        except ValueError as error:raise ConfigurationError('HTTPS_PROXY must be a valid HTTP(S) proxy URL') from error
    if not isinstance(bypass,str) or len(bypass)>8192 or re.search(r'[\x00-\x1f\x7f]',bypass):
        raise ConfigurationError('NO_PROXY must be a comma-separated host exclusion list')
    bypass=','.join(dict.fromkeys([*(part.strip() for part in bypass.split(',') if part.strip()),'localhost','.localhost','127.0.0.1','::1']))
    return {'HTTPS_PROXY':proxy,'https_proxy':proxy,'HTTP_PROXY':proxy,'http_proxy':proxy,'NO_PROXY':bypass,'no_proxy':bypass}


def read_configuration(host):
    path = host.path(CONFIG)
    if not path.exists() and host.path('/etc/dsh-phalanx/install-draft').exists():
        path = host.path('/etc/dsh-phalanx/install-draft')
    if path.is_symlink():
        raise ConfigurationError('Managed configuration must not be a symbolic link')
    values = {}
    if path.exists():
        for line in path.read_text().splitlines():
            key, value = line.split('=', 1)
            parts = shlex.split(value)
            if len(parts) != 1:
                raise ConfigurationError('Invalid protected configuration')
            values[key] = parts[0]
    return values


def validate_authority(url):
    hostname = url.hostname
    if not hostname or '%' in hostname or '\\' in url.netloc:
        raise ConfigurationError('URL must have a valid host')
    if ':' in hostname:
        ipaddress.IPv6Address(hostname)
    else:
        ascii_host = hostname.encode('idna').decode('ascii')
        if not re.fullmatch(r'[A-Za-z0-9_.-]+', ascii_host):
            raise ConfigurationError('URL must have a valid host')
    _ = url.port


def validate_configuration(host, values):
    for name in ('ALLOWED_MODEL_PROVIDER', 'ALLOWED_MODEL', 'MODEL_UPSTREAM_BASE_URL'):
        if not values.get('DSH_PHALANX_'+name, '').strip():
            raise ConfigurationError(name+' must not be empty')
    if values['DSH_PHALANX_ALLOWED_MODEL_PROVIDER'] != 'deepseek-official':
        raise ConfigurationError('Initial legacy model provider must be deepseek-official; configure shared providers in administration after signup')
    if 'DSH_PHALANX_SESSION_SECRET' in values and len(values['DSH_PHALANX_SESSION_SECRET']) < 32:
        raise ConfigurationError('Session secret must contain at least 32 characters')
    for address in filter(None, values['DSH_PHALANX_HOST_PUBLIC_ADDRESSES'].split(',')):
        if not ipaddress.IPv4Address(address.strip()).is_global:
            raise ConfigurationError('Host aliases must be public IPv4 literals')
    if any('\n' in value or '\r' in value or '\0' in value for value in values.values()):
        raise ConfigurationError('Invalid deployment configuration')
    for name in ('PORT', 'CONTAINER_GATEWAY_PORT'):
        if not 1 <= int(values['DSH_PHALANX_'+name]) <= 65535:
            raise ConfigurationError(name+' must be between 1 and 65535')
    if int(values['DSH_PHALANX_PORT']) == int(values['DSH_PHALANX_CONTAINER_GATEWAY_PORT']):
        raise ConfigurationError('Entry and private gateway ports must differ')
    ipaddress.ip_address(values['DSH_PHALANX_HOST'])
    origin = urllib.parse.urlparse(values['DSH_PHALANX_PUBLIC_ORIGIN'])
    if origin.scheme not in ('http', 'https') or not origin.hostname or origin.username or origin.password or origin.path not in ('', '/') or origin.query or origin.fragment:
        raise ConfigurationError('Public origin must be an HTTP(S) origin without credentials or path')
    validate_authority(origin)
    if values.get('DSH_PHALANX_PREVIEW_PORT') or values.get('DSH_PHALANX_PREVIEW_ORIGIN'):
        preview = urllib.parse.urlparse(values.get('DSH_PHALANX_PREVIEW_ORIGIN', ''))
        port = int(values.get('DSH_PHALANX_PREVIEW_PORT', '0'))
        if not 1 <= port <= 65535 or port in (int(values['DSH_PHALANX_PORT']), int(values['DSH_PHALANX_CONTAINER_GATEWAY_PORT'])):
            raise ConfigurationError('Preview requires a separate listener port')
        if preview.scheme != origin.scheme or preview.hostname != origin.hostname or (preview.port or (443 if preview.scheme == 'https' else 80)) == (origin.port or (443 if origin.scheme == 'https' else 80)) or preview.username or preview.password or preview.path not in ('', '/') or preview.query or preview.fragment:
            raise ConfigurationError('Preview origin must use the same host and scheme on a different public port')
        validate_authority(preview)
    upstream = urllib.parse.urlparse(values['DSH_PHALANX_MODEL_UPSTREAM_BASE_URL'])
    if upstream.scheme not in ('http', 'https') or not upstream.hostname or upstream.username or upstream.password or upstream.query or upstream.fragment:
        raise ConfigurationError('Model upstream must be an HTTP(S) URL without credentials, query or fragment')
    validate_authority(upstream)


def validate_storage(host, values):
    root_value, mount_value = (values.get('DSH_PHALANX_'+name) for name in ('USER_DATA_ROOT', 'USER_DATA_MOUNT'))
    if root_value is None and mount_value is None:
        return
    if not root_value or not mount_value or not Path(root_value).is_absolute() or not Path(mount_value).is_absolute():
        raise ConfigurationError('External user storage requires absolute root and mount paths')
    root, mount = host.path(root_value), host.path(mount_value).resolve(strict=True)
    platform = host.path(values['DSH_PHALANX_DATA_ROOT']).resolve()
    canonical = root.resolve()
    if mount == host.path('/') or not canonical.is_relative_to(mount):
        raise ConfigurationError('User storage must be inside the declared independent data mount')
    if canonical.is_relative_to(platform) or platform.is_relative_to(canonical):
        raise ConfigurationError('Platform and external user storage must not overlap')
    ancestor = root
    while not ancestor.exists():
        ancestor = ancestor.parent
    facts = json.loads(host.run(['findmnt', '--json', '--target', str(ancestor), '--output', 'TARGET']).stdout)
    if Path(facts['filesystems'][0]['target']).resolve() != mount:
        raise ConfigurationError('The declared user data volume is not mounted; no directory was created')
    if root.is_symlink() or root.exists() and not root.is_dir():
        raise ConfigurationError('User storage must be a directory, not a symbolic link')


def check_ports(host, args, values, successful, interactive):
    endpoints = [('PORT', values['DSH_PHALANX_HOST'], '--port'), ('CONTAINER_GATEWAY_PORT', '127.0.0.1', '--gateway-port')]
    if values.get('DSH_PHALANX_PREVIEW_PORT'):endpoints.append(('PREVIEW_PORT', values['DSH_PHALANX_HOST'], '--preview-port'))
    for name, address, flag in endpoints:
        key = 'DSH_PHALANX_'+name
        while True:
            number = int(values[key])
            # A previously accepted port can be occupied only by our actual service.
            conflict = host.port_conflict(address, number, allow_managed=successful)
            if conflict is None:
                break
            if name == 'CONTAINER_GATEWAY_PORT' and not successful and args.gateway_port is None and not getattr(args, 'gateway_chosen', False):
                free = number+1
                while free <= 65535 and (free == int(values['DSH_PHALANX_PORT']) or host.port_conflict(address, free) is not None):
                    free += 1
                if free > 65535:
                    raise ConfigurationError('No free private gateway port; specify --gateway-port')
                host.tell(f'Private gateway port {number} is occupied; using {free} (saved in configuration).')
                values[key] = str(free)
                continue
            host.tell(f'{flag} {number} is unavailable: {conflict}. No occupying process was stopped.')
            if not interactive or successful:
                raise ConfigurationError(f'Choose a free {flag} and rerun the installer; {conflict}')
            values[key] = host.prompt(f'New {flag} value: ')
            origin = urllib.parse.urlparse(values['DSH_PHALANX_PUBLIC_ORIGIN'])
            if name == 'PORT' and origin.scheme == 'http' and origin.port == number:
                values['DSH_PHALANX_PUBLIC_ORIGIN'] = origin._replace(netloc=origin.netloc.rsplit(':', 1)[0]+':'+values[key]).geturl()
            if not values[key].isdigit() or not 1 <= int(values[key]) <= 65535:
                raise ConfigurationError('Port must be between 1 and 65535')


def configuration(host, args, *, target_version, entry_url, access_candidate):
    # The release selector has already verified this manifest version.
    release = tuple(map(int, target_version.split('.')))
    protected_secrets = release >= (0, 1, 25)
    if protected_secrets and args.model_key_file:
        raise ConfigurationError('Configure provider credentials in administration after signup; --model-key-file is only for historical releases')
    modern = release >= (0, 1, 1)
    if not modern and (args.user_data_root is not None or args.user_data_mount is not None):
        raise ConfigurationError('External user storage options require 0.1.1 or later')
    previous = read_configuration(host)
    successful = installed_state(host) is not None
    interactive = host.terminal_available()
    values = dict(previous)
    if protected_secrets:
        values.pop('DSH_PHALANX_SESSION_SECRET', None)
        values.pop('DSH_PHALANX_MODEL_UPSTREAM_API_KEY', None)
    proxy=outbound_proxy_environment(previous)
    for name in ('HTTPS_PROXY','NO_PROXY'):
        if name in proxy:values[name]=proxy[name]
    values.pop('https_proxy',None);values.pop('no_proxy',None)
    args.gateway_chosen = 'DSH_PHALANX_CONTAINER_GATEWAY_PORT' in previous
    for option, key in OPTIONS.items():
        value = getattr(args, option, None)
        if value is not None:
            name = 'DSH_PHALANX_'+key
            prior = previous.get(name, '3081' if key == 'CONTAINER_GATEWAY_PORT' else None)
            if prior is not None and prior != str(value):
                if successful:
                    raise ConfigurationError('Existing successful installation configuration differs; use explicit offline configuration/storage maintenance')
            values[name] = str(value)
    missing = []
    if not interactive:
        if 'DSH_PHALANX_HOST_PUBLIC_ADDRESSES' not in values:
            missing.append('--host-public-addresses')
        if modern and 'DSH_PHALANX_PUBLIC_ORIGIN' not in values:
            missing.append('--public-origin')
        if not modern and args.model_key_file is None and 'DSH_PHALANX_MODEL_UPSTREAM_API_KEY' not in values:
            missing.append('--model-key-file')
        if missing:
            raise ConfigurationError('Missing '+', '.join(missing)+'. Example: sudo bash install.sh --public-origin http://<host>:18080 --host-public-addresses ""'+(' --model-key-file /path/to/protected-key' if not modern else ''))
    if 'DSH_PHALANX_HOST_PUBLIC_ADDRESSES' not in values:
        values['DSH_PHALANX_HOST_PUBLIC_ADDRESSES'] = host.prompt('All public IPv4 host aliases, comma-separated (empty if none): ')
    if args.model_key_file:
        path = args.model_key_file
        if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
            raise ConfigurationError('Model key file must be a regular protected file (mode 0600)')
        key = path.read_text().rstrip('\r\n')
        if successful and values.get('DSH_PHALANX_MODEL_UPSTREAM_API_KEY') != key:
            raise ConfigurationError('Existing successful model configuration differs')
        if not key or any(ord(char) < 32 or ord(char) > 126 for char in key):
            raise ConfigurationError('A nonempty printable upstream credential is required')
        values['DSH_PHALANX_MODEL_UPSTREAM_API_KEY'] = key
    elif not modern and 'DSH_PHALANX_MODEL_UPSTREAM_API_KEY' not in values:
        values['DSH_PHALANX_MODEL_UPSTREAM_API_KEY'] = host.prompt('Model upstream API key: ', secret=True)
    key = values.get('DSH_PHALANX_MODEL_UPSTREAM_API_KEY')
    if key is not None and (not key or any(ord(char) < 32 or ord(char) > 126 for char in key)):
        raise ConfigurationError('A nonempty printable upstream credential is required')
    defaults = {'HOST': '0.0.0.0' if modern else '127.0.0.1', 'PORT': '18080', 'CONTAINER_GATEWAY_PORT': '3081',
                'ALLOWED_MODEL_PROVIDER': 'deepseek-official', 'ALLOWED_MODEL': 'deepseek-chat',
                'MODEL_UPSTREAM_BASE_URL': 'https://api.deepseek.com',
                'DATA_ROOT': HOME_DIR+'/data', 'CONTAINER_RUNTIME': '/usr/bin/podman', 'REGISTRATION_ENABLED': 'false'}
    if not protected_secrets:
        defaults['SESSION_SECRET'] = secrets.token_hex(32)
    for name, value in defaults.items():
        values.setdefault('DSH_PHALANX_'+name, value)
    if interactive and modern and not successful:
        if args.port is None:
            values['DSH_PHALANX_PORT'] = host.prompt('Entry port ['+values['DSH_PHALANX_PORT']+']: ') or values['DSH_PHALANX_PORT']
        candidate = values.get('DSH_PHALANX_PUBLIC_ORIGIN') or access_candidate(host, values)
        if args.public_origin is None:
            values['DSH_PHALANX_PUBLIC_ORIGIN'] = host.prompt(f'Browser access URL [{candidate}]: ') or candidate
        if host.prompt('Advanced gateway/storage settings? [y/N]: ').lower() == 'y':
            gateway = host.prompt('Private gateway port ['+values['DSH_PHALANX_CONTAINER_GATEWAY_PORT']+']: ')
            args.gateway_chosen = args.gateway_chosen or bool(gateway)
            values['DSH_PHALANX_CONTAINER_GATEWAY_PORT'] = gateway or values['DSH_PHALANX_CONTAINER_GATEWAY_PORT']
            for name, label in (('USER_DATA_ROOT', 'User data directory'), ('USER_DATA_MOUNT', 'Existing data mount')):
                selected = host.prompt(label+' ['+values.get('DSH_PHALANX_'+name, '')+']: ')
                if selected:
                    values['DSH_PHALANX_'+name] = selected
    values.setdefault('DSH_PHALANX_PUBLIC_ORIGIN', entry_url(values['DSH_PHALANX_PORT'], values['DSH_PHALANX_HOST']))
    values['DSH_PHALANX_DOWNLOAD_SOURCES'] = json.dumps(configured_download_sources(host, values, args), separators=(',', ':'))
    validate_configuration(host, values)
    validate_storage(host, values)
    check_ports(host, args, values, successful, interactive)
    validate_configuration(host, values)
    if not successful:
        changes = sorted(key.removeprefix('DSH_PHALANX_') for key, value in values.items() if key in previous and previous[key] != value)
        host.tell('Configuration: '+values['DSH_PHALANX_PUBLIC_ORIGIN']+'; entry port '+values['DSH_PHALANX_PORT']+'; private gateway '+values['DSH_PHALANX_CONTAINER_GATEWAY_PORT'])
        host.tell('Platform data: '+values['DSH_PHALANX_DATA_ROOT']+'; user data: '+effective_user_data_root(values))
        if changes:
            host.tell('Retry changes: '+', '.join(changes)+'. Existing data will be preserved.')
        if interactive and host.prompt('Continue with this configuration? [y/N]: ').lower() != 'y':
            raise ConfigurationError('Installation cancelled before downloads or deployment changes')
    return values
