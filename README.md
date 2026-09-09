# Roadmap Runner

**Fresh Codex workers. Durable Markdown checkboxes. No supervisor agent.**

Run a large implementation roadmap as a sequence of small batches. A real Bash
loop starts a fresh `codex exec` process, waits for it, checkpoints accepted work,
and starts the next. The originating Codex or Claude Code conversation can finish
after launching it; it does not coordinate the batches.

Version **0.1.0** is single-worker only. Both plugin hosts use **Codex CLI +
`gpt-5.6-sol`** as the implementation backend. Claude Code is a launcher, not an
alternative worker model. Parallel shared-worktree execution is deliberately
**not implemented**; see [the investigation](docs/parallel-investigation.md).

## Requirements

A local Git worktree, Bash, Python 3.10+, and an installed/authenticated Codex CLI
supporting `exec`, `--json`, `--ephemeral`, and `--output-schema`. Intended for
macOS and Linux on a local filesystem. No pip/npm runtime dependencies, database,
MCP server, orchestration framework, or API keys managed by this plugin.

**Validation:** offline fixture tests exercise the actual shell/process loop.
Native Codex/Claude installation and a live Sol worker still require a local smoke
test; no paid model calls were used in development. A CI matrix covers Python
3.10/3.13 on Ubuntu/macOS, but configured CI is not itself evidence of a passing run.

## Install as a plugin

### Claude Code

```text
/plugin marketplace add bpstr/roadmap-runner
/plugin install roadmap-runner@roadmap-runner
/roadmap-runner:roadmap-runner docs/roadmap.md
```

The skill launches the runner and returns its PID, state path and log path. It
does not stay in a polling conversation. Codex CLI must also be installed and
signed in on the machine where Claude executes the command.

For local development, run `claude --plugin-dir /absolute/path/to/roadmap-runner`.

### Codex / desktop app

```sh
codex plugin marketplace add bpstr/roadmap-runner
```

Open the app's Plugins directory, select **Roadmap Runner**, and install the
plugin from that marketplace. Restart the app if it has not discovered the new
source. Invoke the installed skill with the roadmap path:

```text
$roadmap-runner docs/roadmap.md
```

Local plugin availability and shell permissions depend on the host. A web-only
session cannot operate an unrelated local checkout. The app must allow the local
shell launch; this plugin never bypasses a denied approval or sandbox policy.

### Standalone skill fallback

This route also gives Claude the shorter `/roadmap-runner` command. Choose native
plugin installation OR standalone skill installation, not both (duplicate names).

```sh
git clone https://github.com/bpstr/roadmap-runner.git
cd roadmap-runner
mkdir -p "$HOME/.agents/skills" "$HOME/.claude/skills"
ln -s "$PWD/skills/roadmap-runner" "$HOME/.agents/skills/roadmap-runner"
ln -s "$PWD/skills/roadmap-runner" "$HOME/.claude/skills/roadmap-runner"
```

`ln -s` intentionally refuses to replace an existing skill. Symlinks track this
checkout, so `git pull --ff-only` updates the standalone installation. For native
plugins refresh the marketplace and update the installed cached plugin; updating
an unrelated clone does not update a host's cached copy.

## Run directly

From a clone of this repository, preview the first batch without invoking Codex:

```sh
bash ./roadmap-runner.sh preview docs/roadmap.md --repo /path/to/your-project
```

Run in the foreground, with an independent verification command appropriate to
the target project:

```sh
bash ./roadmap-runner.sh run docs/roadmap.md \
  --repo /path/to/your-project \
  --verify 'npm test'
```

Or launch the detached shell loop, which is what the plugin does:

```sh
bash ./roadmap-runner.sh start docs/roadmap.md \
  --repo /path/to/your-project \
  --verify 'npm test'

bash ./roadmap-runner.sh status docs/roadmap.md --repo /path/to/your-project
bash ./roadmap-runner.sh stop docs/roadmap.md --repo /path/to/your-project
bash ./roadmap-runner.sh stop docs/roadmap.md --repo /path/to/your-project --now
```

