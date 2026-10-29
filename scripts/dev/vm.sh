#!/bin/bash
set -euo pipefail

fail() { printf '%s\n' "$*" >&2; exit 1; }
command -v limactl >/dev/null 2>&1 || fail 'Lima is required: brew install lima'

action=${1:-up}
if [ "$#" -gt 0 ]; then shift; fi
case "$action" in up|start|down|destroy|logs|shell|test) ;; *) fail 'Usage: bash scripts/dev/vm.sh {up|start|down|destroy|logs|shell|test} [--source mainland|official] [--resident <version>]' ;; esac
source_preset=mainland
resident_version=
test_files=
retry_run=
quota_reset_at=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --files) [ "$#" -ge 2 ] || fail "--files requires files"; test_files=$2; shift 2 ;;
    --quota-reset-at) [ "$#" -ge 2 ] || fail "--quota-reset-at requires ISO8601"; quota_reset_at=$2; shift 2 ;;
    --retry) [ "$#" -ge 2 ] || fail "--retry requires run ID"; retry_run=$2; shift 2 ;;
    --resident) [ "$#" -ge 2 ] || fail "--resident requires a version"; resident_version=$2; shift 2 ;;
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
version=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$source_root/package.json")
[ -n "$resident_version" ] || resident_version=$version
[ "$resident_version" = "$version" ] || fail 'The resident version must match package.json.'
owner="$vm_home/.dsh-phalanx-checkout"
version_owner="$vm_home/.dsh-phalanx-version"
if [ -d "$vm_home" ]; then
  [ -f "$owner" ] && [ ! -L "$owner" ] && [ "$(cat "$owner")" = "$source_root" ] || fail 'The Lima home is not owned by this checkout; choose a fresh DSH_PHALANX_VM_HOME.'
  [ -f "$version_owner" ] && [ ! -L "$version_owner" ] && [ "$(cat "$version_owner")" = "$resident_version" ] || fail 'The Lima home belongs to another version; use its version checkout to manage it.'
fi

