#!/bin/bash
# Standalone bootstrap template; build-installer.mjs appends the Python owner.
set -euo pipefail
umask 077
output=human
development_arm64=false
language=zh-CN
language_selected=false
interactive=true
help_requested=false
previous=''
for option in "$@"; do
  if [[ "$previous" == --output ]]; then output="$option"; fi
  if [[ "$option" == --output=json ]]; then output=json; fi
  if [[ "$option" == --dev-arm64 ]]; then development_arm64=true; fi
  if [[ "$previous" == --language ]]; then language="$option"; language_selected=true; fi
  if [[ "$option" == --language=* ]]; then language="${option#*=}"; language_selected=true; fi
  if [[ "$option" == --non-interactive ]]; then interactive=false; fi
  if [[ "$option" == --help || "$option" == -h ]]; then help_requested=true; fi
  previous="$option"
done
text() { if [[ "$language" == zh-CN ]]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
if [[ "$help_requested" == true ]]; then
  if [[ "$output" == json ]]; then
    printf '{"status":"help","usage":"sudo bash install.sh [--language zh-CN|en] [--non-interactive] [--version TAG] [--output human|json]","uninstall":"sudo bash install.sh --uninstall [--purge] [--yes]","requiredWithoutTerminal":["--public-origin URL","--host-public-addresses COMPLETE_LIST"],"advanced":["--gateway-port PORT","--user-data-root PATH","--user-data-mount PATH"],"downloadSources":["--download-source-preset official|mainland","--npm-registry URL","--pypi-index URL","--container-mirror URL","--ghcr-mirror URL","--github-proxy-prefix URL","--github-api-proxy-prefix URL","--browser-download-host URL","--chromium-arm64-download-host URL"]}\n'
  else
    text 'dsh-phalanx：面向小团队的多用户自托管 AI 平台，每位成员拥有独立用户空间。' 'dsh-phalanx: a multi-user self-hosted AI platform for small teams, with an independent space for each member.'
    printf '\nhttps://github.com/dake6767/dsh-phalanx\n\n'
    text '安装到 Debian 系 Linux amd64：' 'Install on Debian-family Linux amd64:'
    cat <<'HELP'

  sudo bash install.sh [--language zh-CN|en] [--non-interactive]
    [--version latest|vMAJOR.MINOR.PATCH|vMAJOR.MINOR.PATCH-rc.N|run-ID]
    [--bundle-dir verified-candidate-directory]
    [--dev-release-base-url unsupported-candidate-release-URL]
    [--server-ip IP] [--public-origin URL]
    [--host-public-addresses complete-public-IPv4-list]
    [--listen-address ADDRESS] [--port PORT] [--gateway-port PORT]
    [--user-data-root PATH] [--user-data-mount PATH]
    [--download-source-preset official|mainland]
    [--npm-registry URL] [--pypi-index URL] [--container-mirror URL]
    [--ghcr-mirror URL] [--github-proxy-prefix URL] [--github-api-proxy-prefix URL]
    [--browser-download-host URL] [--chromium-arm64-download-host URL]
    [--upgrade check|prepare|apply|status|recover|bootstrap|cleanup]
    [--operation UUID] [--yes] [--output human|json] [--verbose]
HELP
    text '有终端时进入问答；方括号内为默认值，回车采用。非交互需提供访问地址与映射声明。重新安装保留受保护配置和用户数据。升级apply会立即中断任务，--yes用于明确接受升级中断。' 'With a terminal, follow the questions; press Enter to accept bracketed defaults. Noninteractive use requires an access URL and mapping declaration. Reinstallation retains protected configuration and user data. Upgrade apply interrupts tasks; --yes explicitly accepts that interruption.'
    printf '\n\n  sudo bash install.sh --uninstall [--purge] [--yes] [--output human|json]\n'
    text '默认卸载保留恢复数据。--purge 清理核验归属的本地数据。' 'Default uninstall retains recovery data. --purge removes verified local deployment data.'
    printf '\n'
  fi
  exit 0
fi
if [[ "$language_selected" == false && "$interactive" == true && -r /dev/tty && -w /dev/tty ]]; then
  if { : </dev/tty; } 2>/dev/null; then
    printf '方括号 [] 内是默认值，回车采用；输入 cancel 取消。\nValues in [] are defaults; press Enter to accept, or type cancel.\n' >/dev/tty
    while true; do
      printf '\n语言 / Language\n  zh-CN 简体中文 / en English\n  > [zh-CN]: ' >/dev/tty
      IFS= read -r chosen_language </dev/tty || exit 1
      case "$chosen_language" in
        ''|zh-CN) language=zh-CN; break ;;
        en) language=en; break ;;
        cancel) printf '已取消 / Cancelled\n' >/dev/tty; exit 0 ;;
        *) printf '请选择 zh-CN 或 en / Choose zh-CN or en\n' >/dev/tty ;;
      esac
    done
  fi
fi
if [[ "$language" != zh-CN && "$language" != en ]]; then
  printf '无效的语言 / Invalid language: use zh-CN or en\n' >&2
  if [[ "$output" == json ]]; then printf '{"status":"failed","phase":"Bootstrap","reason":"Invalid language","diagnosticLog":null}\n'; fi
  exit 1
