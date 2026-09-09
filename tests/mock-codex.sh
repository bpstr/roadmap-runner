#!/usr/bin/env bash

set -uo pipefail

result_file=
while (( $# > 0 )); do
  case "$1" in
    --output-last-message)
      result_file=$2
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

prompt=$(cat)
run_id=$(printf '%s\n' "$prompt" | sed -n 's/^Shell run ID: //p')
roadmap=$(printf '%s\n' "$prompt" | sed -n 's/^Roadmap: //p')
count=$(sed -n '1p' "$ROADMAP_MOCK_STATE" 2>/dev/null || true)
count=${count:-0}
count=$((count + 1))
printf '%s\n' "$count" > "$ROADMAP_MOCK_STATE"
printf '\n- Mock evidence: %s\n' "$run_id" >> "$roadmap"

if (( count == 1 )); then
  result_status='continue'
else
  result_status='local_complete'
fi

{
  printf '%s\n' ROADMAP_RUNNER_V1
  printf 'run_id=%s\n' "$run_id"
  printf 'status=%s\n' "$result_status"
  printf 'batch_id=mock-%s\n' "$count"
  printf '%s\n' roadmap_updated=yes
  printf '%s\n' retryable=no
} > "$result_file"
