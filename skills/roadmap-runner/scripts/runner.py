#!/usr/bin/env python3
"""Deterministic helpers for the shell loop. Python 3.10+, Unix, no dependencies."""
from __future__ import annotations

import argparse
import collections
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

HERE = Path(__file__).resolve().parent
VERSION = "0.1.0"
CHECK = re.compile(r"^(?P<indent>[ \t]*)(?:[-+*]|\d+[.)])\s+\[(?P<mark>[ xX])\]\s+(?P<title>.+?)\s*$")
HEADING = re.compile(r"^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$")
FENCE = re.compile(r"^[ \t]*(`{3,}|~{3,})(.*)$")
MAX_DOCUMENT = 8 * 1024 * 1024


class Halt(Exception):
    """A recoverable, fail-closed stop, not a reason to launch more agents."""


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_bytes(path: Path, limit: int = MAX_DOCUMENT) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise Halt(f"Expected a regular, non-symlink file: {path}")
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise Halt(f"File exceeds {limit} bytes: {path}")
    return data


def atomic(path: Path, data: bytes) -> None:
    """Same-directory replace + file/directory fsync; preserve existing mode."""
    if path.is_symlink():
        raise Halt(f"Refusing to replace symlink: {path}")
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    fd, name = tempfile.mkstemp(prefix=".rr-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def load(path: Path) -> dict:
    value = json.loads(read_bytes(path, 1024 * 1024))
    if not isinstance(value, dict):
        raise Halt(f"Expected JSON object: {path}")
    return value


def save(path: Path, value: dict) -> None:
    atomic(path, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode())


def mkdir(path: Path) -> None:
    if path.is_symlink():
        raise Halt(f"Refusing symlink directory: {path}")
    path.mkdir(mode=0o700, exist_ok=True)


def parse(data: bytes) -> tuple[list[str], list[dict]]:
    """Roadmap task-list subset; ignore fences, comments, YAML and quoted examples."""
    lines = data.decode("utf-8-sig").splitlines(keepends=True)
    tasks, headings, parents = [], [], []
    occurrences: collections.Counter = collections.Counter()
    fence = None
    comment = False
    frontmatter = bool(lines and lines[0].strip() == "---")
    for n, line in enumerate(lines):
        stripped = line.strip()
        if frontmatter:
            if n and stripped in ("---", "..."):
                frontmatter = False
            continue
        match = FENCE.match(line)
        if fence:
            if match and match[1][0] == fence[0] and len(match[1]) >= fence[1] and not match[2].strip():
                fence = None
            continue
        if comment or stripped.startswith("<!--"):
            comment = "-->" not in line
            continue
        if match:
            fence = (match[1][0], len(match[1]))
            continue
        if "<!--" in line and "-->" not in line.split("<!--", 1)[1]:
            comment = True
        heading = HEADING.match(line)
        if heading:
            level = len(heading[1])
            headings = [h for h in headings if h[0] < level]
            headings.append((level, n, heading[2]))
            parents = []
            continue
        match = CHECK.match(line.rstrip("\r\n"))
        if not match:
            continue
        indent = len(match["indent"].expandtabs(4))
        while parents and parents[-1]["indent"] >= indent:
            parents.pop()
        if indent >= 4 and not parents:
            continue  # A standalone indented code example, not a root task.
        title = match["title"]
        identity = json.dumps(([h[2] for h in headings], [p["title"] for p in parents], title))
        key = digest(identity.encode())[:12]
        occurrences[key] += 1
        task = {"id": f"t-{key}-{occurrences[key]}", "line": n + 1,
                "mark": match.start("mark"), "title": title, "indent": indent,
                "checked": match["mark"].lower() == "x",
                "section": [h[2] for h in headings],
                "parent": parents[-1]["id"] if parents else None}
        tasks.append(task)
        parents.append(task)
    by_id = {t["id"]: t for t in tasks}
    for task in tasks:
        parent = task["parent"]
        while parent:
            if not task["checked"] and by_id[parent]["checked"]:
                raise Halt(f"Checked parent has an unchecked child at line {task['line']}")
            parent = by_id[parent]["parent"]
    if not tasks:
        raise Halt("No supported checklist tasks found; provide - [ ] tasks outside examples.")
    return lines, tasks


def select(tasks: list[dict], size: int) -> list[dict]:
    ancestors = {t["parent"] for t in tasks if not t["checked"] and t["parent"]}
    ready = [t for t in tasks if not t["checked"] and t["id"] not in ancestors]
    if not ready:
        return []
    selected = []
    for task in ready:
        if (task["section"], task["parent"]) != (ready[0]["section"], ready[0]["parent"]):
            break
        selected.append(task)
        if len(selected) == size:
            break
    return selected


def packet(config: dict, data: bytes, handoff: str = "") -> tuple[str, list[dict]]:
    lines, tasks = parse(data)
    batch = select(tasks, config["batch_size"])
    # Small overview and local task windows. Full criteria remain available on disk.
    indices = set(range(min(24, len(lines))))
    for task in batch:
        indices.update(range(max(0, task["line"] - 5), min(len(lines), task["line"] + 30)))
    excerpt = "".join(f"{i+1}: {lines[i]}" for i in sorted(indices))[:config["context_chars"]]
    payload = {"roadmap": config["roadmap"], "tasks": batch, "handoff": handoff[-2000:],
               "context_files": config["context"], "excerpt_is_incomplete": True,
               "roadmap_excerpt": excerpt, "host_verification": config["verify"]}
    prompt = (HERE / "worker-prompt.md").read_text() + "\nBATCH_JSON_BEGIN\n" + json.dumps(payload, ensure_ascii=False) + "\nBATCH_JSON_END\n"
    if len(prompt) > config["context_chars"] + 16000:
        raise Halt("Selected task metadata is too large; reduce --batch-size or split the checkbox.")
    return prompt, batch


def updated(data: bytes, completed: list[str]) -> bytes:
    lines, tasks = parse(data)
    for task in tasks:
        if task["id"] in completed:
            n, offset = task["line"] - 1, task["mark"]
            lines[n] = lines[n][:offset] + "x" + lines[n][offset + 1:]
    prefix = b"\xef\xbb\xbf" if data.startswith(b"\xef\xbb\xbf") else b""
    return prefix + "".join(lines).encode("utf-8")


def receipt(path: Path, assigned: list[str]) -> dict:
    value = json.loads(read_bytes(path, 65536))
    expected = {"status", "completed_ids", "summary", "handoff", "checks"}
    if not isinstance(value, dict) or set(value) != expected:
        raise Halt("Invalid result fields; no checkboxes accepted.")
    ids = value["completed_ids"]
    if not isinstance(ids, list) or any(not isinstance(x, str) for x in ids) or ids != assigned[:len(ids)]:
        raise Halt("Completion IDs must be an ordered prefix of the assigned batch.")
    if value["status"] not in ("progress", "blocked", "needs_split"):
        raise Halt("Unknown worker status.")
    for field, limit in (("summary", 1200), ("handoff", 2000)):
        if not isinstance(value[field], str) or len(value[field]) > limit:
            raise Halt(f"Invalid or oversized {field}.")
    checks = value["checks"]
    if not isinstance(checks, list) or len(checks) > 30:
        raise Halt("Invalid checks list.")
    for check in checks:
        if not isinstance(check, dict) or set(check) != {"command", "outcome", "detail"}:
            raise Halt("Invalid check record.")
        if any(not isinstance(v, str) or len(v) > 2000 for v in check.values()):
            raise Halt("Invalid check text.")
        if not check["command"].strip() or check["outcome"] not in ("passed", "failed", "not_run"):
            raise Halt("Invalid check outcome.")
    if ids and (not checks or any(c["outcome"] != "passed" for c in checks)):
        raise Halt("Completion requires passed checks, without failures or skipped checks.")
    return value


def usage(path: Path) -> dict:
    total = {"input_tokens": 0, "output_tokens": 0, "cached_input_tokens": 0, "reported": False}
    if not path.exists():
        return total
    # Bounded memory even when tools emit enormous lines. Never replay logs to an agent.
    with path.open("rb") as stream:
        while chunk := stream.readline(1024 * 1024):
            if not chunk.endswith(b"\n"):
                while chunk and not chunk.endswith(b"\n"):
                    chunk = stream.readline(1024 * 1024)
                continue
            try:
                event = json.loads(chunk)
                fields = event.get("usage") if event.get("type") == "turn.completed" else None
                if isinstance(fields, dict) and all(type(fields.get(k)) is int and fields[k] >= 0 for k in ("input_tokens", "output_tokens")):
                    total["reported"] = True
                    for key in ("input_tokens", "output_tokens", "cached_input_tokens"):
                        v = fields.get(key, 0)
                        total[key] += v if type(v) is int and v >= 0 else 0
            except (ValueError, AttributeError):
                continue
    return total


def command(config: dict, directory: Path) -> list[str]:
    cmd = [config["codex_bin"], "--ask-for-approval", "never"]
    if config["profile"]:
        cmd += ["--profile", config["profile"]]
    return cmd + ["exec", "--model", config["model"], "--sandbox", "workspace-write",
                  "-c", f'model_reasoning_effort="{config["effort"]}"',
                  "-c", "features.multi_agent=false",
                  "-c", "sandbox_workspace_write.network_access=" + str(config["allow_network"]).lower(),
                  "--ephemeral", "--json", "--color", "never", "--cd", config["repo"],
                  "--output-schema", str(HERE / "result.schema.json"),
                  "--output-last-message", str(directory / "result.json"), "-"]


def end_group(proc: subprocess.Popen) -> None:
    # Kill only the process group created for this child, never a saved/reused PID.
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    proc.wait()


def execute(cmd: list[str], config: dict, directory: Path, fd: int,
            stdin: Path | None, output: str, error: str) -> int:
    env = dict(os.environ, ROADMAP_RUNNER_WORKER="1", NO_LIVE_AI="1")
    with (stdin.open("rb") if stdin else open(os.devnull, "rb")) as inp, \
            (directory / output).open("wb") as out, (directory / error).open("wb") as err:
        proc = subprocess.Popen(cmd, cwd=config["repo"], stdin=inp, stdout=out, stderr=err,
                                env=env, start_new_session=True, pass_fds=(fd,))
        started = time.monotonic()
        try:
            while proc.poll() is None:
                if (Path(config["state_dir"]) / "CANCEL").exists():
                    raise Halt("Immediate stop requested; partial work preserved.")
                if time.monotonic() - started >= config["batch_timeout"]:
                    raise Halt("Batch/verification timeout; partial work preserved.")
                if time.time() >= config["deadline"]:
                    raise Halt("Run wall-clock limit reached; partial work preserved.")
                if sum(p.stat().st_size for p in (directory / output, directory / error)) > config["log_limit_mb"] * 1024 * 1024:
                    raise Halt("Per-process log limit reached; partial work preserved.")
                time.sleep(0.2)
            return proc.returncode
        finally:
            end_group(proc)


def state_path(config: dict) -> Path:
    return Path(config["state_dir"]) / "state.json"


def read_state(config: dict) -> dict:
    state = load(state_path(config))
    if state.get("version") != 1 or state.get("roadmap") != config["roadmap"]:
        raise Halt("State identity/version mismatch; inspect rather than resetting it.")
    for name in ("attempts", "tokens", "stalls", "usage_missing"):
        if type(state.get(name)) is not int or state[name] < 0:
            raise Halt(f"Invalid state counter: {name}")
    if not isinstance(state.get("handoff"), str):
        raise Halt("Invalid recovery handoff.")
    pending = state.get("pending")
    if pending is not None:
        if not isinstance(pending, dict) or not isinstance(pending.get("directory"), str):
            raise Halt("Invalid pending checkpoint.")
        directory = Path(pending["directory"])
        if directory.resolve().parent != Path(config["state_dir"]).resolve() or not re.fullmatch(r"batch-\d{6,}", directory.name):
            raise Halt("Pending checkpoint is outside this roadmap's artifact directory.")
        if not isinstance(pending.get("assigned"), list) or any(not isinstance(x, str) for x in pending["assigned"]):
            raise Halt("Invalid pending task IDs.")
    return state


def write_state(config: dict, state: dict, status: str, message: str) -> None:
    state.update(status=status, message=message, updated_at=time.time())
    save(state_path(config), state)
    print(json.dumps({"status": status, "message": message, "attempts": state["attempts"],
                      "tokens": state["tokens"]}), flush=True)


def checkpoint(config: dict, state: dict, directory: Path) -> None:
    """Replay an accepted journal after a crash, including after Markdown replacement."""
    accepted = load(directory / "accepted.json")
    before = read_bytes(directory / "roadmap.before.md")
    after = updated(before, accepted["completed_ids"])
    current = read_bytes(Path(config["roadmap"]))
    if digest(before) != accepted["before_sha"] or digest(after) != accepted["after_sha"]:
        raise Halt("Checkpoint journal checksum mismatch.")
    if current == before:
        atomic(Path(config["roadmap"]), after)
    elif current != after:
        raise Halt("Roadmap changed outside the runner; refusing to overwrite it. Inspect pending artifacts.")
    ids = accepted["completed_ids"]
    state.update(pending=None, handoff=accepted["handoff"], stalls=0 if ids else state["stalls"] + 1)
    state["tokens"] += accepted["usage"]["input_tokens"] + accepted["usage"]["output_tokens"]
    state["usage_missing"] = state.get("usage_missing", 0) + int(not accepted["usage"]["reported"])
    state["last_result"] = accepted["status"]
    state["verification"] = accepted.get("verification", "worker_report_only")
    write_state(config, state, "checkpointed", accepted["summary"] or f"Accepted {len(ids)} tasks")


def accept(config: dict, state: dict, directory: Path, fd: int) -> bool:
    before = read_bytes(directory / "roadmap.before.md")
    pending = state["pending"]
    if read_bytes(Path(config["roadmap"])) != before:
        raise Halt("Roadmap changed during a batch; refusing to overwrite it.")
    counts = usage(directory / "events.jsonl")
    try:
        value = receipt(directory / "result.json", pending["assigned"])
    except (Halt, ValueError, OSError) as exc:
        save(directory / "rejected.json", {"reason": str(exc)})
        state.update(pending=None, stalls=state["stalls"] + 1,
                     handoff=f"Previous result was rejected: {exc}. Inspect partial code. Artifacts: {directory}")
        state["tokens"] += counts["input_tokens"] + counts["output_tokens"]
        state["usage_missing"] = state.get("usage_missing", 0) + int(not counts["reported"])
        raise Halt(state["handoff"]) from exc
    # Recovery must not accidentally remove a verification gate from the original batch.
    verify = pending.get("verify", config["verify"])
    if verify and value["completed_ids"]:
        rc = execute(["/bin/sh", "-c", verify], config, directory, fd, None, "verify.log", "verify.stderr.log")
        save(directory / "verification.json", {"returncode": rc, "command": verify})
        if rc:
            state.update(pending=None, stalls=state["stalls"] + 1,
                         handoff=f"Host verification FAILED (exit {rc}). Inspect {directory / 'verify.log'} and verify.stderr.log. Repair the implementation; do not weaken tests.")
            state["tokens"] += counts["input_tokens"] + counts["output_tokens"]
            state["usage_missing"] = state.get("usage_missing", 0) + int(not counts["reported"])
            write_state(config, state, "verification_failed", state["handoff"])
            return False
    value.update(before_sha=digest(before), after_sha=digest(updated(before, value["completed_ids"])), usage=counts,
                 verification="host_command" if verify else "worker_report_only")
    save(directory / "accepted.json", value)  # WAL before Markdown, then atomic state.
    checkpoint(config, state, directory)
    return True


def step(config: dict, fd: int) -> int:
    state = read_state(config)
    try:
        # Resolve an interrupted checkpoint before selecting any new work.
        if state.get("pending"):
            directory = Path(state["pending"]["directory"])
            if (directory / "accepted.json").exists():
                checkpoint(config, state, directory)
            elif (directory / "execution.json").exists() and load(directory / "execution.json").get("returncode") == 0 and (directory / "result.json").exists():
                accept(config, state, directory, fd)
            else:
                snapshot = directory / "roadmap.before.md"
                if snapshot.exists() and read_bytes(Path(config["roadmap"])) != read_bytes(snapshot):
                    raise Halt("Interrupted worker or editor changed the roadmap; inspect pending artifacts before recovery.")
                counts = usage(directory / "events.jsonl")
                state["tokens"] += counts["input_tokens"] + counts["output_tokens"]
                state["usage_missing"] = state.get("usage_missing", 0) + int((directory / "command.json").exists() and not counts["reported"])
                state.update(pending=None, stalls=state["stalls"] + 1,
                             handoff=f"Previous attempt interrupted/failed. Inspect existing code and git diff before retrying unchecked tasks. Artifacts: {directory}")
                write_state(config, state, "recovering", state["handoff"])
        if state.get("last_result") in ("blocked", "needs_split"):
            raise Halt(f"Worker reported {state['last_result']}: {state.get('handoff', '')}")
        if any((Path(config["state_dir"]) / marker).exists() for marker in ("STOP", "CANCEL")):
            raise Halt("Stop requested; last checkpoint preserved.")
        data = read_bytes(Path(config["roadmap"]))
        prompt, batch = packet(config, data, state.get("handoff", ""))
        if not batch:
            write_state(config, state, "completed", "All supported roadmap checkboxes are checked.")
            return 10
        if state["attempts"] - config["base_attempts"] >= config["max_batches"]:
            raise Halt("Maximum batches reached.")
        if state["stalls"] >= config["max_stalls"]:
            raise Halt("No checkbox progress within --max-stalls; review or split the current task.")
        if time.time() >= config["deadline"]:
            raise Halt("Run wall-clock limit reached.")
        if config["max_tokens"] is not None:
            if state.get("usage_missing", 0) > config["base_usage_missing"]:
                raise Halt("Token usage was not reported; refusing another batch with a token limit configured.")
            if state["tokens"] - config["base_tokens"] >= config["max_tokens"]:
                raise Halt("Reported token boundary limit reached (not an in-flight billing cap).")
        state["attempts"] += 1
        directory = Path(config["state_dir"]) / f"batch-{state['attempts']:06d}"
        if directory.exists():
            raise Halt(f"Unexpected pre-existing batch directory: {directory}")
        # Reserve the attempt before creating artifacts, eliminating the mkdir/crash gap.
        state["pending"] = {"directory": str(directory), "assigned": [t["id"] for t in batch], "verify": config["verify"]}
        write_state(config, state, "preparing", f"Batch {state['attempts']}: {len(batch)} tasks")
        mkdir(directory)
        atomic(directory / "roadmap.before.md", data)
        atomic(directory / "prompt.md", prompt.encode())
        write_state(config, state, "running", f"Batch {state['attempts']}: {len(batch)} tasks")
        cmd = command(config, directory)
        save(directory / "command.json", {"argv": cmd})
        rc = execute(cmd, config, directory, fd, directory / "prompt.md", "events.jsonl", "stderr.log")
        save(directory / "execution.json", {"returncode": rc})
        if rc:
            raise Halt(f"Codex exited {rc}; inspect {directory / 'stderr.log'}. No automatic provider/auth retry.")
        accept(config, state, directory, fd)
        if state.get("last_result") in ("blocked", "needs_split"):
            raise Halt(f"Worker reported {state['last_result']}: {state.get('handoff', '')}")
        return 0
    except (Halt, KeyboardInterrupt, OSError, ValueError) as exc:
        write_state(config, state, "paused", str(exc) or "Interrupted; partial work preserved.")
        return 2


def resolve(args: argparse.Namespace) -> dict:
    result = subprocess.run(["git", "-C", str(Path(args.repo).expanduser()), "rev-parse", "--show-toplevel"], text=True, capture_output=True)
    if result.returncode:
        raise Halt("--repo must be inside an existing Git working tree.")
    root = Path(result.stdout.strip()).resolve()
    candidate = Path(args.roadmap).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    if candidate.is_symlink():
        raise Halt("Roadmap must not be a symlink.")
    roadmap = candidate.resolve()
    if not roadmap.is_relative_to(root) or roadmap.suffix.lower() not in (".md", ".markdown"):
        raise Halt("Roadmap must be a Markdown file inside --repo.")
    if args.action not in ("stop", "status"):
        parse(read_bytes(roadmap))
    config = vars(args).copy()
    config.update(repo=str(root), roadmap=str(roadmap), state_dir=str(root / ".roadmap-runner" / digest(str(roadmap.relative_to(root)).encode())[:16]))
    if "context" in config:
        resolved = []
        for value in config["context"]:
            path = Path(value).expanduser()
            path = (path if path.is_absolute() else root / path).resolve()
            if not path.is_relative_to(root) or not path.is_file():
                raise Halt(f"Context file must exist inside the worktree: {value}")
            resolved.append(str(path))
        config["context"] = resolved
    return config


def lock_path(config: dict) -> Path:
    result = subprocess.run(["git", "-C", config["repo"], "rev-parse", "--git-path", "roadmap-runner.lock"], text=True, capture_output=True, check=True)
    path = Path(result.stdout.strip())
    return path if path.is_absolute() else Path(config["repo"]) / path


def acquire(config: dict) -> int:
    # Never unlink a lock file: doing so can produce two separately locked inodes.
    fd = os.open(lock_path(config), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        os.close(fd)
        raise Halt("Another runner/worker owns this worktree. Do not remove the lock file.") from exc
    os.set_inheritable(fd, True)
    return fd


def launch(config: dict, detached: bool) -> int:
    if os.environ.get("ROADMAP_RUNNER_WORKER"):
        raise Halt("Workers cannot recursively launch roadmap-runner.")
    executable = shutil.which(config["codex_bin"])
    if not executable:
        raise Halt("Codex CLI not found. Install and authenticate it first; no automatic install or model fallback.")
    config["codex_bin"] = executable
    fd = acquire(config)
    try:
        parent = Path(config["state_dir"]).parent
        mkdir(parent)
        if not (parent / ".gitignore").exists():
            atomic(parent / ".gitignore", b"*\n")
        state_dir = Path(config["state_dir"])
        mkdir(state_dir)
        if state_path(config).exists():
            state = read_state(config)
            # An explicit launch acknowledges a previous blocked/stalled stop, not a pending receipt.
            state.update(stalls=0, last_result="progress")
        else:
            state = {"version": 1, "roadmap": config["roadmap"], "attempts": 0, "tokens": 0,
                     "usage_missing": 0, "stalls": 0, "handoff": "", "pending": None}
        for marker in ("STOP", "CANCEL"):
            (state_dir / marker).unlink(missing_ok=True)
        config.update(deadline=time.time() + config["max_seconds"], base_attempts=state["attempts"],
                      base_tokens=state["tokens"], base_usage_missing=state.get("usage_missing", 0))
        session = state_dir / ("session-" + uuid.uuid4().hex + ".json")
        save(session, config)
        write_state(config, state, "starting", f"{config['model']} / {config['effort']}; no LLM coordinator")
        env = dict(os.environ, ROADMAP_RUNNER_LOCK_FD=str(fd), ROADMAP_RUNNER_LOCK_PATH=str(lock_path(config)))
        cmd = ["bash", str(HERE / "roadmap-runner.sh"), "__loop", str(session)]
        if detached:
            with (state_dir / "runner.log").open("ab") as log:
                proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                        env=env, start_new_session=True, pass_fds=(fd,))
            save(state_dir / "launcher.json", {"pid": proc.pid, "session": str(session)})
            print(json.dumps({"status": "launched", "pid": proc.pid, "state": str(state_path(config)), "log": str(state_dir / "runner.log")}), flush=True)
            return 0
        os.execvpe(cmd[0], cmd, env)
    finally:
        os.close(fd)
    return 0


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", action="version", version=VERSION)
    sub = parser.add_subparsers(dest="action", required=True)
    for action in ("run", "start", "preview", "status", "stop"):
        p = sub.add_parser(action)
        p.add_argument("roadmap", help="Absolute path or path relative to --repo")
        p.add_argument("--repo", default=".")
        if action == "stop":
            p.add_argument("--now", action="store_true", help="Interrupt the worker instead of stopping after its batch")
        if action in ("run", "start", "preview"):
            p.add_argument("--model", default="gpt-5.6-sol")
            p.add_argument("--effort", choices=("low", "medium", "high", "xhigh"), default="medium")
            p.add_argument("--codex-bin", default=os.environ.get("ROADMAP_RUNNER_CODEX_BIN", "codex"))
            p.add_argument("--profile")
            p.add_argument("--batch-size", type=int, default=3)
            p.add_argument("--max-batches", type=int, default=200)
            p.add_argument("--max-stalls", type=int, default=3)
            p.add_argument("--max-seconds", type=int, default=86400)
            p.add_argument("--batch-timeout", type=int, default=1800)
            p.add_argument("--context-chars", type=int, default=16000)
            p.add_argument("--log-limit-mb", type=int, default=32)
            p.add_argument("--max-tokens", type=int)
            p.add_argument("--context", action="append", default=[], help="Additional brief path; read on demand, not injected")
            p.add_argument("--verify", help="Trusted local command run by host before accepting completed IDs")
            p.add_argument("--allow-network", action="store_true", help="Permit worker shell network access; off by default")
    args = parser.parse_args()
    for key in ("batch_size", "max_batches", "max_stalls", "max_seconds", "batch_timeout", "context_chars", "log_limit_mb", "max_tokens"):
        value = getattr(args, key, None)
        if value is not None and value <= 0:
            parser.error(f"--{key.replace('_', '-')} must be positive")
    return args


def main() -> int:
    if len(sys.argv) == 3 and sys.argv[1] == "__step":
        config = load(Path(sys.argv[2]))
        fd = int(os.environ["ROADMAP_RUNNER_LOCK_FD"])
        held, expected = os.fstat(fd), lock_path(config).stat()
        if (held.st_dev, held.st_ino) != (expected.st_dev, expected.st_ino):
            raise Halt("Internal step requires the inherited worktree lock.")
        def interrupted(*_):
            raise KeyboardInterrupt()
        signal.signal(signal.SIGTERM, interrupted)
        return step(config, fd)
    args = arguments()
    config = resolve(args)
    if args.action == "preview":
        prompt, batch = packet(config, read_bytes(Path(config["roadmap"])))
        print(prompt if batch else "All checkboxes already complete.")
        return 0
    if args.action == "status":
        _, tasks = parse(read_bytes(Path(config["roadmap"])))
        state = load(state_path(config)) if state_path(config).exists() else {"status": "not_started"}
        # PID is diagnostic only; lock state determines whether a worker may be alive.
        try:
            fd = acquire(config)
            os.close(fd)
            active = False
        except Halt:
            active = True
        print(json.dumps({"state": state, "lock_held": active, "checked": sum(t["checked"] for t in tasks), "total": len(tasks)}, indent=2))
        return 0
    if args.action == "stop":
        directory = Path(config["state_dir"])
        if not directory.exists():
            raise Halt("No run state exists for this roadmap.")
        atomic(directory / ("CANCEL" if args.now else "STOP"), b"requested\n")
        print("Stop requested; use status to confirm that the worktree lock is released.")
        return 0
    return launch(config, args.action == "start")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Halt, OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        print(f"roadmap-runner: {exc}", file=sys.stderr)
        sys.exit(2)
