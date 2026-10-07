# Agent integration

Roadmap Runner now supports foreground runs, detached managed runs, local MCP
control, desktop attention alerts, app setup and a bundled roadmap design skill.
Node.js 20 or newer is required by the pinned `@modelcontextprotocol/server` 2.3.1
SDK. Installation alone does not edit app settings or start a run.

```sh
roadmap-runner setup --app codex --app claude --app grok --scope project --dry-run
roadmap-runner setup --app codex --scope project
roadmap-runner setup --app claude --scope user --workspace /absolute/project
roadmap-runner start roadmap.md --client codex --notify attention --json
roadmap-runner status <run-id> --json
roadmap-runner stop <run-id>
roadmap-runner mcp --workspace /absolute/project
```

`roadmap-runner roadmap.md` retains foreground output and exit codes. Foreground
and managed runs share workspace/progress exclusion. Worktrees allow independent
runs. A managed start returns after readiness; its worker survives CLI/MCP
connections closing. Stop first reports `stopping`; `stopped` follows process-tree
cleanup. Run IDs are local to the explicit workspace. Use `--idempotency-key` to
repeat an identical managed request; changing its options is rejected.

## Durable state and control

The private registry defaults to `~/Library/Application Support/roadmap-runner`
on macOS and `$XDG_STATE_HOME/roadmap-runner` (or `~/.local/state/roadmap-runner`)
on Linux. `ROADMAP_STATE_DIR` can relocate it. Run records contain canonical paths,
PID, private ownership token, heartbeat, options and terminal outcome. Atomic lock
publication reserves the workspace and progress path before launch. POSIX control
uses a private per-run Unix socket; management never sends signals to a stored PID.
Unreachable/stale records become `unknown`, not complete. Reservations remain while
a possibly live worker or recorded process group exists. Such orphaned processes
require operator inspection rather than guessing PID ownership.

Status separates process state, roadmap state and wait reason. It includes worker
role/iteration, source revision, quota reset/deadline, attention task IDs, artifacts,
recent output and events. Managed output is normalized even with supervision off,
stripped of terminal controls, redacted for known credential patterns and rotated
at 1 MiB. Lines exceeding 64 KiB are omitted. Treat output as untrusted project
content; pattern redaction cannot guarantee that arbitrary project text is public.
Raw supervisor evidence remains separate.

Managed event journals rotate at 1 MiB. Status defaults to an 8 KiB output tail,
up to 50 events within a 12 KiB event budget and a 32 KiB protocol response budget.
`cursor`, truncation flags and `cursorExpired` support replay. Partial trailing and
malformed records are excluded; malformed counts remain visible. Existing progress,
history and recovery journals stay compatible. Events add run IDs, sequence,
source revision, role/iteration, severity, attention and short reason codes.

## Desktop attention

`--notify attention` is the default; `--notify off` disables built-in delivery.
`ROADMAP_NOTIFY=off` is an environment equivalent. Alerts cover changed blockers,
needs-input tasks, terminal failure, capacity exhaustion and quota wait expiry.
Routine starts, completion, turns and recoverable quota waits remain quiet.
Benign SKIPPED flags alone do not cause an attention alert.

For quota alerts, add `--notify-on runner.usage_paused`. Turn and capacity limits
are separately selectable with `runner.turn_limit_reached` and
`runner.capacity_exhausted`. MCP starts accept the corresponding `notifyOn` array.
Preferences persist with the worker after the chat disconnects; changing an
existing watch is outside this release.

macOS uses an already installed `terminal-notifier` with no open/activate/execute
click action. AppleScript is deliberately excluded from the built-in backend:
clicking its notifications opens Script Editor. Linux uses an available
`notify-send` in a graphical D-Bus session. No system package is installed by the
runner. Missing/headless backends produce a bounded diagnostic and saved delivery
result while work continues. Submission does not prove a notification was seen.
Delivery uses a bounded asynchronous queue, pending-task coalescing and persisted
fingerprints; it is best effort across crashes. Alert bodies contain only a short
roadmap name, task IDs and an instruction to inspect status/progress.

`ROADMAP_NOTIFY_BIN` remains independent and receives journal metadata on stdin.
The older `examples/notify-macos.js` hook uses AppleScript and therefore retains
Script Editor attribution if explicitly selected.

## MCP and protocol support

The three tools are `roadmap_start`, `roadmap_stop` and read-only `roadmap_status`.
Status optionally accepts `runId`, `outputBytes` (0–8192), `cursor` and list `offset`.
State and event resources are `roadmap://<id>/state` and
`roadmap://<id>/events?cursor=<sequence>`. Model-controlled starts cannot select
executables, arbitrary commands or environment variables. Roadmap/progress paths
must remain inside the canonical configured workspace, including symlink checks.
Legacy client roots are checked when advertised. Spawned coding clients inherit a
worker context that prevents nested launches or control of their parent.

The pinned SDK negotiates legacy 2025 handshakes and serves modern 2026-07-28
per-request envelopes. Legacy clients use `resources/subscribe` and unsubscribe;
modern clients use filtered `subscriptions/listen`, including its acknowledgement
and subscription ID. Resource updates contain URIs, never model output. Prepared
exchanges validate both paths; actual host UI behavior remains unverified.
Experimental named events, webhooks, automatic chat wake-up and recovery-agent
dispatch are intentionally absent: no supported client contract was established.
Polling remains available after reconnects.

## App and skill setup

Project scope is the default. Codex and Grok use their project/user `config.toml`;
Claude uses project `.mcp.json` or user `~/.claude.json`. Registration uses an
absolute Node executable and installed package entrypoint with an explicit
workspace, including user scope. Claude's native registration is preferred when
available. TOML is parsed for validation and a single entry appended, preserving
existing comments. Conflicts preserve existing entries; edits are atomic and an
existing config gets a narrowly scoped `.roadmap-runner.bak`. Repeated matching
setup is unchanged. Grok requires the Grok Build MCP interface to be detected.
Project configuration may still require the app's normal project trust approval.

MCP, skill and connectivity outcomes are reported separately. The connectivity
check performs only MCP initialization and tools listing; it never starts a runner.
`--dry-run` reports paths, entries and commands without writing them.

The bundled `write-runner-roadmap` skill supports design/revision, dependency graphs,
session-sized task contracts and a template. A compatible installed `skills` 1.7.1
binary with copy support can install the local version into a temporary project;
setup verifies its contents and atomically publishes to the requested scope.
Unavailable/unqualified installers use an owned local copy in `.agents/skills`,
`.claude/skills` or `.grok/skills`. Setup does not download an installer. Ownership,
version and hashes allow safe upgrades; user-modified skills are preserved.
The deterministic structure checker covers task fields, IDs, dependency existence,
cycles, implementation-before-validation and release-only prerequisites. It cannot
establish task quality or small-model reliability.

Automated validation uses prepared JSON-RPC, mock coding CLIs and stub notification
transports. No paid provider, live desktop visibility or idle-chat behavior is
qualified. See [implementation evidence](agent-integration-evidence.md).

Protocol/configuration sources: [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk),
[Codex MCP](https://developers.openai.com/codex/mcp),
[Claude MCP](https://code.claude.com/docs/en/mcp),
[Grok Build MCP](https://docs.x.ai/build/features/mcp-servers), and
[skills CLI](https://github.com/vercel-labs/skills).
