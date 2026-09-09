#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
test_root=$(mktemp -d "${TMPDIR:-/tmp}/roadmap-runner-test.XXXXXX")
trap 'rm -rf "$test_root"' EXIT

roadmap="$test_root/roadmap.md"
mock_state="$test_root/mock-state"
output="$test_root/output"
printf '%s\n' '# Test roadmap' '' '- [ ] First item' '- [ ] Second item' > "$roadmap"

ROADMAP_WORKSPACE="$test_root" \
ROADMAP_CODEX_BIN="$repo_root/tests/mock-codex.sh" \
ROADMAP_MOCK_STATE="$mock_state" \
ROADMAP_MAX_RUNS=3 \
  "$repo_root/skills/roadmap-runner/scripts/run-roadmap.sh" "$roadmap" > "$output"

[[ $(sed -n '1p' "$mock_state") == 2 ]]
grep -Fq 'continue (batch mock-1)' "$output"
grep -Fq 'local_complete (batch mock-2)' "$output"
[[ $(grep -c 'Mock evidence: RR-' "$roadmap") == 2 ]]

echo "Supervisor test passed"
