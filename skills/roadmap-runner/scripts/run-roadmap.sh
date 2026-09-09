#!/usr/bin/env bash

set -uo pipefail

usage() {
  echo "Usage: $0 /absolute/path/to/roadmap.md" >&2
  exit 64
}

[[ $# -eq 1 ]] || usage

roadmap_input=$1
[[ "$roadmap_input" = /* ]] || {
  echo "Roadmap path must be absolute." >&2
  exit 64
}
[[ -f "$roadmap_input" ]] || {
  echo "Roadmap not found: $roadmap_input" >&2
  exit 66
}
[[ "$roadmap_input" != *$'\n'* ]] || {
  echo "Roadmap path must not contain a newline." >&2
  exit 64
}

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
skill_dir=$(cd "$script_dir/.." && pwd -P)
workspace_input=${ROADMAP_WORKSPACE:-$PWD}
[[ -d "$workspace_input" ]] || {
  echo "Workspace not found: $workspace_input" >&2
  exit 66
}
workspace=$(cd "$workspace_input" && pwd -P)
roadmap=$(cd "$(dirname "$roadmap_input")" && pwd -P)/$(basename "$roadmap_input")
case "$roadmap" in
  "$workspace"/*) ;;
  *)
    echo "Roadmap must be inside the workspace: $workspace" >&2
    exit 64
    ;;
esac

procedure="$skill_dir/references/procedure.md"
codex_bin=${ROADMAP_CODEX_BIN:-codex}
model=${ROADMAP_MODEL:-gpt-5.6-sol}
max_runs=${ROADMAP_MAX_RUNS:-100}
max_failures=${ROADMAP_MAX_FAILURES:-2}

[[ "$max_runs" =~ ^[1-9][0-9]*$ ]] || {
  echo "ROADMAP_MAX_RUNS must be a positive integer." >&2
  exit 64
}
[[ "$max_failures" =~ ^[1-9][0-9]*$ ]] || {
  echo "ROADMAP_MAX_FAILURES must be a positive integer." >&2
  exit 64
}
command -v "$codex_bin" >/dev/null 2>&1 || {
  echo "Codex executable not found: $codex_bin" >&2
  exit 69
}

if awk '
  /<!-- roadmap-execution:start -->/ { legacy = 1 }
  /<!-- roadmap-execution:end -->/ { legacy = 0 }
  legacy && /^[[:space:]]*state:[[:space:]]*running[[:space:]]*$/ { found = 1 }
  END { exit found ? 0 : 1 }
' "$roadmap"; then
  echo "The roadmap still records a running legacy coordinator. Let it settle before starting the shell supervisor." >&2
  exit 73
fi

roadmap_key=$(printf '%s' "$roadmap" | cksum | awk '{print $1}')
run_root="$workspace/.codex/roadmap-runs/$roadmap_key"
lock_dir="$run_root/lock"
stop_file="$run_root/STOP"
mkdir -p "$run_root"

if ! mkdir "$lock_dir" 2>/dev/null; then
  lock_pid=$(sed -n '1p' "$lock_dir/pid" 2>/dev/null || true)
  worker_pid=$(sed -n '1p' "$lock_dir/worker_pid" 2>/dev/null || true)
  if [[ "$lock_pid" =~ ^[0-9]+$ ]] && kill -0 "$lock_pid" 2>/dev/null; then
    echo "A supervisor is already running for this roadmap (pid $lock_pid)." >&2
    exit 73
  fi
  if [[ "$worker_pid" =~ ^[0-9]+$ ]] && kill -0 "$worker_pid" 2>/dev/null; then
    echo "A worker from a stale supervisor is still running (pid $worker_pid)." >&2
    exit 73
  fi
  rm -f "$lock_dir/pid" "$lock_dir/worker_pid" "$lock_dir/roadmap"
  rmdir "$lock_dir" 2>/dev/null || {
    echo "Cannot recover stale lock: $lock_dir" >&2
    exit 73
  }
  mkdir "$lock_dir" || exit 73
fi
printf '%s\n' "$$" > "$lock_dir/pid"
printf '%s\n' "$roadmap" > "$lock_dir/roadmap"

child_pid=
# Invoked indirectly by the EXIT trap.
# shellcheck disable=SC2329
cleanup() {
  if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  rm -f "$lock_dir/pid" "$lock_dir/worker_pid" "$lock_dir/roadmap"
  rmdir "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "Roadmap: $roadmap"
echo "Logs: $run_root"
echo "Stop between workers: touch $stop_file"

consecutive_failures=0
run_number=0

while (( run_number < max_runs )); do
  if [[ -e "$stop_file" ]]; then
    echo "Stopped by operator before the next worker."
    exit 0
  fi

  run_number=$((run_number + 1))
  run_id=$(date -u '+RR-%Y%m%dT%H%M%SZ')-$(printf '%03d' "$run_number")
  run_dir="$run_root/$run_id"
  prompt_file="$run_dir/prompt.md"
  result_file="$run_dir/result.txt"
  transcript_file="$run_dir/transcript.log"
  mkdir -p "$run_dir"

  cat > "$prompt_file" <<EOF
Read $procedure completely, then use it to continue this roadmap:

Roadmap: $roadmap
Shell run ID: $run_id
Workspace: $workspace

You are the only semantic worker for this invocation. Use existing roadmap checkboxes as the queue; do not add a parallel execution-state block or ledger. Reconcile unchecked items, recent delivery evidence, current diffs, and repository instructions first. If a settled legacy roadmap-execution block remains, preserve its useful evidence in the existing checklist or delivery record and remove the block. If an unchecked item has matching partial changes, continue or safely settle it before selecting another. Then implement and validate at most one small local-development batch. Check off only work whose criteria are proven, and add the shell run ID plus concise evidence to the roadmap's existing delivery record or directly under the affected item.

Follow the repository's instructions and preserve unrelated dirty changes. Work only in the local checkout. Treat pushes, pull requests, hosted CI, publication, deployment, production activation, provider mutation, production credentials, destructive operations, paid/live provider calls, and unresolved product decisions as separate authorization gates.

Return exactly these six lines as your final response, with no Markdown fence or additional text:
ROADMAP_RUNNER_V1
run_id=$run_id
status=<continue|local_complete|complete|blocked|failed>
batch_id=<letters, digits, dot, underscore, colon, or hyphen; use none when no batch was selected>
roadmap_updated=yes
retryable=<yes|no>

Use status continue only when another locally eligible checkbox exists, local_complete when local implementation is exhausted but non-local gates remain, complete only when every criterion is proven, blocked when operator input is required and no independent local work remains, or failed when this invocation cannot settle safely. Set roadmap_updated=yes only after writing the run ID into the roadmap.
EOF

  echo "Starting worker $run_id ($run_number/$max_runs)..."
  roadmap_checksum_before=$(cksum "$roadmap")
  "$codex_bin" exec \
    --model "$model" \
    --sandbox workspace-write \
    --cd "$workspace" \
    --skip-git-repo-check \
    --output-last-message "$result_file" \
    - < "$prompt_file" > >(tee "$transcript_file") 2>&1 &
  child_pid=$!
  printf '%s\n' "$child_pid" > "$lock_dir/worker_pid"
  wait "$child_pid"
  process_status=$?
  child_pid=
  rm -f "$lock_dir/worker_pid"

  if (( process_status != 0 )); then
    consecutive_failures=$((consecutive_failures + 1))
    echo "Worker $run_id exited with status $process_status ($consecutive_failures/$max_failures consecutive failures)." >&2
    if (( consecutive_failures >= max_failures )); then
      exit 70
    fi
    continue
  fi

  line_count=$(awk 'END { print NR }' "$result_file" 2>/dev/null || true)
  protocol=$(sed -n '1p' "$result_file" 2>/dev/null || true)
  result_run_id=$(sed -n '2s/^run_id=//p' "$result_file" 2>/dev/null || true)
  status=$(sed -n '3s/^status=//p' "$result_file" 2>/dev/null || true)
  batch_id=$(sed -n '4s/^batch_id=//p' "$result_file" 2>/dev/null || true)
  roadmap_updated=$(sed -n '5s/^roadmap_updated=//p' "$result_file" 2>/dev/null || true)
  retryable=$(sed -n '6s/^retryable=//p' "$result_file" 2>/dev/null || true)

  if [[ "$line_count" != 6 || "$protocol" != ROADMAP_RUNNER_V1 || "$result_run_id" != "$run_id" ||
        ! "$status" =~ ^(continue|local_complete|complete|blocked|failed)$ ||
        ! "$batch_id" =~ ^[A-Za-z0-9._:-]+$ || "$roadmap_updated" != yes ||
        ! "$retryable" =~ ^(yes|no)$ ]]; then
    echo "Worker returned a malformed control response: $result_file" >&2
    exit 65
  fi

  roadmap_checksum_after=$(cksum "$roadmap")
  if [[ "$roadmap_checksum_before" == "$roadmap_checksum_after" ]] || ! grep -Fq "$run_id" "$roadmap"; then
    echo "Worker did not make a verifiable roadmap update for $run_id." >&2
    exit 65
  fi

  echo "Worker $run_id: $status (batch $batch_id)"
  case "$status" in
    continue)
      consecutive_failures=0
      ;;
    local_complete|complete)
      exit 0
      ;;
    blocked)
      exit 75
      ;;
    failed)
      if [[ "$retryable" != yes ]]; then
        exit 70
      fi
      consecutive_failures=$((consecutive_failures + 1))
      if (( consecutive_failures >= max_failures )); then
        exit 70
      fi
      ;;
  esac
done

echo "Stopped after reaching ROADMAP_MAX_RUNS=$max_runs." >&2
exit 76
