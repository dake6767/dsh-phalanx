#!/bin/bash
set -euo pipefail

fail() { printf '%s\n' "$*" >&2; exit 1; }
command -v limactl >/dev/null 2>&1 || fail 'Lima is required: brew install lima'

action=${1:-up}
if [ "$#" -gt 0 ]; then shift; fi
case "$action" in up|down|destroy|logs|shell|test) ;; *) fail 'Usage: bash scripts/dev/vm.sh {up|down|destroy|logs|shell|test} [--source mainland|official]' ;; esac
source_preset=mainland
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) [ "$#" -ge 2 ] || fail '--source requires mainland or official'; source_preset=$2; shift 2 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
case "$source_preset" in mainland|official) ;; *) fail '--source requires mainland or official' ;; esac
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || fail 'The development VM requires an Apple Silicon Mac.'
vm_home=${DSH_PHALANX_VM_HOME:-"$HOME/.lima-dsh-phalanx"}
case "$vm_home" in /*) ;; *) fail 'DSH_PHALANX_VM_HOME must be an absolute directory.' ;; esac
[ "$vm_home" != / ] && [ "$vm_home" != "$HOME" ] || fail 'Choose a dedicated Lima directory.'
[ ! -L "$vm_home" ] || fail 'Choose a real dedicated Lima directory, not a symbolic link.'
source_root=$(cd "${BASH_SOURCE[0]%/*}/../.." && pwd -P)
owner="$vm_home/.dsh-phalanx-checkout"
if [ -d "$vm_home" ]; then
  [ -f "$owner" ] && [ ! -L "$owner" ] && [ "$(cat "$owner")" = "$source_root" ] || fail 'The Lima home is not owned by this checkout; choose a fresh DSH_PHALANX_VM_HOME.'
fi

if [ "$action" = up ]; then
  memory=$(sysctl -n hw.memsize)
  [ "$memory" -ge 17179869184 ] || fail 'Use at least 16 GiB of host memory for the 6 GiB development VM.'
  volume=$vm_home
  while [ ! -d "$volume" ]; do volume=${volume%/*}; done
  available=$(df -Pk "$volume" | awk 'NR==2 {print $4}')
  if [ -d "$vm_home/development" ]; then
    [ "$available" -ge 12582912 ] || fail 'Reserve 12 GiB of free disk before rebuilding the development VM; remove disposable caches or use a larger disk.'
  else
    [ "$available" -ge 41943040 ] || fail 'Reserve 40 GiB of free disk before building the development VM; remove disposable caches or use a larger disk.'
  fi
fi

umask 077
if [ ! -d "$vm_home" ]; then
  [ "$action" = up ] || fail 'No development VM exists; run up first.'
  mkdir -p "$vm_home"
  printf '%s\n' "$source_root" > "$owner"
fi
export LIMA_HOME="$vm_home"
if [ "$action" != logs ] && [ "$action" != shell ]; then
  mkdir "$vm_home/.operation-lock" 2>/dev/null || fail 'Another VM operation owns .operation-lock; wait for it to finish. Remove a stale lock only after checking that no VM command is running.'
  trap 'rmdir "$vm_home/.operation-lock"' EXIT
fi
state=$(limactl list --format '{{.Name}} {{.Status}}' | awk '$1=="development" {print $2}')
case "$action" in
  up)
    # A stopped or new VM cannot already own the forwarded listener.
    if [ "$state" != Running ]; then
      python3 - <<'PYPORT' || fail 'Port 18080 is already in use; stop its owner before starting the development VM.'
import socket
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 18080))
PYPORT
    fi
    vm_started=$SECONDS
    if [ -z "$state" ]; then
      # YAML single-quoted scalars escape a quote by doubling it.
      quoted_source=$(printf '%s' "$source_root" | sed "s/'/''/g")
      image_prefix=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["bootstrap"][sys.argv[2]]["ubuntuPrefix"])' "$source_root/src/domain/download-source-presets.json" "$source_preset")
      image_url="${image_prefix}releases/noble/release-20260926/ubuntu-24.04-server-cloudimg-arm64.img"
      cached_image="$HOME/Library/Caches/dsh-phalanx/sha256/1d6bffe64b848468ac97f821d369a4846d983de1800ccf6b5ec8853e85cefc55/ubuntu-24.04-arm64.img"
      if [ -f "$cached_image" ]; then image_url=$cached_image; fi
      quoted_image=$(printf '%s' "$image_url" | sed "s/'/''/g")
      case "$quoted_source" in *$'\n'*|*$'\r'*) fail 'The checkout path must not contain a newline.' ;; esac
      cat > "$vm_home/development.yaml" <<YAML
minimumLimaVersion: 2.2.1
vmType: vz
arch: aarch64
cpus: 4
memory: 6GiB
disk: 40GiB
images:
  - location: '$quoted_image'
    arch: aarch64
    digest: sha256:1d6bffe64b848468ac97f821d369a4846d983de1800ccf6b5ec8853e85cefc55
mountType: virtiofs
mounts:
  - location: '$quoted_source'
    mountPoint: /mnt/dsh-phalanx
    writable: false
containerd:
  system: false
  user: false
ssh:
  loadDotSSHPubKeys: false
  forwardAgent: false
  overVsock: false
propagateProxyEnv: false
env:
  HTTP_PROXY: ''
  HTTPS_PROXY: ''
  ALL_PROXY: ''
  http_proxy: ''
  https_proxy: ''
  all_proxy: ''
provision:
  - mode: system
    script: |
      #!/bin/sh
      set -eu
      printf '%s\n' 'dsh-phalanx-development-v1' > /etc/dsh-phalanx-development-vm
      chmod 600 /etc/dsh-phalanx-development-vm
portForwards:
  - guestPort: 8080
    hostIP: 127.0.0.1
    hostPort: 18080
  - guestIP: 0.0.0.0
    guestPortRange: [1, 65535]
    proto: any
    ignore: true
YAML
      limactl create --tty=false --name=development "$vm_home/development.yaml"
    fi
    if [ "$state" != Running ]; then limactl start --tty=false development; fi
    printf 'VM startup: %s seconds\n' "$((SECONDS-vm_started))"
    limactl shell --workdir=/mnt/dsh-phalanx development sudo python3 /mnt/dsh-phalanx/scripts/dev/guest.py up --source "$source_preset"
    printf '%s\n' 'Development product: http://127.0.0.1:18080/'
    ;;
  down) if [ "$state" = Running ]; then limactl stop --tty=false development; fi ;;
  destroy)
    if [ "$state" = Running ]; then limactl stop --tty=false development; fi
    if [ -n "$state" ]; then limactl delete --tty=false development; fi
    ;;
  logs|shell|test)
    [ "$state" = Running ] || fail 'The development VM is not running; run up first.'
    if [ "$action" = shell ]; then limactl shell --workdir=/mnt/dsh-phalanx development
    else limactl shell --workdir=/mnt/dsh-phalanx development sudo python3 /mnt/dsh-phalanx/scripts/dev/guest.py "$action"; fi
    ;;
esac
