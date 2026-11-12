"""Deployment facts and read-only checks before large downloads or host changes."""
import ipaddress
import os
import json
import re
from pathlib import Path
import secrets
import shlex
import urllib.parse
import tempfile

VERIFIED_HOSTS = frozenset((('ubuntu', '24.04'), ('ubuntu', '26.04')))
MINIMUM_PODMAN = (4, 9, 3)
MINIMUM_PASST_DATE = 20240220


def passt_version_date(value):
    version = re.search(r'\b(?:0\.0~git)?(20\d{2})[-_]?(\d{2})[-_]?(\d{2})\b', value)
    return int(''.join(version.groups())) if version else None


def entry_url(port, listen_address):
    address = ipaddress.ip_address(listen_address)
    if address.is_unspecified:
        address = ipaddress.ip_address("127.0.0.1" if address.version == 4 else "::1")
    entry = str(address) if address.version == 4 else f"[{address}]"
    return f"http://{entry}:{port}"


def host_version_failure(podman, pasta):
    podman_version = re.search(r'\b(\d+)\.(\d+)\.(\d+)\b', podman)
    if podman_version is None or tuple(map(int, podman_version.groups())) < MINIMUM_PODMAN:
        return 'Podman version '+podman+'; required minimum: '+'.'.join(map(str, MINIMUM_PODMAN))
    passt_version = passt_version_date(pasta)
    if passt_version is None or passt_version < MINIMUM_PASST_DATE:
        return 'passt version '+pasta+'; required minimum: 0.0~git'+str(MINIMUM_PASST_DATE)
    return None


def distribution_facts(text):
    values = {}
    try:
        for line in text.splitlines():
            key, separator, value = line.partition('=')
            if separator and key.strip() in ('ID', 'ID_LIKE', 'VERSION_ID'):
                values[key.strip()] = ' '.join(shlex.split(value, comments=True))
    except ValueError:
        values = {}
    distribution, version = values.get('ID', ''), values.get('VERSION_ID', '')
    family = bool({'debian', 'ubuntu'} & {distribution, *values.get('ID_LIKE', '').split()})
    return {'distribution': distribution, 'version': version, 'family': 'debian' if family else 'unsupported',
            'verified': (distribution, version) in VERIFIED_HOSTS}

# BEGIN GENERATED DOWNLOAD SOURCE PRESETS
# Generated from src/domain/download-source-presets.json; do not edit this value.
DOWNLOAD_SOURCE_PRESETS = json.loads("{\n  \"official\": {\n    \"npm\": \"https://registry.npmjs.org\",\n    \"pypi\": \"https://pypi.org/simple\",\n    \"containerMirror\": \"\",\n    \"ghcrMirror\": \"\",\n    \"githubAssets\": \"\",\n    \"browser\": \"https://cdn.playwright.dev\",\n    \"browserChromiumArm64\": \"https://cdn.playwright.dev\",\n    \"githubApi\": \"\"\n  },\n  \"mainland\": {\n    \"npm\": \"https://registry.npmmirror.com\",\n    \"pypi\": \"https://pypi.tuna.tsinghua.edu.cn/simple\",\n    \"containerMirror\": \"https://docker.m.daocloud.io/\",\n    \"ghcrMirror\": \"https://ghcr.nju.edu.cn/\",\n    \"githubAssets\": \"https://ghfast.top/\",\n    \"browser\": \"https://registry.npmmirror.com/-/binary/playwright\",\n    \"browserChromiumArm64\": \"https://cdn.playwright.dev\",\n    \"githubApi\": \"https://gh-proxy.org/\"\n  },\n  \"bootstrap\": {\n    \"official\": {\n      \"nodePrefix\": \"https://nodejs.org/dist/\",\n      \"ubuntuPrefix\": \"https://cloud-images.ubuntu.com/\"\n    },\n    \"mainland\": {\n      \"nodePrefix\": \"https://npmmirror.com/mirrors/node/\",\n      \"ubuntuPrefix\": \"https://mirrors.nju.edu.cn/ubuntu-cloud-images/\"\n    }\n  }\n}\n")
# END GENERATED DOWNLOAD SOURCE PRESETS

