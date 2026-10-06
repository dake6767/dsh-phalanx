#!/bin/bash
# Standalone bootstrap template; build-installer.mjs appends the Python owner.
set -euo pipefail
umask 077
output=human
previous=''
for option in "$@"; do
  if [[ "$previous" == --output ]]; then output="$option"; fi
  if [[ "$option" == --output=json ]]; then output=json; fi
  previous="$option"
done
for option in "$@"; do
  if [[ "$option" == --help || "$option" == -h ]]; then
    if [[ "$output" == json ]]; then
      printf '{"status":"help","usage":"sudo bash install.sh [--version TAG] [--output human|json] [--verbose]","requiredWithoutTerminal":["--public-origin URL","--host-public-addresses COMPLETE_LIST"],"advanced":["--gateway-port PORT","--user-data-root PATH","--user-data-mount PATH"]}\n'
      exit 0
    fi
    cat <<'HELP'
Install dsh-phalanx on Ubuntu 24.04 LTS amd64:
  sudo bash install.sh [--version latest|v0.1.0|v0.1.1|v0.1.1-rc.N]
                      [--bundle-dir verified-private-candidate-directory]
                      [--model-key-file protected-file] [--model-base-url URL]
                      [--host-public-addresses complete-public-IPv4-list]
                      [--listen-address ADDRESS] [--port PORT] [--gateway-port PORT]
                      [--public-origin URL] [--output human|json] [--verbose]
First installation prompts for deployment facts when a terminal is available.
Reinstallation preserves protected configuration and all user data.
HELP
    exit 0
  fi
done
fail() {
  echo "Installation failed: $1" >&2
  diagnostic_json=null
  if [[ -n "${bootstrap_log:-}" ]]; then diagnostic_json="\"$bootstrap_log\""; fi
  if [[ "$output" == json ]]; then printf '{"status":"failed","phase":"Bootstrap","reason":"%s","diagnosticLog":%s}\n' "$1" "${diagnostic_json:-null}"; fi
  exit 1
}
if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  fail 'Installation supports only Ubuntu 24.04 LTS amd64'
fi
if [[ "$EUID" != 0 ]]; then
  fail 'Run the installer with sudo'
fi
source /etc/os-release
if [[ "$ID" != ubuntu || "$VERSION_ID" != 24.04 ]]; then
  fail 'Installation supports only Ubuntu 24.04 LTS amd64'
fi
if ! command -v python3 >/dev/null || [[ ! -f /etc/ssl/certs/ca-certificates.crt ]]; then
  for path in /var /var/log /var/log/dsh-phalanx; do
    [[ ! -L "$path" ]] || fail 'Diagnostic paths must not be symbolic links'
  done
  mkdir -p /var/log/dsh-phalanx && chmod 700 /var/log/dsh-phalanx || fail 'Cannot create private diagnostics; check disk space'
  bootstrap_log="/var/log/dsh-phalanx/$(date -u +%Y%m%dT%H%M%S)-$$-bootstrap.jsonl"
  (set -o noclobber; : > "$bootstrap_log") || fail 'Cannot create private bootstrap diagnostics'
  bootstrap_event() {
    printf '[Python prerequisites] %s · %ss: %s\n' "$1" "$SECONDS" "$2" >&2
    printf '{"phase":"Python prerequisites","status":"%s","elapsed":%s,"message":"%s"}\n' "$1" "$SECONDS" "$2" >> "$bootstrap_log"
  }
  bootstrap_pid=''
  cleanup_bootstrap() {
    if [[ -n "$bootstrap_pid" ]]; then kill -TERM "$bootstrap_pid" 2>/dev/null || true; wait "$bootstrap_pid" 2>/dev/null || true; fi
  }
  trap cleanup_bootstrap EXIT
  trap 'bootstrap_event failed "Interrupted"; fail "Prerequisite preparation interrupted"' INT TERM
  bootstrap_run() {
    bootstrap_event running 'Preparing Python and certificate prerequisites; raw output withheld until safe diagnostics are available'
    "$@" >/dev/null 2>&1 & bootstrap_pid=$!
    while kill -0 "$bootstrap_pid" 2>/dev/null; do
      bootstrap_event running 'Waiting for prerequisite package manager; check its lock if this continues'
      sleep 3
    done
    if wait "$bootstrap_pid"; then bootstrap_pid=''; bootstrap_event completed 'Prerequisite package command completed';
    else
      status=$?; bootstrap_pid=''; bootstrap_event failed "Package command exited $status"
      echo "Diagnostic log: $bootstrap_log" >&2
      echo 'Inspect prerequisites with sudo apt-get update, then retry sudo bash install.sh.' >&2
      fail 'Unable to prepare Python prerequisites; see the package exit status'
    fi
  }
  bootstrap_run apt-get -o DPkg::Lock::Timeout=600 update
  bootstrap_run env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends python3 ca-certificates
  trap - EXIT INT TERM
fi
python3 - "$@" <<'DSH_PHALANX_INSTALLER_PYTHON'
