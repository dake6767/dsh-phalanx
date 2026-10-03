#!/usr/bin/env bash
# Container sandbox spike: run inside a rootless container with the pinned,
# built DSH checkout reachable at $DSH_CLI. Proves the official
# workspace-write sandbox (bwrap) works in-container: a real headless DSH run
# writes inside the workspace, and an outside-workspace write is denied by the
# sandbox rather than by a missing backend.
#
# Must run as a NON-ROOT container user: non-setuid bwrap only auto-creates
# the user namespace it needs when the caller is unprivileged; as in-container
# uid 0 (without CAP_SYS_ADMIN) it attempts direct namespace clones and fails
# with EPERM.
set -u

DSH_CLI="${DSH_CLI:-/opt/dsh/apps/cli/lib/bin.js}"
SPIKE_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${SPIKE_OUT:-$HOME/spike-out}"
WORK="${SPIKE_WORK:-$HOME/work}"
UNAVAILABLE_PATTERN='SANDBOX_UNAVAILABLE|no sandbox backend is usable|SandboxUnavailableError'
mkdir -p "$OUT" "$WORK"
fail=0

note() { printf '%s\n' "$*"; }
check() {
  if eval "$2"; then note "PASS: $1"; else note "FAIL: $1"; fail=1; fi
}

note "== environment"
uname -r
note "user: $(id -u):$(id -g)"
note "apparmor label: $(cat /proc/self/attr/apparmor/current 2>/dev/null || echo unreadable)"
bwrap --version

note "== DSH-shaped bwrap readiness probe"
if bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true; then
  note "PASS: bwrap readiness probe"
else
  note "FAIL: bwrap readiness probe (exit $?)"
  fail=1
fi

note "== start fixture model"
node "$SPIKE_DIR/probe-model.mjs" &
MODEL_PID=$!
trap 'kill "$MODEL_PID" 2>/dev/null' EXIT
fixture_ready=0
for _ in $(seq 1 50); do
  if curl -s -o /dev/null "http://127.0.0.1:${SPIKE_MODEL_PORT:-8787}/"; then fixture_ready=1; break; fi
  sleep 0.2
done
check "fixture model reachable" "[ $fixture_ready -eq 1 ]"

export DSH_HOME="$HOME/.dsh"
export DSH_TELEMETRY_DISABLED=1
export DSH_TELEMETRY_MODE=DISABLED
export DSH_PERMISSION_MODE=workspace-write
export DEEPSEEK_API_KEY="${SPIKE_MODEL_KEY:-spike-fixture-key}"
mkdir -p "$DSH_HOME"
cat > "$DSH_HOME/settings.yaml" <<YAML
llm-deepseek:
  baseURL: http://127.0.0.1:${SPIKE_MODEL_PORT:-8787}
YAML
cd "$WORK"
rm -f "$WORK/inside.txt"

note "== run 1: inside-workspace write through headless DSH"
node "$DSH_CLI" --profile headless --json "INSIDE_TASK: use the bash tool to write inside.txt." \
  > "$OUT/inside.ndjson" 2> "$OUT/inside.stderr"
inside_exit=$?
check "inside run exits 0" "[ $inside_exit -eq 0 ]"
check "inside.txt written in workspace" "grep -q SPIKE_INSIDE_FILE '$WORK/inside.txt'"
check "run 1 has no sandbox-unavailable" "! grep -qiE '$UNAVAILABLE_PATTERN' '$OUT/inside.ndjson' '$OUT/inside.stderr'"
check "run 1 has no denial marker" "! grep -q 'file access denied' '$OUT/inside.ndjson'"

note "== run 2: outside-workspace write must be denied by the sandbox"
node "$DSH_CLI" --profile headless --json "OUTSIDE_TASK: use the bash tool to write /etc/spike-denied.txt." \
  > "$OUT/outside.ndjson" 2> "$OUT/outside.stderr"
outside_exit=$?
check "outside run exits 0 (denial is a tool result, not a run failure)" "[ $outside_exit -eq 0 ]"
check "denial marker present" "grep -q 'file access denied under workspace-write mode' '$OUT/outside.ndjson'"
check "outside file not created" "[ ! -e /etc/spike-denied.txt ]"
check "run 2 has no sandbox-unavailable" "! grep -qiE '$UNAVAILABLE_PATTERN' '$OUT/outside.ndjson' '$OUT/outside.stderr'"

note "== sandbox evidence"
# The headless NDJSON stream carries no sandbox attribution stamp at the pinned
# revision; enforcement is attributed by the run-1 success / run-2 denial pair
# plus the bwrap readiness probe above.
grep -ho '"sandbox":{[^}]*}' "$OUT"/*.ndjson | sort -u || true

if [ "$fail" -ne 0 ]; then
  note "== failure dumps (tails)"
  for f in "$OUT"/*; do
    note "-- $f"
    tail -c 1500 "$f"
    note ""
  done
fi

if [ "$fail" -eq 0 ]; then note "SPIKE-RESULT: PASS"; else note "SPIKE-RESULT: FAIL"; fi
exit "$fail"
