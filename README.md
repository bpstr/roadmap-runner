# Roadmap Runner

**One shell loop. Fresh Codex workers. The original roadmap.**

A small Codex + Claude Code plugin for implementing large Markdown roadmaps in
bounded batches, without a long-lived model coordinator. Bash starts a worker,
waits for its one-word result, then starts the next. The worker understands the
roadmap; the shell never reads, parses, counts, or rewrites its Markdown.

Version **0.2.1**. Bash 3.2+, standard Unix tools, and an installed/authenticated
Codex CLI. Intended for local Git checkouts on macOS/Linux. No Python, jq, database,
MCP server, task registry, generated IDs, parallel workers or extra worktrees.

## Install

Codex, using the repository marketplace:

```sh
codex plugin marketplace add bpstr/roadmap-runner
codex plugin add roadmap-runner@roadmap-runner
```

Start a new task after installation and invoke `$roadmap-runner` with your roadmap.

Claude Code:

```text
/plugin marketplace add bpstr/roadmap-runner
/plugin install roadmap-runner@roadmap-runner
/roadmap-runner:roadmap-runner /absolute/project/roadmap.md
```

For local plugin development: `claude --plugin-dir /absolute/path/to/roadmap-runner`.
Both hosts launch **Codex** workers; Claude Code is not a second worker backend.

The skill starts a detached shell and returns its PID/state/log paths. It does not
monitor the loop through another agent conversation. Host permissions still apply;
app shutdown may terminate child processes. No automatic reboot service is installed.
Native-host installation and live Sol execution must be smoke-tested locally.

## Run directly

From the target project, with the script in an installed plugin or repository clone:

```sh
RUNNER=/absolute/path/to/roadmap-runner/skills/roadmap-runner/scripts/run-roadmap.sh

bash "$RUNNER" version                           # version and installed script path
bash "$RUNNER" /absolute/project/roadmap.md        # foreground; original invocation
bash "$RUNNER" start /absolute/project/roadmap.md  # launch and return
bash "$RUNNER" status                            # read the global process record
bash "$RUNNER" stop                              # finish the current batch
bash "$RUNNER" stop now                          # interrupt the current batch
bash "$RUNNER" start                             # resume the last roadmap
```

Set `ROADMAP_WORKSPACE=/absolute/project` when launching from another directory.
When no roadmap is supplied, its path and workspace come from the saved global
state. Run options come from the current environment, not a hidden saved profile.
Use `ROADMAP_MAX_RUNS=1 bash "$RUNNER" ...` for a bounded first live trial; this
intentionally exits with `limit` if the worker says more work remains.

## Worker contract

Each fresh worker reads relevant instructions, specs and roadmap sections, checks
existing code/diffs for partial work, selects the next dependency-ready local
item, and implements/tests one small coherent batch (at most three related items).
It may use line references and targeted reads, but there are no shell-generated
cursors or task IDs. Line numbers are hints, never a replacement for requirements.

**The only permitted edits to the supplied roadmap are checkbox state changes.**
No notes, delivery records, run IDs, hidden comments, timestamps or reformatting.
Concise blocker/partial-work hints go to the transcript, not the roadmap. Other
project documentation may be updated when the task requires it.

The final worker response is exactly one lowercase word:

| Word | Shell behavior |
| --- | --- |
| `continue` | Start a fresh worker for the next local batch. |
| `retry` | Start a fresh worker to finish partial work, within the retry limit. |
| `complete` | Stop: the worker reports all roadmap criteria proven. |
| `local` | Stop: only external/non-local gates remain. |
| `blocked` | Stop: operator input or a prerequisite is needed. |
| `failed` | Stop: the worker cannot safely continue. |

Malformed/missing results and nonzero CLI exits stop immediately. `continue` resets
the retry counter. Run-count and timeout bounds apply even if a worker incorrectly
keeps asking to continue. These are process controls, **not semantic verification**:
the shell deliberately does not audit completion, enforce checkbox-only diffs, infer
dependencies or count checked boxes. Those responsibilities belong to the worker
and normal code review. No-op or false completion cannot be detected by this design.

## Validation environment blockers