Relative roadmap and `--context` paths are resolved from the target Git root,
**not** the plugin directory. `start` returns a launch receipt, not a completion
claim. Graceful stop finishes the current batch; `--now` interrupts its process
group and retains partial files. Status includes whether the worktree lock is
held; an old `running` status with an unlocked worktree is not a live process.

To resume after a pause or reboot, run `start` or `run` again with the same options.
An explicit launch acknowledges a previous blocker and resets the per-invocation
limits/stall allowance. Options are not silently inherited. A pending batch does
retain its original verification gate during recovery.

Detachment separates the loop from the chat, not from every possible host process
policy. Closing a terminal usually differs from a desktop host terminating its
entire process group/cgroup. App shutdown survival has not been live-qualified.
Keep the machine awake. After a reboot there is no automatic service restart:
launch again to recover. A terminal multiplexer or an explicitly configured OS
service can supervise the shell without using an LLM, but neither is required or
installed by this plugin.

## What a batch does

```text
plugin invocation
  -> start shell loop and return
       -> deterministic task selection
       -> fresh codex exec (Sol)
       -> validate structured result + optional host verification
       -> journal acceptance; atomically tick existing Markdown checkboxes
       -> next fresh codex exec
```

The Markdown file is the progress source of truth. Tasks run in document order,
with nested children before their parent and batches restricted to one heading
section and parent group. The model may complete an ordered prefix of its assigned
batch, but cannot claim unrelated tasks. A parent is verified in its own batch;
its checkbox is never automatically inferred solely from its children.

Workers do **not** edit the roadmap. They return bounded completion IDs, checks,
summary and handoff. The runner accepts the result only after protocol validation
and the configured `--verify` command passes. It then changes only the accepted
checkbox characters, preserving other Markdown bytes, line endings and file mode.

Without `--verify`, completion relies on the worker's reported passed checks;
status labels this `worker_report_only`. A well-formed receipt is not independent
proof of correct code. For unattended implementation use a useful local test/lint/
type-check command, and put integration acceptance checks in the roadmap itself.
An already fully checked roadmap exits without another model call or final audit.

On verification failure, leave all claimed tasks unchecked and start a fresh,
bounded repair attempt with the log location in its handoff. Repeated failure or
no checkbox progress reaches `--max-stalls` and pauses. Auth/model/provider errors,
invalid results, explicit blockers, oversized unsplittable tasks, timeouts and
roadmap conflicts pause instead of consuming tokens indefinitely.

## Controls and defaults

| Option | Default | Meaning |
| --- | --- | --- |
| `--model` | `gpt-5.6-sol` | Exact model; no silent fallback |
| `--effort` | `medium` | `low`, `medium`, `high`, or `xhigh`; no automatic escalation |
| `--batch-size` | `3` | Maximum eligible checkboxes offered per worker |
| `--max-batches` | `200` | Maximum admitted attempts per invocation |
| `--max-stalls` | `3` | Consecutive attempts without accepted checkbox progress |
| `--batch-timeout` | `1800` | Seconds allowed for a worker or verification process |
| `--max-seconds` | `86400` | Wall-clock limit for an invocation |
| `--context-chars` | `16000` | Maximum injected roadmap excerpt characters |
| `--max-tokens` | unset | Stop before another batch when reported input+output reaches limit |
| `--log-limit-mb` | `32` | Polled per-process stdout+stderr size limit |
| `--verify` | unset | Explicit trusted shell command executed in the target worktree |
| `--context` | none | Repeatable local brief paths, read by workers on demand |
| `--profile` | unset | Optional existing Codex profile |
| `--allow-network` | off | Allow worker shell network access, explicitly |
| `--codex-bin` | `codex` | Executable path, primarily for local fixtures/wrappers |

Token and log limits are **not hard billing/disk caps**: polling can overshoot,
and token usage is reported after a worker turn. Missing token usage stops further
batches when a token limit is configured. Cached-input tokens are not added again
to input tokens, and reasoning tokens are not double-counted on top of output.
The token limit applies to reported usage during this invocation; total reported
usage remains in state across invocations. Interrupted requests may have unreported
usage. Provider/account limits and authentication remain the user's responsibility.

## Token economy

