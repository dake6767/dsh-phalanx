#!/bin/bash
# Standalone bootstrap template; build-installer.mjs appends the Python owner.
set -euo pipefail
umask 077
for option in "$@"; do
  if [[ "$option" == --help || "$option" == -h ]]; then
    cat <<'HELP'
Install dsh-phalanx on Ubuntu 24.04 LTS amd64:
  sudo bash install.sh [--version latest|v0.1.0|v0.1.0-rc.N]
                      [--bundle-dir verified-private-candidate-directory]
                      [--model-key-file protected-file] [--model-base-url URL]
                      [--host-public-addresses complete-public-IPv4-list]
                      [--listen-address ADDRESS] [--port PORT] [--gateway-port PORT]
                      [--public-origin URL]
First installation prompts for deployment facts when a terminal is available.
Reinstallation preserves protected configuration and all user data.
HELP
    exit 0
  fi
done
if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo 'Installation supports only Ubuntu 24.04 LTS amd64' >&2
  exit 1
fi
if [[ "$EUID" != 0 ]]; then
  echo 'Run the installer with sudo' >&2
  exit 1
fi
source /etc/os-release
if [[ "$ID" != ubuntu || "$VERSION_ID" != 24.04 ]]; then
  echo 'Installation supports only Ubuntu 24.04 LTS amd64' >&2
  exit 1
fi
if ! command -v python3 >/dev/null || [[ ! -f /etc/ssl/certs/ca-certificates.crt ]]; then
  apt-get -o DPkg::Lock::Timeout=600 update
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends python3 ca-certificates
fi
python3 - "$@" <<'DSH_PHALANX_INSTALLER_PYTHON'
