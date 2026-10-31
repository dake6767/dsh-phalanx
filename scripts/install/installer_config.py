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


# BEGIN GENERATED EXECUTOR FACTS PROGRAM
EXECUTOR_FACTS_PROGRAM = "// Generated from platform adapters. The source release owns its connection, key and TLS interpretation.\nimport { readFileSync } from 'node:fs';\ntry {\n  const request = JSON.parse(readFileSync(0, 'utf8'));\n  const { readExecutorFacts } = await import(\"data:text/javascript;base64,aW1wb3J0IHsgcGF0aFRvRmlsZVVSTCB9IGZyb20gJ25vZGU6dXJsJzsKaW1wb3J0IHsgbHN0YXRTeW5jIH0gZnJvbSAnbm9kZTpmcyc7CmNvbnN0IHsgRmlsZVBsYXRmb3JtRGF0YWJhc2VDb25maWcgfSA9IGF3YWl0IGltcG9ydChwYXRoVG9GaWxlVVJMKHByb2Nlc3MuYXJndlsyXSArICcvZGlzdC9hZGFwdGVycy9wbGF0Zm9ybS1kYXRhYmFzZS1jb25maWcuanMnKS5ocmVmKTsKY29uc3QgeyBGaWxlUGxhdGZvcm1TZWNyZXRzIH0gPSBhd2FpdCBpbXBvcnQocGF0aFRvRmlsZVVSTChwcm9jZXNzLmFyZ3ZbMl0gKyAnL2Rpc3QvYWRhcHRlcnMvcGxhdGZvcm0tc2VjcmV0cy5qcycpLmhyZWYpOwpjb25zdCB7IHBsYXRmb3JtRGF0YWJhc2VQb29sIH0gPSBhd2FpdCBpbXBvcnQocGF0aFRvRmlsZVVSTChwcm9jZXNzLmFyZ3ZbMl0gKyAnL2Rpc3QvYWRhcHRlcnMvcGxhdGZvcm0tZGF0YWJhc2UtaW5zcGVjdGlvbi5qcycpLmhyZWYpOwpjb25zdCB7IHJlYWRSZWdpc3RlcmVkU2NoZW1hVmVyc2lvbnMgfSA9IGF3YWl0IGltcG9ydCgiZGF0YTp0ZXh0L2phdmFzY3JpcHQ7YmFzZTY0LGFXMXdiM0owSUhzZ2NHRjBhRlJ2Um1sc1pWVlNUQ0I5SUdaeWIyMGdKMjV2WkdVNmRYSnNKenNLWTI5dWMzUWdleUJRVEVGVVJrOVNUVjlUUTBoRlRVRlRMQ0J6WTJobGJXRkpaR1Z1ZEdsbWFXVnlJSDBnUFNCaGQyRnBkQ0JwYlhCdmNuUW9JbVJoZEdFNmRHVjRkQzlxWVhaaGMyTnlhWEIwTzJKaGMyVTJOQ3hoVnpGM1lqTktNRWxJYzJkalIwWXdZVVpTZGxKdGJITmFWbFpUVkVOQ09VbEhXbmxpTWpCblNqSTFkbHBIVlRaa1dFcHpTbnB6UzFreU9YVmpNMUZuWlhsQ1VWUkZSbFZTYXpsVFZGWTVUbE5WWkZOUlZsSktWREExVkVsSU1HZFFVMEpvWkRKR2NHUkRRbkJpV0VKMlkyNVJiMk5IUmpCaFJsSjJVbTFzYzFwV1ZsTlVRMmgzWTIwNWFscFlUbnBNYlVaNVdqTmFZazFzTUdkTGVVRnVUREpTY0dNelVYWlpWMUpvWTBoU2JHTnVUWFpqUjNob1pFZGFkbU50TUhSak1rNXZXbGN4YUV4dGNIcEtlV3QxWVVoS2JGcHBhemREYVRoeFMybENWV0ZIVldkalNFcDJXa2hXYW1SSGJIWmlhVUo2V1RKb2JHSlhSV2RoVnpVeVdsYzFNR0l6U2pWTVEwSjZZVWRHZVZwWFVXZFpibXRuWWxkc2JtTnRSakJoVnpsMVRFTkNhbUl5TVhkWldGSndXVzFzYzJGWVVqVkpSMFoxV2tOQ2FWbFhUbkprV0VGblkyMVdhRnBIVm5samVUUm5TMms0UzFwWWFIZGlNMG93U1VkT2RtSnVUakJKUmtKTlVWWlNSMVF4U2s1WU1VNUVVMFZXVGxGV1RXZFFVMEppWlhsQ2RWbFhNV3hQYVVGdVdraE9iMWd6UW05WlYzaG9ZbTVuYmt4RFFuUmhWMlI1V1ZoU2NHSXlOWHBQYVVKUlZFVkdWVkpyT1ZOVVZqbE9VMVZrVTFGV1VrcFVNRFZVU1VneFpFOTNiM1pMYVc5blZXMVdibUZZVGpCamJtdG5ZbTFHZEZwWVRXZFpXRXBzU1VaT1VsUkRRbkJhUjFaMVpFZHNiV0ZYVm5samVYZG5ZbTFXTWxwWVNXZFpXRXBwWVZoU2VWbFlTalZKUms1U1ZFTkNkbU5wUW1oSlNFNXNXVmhLYW1GR09YZFpXRkp2U1VkV05HTklTbXhqTTA1d1lqSTBkVWxEYjNaRGJWWTBZMGM1ZVdSRFFtMWtWelZxWkVkc2RtSnBRbnBaTW1oc1lsZEdTbHBIVm5Wa1IyeHRZVmRXZVV0SE5XaGlWMVZ3U1VoelMwbERRV2RKUjJ4dFNVTm5hRXd4TldKWlV6RTJXREV4WWxsVE1UWk5RekExV0RFeE4wMURkekpOYmpCclRETlZkV1JIVm5wa1EyaDFXVmN4YkV0VFFqaG1RMEoxV1ZjeGJFeHVUakJaV0Vvd1l6RmtjR1JIWjI5S00wSnVXSGxqY0VsSWVEaEpSelZvWWxkVloxQlVNRGxKUTJSd1ltMWFkbU50TVdoa1IyeDJZbXc1ZWxreWFHeGlWMFZ1U1VoNE9FbEhOV2hpVjFWblVGUXdPVWxEWkhka1YwcHpZVmROYmt0UmIyZEpRMEZuU1VOQlowbElVbTlqYlRrelNVVldlV050T1hsTFEyUkNTVWhLYkZveWJIcGtSMVo1V2xkUloyTkhlR2hrUjFwMlkyMHdaMk15VG05YVZ6Rm9TVWN4TVdNelVXZGhSMFl5V2xOQ2FFbEhVbkJqTTFKd1ltMU9NRWxITlhaaWFURjZaVmhPTUZwWE1HZFZNVVpOU1VjMWFHSlhWVzVMVkhOTFNVTkJaMGxJU214a1NGWjVZbWxDWjBscFVqZGliVVowV2xnd2FWbEVjMHRtVVc5MlMybHZaMUZUUW1waU1qRjNZak5PY0dSSGJIWmlhVUo2WkZoQ2QySkhiR3hqZVVKb1NVZGFjR1ZIVm10SlIyeDFaRzFXZFdSSE9YbGxVMEp0WWpOSloySXlOV3hKUjFKb1pFZEdhVmxZVG14SlIzaHdXbTFXTUdGWE1XeE1hVUZ4VEhkd2JHVklRblpqYmxGbldtNVdkVmt6VW5CaU1qUm5ZMjFXYm1GWVRqQmFXRXBzV2taT2FtRkhWblJaV0Uxdll6Sk9iMXBYTVdoamVXdG5aWGR2WjBsRFFXZGhWMWxuUzBoT2FtRkhWblJaV0U1aVRVWXdMMHh0TldoaVYxVm5TVlF3T1VsRFpHdGpNbWhtWTBkb2FHSkhSblZsUTJOd1EybEJaMGxEUVdkSlEwRm5aRWRvZVdJelkyZFNXRXA1WWpOSmIwb3hVbTlhVTBKM1lrZEdNRnB0T1hsaVUwSnFZak5LYkVsSVRtcGhSMVowV1ZOQ2RHUllUakJKUjBwc1NVaEtiRm95Ykhwa1IxWjVXbGRSWjFwdGJIbGpNMUZ1UzFSelMwbERRV2RKUjA1MlltNU9NRWxITldoaVYxWjZTVVF3WjJKdFZqTkpSazVzWkVObmNFOTNiMmRKUTBGblkyMVdNR1JZU25WSlJUbHBZVzFXYW1SRE5XMWpiVlpzWlcxVmIyTXlUbTlhVnpGb1kzazFkRmxZUVc5ak1rNXZXbGN4YUVsRU1DdEpTSE5MU1VOQlowbERRV2RKUTBKNldUSm9iR0pYUmtwYVIxWjFaRWRzYldGWFZubExTRTVxWVVkV2RGbFROWFZaVnpGc1MxUnpTMGxEUVdkSlEwRm5TVU5DY0ZwcFFXOWliVVowV2xoTmRXRkhSbnBMU0U1cVlVZFdkRmxUTlhWWlZ6RnNTMU5yUzBsRFFXZEpRMEZuU1VOQlowbERRV2RrUjJoNVlqTmpaMUpZU25saU0wbHZTakZDYzFsWVVtMWlNMHAwU1VoT2FtRkhWblJaVTBKMVdWY3hiR041UW5Sa1dFNHdTVWRLYkVsSVZuVmhXRVl4V2xOamNFOTNiMmRKUTBGblNVTkJaMGxITldoaVYxWjZURzFHYTFwRGFIcFpNbWhzWWxkRmRXSnRSblJhVTJzM1EybEJaMGxEUVdkSlEwRm5ZVmRaWjB0RFJucFpNbWhzWWxkRmRXSlhiRzVqYlVZd1lWYzVkV041TlhOYVZ6VnVaRWRuWjJaSWQyZGpNazV2V2xjeGFFeHRNWEJhTTBwb1pFZHNkbUp1VFhWak1qbDBXbE5uYjJKWGJHNWpiVVl3WVZjNWRVeERRbkJpYlZKc1pVTnJaMUJVTkdkaVYyeHVZMjFHTUdGWE9YVk1ibHBzWTI1T2NHSXlOR2RKVkRBNVNVZHNkVnBIVmpSSlEzTm5UVk5yY0VOcFFXZEpRMEZuU1VOQlowbERRV2RKU0ZKdlkyMDVNMGxGVm5samJUbDVTME5rVTFwWFpIQmpNMUpzWTIxV2EwbElUbXBoUjFaMFdWTkNkR0ZYWkhsWldGSndZakkxZWtsSE1URmpNMUZuV1cxVloxa3lPWFZrUjJ4dVpGYzVNV041UW0xamJUbDBTVWhhYkdOdVRuQmlNalJuVFZOamNFOTNiMmRKUTBGblNVTkJaMGxJU214a1NGWjVZbWxDVUZsdGNHeFpNMUYxV201S2JGcFljR3hMU0hOblltMUdkRnBVYjJkak1rNXZXbGN4YUV4dE5XaGlWMVZ6U1VjeGNGb3pTbWhrUjJ4MlltNU5Oa2xGT1dsaGJWWnFaRU0xYldOdFZteGxiVlZ2WXpKT2IxcFhNV2hNYlRGd1dqTkthR1JIYkhaaWJrMTFZbGRHZDB0SE1YQmFNMHBvWkVkc2RtSnBRVGxRYVVKUVdXMXdiRmt6VVhWYWJrcHNXbGh3YkV0SWMyZE1hVFIxWWxkc2JtTnRSakJoVnpsMVNVZ3djRXRUYTJkbVUyczNRMmxCWjBsRFFqbExVMnMzUTI0d1N5SXBPd292S2lvZ1FTQnRhWE56YVc1bklHNWhiV1Z6Y0dGalpTQnZjaUIyWlhKemFXOXVJSFJoWW14bElHbHpJSFpsY25OcGIyNGdlbVZ5YnpzZ2NtVmhaR2x1WnlCdVpYWmxjaUJ3Y21Wd1lYSmxjeUJwZEM0Z0tpOEtaWGh3YjNKMElHRnplVzVqSUdaMWJtTjBhVzl1SUhKbFlXUlNaV2RwYzNSbGNtVmtVMk5vWlcxaFZtVnljMmx2Ym5Nb2MzRnNMQ0J6WTJobGJXRnpJRDBnVUV4QlZFWlBVazFmVTBOSVJVMUJVeWtnZXdvZ0lDQWdZMjl1YzNRZ2RtVnljMmx2Ym5NZ1BTQmJYVHNLSUNBZ0lHWnZjaUFvWTI5dWMzUWdjMk5vWlcxaElHOW1JSE5qYUdWdFlYTXBJSHNLSUNBZ0lDQWdJQ0JqYjI1emRDQjBZV0pzWlNBOUlHQWtlM05qYUdWdFlVbGtaVzUwYVdacFpYSW9jMk5vWlcxaExtNWhiV1VwZlM1elkyaGxiV0ZmYldsbmNtRjBhVzl1YzJBN0NpQWdJQ0FnSUNBZ1kyOXVjM1FnY0hKbGMyVnVkQ0E5SUNoaGQyRnBkQ0J6Y1d3dWNYVmxjbmtvSjFORlRFVkRWQ0IwYjE5eVpXZGpiR0Z6Y3lna01TazZPblJsZUhRZ1FWTWdjbVZzWVhScGIyNG5MQ0JiZEdGaWJHVmRLU2t1Y205M2Mxc3dYUzV5Wld4aGRHbHZianNLSUNBZ0lDQWdJQ0JqYjI1emRDQjJaWEp6YVc5dUlEMGdjSEpsYzJWdWRDQS9JRTUxYldKbGNpZ29ZWGRoYVhRZ2MzRnNMbkYxWlhKNUtHQlRSVXhGUTFRZ1EwOUJURVZUUTBVb2JXRjRLSFpsY25OcGIyNHBMREFwSUVGVElIWmxjbk5wYjI0Z1JsSlBUU0FrZTNSaFlteGxmV0FwS1M1eWIzZHpXekJkTG5abGNuTnBiMjRwSURvZ01Ec0tJQ0FnSUNBZ0lDQjJaWEp6YVc5dWN5NXdkWE5vS0hzZ2JtRnRaVG9nYzJOb1pXMWhMbTVoYldVc0lIWmxjbk5wYjI0Z2ZTazdDaUFnSUNCOUNpQWdJQ0J5WlhSMWNtNGdkbVZ5YzJsdmJuTTdDbjBLIik7CmNvbnN0IHsgcmVhZFNhdmVkRG93bmxvYWRTb3VyY2VzIH0gPSBhd2FpdCBpbXBvcnQoImRhdGE6dGV4dC9qYXZhc2NyaXB0O2Jhc2U2NCxhVzF3YjNKMElIc2djR0YwYUZSdlJtbHNaVlZTVENCOUlHWnliMjBnSjI1dlpHVTZkWEpzSnpzS1kyOXVjM1FnZXlCQ2RYTnBibVZ6YzFKMWJHVkZjbkp2Y2lCOUlEMGdZWGRoYVhRZ2FXMXdiM0owS0hCaGRHaFViMFpwYkdWVlVrd29jSEp2WTJWemN5NWhjbWQyV3pKZElDc2dKeTlrYVhOMEwyUnZiV0ZwYmk5aWRYTnBibVZ6Y3kxbGNuSnZjaTVxY3ljcExtaHlaV1lwT3dwamIyNXpkQ0I3SUdSdmQyNXNiMkZrVTI5MWNtTmxVMlZzWldOMGFXOXVJSDBnUFNCaGQyRnBkQ0JwYlhCdmNuUW9jR0YwYUZSdlJtbHNaVlZTVENod2NtOWpaWE56TG1GeVozWmJNbDBnS3lBbkwyUnBjM1F2Wkc5dFlXbHVMMlJ2ZDI1c2IyRmtMWE52ZFhKalpTNXFjeWNwTG1oeVpXWXBPd3BqYjI1emRDQjdJRkJzWVhSbWIzSnRVM1J2Y21WTWFXWmxZM2xqYkdVZ2ZTQTlJR0YzWVdsMElHbHRjRzl5ZENod1lYUm9WRzlHYVd4bFZWSk1LSEJ5YjJObGMzTXVZWEpuZGxzeVhTQXJJQ2N2WkdsemRDOWhaR0Z3ZEdWeWN5OXdiR0YwWm05eWJTMXpkRzl5WlMxc2FXWmxZM2xqYkdVdWFuTW5LUzVvY21WbUtUc0tMeW9xSUU5dVpTQnliM2NnY21WaFpHVnlJSE5vWVhKbFpDQmllU0IwYUdVZ2JHbDJaU0J6ZEc5eVpTQmhibVFnZEdobElISmxZV1F0YjI1c2VTQmxlR1ZqZFhSdmNpNGdLaThLWlhod2IzSjBJR0Z6ZVc1aklHWjFibU4wYVc5dUlISmxZV1JUWVhabFpFUnZkMjVzYjJGa1UyOTFjbU5sY3loa1lYUmhZbUZ6WlNrZ2V3b2dJQ0FnWTI5dWMzUWdXM0p2ZDEwZ1BTQmhkMkZwZENCa1lYUmhZbUZ6WlM1eGRXVnllU2duVTBWTVJVTlVJSE5sYkdWamRHbHZiaXh5WlhacGMybHZiaUJHVWs5TklHUnphRjl3YUdGc1lXNTRMbVJ2ZDI1c2IyRmtYM052ZFhKalpYTWdWMGhGVWtVZ2FXUTlNU2NwT3dvZ0lDQWdjbVYwZFhKdUlISnZkeUEvSUhzZ2MyVnNaV04wYVc5dU9pQmtiM2R1Ykc5aFpGTnZkWEpqWlZObGJHVmpkR2x2YmloeWIzY3VjMlZzWldOMGFXOXVLU3dnY21WMmFYTnBiMjQ2SUU1MWJXSmxjaWh5YjNjdWNtVjJhWE5wYjI0cElIMGdPaUIxYm1SbFptbHVaV1E3Q24wS0x5b3FDaUFxSUZSb1pTQmtaWEJzYjNsdFpXNTBMWGRwWkdVZ1pHOTNibXh2WVdRZ1kyaHZhV05sTGlCVmJuUnBiQ0JoYmlCaFpHMXBibWx6ZEhKaGRHOXlJSE5oZG1WekxDQjBhR1VnWTJodmFXTmxJSFJvWlFvZ0tpQnBibk4wWVd4c1pYSWdjbVZqYjNKa1pXUWdhVzRnZEdobElHeHZZMkZzSUdOdmJtWnBaM1Z5WVhScGIyNGdZWEJ3YkdsbGN6c2diMjVqWlNCellYWmxaQ3dnZEdobElHUmhkR0ZpWVhObENpQXFJSEp2ZHlCa2IyVnpMaUJVYUdVZ2RtbGxkeUJwY3lCeVpXZHBjM1JsY21Wa0lHbHVJR0Z5WTJocGRHVmpkSFZ5WlM1dFpEb2djM2x1WTJoeWIyNXZkWE1nY0hKbGNHRnlZWFJwYjI0Z1kyOWtaUW9nS2lCeVpXRmtjeUJwZEN3Z1lXNWtJR2wwSUdseklISmxabkpsYzJobFpDQnZibXg1SUdGbWRHVnlJR1ZoWTJnZ1kyOXRiV2wwZEdWa0lITmhkbVV1Q2lBcUx3cGxlSEJ2Y25RZ1kyeGhjM01nVUc5emRHZHlaWE5FYjNkdWJHOWhaRk52ZFhKalpYTWdld29nSUNBZ1pHRjBZV0poYzJVN0NpQWdJQ0JwYm5OMFlXeHNaV1E3Q2lBZ0lDQjJhV1YzT3dvZ0lDQWdiR2xtWldONVkyeGxJRDBnYm1WM0lGQnNZWFJtYjNKdFUzUnZjbVZNYVdabFkzbGpiR1VvSjBSdmQyNXNiMkZrSUhOdmRYSmpaU0J6ZEc5eVlXZGxKeWs3Q2lBZ0lDQmpiMjV6ZEhKMVkzUnZjaWhrWVhSaFltRnpaU3dnYVc1emRHRnNiR1ZrS1NCN0NpQWdJQ0FnSUNBZ2RHaHBjeTVrWVhSaFltRnpaU0E5SUdSaGRHRmlZWE5sT3dvZ0lDQWdJQ0FnSUhSb2FYTXVhVzV6ZEdGc2JHVmtJRDBnYVc1emRHRnNiR1ZrT3dvZ0lDQWdmUW9nSUNBZ2FXNXBkR2xoYkdsNlpTZ3BJSHNLSUNBZ0lDQWdJQ0J5WlhSMWNtNGdkR2hwY3k1c2FXWmxZM2xqYkdVdWFXNXBkR2xoYkdsNlpTZ29LU0E5UGlCMGFHbHpMbXh2WVdRb0tTazdDaUFnSUNCOUNpQWdJQ0JqYkc5elpTZ3BJSHNLSUNBZ0lDQWdJQ0J5WlhSMWNtNGdkR2hwY3k1c2FXWmxZM2xqYkdVdVkyeHZjMlVvS0NrZ1BUNGdLSFJvYVhNdWRtbGxkeUE5SUhWdVpHVm1hVzVsWkNrcE93b2dJQ0FnZlFvZ0lDQWdaMlYwS0NrZ2V3b2dJQ0FnSUNBZ0lIUm9hWE11YkdsbVpXTjVZMnhsTG1GemMyVnlkRTl3Wlc0b0tUc0tJQ0FnSUNBZ0lDQnBaaUFvSVhSb2FYTXVkbWxsZHlrS0lDQWdJQ0FnSUNBZ0lDQWdkR2h5YjNjZ1JYSnliM0lvSjBSdmQyNXNiMkZrSUhOdmRYSmpaU0J6ZEc5eVlXZGxJR2x6SUc1dmRDQnlaV0ZrZVNjcE93b2dJQ0FnSUNBZ0lISmxkSFZ5YmlCN0lDNHVMbk4wY25WamRIVnlaV1JEYkc5dVpTaDBhR2x6TG5acFpYY3VjMlZzWldOMGFXOXVLU3dnYzJGMlpXUTZJSFJvYVhNdWRtbGxkeTV5WlhacGMybHZiaUErSURBZ2ZUc0tJQ0FnSUgwS0lDQWdJSE5oZG1Vb2FXNXdkWFFwSUhzS0lDQWdJQ0FnSUNCeVpYUjFjbTRnZEdocGN5NXNhV1psWTNsamJHVXVkM0pwZEdVb1lYTjVibU1nS0NrZ1BUNGdld29nSUNBZ0lDQWdJQ0FnSUNCamIyNXpkQ0J6Wld4bFkzUnBiMjRnUFNCa2IzZHViRzloWkZOdmRYSmpaVk5sYkdWamRHbHZiaWhwYm5CMWRDazdDaUFnSUNBZ0lDQWdJQ0FnSUhSb2FYTXVaMlYwS0NrN0lDOHZJR05zYjNObFpDQnZjaUJ1YjNRZ2VXVjBJR2x1YVhScFlXeHBlbVZrSUdseklISmxjRzl5ZEdWa0lHSmxabTl5WlNCaGJua2djWFZsY25rS0lDQWdJQ0FnSUNBZ0lDQWdZMjl1YzNRZ1pYaHdaV04wWldRZ1BTQjBhR2x6TG5acFpYY3VjbVYyYVhOcGIyNDdDaUFnSUNBZ0lDQWdJQ0FnSUdOdmJuTjBJRnR5YjNkZElEMGdZWGRoYVhRZ2RHaHBjeTVrWVhSaFltRnpaUzV4ZFdWeWVTaGdTVTVUUlZKVUlFbE9WRThnWkhOb1gzQm9ZV3hoYm5ndVpHOTNibXh2WVdSZmMyOTFjbU5sY3locFpDeHpaV3hsWTNScGIyNHNjbVYyYVhOcGIyNHBJRlpCVEZWRlV5Z3hMQ1F4TERFcENpQWdJQ0FnSUNBZ0lFOU9JRU5QVGtaTVNVTlVLR2xrS1NCRVR5QlZVRVJCVkVVZ1UwVlVJSE5sYkdWamRHbHZiajFGV0VOTVZVUkZSQzV6Wld4bFkzUnBiMjRzY21WMmFYTnBiMjQ5Wkc5M2JteHZZV1JmYzI5MWNtTmxjeTV5WlhacGMybHZiaXN4SUZkSVJWSkZJR1J2ZDI1c2IyRmtYM052ZFhKalpYTXVjbVYyYVhOcGIyNDlKRElLSUNBZ0lDQWdJQ0FnVWtWVVZWSk9TVTVISUhKbGRtbHphVzl1WUN3Z1cwcFRUMDR1YzNSeWFXNW5hV1o1S0hObGJHVmpkR2x2Ymlrc0lHVjRjR1ZqZEdWa1hTazdDaUFnSUNBZ0lDQWdJQ0FnSUM4dklFNXZJSEp2ZHlCaVlXTnJPaUIwYUdVZ2MzUnZjbVZrSUhKbGRtbHphVzl1SUcxdmRtVmtJSEJoYzNRZ2IzVnljeUFvYVc1amJIVmthVzVuSUdFZ1kyOXVZM1Z5Y21WdWRDQm1hWEp6ZENCellYWmxLUzRLSUNBZ0lDQWdJQ0FnSUNBZ2FXWWdLQ0Z5YjNjcENpQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNCMGFISnZkeUJ1WlhjZ1FuVnphVzVsYzNOU2RXeGxSWEp5YjNJb0oyTnZibVpzYVdOMEp5d2dKMUJzWVhSbWIzSnRJR052Ym1acFozVnlZWFJwYjI0Z1kyaGhibWRsWkM0Z1VtVnNiMkZrSUdKbFptOXlaU0J6WVhacGJtY3VKeXdnSjNCc1lYUm1iM0p0TFdOdmJtWnBaM1Z5WVhScGIyNHRZMjl1Wm14cFkzUW5LVHNLSUNBZ0lDQWdJQ0FnSUNBZ2RHaHBjeTUyYVdWM0lEMGdleUJ6Wld4bFkzUnBiMjRzSUhKbGRtbHphVzl1T2lCT2RXMWlaWElvY205M0xuSmxkbWx6YVc5dUtTQjlPd29nSUNBZ0lDQWdJSDBwT3dvZ0lDQWdmUW9nSUNBZ1lYTjVibU1nYkc5aFpDZ3BJSHNLSUNBZ0lDQWdJQ0IwYUdsekxuWnBaWGNnUFNBb1lYZGhhWFFnY21WaFpGTmhkbVZrUkc5M2JteHZZV1JUYjNWeVkyVnpLSFJvYVhNdVpHRjBZV0poYzJVcEtTQS9QeUI3SUhObGJHVmpkR2x2YmpvZ1pHOTNibXh2WVdSVGIzVnlZMlZUWld4bFkzUnBiMjRvZEdocGN5NXBibk4wWVd4c1pXUXBMQ0J5WlhacGMybHZiam9nTUNCOU93b2dJQ0FnZlFwOUNnPT0iKTsKLyoqIE9wYXF1ZSBmaWxlc3lzdGVtIGZlbmNlOyBjb25uZWN0aW9uIGFuZCBrZXkgaW50ZXJwcmV0YXRpb24gcmVtYWluIHdpdGggdGhlIHNvdXJjZSBvd25lcnMuICovCmZ1bmN0aW9uIGZpbGVJZGVudGl0eShwYXRoKSB7CiAgICBjb25zdCBpbmZvID0gbHN0YXRTeW5jKHBhdGgsIHsgYmlnaW50OiB0cnVlIH0pOwogICAgaWYgKCFpbmZvLmlzRmlsZSgpKQogICAgICAgIHRocm93IEVycm9yKCdFeGVjdXRvciBmYWN0cyByZXF1aXJlIGFuIGluZGVwZW5kZW50IHByb3RlY3RlZCBmaWxlJyk7CiAgICByZXR1cm4geyBwYXRoLCBkZXZpY2U6IFN0cmluZyhpbmZvLmRldiksIGlub2RlOiBTdHJpbmcoaW5mby5pbm8pLCBzaXplOiBTdHJpbmcoaW5mby5zaXplKSwgbW9kaWZpZWQ6IFN0cmluZyhpbmZvLm10aW1lTnMpLCBjaGFuZ2VkOiBTdHJpbmcoaW5mby5jdGltZU5zKSB9Owp9CmNvbnN0IHJvd3MgPSAoc3FsKSA9PiAoewogICAgcXVlcnk6IGFzeW5jICh0ZXh0LCB2YWx1ZXMpID0+IChhd2FpdCBzcWwucXVlcnkodGV4dCwgdmFsdWVzID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiBbLi4udmFsdWVzXSkpLnJvd3MsCn0pOwphc3luYyBmdW5jdGlvbiBjaGVja0ZhY3RzKHNxbCwgc2NoZW1hcykgewogICAgbGV0IHNlbGVjdGlvbiwgdmVyc2lvbnMgPSBudWxsLCBjbGllbnQ7CiAgICB0cnkgewogICAgICAgIGNsaWVudCA9IGF3YWl0IHNxbC5jb25uZWN0KCk7CiAgICAgICAgYXdhaXQgY2xpZW50LnF1ZXJ5KCdCRUdJTiBJU09MQVRJT04gTEVWRUwgUkVQRUFUQUJMRSBSRUFEIFJFQUQgT05MWScpOwogICAgICAgIGF3YWl0IGNsaWVudC5xdWVyeSgnU0VUIExPQ0FMIHN0YXRlbWVudF90aW1lb3V0PTEwMDAwJyk7CiAgICAgICAgYXdhaXQgY2xpZW50LnF1ZXJ5KCdTQVZFUE9JTlQgZG93bmxvYWRfc291cmNlcycpOwogICAgICAgIHRyeSB7CiAgICAgICAgICAgIHNlbGVjdGlvbiA9IGF3YWl0IHJlYWRTYXZlZERvd25sb2FkU291cmNlcyhyb3dzKGNsaWVudCkpOwogICAgICAgIH0KICAgICAgICBjYXRjaCB7CiAgICAgICAgICAgIGF3YWl0IGNsaWVudC5xdWVyeSgnUk9MTEJBQ0sgVE8gU0FWRVBPSU5UIGRvd25sb2FkX3NvdXJjZXMnKTsKICAgICAgICB9CiAgICAgICAgYXdhaXQgY2xpZW50LnF1ZXJ5KCdTQVZFUE9JTlQgc2NoZW1hX3ZlcnNpb25zJyk7CiAgICAgICAgdHJ5IHsKICAgICAgICAgICAgdmVyc2lvbnMgPSBhd2FpdCByZWFkUmVnaXN0ZXJlZFNjaGVtYVZlcnNpb25zKGNsaWVudCwgc2NoZW1hcy5tYXAobmFtZSA9PiAoeyBuYW1lLCBtaWdyYXRpb25zOiBbXSB9KSkpOwogICAgICAgIH0KICAgICAgICBjYXRjaCB7CiAgICAgICAgICAgIGF3YWl0IGNsaWVudC5xdWVyeSgnUk9MTEJBQ0sgVE8gU0FWRVBPSU5UIHNjaGVtYV92ZXJzaW9ucycpOwogICAgICAgIH0KICAgICAgICBhd2FpdCBjbGllbnQucXVlcnkoJ0NPTU1JVCcpOwogICAgfQogICAgY2F0Y2ggewogICAgICAgIHZlcnNpb25zID0gbnVsbDsKICAgICAgICB0cnkgewogICAgICAgICAgICBhd2FpdCBjbGllbnQ/LnF1ZXJ5KCdST0xMQkFDSycpOwogICAgICAgIH0KICAgICAgICBjYXRjaCB7CiAgICAgICAgICAgIC8qIFRoZSBjb25uZWN0aW9uIG1heSBhbHJlYWR5IGhhdmUgY2xvc2VkLiAqLwogICAgICAgIH0KICAgIH0KICAgIGZpbmFsbHkgewogICAgICAgIGNsaWVudD8ucmVsZWFzZSgpOwogICAgfQogICAgcmV0dXJuIHsgc2VsZWN0aW9uOiBzZWxlY3Rpb24/LnNlbGVjdGlvbiA/PyBudWxsLCBzY2hlbWFzOiB2ZXJzaW9ucyB9Owp9Ci8qKiBSZWFkIHNlbGVjdGVkIHNvdXJjZSBmYWN0cyB3aXRob3V0IHByZXBhcmluZyBzdG9yZXMsIG1pZ3JhdGlvbnMgb3IgYSBwbGF0Zm9ybSBydW50aW1lLiAqLwpleHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVhZEV4ZWN1dG9yRmFjdHMoY29uZmlnRmlsZSwgZGF0YVJvb3QsIGZhY3QsIHNjaGVtYXMpIHsKICAgIGNvbnN0IGJlZm9yZSA9IGZpbGVJZGVudGl0eShjb25maWdGaWxlKSwgc2VsZWN0ZWQgPSBGaWxlUGxhdGZvcm1EYXRhYmFzZUNvbmZpZy5vcGVuKGNvbmZpZ0ZpbGUsIGRhdGFSb290KSwga2V5ID0gZmlsZUlkZW50aXR5KHNlbGVjdGVkLnNlY3VyaXR5Lm1hc3RlcktleVBhdGgpLCB2ZXJpZmllZEtleSA9IEZpbGVQbGF0Zm9ybVNlY3JldHMub3BlbihzZWxlY3RlZC5zZWN1cml0eS5tYXN0ZXJLZXlQYXRoLCBzZWxlY3RlZC5zZWN1cml0eS5yZWdpc3RyeSk7CiAgICB2ZXJpZmllZEtleS5jbG9zZSgpOwogICAgY29uc3Qgc3FsID0gcGxhdGZvcm1EYXRhYmFzZVBvb2woc2VsZWN0ZWQuY29ubmVjdGlvbik7CiAgICB0cnkgewogICAgICAgIGlmIChmYWN0ID09PSAnY2hlY2snKSB7CiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNoZWNrRmFjdHMoc3FsLCBzY2hlbWFzKTsKICAgICAgICAgICAgaWYgKEpTT04uc3RyaW5naWZ5KGJlZm9yZSkgIT09IEpTT04uc3RyaW5naWZ5KGZpbGVJZGVudGl0eShjb25maWdGaWxlKSkgfHwgSlNPTi5zdHJpbmdpZnkoa2V5KSAhPT0gSlNPTi5zdHJpbmdpZnkoZmlsZUlkZW50aXR5KGtleS5wYXRoKSkpCiAgICAgICAgICAgICAgICB0aHJvdyBFcnJvcignVGhlIHNlbGVjdGVkIGNvbm5lY3Rpb24gb3Iga2V5IGNoYW5nZWQgZHVyaW5nIHRoZSByZXF1ZXN0Jyk7CiAgICAgICAgICAgIHJldHVybiB7IC4uLnJlc3VsdCwgaWRlbnRpdHk6IFtiZWZvcmUsIGtleV0gfTsKICAgICAgICB9CiAgICAgICAgYXdhaXQgc3FsLnF1ZXJ5KCdTRVQgc3RhdGVtZW50X3RpbWVvdXQ9MTAwMDAnKTsKICAgICAgICBpZiAoZmFjdCA9PT0gJ3NjaGVtYXMnKQogICAgICAgICAgICByZXR1cm4gewogICAgICAgICAgICAgICAgc2NoZW1hczogYXdhaXQgcmVhZFJlZ2lzdGVyZWRTY2hlbWFWZXJzaW9ucyhzcWwsIHNjaGVtYXMubWFwKG5hbWUgPT4gKHsgbmFtZSwgbWlncmF0aW9uczogW10gfSkpKSwKICAgICAgICAgICAgfTsKICAgICAgICBjb25zdCByb3cgPSBhd2FpdCByZWFkU2F2ZWREb3dubG9hZFNvdXJjZXMocm93cyhzcWwpKTsKICAgICAgICByZXR1cm4geyBzZWxlY3Rpb246IHJvdz8uc2VsZWN0aW9uID8/IG51bGwgfTsKICAgIH0KICAgIGZpbmFsbHkgewogICAgICAgIGF3YWl0IHNxbC5lbmQoKTsKICAgIH0KfQo=\");\n  const result = await readExecutorFacts(request.configFile, request.dataRoot, request.fact, request.schemas);\n  console.log(JSON.stringify(result));\n} catch {\n  console.error('Platform database facts are unavailable; inspect the selected connection and master-key file');\n  process.exitCode = 2;\n}\n"
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