if [ "$action" = up ] || [ "$action" = start ] || [ "$action" = test ]; then
  memory=$(sysctl -n hw.memsize)
  [ "$memory" -ge 17179869184 ] || fail 'Use at least 16 GiB of host memory for the 6 GiB development VM.'
  volume=$vm_home
  while [ ! -d "$volume" ]; do volume=${volume%/*}; done
  available=$(df -Pk "$volume" | awk 'NR==2 {print $4}')
  if [ -d "$vm_home/development" ]; then
    [ "$available" -ge 12582912 ] || fail 'Reserve 12 GiB of free disk before rebuilding the development VM; remove disposable caches or use a larger disk.'
  else
    [ "$available" -ge 31457280 ] || fail 'Reserve 30 GiB of free disk before building the development VM; remove disposable caches or use a larger disk.'
  fi
fi

umask 077
if [ ! -d "$vm_home" ]; then
  [ "$action" = up ] || fail 'No development VM exists; run up first.'
  mkdir -p "$vm_home"
  printf '%s\n' "$source_root" > "$owner"
  printf '%s\n' "$resident_version" > "$version_owner"
fi
export LIMA_HOME="$vm_home"
if [ "$action" != logs ] && [ "$action" != shell ]; then
  python3 "$source_root/scripts/dev/operation-lock.py" acquire "$vm_home/.operation-lock" "$$"
  trap 'python3 "$source_root/scripts/dev/operation-lock.py" release "$vm_home/.operation-lock" "$$"' EXIT
fi
cache_root=${DSH_PHALANX_IMAGE_CACHE:-"$HOME/Library/Caches/dsh-phalanx/development-images"}
case "$cache_root" in /*) ;; *) fail 'Image cache must be an absolute directory.' ;; esac
if [ "$action" = up ] || [ "$action" = start ] || [ "$action" = test ]; then
  cache_owner="$vm_home/.dsh-phalanx-image-cache"
  if [ -f "$vm_home/development/lima.yaml" ]; then
    [ -f "$cache_owner" ] && [ ! -L "$cache_owner" ] && [ "$(cat "$cache_owner")" = "$cache_root" ] || fail 'The resident VM uses a different image cache; restore its cache path.'
  fi
  python3 "$source_root/scripts/dev/image-cache.py" init "$cache_root"
  printf '%s\n' "$cache_root" > "$cache_owner"
  python3 "$source_root/scripts/dev/operation-lock.py" acquire "$cache_root/.operation-lock" "$$"
  trap 'python3 "$source_root/scripts/dev/operation-lock.py" release "$cache_root/.operation-lock" "$$"; python3 "$source_root/scripts/dev/operation-lock.py" release "$vm_home/.operation-lock" "$$"' EXIT
fi
if [ -n "${DSH_PHALANX_VM_READY_FILE:-}" ]; then
  printf '%s\n' "$$" > "$DSH_PHALANX_VM_READY_FILE"
fi
ensure_clock() {
  local clock_state
  clock_state=$(limactl shell --workdir=/mnt/dsh-phalanx development sudo python3 /mnt/dsh-phalanx/scripts/dev/guest.py clock)
  case "$clock_state" in
    ready) ;;
    restart-required)
      limactl stop --tty=false development
      limactl start --tty=false development
      clock_state=$(limactl shell --workdir=/mnt/dsh-phalanx development sudo python3 /mnt/dsh-phalanx/scripts/dev/guest.py clock)
      [ "$clock_state" = ready ] || fail 'The development clock configuration still requires a restart; inspect the guest time services before retrying.'
      ;;
    *) fail 'The development guest returned an invalid clock configuration state.' ;;
  esac
}

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
      quoted_cache=$(printf '%s' "$cache_root" | sed "s/'/''/g")
      quoted_image=$(printf '%s' "$image_url" | sed "s/'/''/g")
      case "$quoted_source$quoted_cache" in *$'\n'*|*$'\r'*) fail 'The checkout path must not contain a newline.' ;; esac
      cat > "$vm_home/development.yaml" <<YAML
minimumLimaVersion: 2.2.1
vmType: vz
arch: aarch64
cpus: 4
memory: 6GiB
disk: 30GiB
images:
  - location: '$quoted_image'
    arch: aarch64
    digest: sha256:1d6bffe64b848468ac97f821d369a4846d983de1800ccf6b5ec8853e85cefc55
mountType: virtiofs
mounts:
  - location: '$quoted_source'
    mountPoint: /mnt/dsh-phalanx
    writable: false
  - location: '$quoted_cache'
    mountPoint: /mnt/dsh-image-cache
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
      mkdir -p /etc/systemd/journald.conf.d
      printf '[Journal]\nSystemMaxUse=200M\n' > /etc/systemd/journald.conf.d/dsh-phalanx-development.conf
      systemctl restart systemd-journald
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
    ensure_clock
    printf 'VM startup: %s seconds\n' "$((SECONDS-vm_started))"
    limactl shell --workdir=/mnt/dsh-phalanx development sudo python3 /mnt/dsh-phalanx/scripts/dev/guest.py up --source "$source_preset"
    python3 "$source_root/scripts/dev/image-cache.py" collect "$cache_root" --version "$resident_version"
    printf '%s\n' 'Development product: http://127.0.0.1:18080/'
    ;;
  start)
    [ -n "$state" ] || fail 'No development VM exists; run up first.'
    if [ "$state" != Running ]; then
      python3 - <<'PYPORT' || fail 'Port 18080 is already in use; stop its owner before starting the development VM.'
import socket
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 18080))
PYPORT
      limactl start --tty=false development
    fi
    ensure_clock
    ;;
  down) if [ "$state" = Running ]; then limactl stop --tty=false development; fi ;;
  destroy)
    if [ "$state" = Running ]; then limactl stop --tty=false development; fi
    if [ -n "$state" ]; then limactl delete --tty=false development; fi
    ;;
  logs|shell|test)
    [ "$state" = Running ] || fail 'The development VM is not running; run up first.'
    if [ "$action" = test ]; then ensure_clock; fi
    if [ "$action" = shell ]; then limactl shell --workdir=/mnt/dsh-phalanx development
    else
      test_args=()
      if [ -n "$test_files" ]; then test_args+=(--files "$test_files"); fi
      if [ -n "$retry_run" ]; then test_args+=(--retry "$retry_run"); fi
      if [ -n "$quota_reset_at" ]; then test_args+=(--quota-reset-at "$quota_reset_at"); fi
      limactl shell --workdir=/mnt/dsh-phalanx development sudo python3 /mnt/dsh-phalanx/scripts/dev/guest.py "$action" ${test_args[@]+"${test_args[@]}"}
      if [ "$action" = test ]; then python3 "$source_root/scripts/dev/image-cache.py" collect "$cache_root" --version "$resident_version"; fi
    fi
    ;;
esac
