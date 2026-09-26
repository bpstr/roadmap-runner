#!/usr/bin/env bash

set -uo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  bash roadmap-runner.sh <roadmap-file>

Run from the workspace you want Codex to use. The current directory (pwd) is
always the Codex workdir. The roadmap path may be absolute or relative to it.

Environment:
  ROADMAP_TIMEOUT   Per-run timeout. Default: 2h
  ROADMAP_CODEX     Codex executable. Default: codex
  ROADMAP_MODEL     Optional model override
  ROADMAP_EFFORT    Optional reasoning effort override
EOF
  exit 64
}

[[ $# -eq 1 ]] || usage

WORKDIR="$(pwd)"
ROADMAP_INPUT="$1"
TIME_LIMIT="${ROADMAP_TIMEOUT:-2h}"
CODEX_BIN="${ROADMAP_CODEX:-codex}"

if [[ "$ROADMAP_INPUT" = /* ]]; then
  ROADMAP="$ROADMAP_INPUT"
else
  ROADMAP="$WORKDIR/$ROADMAP_INPUT"
fi

[[ -f "$ROADMAP" ]] || {
  echo "roadmap-runner: roadmap not found: $ROADMAP" >&2
  exit 1
}

command -v "$CODEX_BIN" >/dev/null 2>&1 || {
  echo "roadmap-runner: Codex executable not found: $CODEX_BIN" >&2
  exit 1
}

if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
else
  echo "roadmap-runner: timeout command not found." >&2
  echo "On macOS: brew install coreutils" >&2
  exit 1
fi

PROMPT=$(cat <<EOF
Work on this implementation roadmap:

$ROADMAP

This is one fresh-context iteration. The roadmap and current filesystem are the
handoff to the next session. The working directory may contain multiple repositories.
Read repository instructions and preserve unrelated changes.

Select the acceptance gate:

1. Read the maintained Markdown checkbox checklist and compact current handoff
   near the top of the roadmap. Consult historical entries for evidence, not as
   a competing task list. If no checklist exists, create one from the roadmap's
   existing acceptance gates without changing their scope or deleting history.
2. Resume the handoff's active unchecked gate. If none is named, choose the first
   dependency-ready unchecked gate in roadmap order. Before editing, state its
   exact checkbox ID/text, acceptance criteria and necessary prerequisites.
3. Compare the last two iteration records. Resolve the active gate's missing
   dependency when it is authorized and feasible; size or difficulty alone is
   not a blocker. If it needs unavailable access, an external service, user
   judgment or another unmet dependency, leave its checkbox open and record the
   evidence, unblock condition and next ready checkbox. Continue other useful
   authorized work in this invocation if coding has not started, or hand it off
   for the next iteration after finishing the current coherent batch.
4. Revisit a deferred gate only when its unblock condition changes or a planned
   bounded retry is due. Keep a compact deferred-gates list in the handoff so
   fresh contexts do not repeat discovery or silently forget the original gate.
   Resume it when ready; do not replace its criteria with smaller adjacent tests.

Implement and verify:

- Complete one coherent acceptance gate, including necessary cross-repository
  changes and integration checks. Batch size follows acceptance criteria, not
  an arbitrary task count. Stop after that gate is complete.
- A local prerequisite or prepared component test does not close an end-to-end
  gate. Keep the parent unchecked until its full stated criteria pass; record
  prerequisite progress under that parent rather than substituting tiny new
  checked items for the original requirement.
- Finish the coding batch before validation. Reuse passing evidence for unchanged
  code and environments; rerun only failed or invalidated checks after repairs.
- Inspect executed, passed, failed and skipped counts. A skipped check is not a
  pass. Distinguish prepared tests, actual integration and deployed behavior.
- Use existing authorization for tests and side effects. An unchecked deployment
  or live-provider gate does not itself authorize publication or spending.
- Do not use subagents. Use Git only inside the applicable repositories.

Update the roadmap and stop this invocation:

- Maintain - [ ] for incomplete gates and - [x] only for gates whose stated
  acceptance criteria passed. Preserve IDs, unresolved criteria and dated failures.
- Replace a compact Current handoff near the top with: active checkbox, criteria
  closed this iteration, remaining criteria, blocker/dependency, verification
  results (including skips), deferred gates with unblock conditions, and the
  exact next ready checkbox. Preserve historical records below it. Continue the
  unfinished active gate unless its documented blocker makes another gate ready.
- Summarize concrete changes and checks; explain any scope change. If no gate
  closed, identify the material prerequisite advanced and how it reduces the
  remaining work. Repeated rediscovery, extra notes or adjacent tests alone
  are not progress toward the active gate.
- Before declaring the entire roadmap blocked, inspect ALL remaining unchecked
  gates and their dependencies for useful authorized implementation, repair or
  verification work. One blocked gate, a failed check, a hard task or one
  no-progress attempt is not enough: diagnose and repair, or move to a genuinely
  ready gate with the deferral recorded. Avoid repeatedly running unchanged checks.
- Set Status: BLOCKED only when no remaining gate or prerequisite can materially
  advance within existing authorization and available resources. Record every
  remaining gate's blocking dependency and the exact external unblock action.
  Otherwise keep Status: IN_PROGRESS and hand off the next actionable checkbox.
- Set Status: COMPLETE only when every original gate is implemented and verified.
  Otherwise use Status: IN_PROGRESS when material progress permits continuation.
  Maintain exactly one of these status lines near the top of the roadmap.
EOF
)

CODEX_ARGS=(
  exec
  --dangerously-bypass-approvals-and-sandbox
  --json
  --skip-git-repo-check
  --ephemeral
  --cd "$WORKDIR"
)

if [[ -n "${ROADMAP_MODEL:-}" ]]; then
  CODEX_ARGS+=(--model "$ROADMAP_MODEL")
fi

if [[ -n "${ROADMAP_EFFORT:-}" ]]; then
  CODEX_ARGS+=(-c "model_reasoning_effort=\"$ROADMAP_EFFORT\"")
fi

command -v python3 >/dev/null 2>&1 || {
  echo "roadmap-runner: Python 3 is required." >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_TMP="$(mktemp -d "${TMPDIR:-/tmp}/roadmap-runner.XXXXXX")" || exit 1
RUNNER_PID=""
trap 'rm -rf -- "$RUN_TMP"' EXIT
stop_loop() {
  local code="$1"
  trap '' INT TERM
  echo
  echo "Stopping Roadmap Runner..."
  if [[ -n "$RUNNER_PID" ]]; then
    kill -TERM "$RUNNER_PID" 2>/dev/null || true
    wait "$RUNNER_PID" 2>/dev/null || true
  fi
  exit "$code"
}
trap 'stop_loop 130' INT
trap 'stop_loop 143' TERM

iteration=0

echo "Roadmap Runner"
echo "Workspace: $WORKDIR"
echo "Roadmap:   $ROADMAP"
echo "Timeout:   $TIME_LIMIT per run"
echo "Press Ctrl-C to stop."
echo

while true; do
  if grep -Eq '^Status:[[:space:]]*BLOCKED[[:space:]]*$' "$ROADMAP"; then
      echo "Roadmap blocked; resolve the recorded blocker before restarting." >&2
      exit 3
  fi
  if grep -Eq '^Status:[[:space:]]*COMPLETE[[:space:]]*$' "$ROADMAP"; then
    echo "Roadmap complete after $iteration iteration(s)."
    exit 0
  fi

  iteration=$((iteration + 1))
  echo "===== iteration $iteration | $(date '+%Y-%m-%d %H:%M:%S') ====="

  python3 "$SCRIPT_DIR/roadmap-run.py" "$RUN_TMP/stderr" \
    "$TIMEOUT_BIN" --signal=TERM --kill-after=2m "$TIME_LIMIT" \
    "$CODEX_BIN" "${CODEX_ARGS[@]}" "$PROMPT" &
  RUNNER_PID=$!
  wait "$RUNNER_PID"
  code=$?
  RUNNER_PID=""
  if [[ $code -ne 0 && -s "$RUN_TMP/stderr" ]]; then
    tail -n 40 "$RUN_TMP/stderr" >&2
  fi

  case "$code" in
    0)
      echo "Iteration $iteration completed."
      ;;
    124|137)
      echo "Iteration $iteration hit the $TIME_LIMIT limit; starting fresh."
      ;;
    *)
      echo "roadmap-runner: Codex exited with code $code; stopping." >&2
      exit "$code"
      ;;
  esac

  echo
done