fi
if [[ "$language_selected" == false ]]; then set -- "$@" --language "$language"; fi
fail() {
  printf '%s: %s\n' "$(text '安装失败' 'Installation failed')" "$1" >&2
  diagnostic_json=null
  if [[ -n "${bootstrap_log:-}" ]]; then diagnostic_json="\"$bootstrap_log\""; fi
  if [[ "$output" == json ]]; then printf '{"status":"failed","phase":"Bootstrap","reason":"%s","diagnosticLog":%s}\n' "$1" "${diagnostic_json:-null}"; fi
  exit 1
}
if [[ "$(uname -s)" != Linux ]] || { [[ "$(uname -m)" != x86_64 ]] && { [[ "$development_arm64" != true ]] || [[ "$(uname -m)" != aarch64 ]]; }; }; then
  fail "$(text '安装需要 Linux amd64 主机' 'Installation requires Linux amd64')"
fi
ID=''; ID_LIKE=''
if [[ -r /etc/os-release ]]; then source /etc/os-release; fi
case " $ID $ID_LIKE " in
  *" debian "*|*" ubuntu "*) ;;
  *) fail "$(text '仅支持 Debian 系 Linux（Ubuntu、Debian 及衍生发行版）' 'Installation supports only Debian-family Linux hosts (Ubuntu, Debian and derivatives)')" ;;
esac
command -v apt-get >/dev/null || fail "$(text 'Debian 系安装需要 apt-get' 'Debian-family installation requires apt-get')"
if [[ "$EUID" != 0 ]]; then
  fail "$(text '请使用 sudo 运行安装器' 'Run the installer with sudo')"
fi
if ! command -v python3 >/dev/null || [[ ! -f /etc/ssl/certs/ca-certificates.crt ]]; then
  for path in /var /var/log /var/log/dsh-phalanx; do
    [[ ! -L "$path" ]] || fail "$(text '诊断路径不能是符号链接' 'Diagnostic paths must not be symbolic links')"
  done
  mkdir -p /var/log/dsh-phalanx && chmod 700 /var/log/dsh-phalanx || fail "$(text '无法创建私有诊断，请检查磁盘空间' 'Cannot create private diagnostics; check disk space')"
  bootstrap_log="/var/log/dsh-phalanx/$(date -u +%Y%m%dT%H%M%S)-$$-bootstrap.jsonl"
  (set -o noclobber; : > "$bootstrap_log") || fail "$(text '无法创建私有前置准备诊断' 'Cannot create private bootstrap diagnostics')"
  bootstrap_event() {
    printf '[%s] %s · %ss: %s\n' "$(text 'Python 前置依赖' 'Python prerequisites')" "$1" "$SECONDS" "$2" >&2
    printf '{"phase":"Python prerequisites","status":"%s","elapsed":%s,"message":"%s"}\n' "$1" "$SECONDS" "$2" >> "$bootstrap_log"
  }
  bootstrap_pid=''
  cleanup_bootstrap() {
    if [[ -n "$bootstrap_pid" ]]; then kill -TERM "$bootstrap_pid" 2>/dev/null || true; wait "$bootstrap_pid" 2>/dev/null || true; fi
  }
  trap cleanup_bootstrap EXIT
  interrupted_bootstrap() {
    bootstrap_event failed "$(text '已中断' 'Interrupted')"
    fail "$(text '前置依赖准备被中断；可能已安装部分系统依赖' 'Prerequisite preparation interrupted; some OS packages may already be installed')"
  }
  trap interrupted_bootstrap INT TERM
  bootstrap_run() {
    bootstrap_event running "$(text '准备 Python 和证书依赖；原始输出不直接展示，以保护诊断内容' 'Preparing Python and certificate prerequisites; raw output withheld until safe diagnostics are available')"
    "$@" >/dev/null 2>&1 & bootstrap_pid=$!
    while kill -0 "$bootstrap_pid" 2>/dev/null; do
      bootstrap_event running "$(text '等待依赖软件包管理器，如持续等待请检查其锁' 'Waiting for prerequisite package manager; check its lock if this continues')"
      sleep 3
    done
    if wait "$bootstrap_pid"; then bootstrap_pid=''; bootstrap_event completed "$(text '依赖软件包命令已完成' 'Prerequisite package command completed')";
    else
      status=$?; bootstrap_pid=''; bootstrap_event failed "$(text "软件包命令退出码 $status" "Package command exited $status")"
      printf '%s: %s\n' "$(text '诊断日志' 'Diagnostic log')" "$bootstrap_log" >&2
      text '请使用 sudo apt-get update 检查依赖，再重试 sudo bash install.sh。' 'Inspect prerequisites with sudo apt-get update, then retry sudo bash install.sh.' >&2; printf '\n' >&2
      fail "$(text 'Python 依赖准备失败，请查看软件包退出状态' 'Unable to prepare Python prerequisites; see the package exit status')"
    fi
  }
  bootstrap_run apt-get -o DPkg::Lock::Timeout=600 update
  bootstrap_run env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends python3 ca-certificates
  trap - EXIT INT TERM
fi
python3 - "$@" <<'DSH_PHALANX_INSTALLER_PYTHON'
