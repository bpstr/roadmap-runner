#!/usr/bin/env bash
# Bash-only offline integration tests. No real Codex, Python, jq, or model calls.
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
runner="$repo/skills/roadmap-runner/scripts/run-roadmap.sh"
root=$(mktemp -d "${TMPDIR:-/tmp}/roadmap-runner-test.XXXXXX")
active=
cleanup() {
  if [[ -n $active ]]; then kill -TERM "$active" 2>/dev/null || true; wait "$active" 2>/dev/null || true; fi
  rm -rf "$root"
}
trap cleanup EXIT
n=0
export ROADMAP_CODEX_BIN="$repo/tests/mock-codex.sh"
unset ROADMAP_RUNNER_WORKER ROADMAP_STARTER || true
setup() {
  n=$((n + 1))
  dir="$root/case $n"
  export CODEX_HOME="$dir/global codex" ROADMAP_WORKSPACE="$dir/project"
  export ROADMAP_MOCK_STATE="$dir/mock-state" ROADMAP_MAX_RUNS=3 ROADMAP_MAX_FAILURES=2 ROADMAP_TIMEOUT=10
  export MOCK_MODE=ok
  mkdir -p "$ROADMAP_WORKSPACE" "$CODEX_HOME"
  roadmap="$ROADMAP_WORKSPACE/roadmap with = spaces.md"
  printf '# Plan\n\n- [ ] First item\n- [ ] Second item\n\nUNIQUE_ROADMAP_CONTENT_NOT_TO_INJECT\n' > "$roadmap"
  cp "$roadmap" "$dir/before"
}
run() {
  rc=0
  bash "$runner" "$@" > "$dir/output" 2>&1 || rc=$?
}
expect() { [[ $rc == "$1" ]] || { cat "$dir/output"; echo "Expected exit $1, got $rc" >&2; exit 1; }; }
state_is() { grep -qx "status=$1" "$CODEX_HOME/roadmap-runner.state"; }
pass() { echo "PASS $n: $*"; }
wait_worker() {
  for _ in {1..100}; do [[ ! -f "$ROADMAP_MOCK_STATE.pid" ]] || return 0; sleep 0.1; done
  echo 'Worker did not start' >&2; exit 1
}

setup; run "$roadmap"; expect 0
[[ $(cat "$ROADMAP_MOCK_STATE") == 2 ]]; state_is complete
sed 's/\[ \]/[x]/g' "$dir/before" > "$dir/expected"
cmp "$dir/expected" "$roadmap"
[[ ! -d "$ROADMAP_WORKSPACE/.codex" && ! -d "$CODEX_HOME/roadmap-runner.lock" ]]
[[ $(find "$CODEX_HOME" -type f | wc -l | tr -d ' ') == 2 ]]
pass 'Sequential workers, checkbox-only edits, one global state and one log'

setup; MOCK_MODE=blocked; run "$roadmap"; expect 75; state_is blocked; cmp "$dir/before" "$roadmap"
pass 'Blocked status needs no roadmap markup or modification'

setup; MOCK_MODE=local; run "$roadmap"; expect 0; state_is local; cmp "$dir/before" "$roadmap"
pass 'Local completion is distinct from full completion'

setup; MOCK_MODE=complete; run "$roadmap"; expect 0; state_is complete; cmp "$dir/before" "$roadmap"
pass 'Completion is worker-owned, not a shell Markdown interpretation'

for mode in invalid multiline huge missing; do
  setup; MOCK_MODE=$mode; run "$roadmap"; expect 1; state_is failed
  [[ $(cat "$ROADMAP_MOCK_STATE") == 1 ]]; cmp "$dir/before" "$roadmap"
  pass "Malformed or absent result rejected: $mode"
done

setup; MOCK_MODE=stale; run "$roadmap"; expect 1; state_is failed
[[ $(cat "$ROADMAP_MOCK_STATE") == 2 ]]
pass 'Previous result cannot be replayed when the next worker omits its result'

setup; MOCK_MODE=retry; run "$roadmap"; expect 70; state_is failed
[[ $(cat "$ROADMAP_MOCK_STATE") == 2 ]]; cmp "$dir/before" "$roadmap"
pass 'Single-word retry has a finite consecutive limit'

setup; MOCK_MODE=fail; run "$roadmap"; expect 70; state_is failed
[[ $(cat "$ROADMAP_MOCK_STATE") == 1 ]]
pass 'Provider/CLI failure stops without another model call'

setup; MOCK_MODE=failed; run "$roadmap"; expect 70; state_is failed
[[ $(cat "$ROADMAP_MOCK_STATE") == 1 ]]
pass 'Worker-reported failure stops'

