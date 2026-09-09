#!/usr/bin/env bash
# The shell owns sequencing. Python only performs deterministic filesystem/process work.
set -u
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ "${1:-}" != "__loop" ]; then
    exec python3 "$HERE/runner.py" "$@"
fi
shift
child=""
interrupt() {
    trap '' INT TERM
    if [ -n "$child" ]; then
        kill -TERM "$child" 2>/dev/null || true
        wait "$child" 2>/dev/null || true
    fi
    exit "$1"
}
trap 'interrupt 130' INT
trap 'interrupt 143' TERM
while :; do
    python3 "$HERE/runner.py" __step "$@" &
    child=$!
    wait "$child"
    code=$?
    child=""
    case "$code" in
        0) ;;        # A bounded batch finished; start a fresh process.
        10) exit 0 ;; # All checkboxes are complete.
        *) exit "$code" ;;
    esac
done
