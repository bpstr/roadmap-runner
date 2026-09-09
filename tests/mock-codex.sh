#!/usr/bin/env bash
# Offline fixture only. Never forward to an installed Codex executable.
set -euo pipefail
result_file=
workspace=
args=" $* "
[[ $args == *' --ask-for-approval never exec '* ]]
[[ $args == *' --sandbox workspace-write '* && $args == *' --ephemeral '* ]]
[[ $args != *'dangerously-bypass'* && $args != *'output-schema'* ]]
[[ ${ROADMAP_RUNNER_WORKER:-0} == 1 ]]
while (( $# )); do
  case "$1" in
    --output-last-message) result_file=$2; shift 2 ;;
    --cd) workspace=$2; shift 2 ;;
    *) shift ;;
  esac
done
prompt=$(cat)
roadmap=$(printf '%s\n' "$prompt" | sed -n 's/^Roadmap: //p')
[[ $prompt == *'edit ONLY checkbox states'* ]]
[[ $prompt != *'UNIQUE_ROADMAP_CONTENT_NOT_TO_INJECT'* ]]
printf '%s\n' "$prompt" > "$ROADMAP_MOCK_STATE.prompt"
count=$(cat "$ROADMAP_MOCK_STATE" 2>/dev/null || true)
count=$((${count:-0} + 1))
printf '%s\n' "$count" > "$ROADMAP_MOCK_STATE"
printf '%s\n' "$$" > "$ROADMAP_MOCK_STATE.pid"
case ${MOCK_MODE:-ok} in
  fail) exit 9 ;;
  hang) sleep 30 ;;
  slow) sleep 3 ;;
  invalid) echo 'continue please' > "$result_file"; exit 0 ;;
  multiline) printf 'continue\ncomplete\n' > "$result_file"; exit 0 ;;
  huge) printf '%02000d' 0 > "$result_file"; exit 0 ;;
  missing) exit 0 ;;
  stale) if (( count > 1 )); then exit 0; fi ;;
  retry) echo 'Useful partial work near roadmap.md:3' >&2; echo retry > "$result_file"; exit 0 ;;
  blocked) echo blocked > "$result_file"; exit 0 ;;
  local) echo local > "$result_file"; exit 0 ;;
  failed) echo failed > "$result_file"; exit 0 ;;
  complete) echo complete > "$result_file"; exit 0 ;;
  unchanged) echo continue > "$result_file"; exit 0 ;;
esac
# This fixture understands its two known tasks; the actual runner never parses them.
if (( count == 1 )); then
  sed 's/^- \[ \] First item$/- [x] First item/' "$roadmap" > "$roadmap.tmp"
  result=continue
else
  sed 's/^- \[ \] Second item$/- [x] Second item/' "$roadmap" > "$roadmap.tmp"
  result=complete
fi
mv "$roadmap.tmp" "$roadmap"
echo "$result" > "$result_file"