A denied database/shared-memory/socket operation is not fixed by a fresh model.
The worker must preserve partial code, leave its validation-dependent checkbox
unchecked, and return `blocked` (exit 75) when no independent local work remains.
`retry` is only for work that can progress with existing permissions. A failed SQL
assertion is different from an unavailable test environment. The shell does not
parse error text or guess which one occurred; classification remains worker-owned.

Workers now check relevant validation prerequisites before substantial edits and
report the specific missing capability in the log. They must not skip the test,
claim `local`/`complete`, or silently broaden permissions to escape a local blocker.
This fix does not grant PostgreSQL System V IPC access through an OS sandbox.

`version`/`--version` reports the exact installed script without starting Codex.
`status` distinguishes `installed_version`/`installed_script` from the last run's
saved `version`/`script`. Launch receipts and run log boundaries identify the version.
An `RR-...` run with per-project `.codex/roadmap-runs/` logs was started by the legacy
runner, even if a newer checkout now exists. Update the actual cached plugin and
start a fresh task; an already running process does not hot-reload an update.
See [sandbox and upgrade troubleshooting](docs/troubleshooting.md) for recovery.

## One global process record

The only persistent process-state file is:

```text
~/.codex/roadmap-runner.state
```

It contains the roadmap path, workspace, supervisor PID, worker process-group ID,
batch number, status, model, runner version and script path. `CODEX_HOME` overrides `~/.codex`. The runner writes
it by atomic rename; it is data, never executable shell configuration. The worker
does not edit it. There is no task queue or per-task state in this file.

A single append-only `roadmap-runner.log` retains worker output for debugging.
A temporary `roadmap-runner.lock/` holds the current prompt/result, PID owner and
stop markers while active. It prevents accidental duplicate launches globally
within that Codex home, even across different projects. This is not multi-worker
coordination. No runner state, IDs or logs are added to the target project.

On a normal stop, the temporary lock is removed; the state and log remain. After
an abrupt shutdown, use `status`, inspect any surviving worker, then `recover` and
`start`. Recovery refuses a possibly live owner/group or an uncertain empty lock;
it never kills an unrelated saved PID or automatically steals a stale-looking lock.
An incomplete lock or reused PID can require manual inspection. Stop old v0.1
supervisors before upgrading: their per-roadmap locks are not shared with v0.2.

Resume uses checkboxes and the actual code/diffs, not a resumed model conversation.
Partial changes are preserved, not rolled back or committed automatically. This is
not an exactly-once guarantee or a transactional backup of code edits. Unsaved work
can be lost in a crash. Status is a last-written record; `locked=yes` alone does
not prove a process is alive. Logs are private by default and may contain source
or secrets printed by project tools; review before sharing and prune while stopped.

## Controls

| Environment variable | Default |
| --- | --- |
| `ROADMAP_MODEL` | `gpt-5.6-sol` (no silent fallback) |
| `ROADMAP_EFFORT` | `medium` |
| `ROADMAP_MAX_RUNS` | `100` workers per invocation |
| `ROADMAP_MAX_FAILURES` | `2` consecutive `retry` responses |
| `ROADMAP_TIMEOUT` | `1800` seconds per worker, plus bounded shutdown grace |
| `ROADMAP_WORKSPACE` | Current directory, or saved workspace on no-path resume |
| `ROADMAP_CODEX_BIN` | `codex` |

The loop makes no LLM calls of its own. Workers still consume tokens and repeat some
context discovery. There is no token/dollar accounting or hard spending cap in this
small shell implementation. Configure account limits separately; no savings
percentage is claimed without measurement.

Workers use `workspace-write`, no approval escalation, shell network disabled, and
fresh ephemeral sessions. Multi-agent support is disabled. The prompt excludes
commits, pushes, deployment, destructive actions and paid/live API tests. This is
not a firewall against all configured tools/MCP services or malicious local code;
run trusted projects and preserve host permissions.

## Development

```sh
bash tests/supervisor-test.sh
bash -n skills/roadmap-runner/scripts/run-roadmap.sh
```

The suite uses a fake Codex executable only, including timeout, stop, launch,
recovery, strict results and the intentional trust boundary around Markdown.
Never run paid/live models in CI. See `AGENTS.md` for the design constraints.

CLI behavior references: [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[Codex commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli),
and [Claude Code plugins](https://code.claude.com/docs/en/plugins).