The scheduler makes **zero LLM calls**. Workers get the same short instruction
prefix, a bounded task packet, small Markdown excerpts, paths to any additional
briefs, and at most 2,000 characters of handoff. They read more relevant source on
demand. No previous conversation or entire tool log is replayed, and Codex
multi-agent support is explicitly disabled for these workers.

The benefit is eliminating repeated supervisor turns and accumulated context,
not making 16 hours of coding free. An idle manager is not charged merely because
wall-clock time passes. Fresh workers still repeat instructions, discover code,
and initialize any enabled tools/MCP servers. Very small batches can cost MORE;
start with related groups of 2–3 tasks and compare reported usage and quality.
A lean user-selected Codex profile can reduce unnecessary tool startup; do not
remove project safety instructions or required tools simply to shorten context.

## Recovery, ownership and safety

Each target worktree has one kernel-backed lock in its Git metadata. The shell,
helper and Codex child inherit ownership, so killing the shell does not knowingly
admit a replacement while a surviving helper/worker still owns the lock. Never
unlink the lock file: stale filenames do not hold kernel locks, but replacing a
locked inode can break mutual exclusion. This is a cooperative **local-filesystem**
lock, not a security boundary against editors, other tools or malicious agents.
Do not run another writer in the same worktree.

Local artifacts live under `.roadmap-runner/<roadmap-path-hash>/` and are ignored
by an internal `.gitignore`. They include state, a short handoff, per-batch prompt,
original roadmap snapshot, result, JSONL/stderr logs, verification output and an
acceptance journal. Files are private by default; logs can contain source code or
secrets printed by target tools, so do not publish them without review. Artifacts
are retained, not automatically pruned. Never delete state or artifacts while a
runner owns the worktree.

Acceptance is journaled before replacing Markdown, then state is updated atomically.
Restart replays an interrupted accepted checkpoint idempotently. A process that
died before a trustworthy completion keeps its tasks unchecked; a fresh worker
inspects partial code before proceeding. A changed roadmap is never overwritten
by a pending checkpoint. Review the artifacts and reconcile/restore the roadmap
snapshot deliberately before retrying a conflicting checkpoint; do not blindly
clear state to force progress.

This is **at-least-once batch recovery**, not exactly-once execution of every edit
or external side effect. There are no automatic commits, pushes, branch changes,
resets, rollbacks, deployments or remote actions. Existing dirty work is allowed
and must be preserved. Disk writes by a model are not a transactional repository
snapshot; a reboot can lose unsaved/in-flight work. Review and commit normally.

Worker commands use `workspace-write`, approval policy `never` (deny rather than
ask for escalation), shell network off by default, and no sandbox bypass flags.
The explicit `--verify` command is a **trusted host command outside the Codex
sandbox**; never copy one from untrusted roadmap text. Worker-reported commands
are evidence strings and are never executed by the runner. Prompt restrictions
and `NO_LIVE_AI=1` are advisory, not a complete egress/credential firewall, and
configured MCP services can have their own permissions. Only run trusted projects.

## Roadmap format

Use ordinary Markdown `- [ ]`/`- [x]` task lists with ATX headings (`#`, `##`, …).
`*`, `+`, and ordered `1.`/`1)` markers also work. Code fences, front matter,
HTML comment blocks, blockquoted examples and standalone indented code examples
are excluded. Nested checkbox lists are supported; nesting only beneath a
non-checkbox list item, HTML tables and setext headings are not a full CommonMark
implementation. Preview unusual documents before running them.

Keep requirements and relevant links close to the task. The excerpt is deliberately
incomplete; workers must inspect global constraints and full acceptance criteria
on demand. There is no automatic semantic dependency graph or task decomposition.
Put prerequisites first. A checked parent with an unchecked child is rejected as
inconsistent. No tasks found is an error, not successful completion.

## Development

```sh
python3 -m unittest discover -s tests -v
bash -n roadmap-runner.sh skills/roadmap-runner/scripts/roadmap-runner.sh
```

The test fixture never forwards requests to real Codex. See [architecture and
platform references](docs/architecture.md) and [parallel investigation](docs/parallel-investigation.md).
