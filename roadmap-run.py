#!/usr/bin/env python3
"""Stream concise Codex output and terminate the active process tree on signals."""

import json
import os
import signal
import subprocess
import sys
import time


def descendants(root):
    rows = subprocess.check_output(["ps", "-axo", "pid=,ppid="], text=True)
    parents = [tuple(map(int, row.split())) for row in rows.splitlines()]
    found = {root}
    while True:
        children = {pid for pid, parent in parents if parent in found}
        if children <= found:
            return found
        found |= children


def send(pid, sig):
    try:
        os.kill(pid, sig)
    except ProcessLookupError:
        pass


def run():
    process = None

    def stop(signum, _frame):
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        if process is not None:
            targets = descendants(process.pid)
            # Stop creation of new descendants before signaling the captured tree.
            for pid in targets:
                send(pid, signal.SIGSTOP)
            targets |= descendants(process.pid)
            for pid in targets:
                send(pid, signal.SIGTERM)
                send(pid, signal.SIGCONT)
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                process.poll()
                alive = set()
                for pid in targets:
                    try:
                        os.kill(pid, 0)
                        alive.add(pid)
                    except ProcessLookupError:
                        pass
                if not alive:
                    break
                time.sleep(0.05)
            for pid in targets:
                send(pid, signal.SIGKILL)
            process.wait()
        raise SystemExit(128 + signum)

    # The shell forwards Ctrl-C as TERM; don't inherit background-job SIGINT ignore.
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    with open(sys.argv[1], "w") as errors:
        process = subprocess.Popen(
            sys.argv[2:], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=errors, text=True, start_new_session=True,
        )
        try:
            for line in process.stdout:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    print(line.rstrip(), file=sys.stderr, flush=True)
                    continue
                kind = event.get("type")
                if kind == "item.completed":
                    item = event.get("item", {})
                    if item.get("type") == "agent_message":
                        print(item.get("text", ""), flush=True)
                elif kind in ("error", "turn.failed"):
                    error = event.get("error", event)
                    message = error.get("message", str(error)) if isinstance(error, dict) else str(error)
                    print("Codex error: " + message, file=sys.stderr, flush=True)
        except (BrokenPipeError, ValueError):
            stop(signal.SIGTERM, None)
        returncode = process.wait()
        return returncode if returncode >= 0 else 128 - returncode


if __name__ == "__main__":
    sys.exit(run())
