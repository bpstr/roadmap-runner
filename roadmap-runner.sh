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

This is one iteration of a repeated fresh-context implementation process.
A completely fresh Codex session will continue from the current filesystem
and roadmap after this invocation exits.

For this invocation:

1. Read the roadmap and inspect the current workspace.
2. Determine what is already implemented from code and tests, not assumptions.
3. Choose the next coherent unfinished batch of work.
4. Implement that batch completely.
5. Run the relevant tests, checks, linters, or builds.
6. Update the roadmap accurately with completed work, discoveries, changed
   assumptions, follow-up work, and blockers where useful.

Rules:

- Work on one coherent batch only.
- Prefer a bounded batch that can be completed and verified in this invocation.
- Do not attempt the entire remaining roadmap just because time remains.
- Do not use subagents.
- Do not start another major batch after the selected batch is complete.
- The workspace may contain multiple Git repositories. Do not assume one repo root.
- Preserve unrelated changes and do not revert work you did not make.
- Never mark work complete unless relevant verification succeeds.
- Use configured MCP tools when useful and available, but do not make the batch
  depend on MCP when the same information is available locally.

Completion protocol:

If ALL work described by the roadmap is genuinely implemented and verified,
ensure this exact line exists near the top of the roadmap:

Status: COMPLETE

Otherwise ensure it contains:

Status: IN_PROGRESS

When the selected batch is finished and the roadmap is updated, stop.
EOF
)

CODEX_ARGS=(
  exec
  --sandbox workspace-write
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

iteration=0

echo "Roadmap Runner"
echo "Workspace: $WORKDIR"
echo "Roadmap:   $ROADMAP"
echo "Timeout:   $TIME_LIMIT per run"
echo "Press Ctrl-C to stop."
echo

while true; do
  if grep -Eq '^Status:[[:space:]]*COMPLETE[[:space:]]*$' "$ROADMAP"; then
    echo "Roadmap complete after $iteration iteration(s)."
    exit 0
  fi

  iteration=$((iteration + 1))
  echo "===== iteration $iteration | $(date '+%Y-%m-%d %H:%M:%S') ====="

  "$TIMEOUT_BIN" --signal=TERM --kill-after=2m "$TIME_LIMIT"     "$CODEX_BIN" "${CODEX_ARGS[@]}" "$PROMPT"

  code=$?

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
