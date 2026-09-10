#!/usr/bin/env bash
# Bash 3.2+ and standard Unix tools. The worker, never this shell, reads Markdown.
set -eu -o pipefail
umask 077
VERSION=0.2.1

fail() { echo "roadmap-runner: $*" >&2; exit 1; }
usage() {
  echo "Usage: $0 [run|start] [/absolute/roadmap.md] | version | status | stop [now] | recover" >&2
  exit 64
}
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
script="$script_dir/$(basename "${BASH_SOURCE[0]}")"
# Version inspection must work for stale-install diagnosis without starting Codex
# or creating state/locks. It identifies this exact installed/cached script.
case ${1:-} in
  version|--version)
    [[ $# == 1 ]] || usage
    printf 'roadmap-runner %s\nscript=%s\n' "$VERSION" "$script"
    exit 0 ;;
esac
code_home=${CODEX_HOME:-"$HOME/.codex"}
mkdir -p "$code_home"
code_home=$(cd "$code_home" && pwd -P)
state="$code_home/roadmap-runner.state"
lock="$code_home/roadmap-runner.lock"
log="$code_home/roadmap-runner.log"
[[ ! -L "$state" && ! -L "$lock" && ! -L "$log" ]] || fail 'Runner files must not be symlinks.'
# State is data, never sourced or evaluated. Values may contain spaces and '='.
field() { sed -n "s/^$1=//p" "$state" 2>/dev/null || true; }
alive() { [[ "$1" =~ ^[1-9][0-9]*$ ]] && kill -0 "$1" 2>/dev/null; }
group_alive() { [[ "$1" =~ ^[1-9][0-9]*$ ]] && kill -0 -- "-$1" 2>/dev/null; }

action=${1:-run}
case "$action" in
  run|start|__run|status|stop|recover) (( $# == 0 )) || shift ;;
  /*) action=run ;;
  *) usage ;;
esac
case "$action" in
  status)
    [[ $# == 0 ]] || usage
    printf 'installed_version=%s\ninstalled_script=%s\n' "$VERSION" "$script"
    if [[ -f "$state" ]]; then cat "$state"; else echo 'status=idle'; fi
    if [[ -d "$lock" ]]; then echo 'locked=yes'; else echo 'locked=no'; fi
    exit 0 ;;
  stop)
    [[ $# == 0 || ( $# == 1 && $1 == now ) ]] || usage
    [[ -d "$lock" ]] || fail 'No active lock.'
    if [[ ${1:-} == now ]]; then : > "$lock/CANCEL"; else : > "$lock/STOP"; fi
    echo 'Stop requested. Check status for completion.'
    exit 0 ;;
  recover)
    [[ $# == 0 ]] || usage
    [[ -d "$lock" ]] || { echo 'No stale lock.'; exit 0; }
    # An empty/uncertain lock is never stolen. Serialize explicit recovery attempts.
    mkdir "$lock/recovering" 2>/dev/null || fail 'Recovery already in progress.'
    trap 'rmdir "$lock/recovering" 2>/dev/null || true' EXIT
    owner=$(cat "$lock/owner" 2>/dev/null || true)
    [[ "$owner" =~ ^[1-9][0-9]*$ ]] || fail 'Lock owner is unknown; inspect it manually.'
    if alive "$owner" || alive "$(field pid)" || group_alive "$(field worker)"; then
      fail 'A prior runner or worker may still be alive. Lock retained.'
    fi
    # All starters require this directory to be absent. Keep it until cleanup ends.
    rm -f "$lock/owner" "$lock/prompt" "$lock/result" "$lock/GO" \
      "$lock/STOP" "$lock/CANCEL" "$lock/state.tmp"
    rmdir "$lock/recovering"
    trap - EXIT
    rmdir "$lock" || fail 'Unexpected lock contents; inspect manually.'
    echo 'Stale lock released. Run start or run without a path to resume.'
    exit 0 ;;
esac

[[ $# -le 1 ]] || usage
[[ ${ROADMAP_RUNNER_WORKER:-0} != 1 ]] || fail 'Workers cannot recursively launch the runner.'
roadmap=${1:-$(field roadmap)}
workspace_input=${ROADMAP_WORKSPACE:-}
if [[ -z "$workspace_input" ]]; then
  if [[ $# == 0 || $action == __run ]]; then workspace_input=$(field workspace); else workspace_input=$PWD; fi
fi
[[ -n "$workspace_input" && -d "$workspace_input" ]] || fail 'Workspace not found. Set ROADMAP_WORKSPACE.'
workspace=$(cd "$workspace_input" && pwd -P)
[[ "$roadmap" == /* && -f "$roadmap" && ! -L "$roadmap" ]] || fail 'Provide an absolute, non-symlink roadmap file.'
roadmap=$(cd "$(dirname "$roadmap")" && pwd -P)/$(basename "$roadmap")
[[ "$roadmap" == "$workspace/"* || $workspace == / ]] || fail 'Roadmap must be inside the workspace.'
for value in "$roadmap" "$workspace" "$code_home" "$script"; do
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail 'Paths must not contain line breaks.'
done
codex_bin=${ROADMAP_CODEX_BIN:-codex}
model=${ROADMAP_MODEL:-gpt-5.6-sol}
effort=${ROADMAP_EFFORT:-medium}
max_runs=${ROADMAP_MAX_RUNS:-100}
max_retries=${ROADMAP_MAX_FAILURES:-2}
timeout=${ROADMAP_TIMEOUT:-1800}
for value in "$max_runs" "$max_retries" "$timeout"; do
  [[ "$value" =~ ^[1-9][0-9]{0,6}$ ]] || fail 'Run, failure and timeout limits must be positive integers (at most seven digits).'
done
case "$effort" in low|medium|high|xhigh) ;; *) fail 'Invalid ROADMAP_EFFORT.' ;; esac
[[ -n "$model" && "$model" != *$'\n'* && "$model" != *$'\r'* ]] || fail 'Invalid model.'
command -v "$codex_bin" >/dev/null 2>&1 || fail "Codex executable not found: $codex_bin"
[[ -r "$script_dir/../references/procedure.md" ]] || fail 'Worker procedure is missing.'

worker=0
batch=0
status=starting
save_state() {
  printf 'roadmap=%s\nworkspace=%s\npid=%s\nworker=%s\nbatch=%s\nstatus=%s\nmodel=%s\n' \
    "$roadmap" "$workspace" "$$" "$worker" "$batch" "$status" "$model" > "$lock/state.tmp"
  printf 'version=%s\nscript=%s\n' "$VERSION" "$script" >> "$lock/state.tmp"
  mv -f "$lock/state.tmp" "$state"
}
if [[ $action == __run ]]; then
  [[ -n ${ROADMAP_STARTER:-} && -d "$lock" ]] || fail 'Internal launch requires a starter.'
  [[ $(cat "$lock/owner") == "$ROADMAP_STARTER" && $(field pid) == "$ROADMAP_STARTER" ]] || fail 'Starter does not own the lock.'
else
  mkdir "$lock" 2>/dev/null || fail "Runner is locked. Use status; after interruption, inspect then recover. ($lock)"
fi
printf '%s\n' "$$" > "$lock/owner"
save_state
if [[ $action == start ]]; then
  # Only this child receives __run authorization; no foreground agent needs to wait.
  ROADMAP_STARTER=$$ ROADMAP_WORKSPACE="$workspace" nohup "$BASH" "$script" __run "$roadmap" \
    </dev/null >> "$log" 2>&1 &
  pid=$!
  # Keep the starter alive until the child owns the record; no stale-lock gap.
  for _ in {1..100}; do
    if [[ $(field pid) == "$pid" ]]; then
      echo "Started Roadmap Runner $VERSION, shell PID $pid. State: $state. Log: $log"
      exit 0
    fi
    alive "$pid" || fail "Child did not start; inspect $log and the lock."
    sleep 0.1
  done
  fail "Child has not acknowledged startup; inspect status and $log."
fi

# Job control gives the worker its own process group on Linux and macOS.
# This is one implementation worker, not a pool. Do not detach work inside a batch.
set -m
stop_worker() {
  [[ $worker != 0 ]] || return 0
  kill -TERM -- "-$worker" 2>/dev/null || true
  for _ in 1 2 3; do
    group_alive "$worker" || break
    sleep 1
  done
  kill -KILL -- "-$worker" 2>/dev/null || true
  wait "$worker" 2>/dev/null || true
  worker=0
}
cleanup() {
  trap '' INT TERM HUP
  stop_worker
  save_state || true
  rm -f "$lock/owner" "$lock/prompt" "$lock/result" "$lock/GO" \
    "$lock/STOP" "$lock/CANCEL" "$lock/state.tmp"
  rmdir "$lock" 2>/dev/null || true
}
trap cleanup EXIT
trap 'status=stopped; exit 130' INT
trap 'status=stopped; exit 143' TERM
trap 'status=stopped; exit 129' HUP

# Constant instructions and file references, never expanded roadmap contents.
cat "$script_dir/../references/procedure.md" > "$lock/prompt"
printf '\nRoadmap: %s\nWorkspace: %s\nRunner log: %s\nRunner version: %s\n' "$roadmap" "$workspace" "$log" "$VERSION" >> "$lock/prompt"
printf 'Worker permissions: workspace-write; approval=never; shell network disabled.\n' >> "$lock/prompt"
# Boundaries make it possible to inspect the relevant tail, not every prior run.
printf '\n=== Roadmap Runner %s | %s ===\nScript: %s\nRoadmap: %s\nWorkspace: %s\nPermissions: workspace-write; approval=never; shell network disabled.\n' \
  "$VERSION" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$script" "$roadmap" "$workspace" >> "$log"
echo "Roadmap Runner $VERSION ($script)"
echo "Roadmap: $roadmap"
echo "State: $state"
echo "Log: $log"
retries=0
while (( batch < max_runs )); do
  if [[ -e "$lock/STOP" || -e "$lock/CANCEL" ]]; then status=stopped; exit 0; fi
  batch=$((batch + 1))
  status=running
  rm -f "$lock/result" "$lock/GO"
  printf '\n--- Batch %s (%s) ---\n' "$batch" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$log"
  # The worker cannot edit anything until its group ID has been recorded.
  owner=$$
  (
    while [[ ! -e "$lock/GO" ]]; do
      alive "$owner" || exit 1
      sleep 0.1
    done
    export ROADMAP_RUNNER_WORKER=1
    exec "$codex_bin" --ask-for-approval never exec \
      --model "$model" --sandbox workspace-write --cd "$workspace" \
      -c "model_reasoning_effort=\"$effort\"" \
      -c 'features.multi_agent=false' \
      -c 'sandbox_workspace_write.network_access=false' \
      --ephemeral --color never --output-last-message "$lock/result" -
  ) < "$lock/prompt" >> "$log" 2>&1 &
  worker=$!
  save_state
  : > "$lock/GO"
  started=$SECONDS
  while alive "$worker"; do
    if [[ -e "$lock/CANCEL" ]]; then status=stopped; exit 130; fi
    if (( SECONDS - started >= timeout )); then status=timeout; exit 70; fi
    sleep 1
  done
  code=0
  wait "$worker" || code=$?
  stop_worker
  if (( code != 0 )); then status=failed; echo "Codex exited $code; see $log" >&2; exit 70; fi
  # The only worker output the shell interprets is one bounded control word.
  [[ -f "$lock/result" && ! -L "$lock/result" ]] || { status=failed; fail 'No worker result.'; }
  (( $(wc -c < "$lock/result") <= 16 )) || { status=failed; fail 'Expected one control word.'; }
  result=$(cat "$lock/result")
  status=$result
  case "$result" in
    continue) retries=0 ;;
    retry)
      retries=$((retries + 1))
      if (( retries >= max_retries )); then status=failed; exit 70; fi ;;
    complete|local) echo "$result"; exit 0 ;;
    blocked)
      echo "Blocked: prerequisite or permission change required; no automatic retry. See $log" >&2
      echo "$result"; exit 75 ;;
    failed) echo "$result"; exit 70 ;;
    *) status=failed; fail "Invalid worker result; see $log" ;;
  esac
  save_state
  echo "Batch $batch: $result"
done
status=limit
echo "Stopped at ROADMAP_MAX_RUNS=$max_runs." >&2
exit 76