setup; MOCK_MODE=unchanged; ROADMAP_MAX_RUNS=2; run "$roadmap"; expect 76; state_is limit
[[ $(cat "$ROADMAP_MOCK_STATE") == 2 ]]; cmp "$dir/before" "$roadmap"
pass 'Global run cap bounds even dishonest continue responses without parsing Markdown'

setup; ROADMAP_MAX_RUNS=1; run "$roadmap"; expect 76
ROADMAP_MAX_RUNS=3; unset ROADMAP_WORKSPACE; run run; expect 0; state_is complete
[[ $(cat "$ROADMAP_MOCK_STATE") == 2 ]]
pass 'No-path resume restores roadmap and workspace from the single state file'

setup; MOCK_MODE=slow
bash "$runner" "$roadmap" > "$dir/first-output" 2>&1 & active=$!
wait_worker
mkdir -p "$dir/other project"; cp "$dir/before" "$dir/other project/other.md"
ROADMAP_WORKSPACE="$dir/other project" run "$dir/other project/other.md"; expect 1
run recover; expect 1
run stop; expect 0
wait "$active"; active=
[[ $(cat "$ROADMAP_MOCK_STATE") == 1 ]]; state_is stopped
pass 'One global worker; duplicate launch/recovery rejected; graceful stop finishes batch'

setup; MOCK_MODE=hang; ROADMAP_TIMEOUT=1; run "$roadmap"; expect 70; state_is timeout
! kill -0 "$(cat "$ROADMAP_MOCK_STATE.pid")" 2>/dev/null
pass 'Timeout terminates the active worker and retains unchecked work'

setup; MOCK_MODE=hang
bash "$runner" "$roadmap" > "$dir/first-output" 2>&1 & active=$!
wait_worker; run stop now; expect 0
wait "$active" || [[ $? == 130 ]]; active=
state_is stopped; cmp "$dir/before" "$roadmap"
! kill -0 "$(cat "$ROADMAP_MOCK_STATE.pid")" 2>/dev/null
pass 'Immediate stop terminates the worker without modifying progress'

setup; run start "$roadmap"; expect 0
for _ in {1..100}; do
  if [[ ! -d "$CODEX_HOME/roadmap-runner.lock" ]]; then break; fi
  sleep 0.1
done
state_is complete
[[ ! -d "$CODEX_HOME/roadmap-runner.lock" ]]
pass 'Detached start finishes after the initiating shell has returned'

setup; mv "$roadmap" "$dir/outside.md"; ln -s "$dir/outside.md" "$roadmap"; run "$roadmap"; expect 1
[[ ! -e "$ROADMAP_MOCK_STATE" ]]
pass 'Roadmap symlink rejected before any worker runs'

setup; ROADMAP_MAX_RUNS=0; run "$roadmap"; expect 1
[[ ! -e "$ROADMAP_MOCK_STATE" ]]
pass 'Invalid limits rejected before locking or spawning'

setup; export ROADMAP_RUNNER_WORKER=1; run "$roadmap"; expect 1; unset ROADMAP_RUNNER_WORKER
[[ ! -e "$ROADMAP_MOCK_STATE" ]]
pass 'Recursive runner launch rejected'

setup; MOCK_MODE=blocked; run "$roadmap"; expect 75
# Simulate a reboot checkpoint, not a real long-running process. PID 2147483647 is absent.
sed -e 's/^pid=.*/pid=2147483647/' -e 's/^worker=.*/worker=0/' "$CODEX_HOME/roadmap-runner.state" > "$dir/stale"
mv "$dir/stale" "$CODEX_HOME/roadmap-runner.state"
mkdir "$CODEX_HOME/roadmap-runner.lock"; echo 2147483647 > "$CODEX_HOME/roadmap-runner.lock/owner"
run recover; expect 0
cmp "$dir/before" "$roadmap"
MOCK_MODE=complete; unset ROADMAP_WORKSPACE; run run; expect 0
pass 'Explicit stale-lock recovery preserves state for no-path resume'

setup; mkdir "$CODEX_HOME/roadmap-runner.lock"; run recover; expect 1
[[ -d "$CODEX_HOME/roadmap-runner.lock" ]]
pass 'An uncertain empty lock is not automatically stolen'

setup; echo '$(touch should-not-exist)' > "$CODEX_HOME/roadmap-runner.state"; run run; expect 1
[[ ! -e should-not-exist && ! -e "$ROADMAP_MOCK_STATE" ]]
pass 'State is never evaluated as shell code'

setup; run status; expect 0; grep -qx status=idle "$dir/output"
[[ ! -e "$ROADMAP_MOCK_STATE" ]]
pass 'Status never starts a model'