DOWNLOAD_SOURCE_OPTIONS = {
    'npm_registry': 'npm', 'pypi_index': 'pypi', 'container_mirror': 'containerMirror',
    'ghcr_mirror': 'ghcrMirror', 'github_proxy_prefix': 'githubAssets',
    'github_api_proxy_prefix': 'githubApi', 'browser_download_host': 'browser',
    'chromium_arm64_download_host': 'browserChromiumArm64',
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


# BEGIN GENERATED EXECUTOR FACTS PROGRAM
EXECUTOR_FACTS_PROGRAM = "// Generated from platform adapters. The source release owns its connection, key and TLS interpretation.\nimport { readFileSync } from 'node:fs';\ntry {\n  const request = JSON.parse(readFileSync(0, 'utf8'));\n  const { readExecutorFacts } = await import(\"data:text/javascript;base64,aW1wb3J0IHsgcGF0aFRvRmlsZVVSTCB9IGZyb20gJ25vZGU6dXJsJzsKaW1wb3J0IHsgbHN0YXRTeW5jLCByZWFkZGlyU3luYyB9IGZyb20gJ25vZGU6ZnMnOwppbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7CmNvbnN0IHsgRmlsZVBsYXRmb3JtRGF0YWJhc2VDb25maWcgfSA9IGF3YWl0IGltcG9ydChwYXRoVG9GaWxlVVJMKHByb2Nlc3MuYXJndlsyXSArICcvZGlzdC9hZGFwdGVycy9wbGF0Zm9ybS1kYXRhYmFzZS1jb25maWcuanMnKS5ocmVmKTsKY29uc3QgeyBGaWxlUGxhdGZvcm1TZWNyZXRzIH0gPSBhd2FpdCBpbXBvcnQocGF0aFRvRmlsZVVSTChwcm9jZXNzLmFyZ3ZbMl0gKyAnL2Rpc3QvYWRhcHRlcnMvcGxhdGZvcm0tc2VjcmV0cy5qcycpLmhyZWYpOwpjb25zdCB7IGluc3BlY3RQbGF0Zm9ybURhdGFiYXNlLCBwbGF0Zm9ybURhdGFiYXNlUG9vbCB9ID0gYXdhaXQgaW1wb3J0KHBhdGhUb0ZpbGVVUkwocHJvY2Vzcy5hcmd2WzJdICsgJy9kaXN0L2FkYXB0ZXJzL3BsYXRmb3JtLWRhdGFiYXNlLWluc3BlY3Rpb24uanMnKS5ocmVmKTsKY29uc3QgeyByZWFkUmVnaXN0ZXJlZFNjaGVtYVZlcnNpb25zIH0gPSBhd2FpdCBpbXBvcnQoImRhdGE6dGV4dC9qYXZhc2NyaXB0O2Jhc2U2NCxhVzF3YjNKMElIc2djR0YwYUZSdlJtbHNaVlZTVENCOUlHWnliMjBnSjI1dlpHVTZkWEpzSnpzS1kyOXVjM1FnZXlCUVRFRlVSazlTVFY5VFEwaEZUVUZUTENCelkyaGxiV0ZKWkdWdWRHbG1hV1Z5SUgwZ1BTQmhkMkZwZENCcGJYQnZjblFvSW1SaGRHRTZkR1Y0ZEM5cVlYWmhjMk55YVhCME8ySmhjMlUyTkN4aFZ6RjNZak5LTUVsSWMyZGpSMFl3WVVaU2RsSnRiSE5hVmxaVFZFTkNPVWxIV25saU1qQm5TakkxZGxwSFZUWmtXRXB6U25welMxa3lPWFZqTTFGblpYbENVVlJGUmxWU2F6bFRWRlk1VGxOVlpGTlJWbEpLVkRBMVZFbElNR2RRVTBKb1pESkdjR1JEUW5CaVdFSjJZMjVSYjJOSFJqQmhSbEoyVW0xc2MxcFdWbE5VUTJoM1kyMDVhbHBZVG5wTWJVWjVXak5hWWsxc01HZExlVUZ1VERKU2NHTXpVWFpaVjFKb1kwaFNiR051VFhaalIzaG9aRWRhZG1OdE1IUmpNazV2V2xjeGFFeHRjSHBLZVd0MVlVaEtiRnBwYXpkRGFUaHhTMmxDVldGSFZXZGpTRXAyV2toV2FtUkhiSFppYVVKNldUSm9iR0pYUldkaFZ6VXlXbGMxTUdJelNqVk1RMEo2WVVkR2VWcFhVV2RaYm10bllsZHNibU50UmpCaFZ6bDFURU5DYW1JeU1YZFpXRkp3V1cxc2MyRllValZKUjBaMVdrTkNhVmxYVG5Ka1dFRm5ZMjFXYUZwSFZubGplVFJuUzJrNFMxcFlhSGRpTTBvd1NVZE9kbUp1VGpCSlJrSk5VVlpTUjFReFNrNVlNVTVFVTBWV1RsRldUV2RRVTBKaVpYbENkVmxYTVd4UGFVRnVXa2hPYjFnelFtOVpWM2hvWW01bmJreERRblJoVjJSNVdWaFNjR0l5TlhwUGFVSlJWRVZHVlZKck9WTlVWamxPVTFWa1UxRldVa3BVTURWVVNVZ3haRTkzYjNaTGFXOW5WVzFXYm1GWVRqQmpibXRuWW0xR2RGcFlUV2RaV0Vwc1NVWk9VbFJEUW5CYVIxWjFaRWRzYldGWFZubGplWGRuWW0xV01scFlTV2RaV0VwcFlWaFNlVmxZU2pWSlJrNVNWRU5DZG1OcFFtaEpTRTVzV1ZoS2FtRkdPWGRaV0ZKdlNVZFdOR05JU214ak0wNXdZakkwZFVsRGIzWkRiVlkwWTBjNWVXUkRRbTFrVnpWcVpFZHNkbUpwUW5wWk1taHNZbGRHU2xwSFZuVmtSMnh0WVZkV2VVdEhOV2hpVjFWd1NVaHpTMGxEUVdkSlIyeHRTVU5uYUV3eE5XSlpVekUyV0RFeFlsbFRNVFpOUXpBMVdERXhOMDFEZHpKTmJqQnJURE5WZFdSSFZucGtRMmgxV1ZjeGJFdFRRamhtUTBKMVdWY3hiRXh1VGpCWldFb3dZekZrY0dSSFoyOUtNMEp1V0hsamNFbEllRGhKUnpWb1lsZFZaMUJVTURsSlEyUndZbTFhZG1OdE1XaGtSMngyWW13NWVsa3lhR3hpVjBWdVNVaDRPRWxITldoaVYxVm5VRlF3T1VsRFpIZGtWMHB6WVZkTmJrdFJiMmRKUTBGblNVTkJaMGxJVW05amJUa3pTVVZXZVdOdE9YbExRMlJDU1VoS2JGb3liSHBrUjFaNVdsZFJaMk5IZUdoa1IxcDJZMjB3WjJNeVRtOWFWekZvU1VjeE1XTXpVV2RoUjBZeVdsTkNhRWxIVW5Cak0xSndZbTFPTUVsSE5YWmlhVEY2WlZoT01GcFhNR2RWTVVaTlNVYzFhR0pYVlc1TFZITkxTVU5CWjBsSVNteGtTRlo1WW1sQ1owbHBVamRpYlVaMFdsZ3dhVmxFYzB0bVVXOTJTMmx2WjFGVFFtcGlNakYzWWpOT2NHUkhiSFppYVVKNlpGaENkMkpIYkd4amVVSm9TVWRhY0dWSFZtdEpSMngxWkcxV2RXUkhPWGxsVTBKdFlqTkpaMkl5Tld4SlIxSm9aRWRHYVZsWVRteEpSM2h3V20xV01HRlhNV3hNYVVGeFRIZHdiR1ZJUW5aamJsRm5XbTVXZFZrelVuQmlNalJuWTIxV2JtRllUakJhV0Vwc1drWk9hbUZIVm5SWldFMXZZekpPYjFwWE1XaGplV3RuWlhkdlowbERRV2RoVjFsblMwaE9hbUZIVm5SWldFNWlUVVl3TDB4dE5XaGlWMVZuU1ZRd09VbERaR3RqTW1obVkwZG9hR0pIUm5WbFEyTndRMmxCWjBsRFFXZEpRMEZuWkVkb2VXSXpZMmRTV0VwNVlqTkpiMG94VW05YVUwSjNZa2RHTUZwdE9YbGlVMEpxWWpOS2JFbElUbXBoUjFaMFdWTkNkR1JZVGpCSlIwcHNTVWhLYkZveWJIcGtSMVo1V2xkUloxcHRiSGxqTTFGdVMxUnpTMGxEUVdkSlIwNTJZbTVPTUVsSE5XaGlWMVo2U1VRd1oySnRWak5KUms1c1pFTm5jRTkzYjJkSlEwRm5ZMjFXTUdSWVNuVkpSVGxwWVcxV2FtUkROVzFqYlZac1pXMVZiMk15VG05YVZ6Rm9ZM2sxZEZsWVFXOWpNazV2V2xjeGFFbEVNQ3RKU0hOTFNVTkJaMGxEUVdkSlEwSjZXVEpvYkdKWFJrcGFSMVoxWkVkc2JXRlhWbmxMU0U1cVlVZFdkRmxUTlhWWlZ6RnNTMVJ6UzBsRFFXZEpRMEZuU1VOQ2NGcHBRVzlpYlVaMFdsaE5kV0ZIUm5wTFNFNXFZVWRXZEZsVE5YVlpWekZzUzFOclMwbERRV2RKUTBGblNVTkJaMGxEUVdka1IyaDVZak5qWjFKWVNubGlNMGx2U2pGQ2MxbFlVbTFpTTBwMFNVaE9hbUZIVm5SWlUwSjFXVmN4YkdONVFuUmtXRTR3U1VkS2JFbElWblZoV0VZeFdsTmpjRTkzYjJkSlEwRm5TVU5CWjBsSE5XaGlWMVo2VEcxR2ExcERhSHBaTW1oc1lsZEZkV0p0Um5SYVUyczNRMmxCWjBsRFFXZEpRMEZuWVZkWlowdERSbnBaTW1oc1lsZEZkV0pYYkc1amJVWXdZVmM1ZFdONU5YTmFWelZ1WkVkbloyWklkMmRqTWs1dldsY3hhRXh0TVhCYU0wcG9aRWRzZG1KdVRYVmpNamwwV2xObmIySlhiRzVqYlVZd1lWYzVkVXhEUW5CaWJWSnNaVU5yWjFCVU5HZGlWMnh1WTIxR01HRlhPWFZNYmxwc1kyNU9jR0l5TkdkSlZEQTVTVWRzZFZwSFZqUkpRM05uVFZOcmNFTnBRV2RKUTBGblNVTkJaMGxEUVdkSlNGSnZZMjA1TTBsRlZubGpiVGw1UzBOa1UxcFhaSEJqTTFKc1kyMVdhMGxJVG1waFIxWjBXVk5DZEdGWFpIbFpXRkp3WWpJMWVrbEhNVEZqTTFGbldXMVZaMWt5T1hWa1IyeHVaRmM1TVdONVFtMWpiVGwwU1VoYWJHTnVUbkJpTWpSblRWTmpjRTkzYjJkSlEwRm5TVU5CWjBsSVNteGtTRlo1WW1sQ1VGbHRjR3haTTFGMVdtNUtiRnBZY0d4TFNITm5ZbTFHZEZwVWIyZGpNazV2V2xjeGFFeHROV2hpVjFWelNVY3hjRm96U21oa1IyeDJZbTVOTmtsRk9XbGhiVlpxWkVNMWJXTnRWbXhsYlZWdll6Sk9iMXBYTVdoTWJURndXak5LYUdSSGJIWmliazExWWxkR2QwdEhNWEJhTTBwb1pFZHNkbUpwUVRsUWFVSlFXVzF3YkZrelVYVmFia3BzV2xod2JFdEljMmRNYVRSMVlsZHNibU50UmpCaFZ6bDFTVWd3Y0V0VGEyZG1VMnMzUTJsQlowbERRamxMVTJzM1EyNHdTeUlwT3dvdktpb2dRU0J0YVhOemFXNW5JRzVoYldWemNHRmpaU0J2Y2lCMlpYSnphVzl1SUhSaFlteGxJR2x6SUhabGNuTnBiMjRnZW1WeWJ6c2djbVZoWkdsdVp5QnVaWFpsY2lCd2NtVndZWEpsY3lCcGRDNGdLaThLWlhod2IzSjBJR0Z6ZVc1aklHWjFibU4wYVc5dUlISmxZV1JTWldkcGMzUmxjbVZrVTJOb1pXMWhWbVZ5YzJsdmJuTW9jM0ZzTENCelkyaGxiV0Z6SUQwZ1VFeEJWRVpQVWsxZlUwTklSVTFCVXlrZ2V3b2dJQ0FnWTI5dWMzUWdkbVZ5YzJsdmJuTWdQU0JiWFRzS0lDQWdJR1p2Y2lBb1kyOXVjM1FnYzJOb1pXMWhJRzltSUhOamFHVnRZWE1wSUhzS0lDQWdJQ0FnSUNCamIyNXpkQ0IwWVdKc1pTQTlJR0FrZTNOamFHVnRZVWxrWlc1MGFXWnBaWElvYzJOb1pXMWhMbTVoYldVcGZTNXpZMmhsYldGZmJXbG5jbUYwYVc5dWMyQTdDaUFnSUNBZ0lDQWdZMjl1YzNRZ2NISmxjMlZ1ZENBOUlDaGhkMkZwZENCemNXd3VjWFZsY25rb0oxTkZURVZEVkNCMGIxOXlaV2RqYkdGemN5Z2tNU2s2T25SbGVIUWdRVk1nY21Wc1lYUnBiMjRuTENCYmRHRmliR1ZkS1NrdWNtOTNjMXN3WFM1eVpXeGhkR2x2YmpzS0lDQWdJQ0FnSUNCamIyNXpkQ0IyWlhKemFXOXVJRDBnY0hKbGMyVnVkQ0EvSUU1MWJXSmxjaWdvWVhkaGFYUWdjM0ZzTG5GMVpYSjVLR0JUUlV4RlExUWdRMDlCVEVWVFEwVW9iV0Y0S0habGNuTnBiMjRwTERBcElFRlRJSFpsY25OcGIyNGdSbEpQVFNBa2UzUmhZbXhsZldBcEtTNXliM2R6V3pCZExuWmxjbk5wYjI0cElEb2dNRHNLSUNBZ0lDQWdJQ0IyWlhKemFXOXVjeTV3ZFhOb0tIc2dibUZ0WlRvZ2MyTm9aVzFoTG01aGJXVXNJSFpsY25OcGIyNGdmU2s3Q2lBZ0lDQjlDaUFnSUNCeVpYUjFjbTRnZG1WeWMybHZibk03Q24wSyIpOwpjb25zdCB7IHJlYWRTYXZlZERvd25sb2FkU291cmNlcyB9ID0gYXdhaXQgaW1wb3J0KCJkYXRhOnRleHQvamF2YXNjcmlwdDtiYXNlNjQsYVcxd2IzSjBJSHNnY0dGMGFGUnZSbWxzWlZWU1RDQjlJR1p5YjIwZ0oyNXZaR1U2ZFhKc0p6c0tZMjl1YzNRZ2V5QkNkWE5wYm1WemMxSjFiR1ZGY25KdmNpQjlJRDBnWVhkaGFYUWdhVzF3YjNKMEtIQmhkR2hVYjBacGJHVlZVa3dvY0hKdlkyVnpjeTVoY21kMld6SmRJQ3NnSnk5a2FYTjBMMlJ2YldGcGJpOWlkWE5wYm1WemN5MWxjbkp2Y2k1cWN5Y3BMbWh5WldZcE93cGpiMjV6ZENCN0lHUnZkMjVzYjJGa1UyOTFjbU5sVTJWc1pXTjBhVzl1SUgwZ1BTQmhkMkZwZENCcGJYQnZjblFvY0dGMGFGUnZSbWxzWlZWU1RDaHdjbTlqWlhOekxtRnlaM1piTWwwZ0t5QW5MMlJwYzNRdlpHOXRZV2x1TDJSdmQyNXNiMkZrTFhOdmRYSmpaUzVxY3ljcExtaHlaV1lwT3dwamIyNXpkQ0I3SUZCc1lYUm1iM0p0VTNSdmNtVk1hV1psWTNsamJHVWdmU0E5SUdGM1lXbDBJR2x0Y0c5eWRDaHdZWFJvVkc5R2FXeGxWVkpNS0hCeWIyTmxjM011WVhKbmRsc3lYU0FySUNjdlpHbHpkQzloWkdGd2RHVnljeTl3YkdGMFptOXliUzF6ZEc5eVpTMXNhV1psWTNsamJHVXVhbk1uS1M1b2NtVm1LVHNLTHlvcUlFOXVaU0J5YjNjZ2NtVmhaR1Z5SUhOb1lYSmxaQ0JpZVNCMGFHVWdiR2wyWlNCemRHOXlaU0JoYm1RZ2RHaGxJSEpsWVdRdGIyNXNlU0JsZUdWamRYUnZjaTRnS2k4S1pYaHdiM0owSUdGemVXNWpJR1oxYm1OMGFXOXVJSEpsWVdSVFlYWmxaRVJ2ZDI1c2IyRmtVMjkxY21ObGN5aGtZWFJoWW1GelpTa2dld29nSUNBZ1kyOXVjM1FnVzNKdmQxMGdQU0JoZDJGcGRDQmtZWFJoWW1GelpTNXhkV1Z5ZVNnblUwVk1SVU5VSUhObGJHVmpkR2x2Yml4eVpYWnBjMmx2YmlCR1VrOU5JR1J6YUY5d2FHRnNZVzU0TG1SdmQyNXNiMkZrWDNOdmRYSmpaWE1nVjBoRlVrVWdhV1E5TVNjcE93b2dJQ0FnY21WMGRYSnVJSEp2ZHlBL0lIc2djMlZzWldOMGFXOXVPaUJrYjNkdWJHOWhaRk52ZFhKalpWTmxiR1ZqZEdsdmJpaHliM2N1YzJWc1pXTjBhVzl1S1N3Z2NtVjJhWE5wYjI0NklFNTFiV0psY2loeWIzY3VjbVYyYVhOcGIyNHBJSDBnT2lCMWJtUmxabWx1WldRN0NuMEtMeW9xQ2lBcUlGUm9aU0JrWlhCc2IzbHRaVzUwTFhkcFpHVWdaRzkzYm14dllXUWdZMmh2YVdObExpQlZiblJwYkNCaGJpQmhaRzFwYm1semRISmhkRzl5SUhOaGRtVnpMQ0IwYUdVZ1kyaHZhV05sSUhSb1pRb2dLaUJwYm5OMFlXeHNaWElnY21WamIzSmtaV1FnYVc0Z2RHaGxJR3h2WTJGc0lHTnZibVpwWjNWeVlYUnBiMjRnWVhCd2JHbGxjenNnYjI1alpTQnpZWFpsWkN3Z2RHaGxJR1JoZEdGaVlYTmxDaUFxSUhKdmR5QmtiMlZ6TGlCVWFHVWdkbWxsZHlCcGN5QnlaV2RwYzNSbGNtVmtJR2x1SUdGeVkyaHBkR1ZqZEhWeVpTNXRaRG9nYzNsdVkyaHliMjV2ZFhNZ2NISmxjR0Z5WVhScGIyNGdZMjlrWlFvZ0tpQnlaV0ZrY3lCcGRDd2dZVzVrSUdsMElHbHpJSEpsWm5KbGMyaGxaQ0J2Ym14NUlHRm1kR1Z5SUdWaFkyZ2dZMjl0YldsMGRHVmtJSE5oZG1VdUNpQXFMd3BsZUhCdmNuUWdZMnhoYzNNZ1VHOXpkR2R5WlhORWIzZHViRzloWkZOdmRYSmpaWE1nZXdvZ0lDQWdaR0YwWVdKaGMyVTdDaUFnSUNCcGJuTjBZV3hzWldRN0NpQWdJQ0IyYVdWM093b2dJQ0FnYkdsbVpXTjVZMnhsSUQwZ2JtVjNJRkJzWVhSbWIzSnRVM1J2Y21WTWFXWmxZM2xqYkdVb0owUnZkMjVzYjJGa0lITnZkWEpqWlNCemRHOXlZV2RsSnlrN0NpQWdJQ0JqYjI1emRISjFZM1J2Y2loa1lYUmhZbUZ6WlN3Z2FXNXpkR0ZzYkdWa0tTQjdDaUFnSUNBZ0lDQWdkR2hwY3k1a1lYUmhZbUZ6WlNBOUlHUmhkR0ZpWVhObE93b2dJQ0FnSUNBZ0lIUm9hWE11YVc1emRHRnNiR1ZrSUQwZ2FXNXpkR0ZzYkdWa093b2dJQ0FnZlFvZ0lDQWdhVzVwZEdsaGJHbDZaU2dwSUhzS0lDQWdJQ0FnSUNCeVpYUjFjbTRnZEdocGN5NXNhV1psWTNsamJHVXVhVzVwZEdsaGJHbDZaU2dvS1NBOVBpQjBhR2x6TG14dllXUW9LU2s3Q2lBZ0lDQjlDaUFnSUNCamJHOXpaU2dwSUhzS0lDQWdJQ0FnSUNCeVpYUjFjbTRnZEdocGN5NXNhV1psWTNsamJHVXVZMnh2YzJVb0tDa2dQVDRnS0hSb2FYTXVkbWxsZHlBOUlIVnVaR1ZtYVc1bFpDa3BPd29nSUNBZ2ZRb2dJQ0FnWjJWMEtDa2dld29nSUNBZ0lDQWdJSFJvYVhNdWJHbG1aV041WTJ4bExtRnpjMlZ5ZEU5d1pXNG9LVHNLSUNBZ0lDQWdJQ0JwWmlBb0lYUm9hWE11ZG1sbGR5a0tJQ0FnSUNBZ0lDQWdJQ0FnZEdoeWIzY2dSWEp5YjNJb0owUnZkMjVzYjJGa0lITnZkWEpqWlNCemRHOXlZV2RsSUdseklHNXZkQ0J5WldGa2VTY3BPd29nSUNBZ0lDQWdJSEpsZEhWeWJpQjdJQzR1TG5OMGNuVmpkSFZ5WldSRGJHOXVaU2gwYUdsekxuWnBaWGN1YzJWc1pXTjBhVzl1S1N3Z2MyRjJaV1E2SUhSb2FYTXVkbWxsZHk1eVpYWnBjMmx2YmlBK0lEQWdmVHNLSUNBZ0lIMEtJQ0FnSUhOaGRtVW9hVzV3ZFhRcElIc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z2RHaHBjeTVzYVdabFkzbGpiR1V1ZDNKcGRHVW9ZWE41Ym1NZ0tDa2dQVDRnZXdvZ0lDQWdJQ0FnSUNBZ0lDQmpiMjV6ZENCelpXeGxZM1JwYjI0Z1BTQmtiM2R1Ykc5aFpGTnZkWEpqWlZObGJHVmpkR2x2YmlocGJuQjFkQ2s3Q2lBZ0lDQWdJQ0FnSUNBZ0lIUm9hWE11WjJWMEtDazdJQzh2SUdOc2IzTmxaQ0J2Y2lCdWIzUWdlV1YwSUdsdWFYUnBZV3hwZW1Wa0lHbHpJSEpsY0c5eWRHVmtJR0psWm05eVpTQmhibmtnY1hWbGNua0tJQ0FnSUNBZ0lDQWdJQ0FnWTI5dWMzUWdaWGh3WldOMFpXUWdQU0IwYUdsekxuWnBaWGN1Y21WMmFYTnBiMjQ3Q2lBZ0lDQWdJQ0FnSUNBZ0lHTnZibk4wSUZ0eWIzZGRJRDBnWVhkaGFYUWdkR2hwY3k1a1lYUmhZbUZ6WlM1eGRXVnllU2hnU1U1VFJWSlVJRWxPVkU4Z1pITm9YM0JvWVd4aGJuZ3VaRzkzYm14dllXUmZjMjkxY21ObGN5aHBaQ3h6Wld4bFkzUnBiMjRzY21WMmFYTnBiMjRwSUZaQlRGVkZVeWd4TENReExERXBDaUFnSUNBZ0lDQWdJRTlPSUVOUFRrWk1TVU5VS0dsa0tTQkVUeUJWVUVSQlZFVWdVMFZVSUhObGJHVmpkR2x2YmoxRldFTk1WVVJGUkM1elpXeGxZM1JwYjI0c2NtVjJhWE5wYjI0OVpHOTNibXh2WVdSZmMyOTFjbU5sY3k1eVpYWnBjMmx2YmlzeElGZElSVkpGSUdSdmQyNXNiMkZrWDNOdmRYSmpaWE11Y21WMmFYTnBiMjQ5SkRJS0lDQWdJQ0FnSUNBZ1VrVlVWVkpPU1U1SElISmxkbWx6YVc5dVlDd2dXMHBUVDA0dWMzUnlhVzVuYVdaNUtITmxiR1ZqZEdsdmJpa3NJR1Y0Y0dWamRHVmtYU2s3Q2lBZ0lDQWdJQ0FnSUNBZ0lDOHZJRTV2SUhKdmR5QmlZV05yT2lCMGFHVWdjM1J2Y21Wa0lISmxkbWx6YVc5dUlHMXZkbVZrSUhCaGMzUWdiM1Z5Y3lBb2FXNWpiSFZrYVc1bklHRWdZMjl1WTNWeWNtVnVkQ0JtYVhKemRDQnpZWFpsS1M0S0lDQWdJQ0FnSUNBZ0lDQWdhV1lnS0NGeWIzY3BDaUFnSUNBZ0lDQWdJQ0FnSUNBZ0lDQjBhSEp2ZHlCdVpYY2dRblZ6YVc1bGMzTlNkV3hsUlhKeWIzSW9KMk52Ym1ac2FXTjBKeXdnSjFCc1lYUm1iM0p0SUdOdmJtWnBaM1Z5WVhScGIyNGdZMmhoYm1kbFpDNGdVbVZzYjJGa0lHSmxabTl5WlNCellYWnBibWN1Snl3Z0ozQnNZWFJtYjNKdExXTnZibVpwWjNWeVlYUnBiMjR0WTI5dVpteHBZM1FuS1RzS0lDQWdJQ0FnSUNBZ0lDQWdkR2hwY3k1MmFXVjNJRDBnZXlCelpXeGxZM1JwYjI0c0lISmxkbWx6YVc5dU9pQk9kVzFpWlhJb2NtOTNMbkpsZG1semFXOXVLU0I5T3dvZ0lDQWdJQ0FnSUgwcE93b2dJQ0FnZlFvZ0lDQWdZWE41Ym1NZ2JHOWhaQ2dwSUhzS0lDQWdJQ0FnSUNCMGFHbHpMblpwWlhjZ1BTQW9ZWGRoYVhRZ2NtVmhaRk5oZG1Wa1JHOTNibXh2WVdSVGIzVnlZMlZ6S0hSb2FYTXVaR0YwWVdKaGMyVXBLU0EvUHlCN0lITmxiR1ZqZEdsdmJqb2daRzkzYm14dllXUlRiM1Z5WTJWVFpXeGxZM1JwYjI0b2RHaHBjeTVwYm5OMFlXeHNaV1FwTENCeVpYWnBjMmx2YmpvZ01DQjlPd29nSUNBZ2ZRcDlDZz09Iik7Ci8qKiBPcGFxdWUgZmlsZXN5c3RlbSBmZW5jZTsgY29ubmVjdGlvbiBhbmQga2V5IGludGVycHJldGF0aW9uIHJlbWFpbiB3aXRoIHRoZSBzb3VyY2Ugb3duZXJzLiAqLwpmdW5jdGlvbiBmaWxlSWRlbnRpdHkocGF0aCkgewogICAgY29uc3QgaW5mbyA9IGxzdGF0U3luYyhwYXRoLCB7IGJpZ2ludDogdHJ1ZSB9KTsKICAgIGlmICghaW5mby5pc0ZpbGUoKSkKICAgICAgICB0aHJvdyBFcnJvcignRXhlY3V0b3IgZmFjdHMgcmVxdWlyZSBhbiBpbmRlcGVuZGVudCBwcm90ZWN0ZWQgZmlsZScpOwogICAgcmV0dXJuIHsgcGF0aCwgZGV2aWNlOiBTdHJpbmcoaW5mby5kZXYpLCBpbm9kZTogU3RyaW5nKGluZm8uaW5vKSwgc2l6ZTogU3RyaW5nKGluZm8uc2l6ZSksIG1vZGlmaWVkOiBTdHJpbmcoaW5mby5tdGltZU5zKSwgY2hhbmdlZDogU3RyaW5nKGluZm8uY3RpbWVOcykgfTsKfQpjb25zdCByb3dzID0gKHNxbCkgPT4gKHsKICAgIHF1ZXJ5OiBhc3luYyAodGV4dCwgdmFsdWVzKSA9PiAoYXdhaXQgc3FsLnF1ZXJ5KHRleHQsIHZhbHVlcyA9PT0gdW5kZWZpbmVkID8gdW5kZWZpbmVkIDogWy4uLnZhbHVlc10pKS5yb3dzLAp9KTsKYXN5bmMgZnVuY3Rpb24gY2hlY2tGYWN0cyhzcWwsIHNjaGVtYXMpIHsKICAgIGxldCBzZWxlY3Rpb24sIHZlcnNpb25zID0gbnVsbCwgY2xpZW50OwogICAgdHJ5IHsKICAgICAgICBjbGllbnQgPSBhd2FpdCBzcWwuY29ubmVjdCgpOwogICAgICAgIGF3YWl0IGNsaWVudC5xdWVyeSgnQkVHSU4gSVNPTEFUSU9OIExFVkVMIFJFUEVBVEFCTEUgUkVBRCBSRUFEIE9OTFknKTsKICAgICAgICBhd2FpdCBjbGllbnQucXVlcnkoJ1NFVCBMT0NBTCBzdGF0ZW1lbnRfdGltZW91dD0xMDAwMCcpOwogICAgICAgIGF3YWl0IGNsaWVudC5xdWVyeSgnU0FWRVBPSU5UIGRvd25sb2FkX3NvdXJjZXMnKTsKICAgICAgICB0cnkgewogICAgICAgICAgICBzZWxlY3Rpb24gPSBhd2FpdCByZWFkU2F2ZWREb3dubG9hZFNvdXJjZXMocm93cyhjbGllbnQpKTsKICAgICAgICB9CiAgICAgICAgY2F0Y2ggewogICAgICAgICAgICBhd2FpdCBjbGllbnQucXVlcnkoJ1JPTExCQUNLIFRPIFNBVkVQT0lOVCBkb3dubG9hZF9zb3VyY2VzJyk7CiAgICAgICAgfQogICAgICAgIGF3YWl0IGNsaWVudC5xdWVyeSgnU0FWRVBPSU5UIHNjaGVtYV92ZXJzaW9ucycpOwogICAgICAgIHRyeSB7CiAgICAgICAgICAgIHZlcnNpb25zID0gYXdhaXQgcmVhZFJlZ2lzdGVyZWRTY2hlbWFWZXJzaW9ucyhjbGllbnQsIHNjaGVtYXMubWFwKG5hbWUgPT4gKHsgbmFtZSwgbWlncmF0aW9uczogW10gfSkpKTsKICAgICAgICB9CiAgICAgICAgY2F0Y2ggewogICAgICAgICAgICBhd2FpdCBjbGllbnQucXVlcnkoJ1JPTExCQUNLIFRPIFNBVkVQT0lOVCBzY2hlbWFfdmVyc2lvbnMnKTsKICAgICAgICB9CiAgICAgICAgYXdhaXQgY2xpZW50LnF1ZXJ5KCdDT01NSVQnKTsKICAgIH0KICAgIGNhdGNoIHsKICAgICAgICB2ZXJzaW9ucyA9IG51bGw7CiAgICAgICAgdHJ5IHsKICAgICAgICAgICAgYXdhaXQgY2xpZW50Py5xdWVyeSgnUk9MTEJBQ0snKTsKICAgICAgICB9CiAgICAgICAgY2F0Y2ggewogICAgICAgICAgICAvKiBUaGUgY29ubmVjdGlvbiBtYXkgYWxyZWFkeSBoYXZlIGNsb3NlZC4gKi8KICAgICAgICB9CiAgICB9CiAgICBmaW5hbGx5IHsKICAgICAgICBjbGllbnQ/LnJlbGVhc2UoKTsKICAgIH0KICAgIHJldHVybiB7IHNlbGVjdGlvbjogc2VsZWN0aW9uPy5zZWxlY3Rpb24gPz8gbnVsbCwgc2NoZW1hczogdmVyc2lvbnMgfTsKfQovKiogUmVhZCBzZWxlY3RlZCBzb3VyY2UgZmFjdHMgd2l0aG91dCBwcmVwYXJpbmcgc3RvcmVzLCBtaWdyYXRpb25zIG9yIGEgcGxhdGZvcm0gcnVudGltZS4gKi8KZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlYWRFeGVjdXRvckZhY3RzKGNvbmZpZ0ZpbGUsIGRhdGFSb290LCBmYWN0LCBzY2hlbWFzKSB7CiAgICBjb25zdCBiZWZvcmUgPSBmaWxlSWRlbnRpdHkoY29uZmlnRmlsZSksIHNlbGVjdGVkID0gRmlsZVBsYXRmb3JtRGF0YWJhc2VDb25maWcub3Blbihjb25maWdGaWxlLCBkYXRhUm9vdCksIGtleSA9IGZpbGVJZGVudGl0eShzZWxlY3RlZC5zZWN1cml0eS5tYXN0ZXJLZXlQYXRoKSwgdmVyaWZpZWRLZXkgPSBGaWxlUGxhdGZvcm1TZWNyZXRzLm9wZW4oc2VsZWN0ZWQuc2VjdXJpdHkubWFzdGVyS2V5UGF0aCwgc2VsZWN0ZWQuc2VjdXJpdHkucmVnaXN0cnkpOwogICAgdmVyaWZpZWRLZXkuY2xvc2UoKTsKICAgIGlmIChmYWN0ID09PSAncm90YXRpb24nKQogICAgICAgIHJldHVybiByb3RhdGlvbkZhY3RzKGNvbmZpZ0ZpbGUsIGRhdGFSb290LCBzZWxlY3RlZCwgW2JlZm9yZSwga2V5XSk7CiAgICBjb25zdCBzcWwgPSBwbGF0Zm9ybURhdGFiYXNlUG9vbChzZWxlY3RlZC5jb25uZWN0aW9uKTsKICAgIHRyeSB7CiAgICAgICAgaWYgKGZhY3QgPT09ICdjaGVjaycpIHsKICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2hlY2tGYWN0cyhzcWwsIHNjaGVtYXMpOwogICAgICAgICAgICBpZiAoSlNPTi5zdHJpbmdpZnkoYmVmb3JlKSAhPT0gSlNPTi5zdHJpbmdpZnkoZmlsZUlkZW50aXR5KGNvbmZpZ0ZpbGUpKSB8fCBKU09OLnN0cmluZ2lmeShrZXkpICE9PSBKU09OLnN0cmluZ2lmeShmaWxlSWRlbnRpdHkoa2V5LnBhdGgpKSkKICAgICAgICAgICAgICAgIHRocm93IEVycm9yKCdUaGUgc2VsZWN0ZWQgY29ubmVjdGlvbiBvciBrZXkgY2hhbmdlZCBkdXJpbmcgdGhlIHJlcXVlc3QnKTsKICAgICAgICAgICAgcmV0dXJuIHsgLi4ucmVzdWx0LCBpZGVudGl0eTogW2JlZm9yZSwga2V5XSB9OwogICAgICAgIH0KICAgICAgICBhd2FpdCBzcWwucXVlcnkoJ1NFVCBzdGF0ZW1lbnRfdGltZW91dD0xMDAwMCcpOwogICAgICAgIGlmIChmYWN0ID09PSAnc2NoZW1hcycpCiAgICAgICAgICAgIHJldHVybiB7CiAgICAgICAgICAgICAgICBzY2hlbWFzOiBhd2FpdCByZWFkUmVnaXN0ZXJlZFNjaGVtYVZlcnNpb25zKHNxbCwgc2NoZW1hcy5tYXAobmFtZSA9PiAoeyBuYW1lLCBtaWdyYXRpb25zOiBbXSB9KSkpLAogICAgICAgICAgICB9OwogICAgICAgIGNvbnN0IHJvdyA9IGF3YWl0IHJlYWRTYXZlZERvd25sb2FkU291cmNlcyhyb3dzKHNxbCkpOwogICAgICAgIHJldHVybiB7IHNlbGVjdGlvbjogcm93Py5zZWxlY3Rpb24gPz8gbnVsbCB9OwogICAgfQogICAgZmluYWxseSB7CiAgICAgICAgYXdhaXQgc3FsLmVuZCgpOwogICAgfQp9Ci8qKiBBIGxpdmUtc2VydmljZSBwcm9iZSBuZXZlciB0YWtlcyBtYWludGVuYW5jZSBsb2NrcyBvciBwcmVwYXJlcyBzY2hlbWEgb3Iga2V5IGZpbGVzLiAqLwphc3luYyBmdW5jdGlvbiByb3RhdGlvbkZhY3RzKGNvbmZpZ0ZpbGUsIGRhdGFSb290LCBzZWxlY3RlZCwgaWRlbnRpdHkpIHsKICAgIGNvbnN0IGJ1aWx0aW5GaWxlID0gam9pbihkaXJuYW1lKGNvbmZpZ0ZpbGUpLCAnYnVpbHRpbi1kYXRhYmFzZS5qc29uJyk7CiAgICBpZGVudGl0eS5wdXNoKGZpbGVJZGVudGl0eShidWlsdGluRmlsZSkpOwogICAgY29uc3QgYnVpbHRpbiA9IEZpbGVQbGF0Zm9ybURhdGFiYXNlQ29uZmlnLm9wZW4oYnVpbHRpbkZpbGUsIGRhdGFSb290KTsKICAgIGlmICghc2VsZWN0ZWQuZGVwbG95bWVudElkIHx8IGJ1aWx0aW4uZGVwbG95bWVudElkICE9PSBzZWxlY3RlZC5kZXBsb3ltZW50SWQgfHwgYnVpbHRpbi5zZWN1cml0eS5tYXN0ZXJLZXlQYXRoICE9PSBzZWxlY3RlZC5zZWN1cml0eS5tYXN0ZXJLZXlQYXRoKQogICAgICAgIHRocm93IEVycm9yKCdSb3RhdGlvbiByZXF1aXJlcyBtYXRjaGluZyBwcm90ZWN0ZWQgZGVwbG95bWVudCBjb25maWd1cmF0aW9ucycpOwogICAgY29uc3QgY2xlYXIgPSAoKSA9PiB7CiAgICAgICAgZm9yIChjb25zdCBwYXRoIG9mIFtjb25maWdGaWxlLCBidWlsdGluRmlsZSwgc2VsZWN0ZWQuc2VjdXJpdHkubWFzdGVyS2V5UGF0aF0pIHsKICAgICAgICAgICAgY29uc3QgbmFtZSA9IGJhc2VuYW1lKHBhdGgpOwogICAgICAgICAgICBpZiAocmVhZGRpclN5bmMoZGlybmFtZShwYXRoKSkuc29tZShlbnRyeSA9PiBlbnRyeS5zdGFydHNXaXRoKG5hbWUgKyAnLm5leHQtJykgfHwgZW50cnkuc3RhcnRzV2l0aChuYW1lICsgJy50bXAta2V5LScpKSkKICAgICAgICAgICAgICAgIHRocm93IEVycm9yKCdBIHN0YWdlZCBrZXkgb3BlcmF0aW9uIG11c3QgYmUgcmVjb3ZlcmVkIGZpcnN0Jyk7CiAgICAgICAgfQogICAgICAgIGNvbnN0IGVudHJpZXMgPSByZWFkZGlyU3luYyhkaXJuYW1lKGNvbmZpZ0ZpbGUpKTsKICAgICAgICBpZiAoZW50cmllcy5pbmNsdWRlcygncGxhdGZvcm0ta2V5LW9wZXJhdGlvbi5qc29uJykgfHwgZW50cmllcy5pbmNsdWRlcygncGxhdGZvcm0tZGF0YWJhc2Utb3BlcmF0aW9uLmpzb24nKSkKICAgICAgICAgICAgdGhyb3cgRXJyb3IoJ0EgcHJvZHVjdCBtYWludGVuYW5jZSBqb3VybmFsIG11c3QgYmUgcmVjb3ZlcmVkIGZpcnN0Jyk7CiAgICB9OwogICAgY2xlYXIoKTsKICAgIGxldCByZWFkeSA9IGZhbHNlOwogICAgaWYgKHNlbGVjdGVkLnNlbGVjdGlvbiAhPT0gdW5kZWZpbmVkKSB7CiAgICAgICAgY29uc3QgY2hlY2tlZCA9IGF3YWl0IGluc3BlY3RQbGF0Zm9ybURhdGFiYXNlKHNlbGVjdGVkLmNvbm5lY3Rpb24sIHNlbGVjdGVkLnNlY3VyaXR5LnJlZ2lzdHJ5Lm1hc3RlckZpbmdlcnByaW50LCBzZWxlY3RlZC5kZXBsb3ltZW50SWQpOwogICAgICAgIGlmICghY2hlY2tlZC5vaykKICAgICAgICAgICAgdGhyb3cgRXJyb3IoJ1JvdGF0aW9uIHJlYWRpbmVzcyByZXF1aXJlcyBhIHJlYWNoYWJsZSBtYXRjaGluZyBwbGF0Zm9ybSBkYXRhYmFzZScpOwogICAgICAgIHJlYWR5ID0gY2hlY2tlZC5zY2hlbWEgPT09ICdwbGF0Zm9ybSc7CiAgICB9CiAgICBjbGVhcigpOwogICAgaWYgKGlkZW50aXR5LnNvbWUoYmVmb3JlID0+IEpTT04uc3RyaW5naWZ5KGJlZm9yZSkgIT09IEpTT04uc3RyaW5naWZ5KGZpbGVJZGVudGl0eShiZWZvcmUucGF0aCkpKSkKICAgICAgICB0aHJvdyBFcnJvcignVGhlIHByb3RlY3RlZCBjb25maWd1cmF0aW9uIG9yIGtleSBjaGFuZ2VkIGR1cmluZyByb3RhdGlvbiByZWFkaW5lc3MgY2hlY2tzJyk7CiAgICByZXR1cm4gewogICAgICAgIHJlYWR5LAogICAgICAgIGluaXRpYWxpemF0aW9uUGVuZGluZzogIXJlYWR5LAogICAgICAgIGRlcGxveW1lbnRJZDogc2VsZWN0ZWQuZGVwbG95bWVudElkLAogICAgICAgIGZpbmdlcnByaW50OiBzZWxlY3RlZC5zZWN1cml0eS5yZWdpc3RyeS5tYXN0ZXJGaW5nZXJwcmludCwKICAgICAgICBpZGVudGl0eSwKICAgIH07Cn0K\");\n  const result = await readExecutorFacts(request.configFile, request.dataRoot, request.fact, request.schemas);\n  console.log(JSON.stringify(result));\n} catch {\n  console.error('Platform database facts are unavailable; inspect the selected connection and master-key file');\n  process.exitCode = 2;\n}\n"
# END GENERATED EXECUTOR FACTS PROGRAM


def executor_facts(host, values, fact, *, source=None, schemas=('dsh_phalanx',)):
    """A bounded read-only adapter; the selected source owns its connection and key interpretation."""
    target=Path(source) if source is not None else host.path('/opt/dsh-phalanx/current').resolve()
    config=host.path(values.get('DSH_PHALANX_DATABASE_CONFIG_FILE', HOME_DIR + '/keys/database.json'))
    if 'DSH_PHALANX_DATA_ROOT' not in values or not (target/'start').exists() or fact=='download-sources' and not config.exists():return None
    with tempfile.TemporaryDirectory(prefix='dsh-phalanx-facts-') as temporary:
        program=Path(temporary)/'executor-facts.mjs';request=Path(temporary)/'request.json'
        program.write_text(EXECUTOR_FACTS_PROGRAM);program.chmod(0o600)
        request.write_text(json.dumps({'fact':fact,'configFile':str(config),'dataRoot':str(host.path(values['DSH_PHALANX_DATA_ROOT'])),'schemas':list(schemas)}));request.chmod(0o600)
        result=host.run(['timeout','--signal=TERM','--kill-after=5s','20s',str(target/'node/bin/node'),str(program),str(target)],input_file=request,check=False)
    if result.returncode==2:
        host.tell('The platform database did not answer; using the local record instead of ' + fact)
        return None
    if result.returncode!=0:raise ValueError('The installed platform could not report ' + fact)
    return json.loads(result.stdout)


def platform_facts(host, values, fact):
    """Read narrow download facts; other diagnostics use the installed CLI."""
    if fact=='download-sources':return executor_facts(host,values,fact)
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
    saved = platform_facts(host, values, 'download-sources') if platform_running else None
    return download_source_choice(values, args, saved)


def download_source_choice(values, args=None, saved=None):
    selection = json.loads(values.get('DSH_PHALANX_DOWNLOAD_SOURCES', '{"preset":"official"}'))
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
UNINSTALL_STATE = '/etc/dsh-phalanx/uninstall-state.json'


def uninstall_record(host):
    path = host.path(UNINSTALL_STATE)
    if not path.exists() and not path.is_symlink():
        return None
    if path.parent.is_symlink() or path.is_symlink() or not path.is_file() or path.stat().st_uid != os.geteuid() or path.stat().st_mode & 0o077:
        raise ConfigurationError('Uninstall receipt ownership cannot be verified')
    if path.stat().st_size > 1048576:
        raise ConfigurationError('Uninstall receipt exceeds its allowed size')
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or value.get('schema') != 1 or value.get('phase') not in ('removing', 'retained', 'purging'):
        raise ConfigurationError('Invalid uninstall receipt')
    return value


def default_storage_root(data_root):
    return os.path.abspath(data_root)+'.durable'


def unit_argument(value):
    return '"'+str(value).replace('\\','\\\\').replace('"','\\"').replace('%','%%')+'"'


def effective_user_data_root(values):
    return values.get('DSH_PHALANX_USER_DATA_ROOT') or default_storage_root(values['DSH_PHALANX_DATA_ROOT'])+'/users'


class ConfigurationError(ValueError):
    pass


class HiddenConfigurationConflict(ConfigurationError):
    """An existing compatibility listener needs explicit offline maintenance."""
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
    for address in filter(None, values.get('DSH_PHALANX_HOST_PUBLIC_ADDRESSES', '').split(',')):
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
    from installer_questions import InstallerQuestions, validate_port  # embedded-questions
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
            if name == 'PREVIEW_PORT':
                reason = f'已有兼容监听端口 {number} 不可用，已保留配置；请按服务管理文档处理后重试。' if getattr(args, 'language', 'zh-CN') == 'zh-CN' else f'Existing compatibility listener port {number} is unavailable; configuration retained. Follow service management documentation before retrying.'
                raise HiddenConfigurationConflict(reason)
            host.tell(f'{flag} {number} is unavailable: {conflict}. No occupying process was stopped.')
            if not interactive or successful:
                raise ConfigurationError(f'Choose a free {flag} and rerun the installer; {conflict}')
            dialogue = getattr(args, 'dialogue', None) or InstallerQuestions(getattr(args, 'language', 'zh-CN'), host.prompt, host.operator, DOWNLOAD_SOURCE_PRESETS)
            values[key] = dialogue.ask(f'新的 {flag} 值', f'New {flag} value', validate=validate_port)
            origin = urllib.parse.urlparse(values['DSH_PHALANX_PUBLIC_ORIGIN'])
            if name == 'PORT' and origin.scheme == 'http' and origin.port == number and (getattr(args, 'dialogue', None) is None or args.dialogue.automatic_origin):
                values['DSH_PHALANX_PUBLIC_ORIGIN'] = origin._replace(netloc=origin.netloc.rsplit(':', 1)[0]+':'+values[key]).geturl()
            if not values[key].isdigit() or not 1 <= int(values[key]) <= 65535:
                raise ConfigurationError('Port must be between 1 and 65535')


def configuration(host, args, *, target_version, entry_url, access_candidate):
    from installer_progress import operator_text  # embedded-progress
    from installer_questions import InstallerQuestions, apply_source_choice, validate_ip, Cancelled  # embedded-questions
    # The release selector has already verified this manifest version.
    release = tuple(map(int, target_version.split('.')))
    protected_secrets = release >= (0, 1, 25)
    if protected_secrets and args.model_key_file:
        raise ConfigurationError('Configure provider credentials in administration after signup; --model-key-file is only for historical releases')
    modern = release >= (0, 1, 1)
    if not modern and (args.user_data_root is not None or args.user_data_mount is not None):
        raise ConfigurationError('External user storage options require 0.1.1 or later')
    previous = read_configuration(host)
    successful = installed_state(host) is not None or uninstall_record(host) is not None
    interactive = host.terminal_available() and not getattr(args, 'non_interactive', False)
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
    if getattr(args, 'server_ip', None) is not None:
        validate_ip(args.server_ip)
    missing = []
    if not interactive:
        if 'DSH_PHALANX_HOST_PUBLIC_ADDRESSES' not in values:
            missing.append('--host-public-addresses')
        if modern and 'DSH_PHALANX_PUBLIC_ORIGIN' not in values:
            missing.append('--public-origin')
        if not modern and args.model_key_file is None and 'DSH_PHALANX_MODEL_UPSTREAM_API_KEY' not in values:
            missing.append('--model-key-file')
        if missing:
            prefix = '非交互安装缺少参数：' if getattr(args, 'language', 'zh-CN') == 'zh-CN' else 'Missing '
            example = '。示例：' if getattr(args, 'language', 'zh-CN') == 'zh-CN' else '. Example: '
            raise ConfigurationError(prefix+', '.join(missing)+example+'sudo bash install.sh --public-origin http://<host>:18080 --host-public-addresses ""'+(' --model-key-file /path/to/protected-key' if not modern else ''))
    if not modern and 'DSH_PHALANX_HOST_PUBLIC_ADDRESSES' not in values:
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
        dialogue = getattr(args, 'dialogue', None) or InstallerQuestions(getattr(args, 'language', 'zh-CN'), host.prompt, host.operator, DOWNLOAD_SOURCE_PRESETS)
        selection = configured_download_sources(host, values, args)
        config = {'source': selection['preset'], 'overrides': selection.get('overrides', {}),
                  'server_ip': getattr(args, 'server_ip', None), 'port': values['DSH_PHALANX_PORT'],
                  'origin': values.get('DSH_PHALANX_PUBLIC_ORIGIN'), 'mapping': values.get('DSH_PHALANX_HOST_PUBLIC_ADDRESSES'),
                  'gateway': values['DSH_PHALANX_CONTAINER_GATEWAY_PORT'], 'data': values.get('DSH_PHALANX_USER_DATA_ROOT', ''),
                  'mount': values.get('DSH_PHALANX_USER_DATA_MOUNT', '')}
        if config['origin'] and args.public_origin is None:
            try:
                previous_ip = str(ipaddress.ip_address(urllib.parse.urlsplit(config['origin']).hostname))
            except ValueError:
                previous_ip = None
            config['server_ip'] = config['server_ip'] or previous_ip
            dialogue.automatic_origin = previous_ip is not None and config['origin'] == entry_url(config['port'], previous_ip)
        supplied = set()
        if args.public_origin is not None: supplied.update(('server_ip', 'origin'))
        if getattr(args, 'server_ip', None) is not None:
            config['server_ip'] = validate_ip(args.server_ip)
            supplied.add('server_ip')
        if args.port is not None: supplied.add('port')
        if args.host_public_addresses is not None: supplied.add('mapping')
        dialogue.edit_common(config, supplied)
        if dialogue.choose('展开高级设置？y/n', 'Open advanced settings? y/n', ('y', 'n'), 'n') == 'y':
            dialogue.edit_advanced(config)
        while True:
            for name, key in (('port', 'PORT'), ('origin', 'PUBLIC_ORIGIN'), ('gateway', 'CONTAINER_GATEWAY_PORT')):
                values['DSH_PHALANX_'+key] = config[name]
            for name, key in (('mapping', 'HOST_PUBLIC_ADDRESSES'), ('data', 'USER_DATA_ROOT'), ('mount', 'USER_DATA_MOUNT')):
                if config[name] is None or name != 'mapping' and not config[name]:
                    values.pop('DSH_PHALANX_'+key, None)
                else:
                    values['DSH_PHALANX_'+key] = config[name]
            apply_source_choice(args, config)
            args.gateway_chosen = args.gateway_chosen or dialogue.gateway_chosen
            try:
                validate_configuration(host, values)
                validate_storage(host, values)
                check_ports(host, args, values, successful, interactive)
                config['port'] = values['DSH_PHALANX_PORT']
                config['gateway'] = values['DSH_PHALANX_CONTAINER_GATEWAY_PORT']
                config['origin'] = values['DSH_PHALANX_PUBLIC_ORIGIN']
            except (ValueError, OSError) as error:
                if isinstance(error, (Cancelled, HiddenConfigurationConflict)) or args.preview_port is not None or args.preview_origin is not None:
                    raise
                dialogue.tell('配置未通过校验，请修改后重试：'+operator_text(str(error), 'zh-CN'), 'Configuration validation failed; edit and retry: '+str(error))
                dialogue.edit_common(config)
                dialogue.edit_advanced(config)
                continue
            dialogue.summary({**config, 'data': config['data'] or effective_user_data_root(values)})
            action = dialogue.choose('摘要：install 安装 / edit 修改 / cancel 取消', 'Summary: install / edit / cancel', ('install', 'edit', 'cancel'), 'install')
            if action == 'install': break
            if action == 'cancel':
                raise Cancelled(dialogue.tr('安装已取消；保留已准备的依赖及现有数据。', 'Installation cancelled; prepared dependencies and existing data are retained.'))
            section = dialogue.choose('修改：source 下载源 / common 常用 / advanced 高级', 'Edit: source / common / advanced', ('source', 'common', 'advanced'), 'common')
            if section == 'source':
                dialogue.edit_source(config)
                apply_source_choice(args, config)
                host.download_sources = resolve_download_sources({'preset': config['source'], 'overrides': config['overrides']})
                if getattr(host, 'recheck_release', None) is not None: host.recheck_release()
                dialogue.tell('已按新下载源重新核对版本。', 'Release rechecked using the new source.')
            elif section == 'common': dialogue.edit_common(config)
            else: dialogue.edit_advanced(config)
    values.setdefault('DSH_PHALANX_PUBLIC_ORIGIN', entry_url(values['DSH_PHALANX_PORT'], values['DSH_PHALANX_HOST']))
    values['DSH_PHALANX_DOWNLOAD_SOURCES'] = json.dumps(configured_download_sources(host, values, args), separators=(',', ':'))
    validate_configuration(host, values)
    validate_storage(host, values)
    check_ports(host, args, values, successful, interactive)
    validate_configuration(host, values)
    if not successful:
        changes = sorted(key.removeprefix('DSH_PHALANX_') for key, value in values.items() if key in previous and previous[key] != value)
        if modern:
            if not interactive:
                dialogue = getattr(args, 'dialogue', None) or InstallerQuestions(getattr(args, 'language', 'zh-CN'), host.prompt, host.operator, DOWNLOAD_SOURCE_PRESETS)
                selection = configured_download_sources(host, values, args)
                dialogue.summary({'source': selection['preset'], 'overrides': selection.get('overrides', {}), 'server_ip': getattr(args, 'server_ip', None),
                                  'port': values['DSH_PHALANX_PORT'], 'origin': values['DSH_PHALANX_PUBLIC_ORIGIN'], 'gateway': values['DSH_PHALANX_CONTAINER_GATEWAY_PORT'],
                                  'mapping': values.get('DSH_PHALANX_HOST_PUBLIC_ADDRESSES'), 'data': effective_user_data_root(values), 'mount': values.get('DSH_PHALANX_USER_DATA_MOUNT', '')})
        else:
            host.tell('Configuration: '+values['DSH_PHALANX_PUBLIC_ORIGIN']+'; entry port '+values['DSH_PHALANX_PORT']+'; private gateway '+values['DSH_PHALANX_CONTAINER_GATEWAY_PORT'])
            host.tell('Platform data: '+values['DSH_PHALANX_DATA_ROOT']+'; user data: '+effective_user_data_root(values))
        if changes:
            host.tell('Retry changes: '+', '.join(changes)+'. Existing data will be preserved.')
        if interactive and not modern and host.prompt('Continue with this configuration? [y/N]: ').lower() != 'y':
            raise ConfigurationError('Installation cancelled before downloads or deployment changes')
    return values
