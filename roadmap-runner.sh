#!/usr/bin/env bash
set -eu
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec bash "$HERE/skills/roadmap-runner/scripts/roadmap-runner.sh" "$@"