setup; CODEX_HOME="$dir/unused-home" ROADMAP_CODEX_BIN=/not/installed run version; expect 0
grep -qx 'roadmap-runner 0.2.1' "$dir/output"
grep -Fxq "script=$runner" "$dir/output"
[[ ! -e "$dir/unused-home" && ! -e "$ROADMAP_MOCK_STATE" ]]
run --version; expect 0
pass 'Version identifies the installed script without Codex or state writes'

setup; run version extra; expect 64
[[ ! -e "$ROADMAP_MOCK_STATE" && ! -e "$CODEX_HOME/roadmap-runner.state" ]]
pass 'Version rejects unexpected arguments without launching'

setup; MOCK_MODE=db-blocked; ROADMAP_MAX_FAILURES=50; run "$roadmap"; expect 75
state_is blocked; [[ $(cat "$ROADMAP_MOCK_STATE") == 1 ]]
cmp "$dir/before" "$roadmap"
[[ -s "$ROADMAP_WORKSPACE/partial.sql" && ! -d "$CODEX_HOME/roadmap-runner.lock" ]]
grep -Fq 'no automatic retry' "$dir/output"
grep -Fq 'shmget: Operation not permitted' "$CODEX_HOME/roadmap-runner.log"
grep -qx 'version=0.2.1' "$CODEX_HOME/roadmap-runner.state"
grep -Fxq "script=$runner" "$CODEX_HOME/roadmap-runner.state"
pass 'DB prerequisite denial stops after one worker with exit 75; partial work preserved'

setup; MOCK_MODE=db-blocked; run "$roadmap"; expect 75
cp "$ROADMAP_WORKSPACE/partial.sql" "$dir/saved-partial.sql"
MOCK_MODE=db-resume; unset ROADMAP_WORKSPACE
MOCK_DB_READY=1 run run; expect 0; state_is complete
[[ $(cat "$ROADMAP_MOCK_STATE") == 2 ]]
cmp "$dir/saved-partial.sql" "$dir/project/partial.sql"
sed 's/\[ \]/[x]/g' "$dir/before" > "$dir/expected"
cmp "$dir/expected" "$roadmap"
pass 'Explicit resume after simulated prerequisite repair validates and keeps partial code'

setup; printf '\n- [ ] Third item\n' >> "$roadmap"; MOCK_MODE=db-independent
run "$roadmap"; expect 75; state_is blocked
[[ $(cat "$ROADMAP_MOCK_STATE") == 2 ]]
grep -qx -- '- \[ \] First item' "$roadmap"
grep -qx -- '- \[x\] Second item' "$roadmap"
grep -qx -- '- \[x\] Third item' "$roadmap"
[[ $(grep -c 'DB_CAPABILITY_PROBE' "$CODEX_HOME/roadmap-runner.log") == 1 ]]
pass 'Independent work completes while validation-dependent checkbox stays open'

setup; MOCK_MODE=db-cli-fail; run "$roadmap"; expect 70; state_is failed
[[ $(cat "$ROADMAP_MOCK_STATE") == 1 ]]; cmp "$dir/before" "$roadmap"
pass 'Shell does not classify arbitrary stderr; CLI failures still stop without retries'

setup; MOCK_MODE=legacy-result; run "$roadmap"; expect 1; state_is failed
[[ $(cat "$ROADMAP_MOCK_STATE") == 1 ]]; cmp "$dir/before" "$roadmap"
pass 'Legacy six-line retryable results are not silently accepted'

setup; printf 'status=blocked\nversion=0.2.0\nscript=/old/cache/run-roadmap.sh\n' > "$CODEX_HOME/roadmap-runner.state"
cp "$CODEX_HOME/roadmap-runner.state" "$dir/saved-state"
run status; expect 0
grep -qx 'installed_version=0.2.1' "$dir/output"
grep -qx 'version=0.2.0' "$dir/output"
grep -Fxq "installed_script=$runner" "$dir/output"
cmp "$dir/saved-state" "$CODEX_HOME/roadmap-runner.state"
[[ ! -e "$ROADMAP_MOCK_STATE" ]]
pass 'Status distinguishes the inspected installation from the last recorded run'

setup
for manifest in plugin.json .codex-plugin/plugin.json .claude-plugin/plugin.json .claude-plugin/marketplace.json; do
  grep -q '\"version\": \"0.2.1\"' "$repo/$manifest"
done
pass 'All plugin manifests match the shell version'

bash -n "$runner" "$repo/tests/mock-codex.sh" "$0"
echo "All $n offline cases passed. No live model calls."
