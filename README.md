# Roadmap Runner

Run a long Markdown implementation roadmap through fresh coding-agent CLI sessions until it is complete.

The goal is to start one command, let it keep working for **8–10 hours or longer** on a large roadmap without human approval prompts, and have it stop automatically when the roadmap is finished.

Each implementation batch gets a fresh CLI session. The roadmap and filesystem are the durable handoff between runs, so context does not grow forever.

## Install

From GitHub:

```sh
npm install -g github:bpstr/roadmap-runner
```

Update later:

```sh
npm install -g github:bpstr/roadmap-runner@main
```

This installs:

```sh
roadmap-runner
```

There is only one Node CLI implementation and one versioned `prompt.md`, so installed copies can be refreshed with the same npm command.

## Usage

Run from the workspace you want the agent to operate in:

```sh
cd /path/to/workspace
roadmap-runner docs/roadmap.md
```

The current `pwd` is always the workspace. It may contain multiple Git repositories.

Default client:

```sh
roadmap-runner docs/roadmap.md
# same as:
roadmap-runner docs/roadmap.md --client codex
```

Other adapters:

```sh
roadmap-runner docs/roadmap.md --client claude
roadmap-runner docs/roadmap.md --client gemini
roadmap-runner docs/roadmap.md --client grok
roadmap-runner docs/roadmap.md --client muse
roadmap-runner docs/roadmap.md --client kimi
```

Supported adapters currently mirror the unattended invocation patterns already used in `bpstr/campfire`.

| Client | Invocation mode | Approval behavior |
| --- | --- | --- |
| Codex | `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral` | bypassed |
| Claude | `claude -p --permission-mode bypassPermissions` | bypassed |
| Gemini | `gemini -p ... --skip-trust --approval-mode=yolo` | bypassed |
| Grok | `grok -p ... --yolo` | bypassed |
| Muse | `muse exec --yolo` | bypassed |
| Kimi | `kimi -p` | inherited from local Kimi config |

Kimi is exposed because Campfire already has a working adapter, but its current adapter does not provide an explicit permission-bypass flag. The runner warns about that at startup.

## Continuous execution

One outer process can run for many hours:

```text
fresh client session
        ↓
read roadmap + filesystem
        ↓
resume current acceptance gate
        ↓
implement one coherent gate / child batch
        ↓
verify
        ↓
update roadmap + handoff
        ↓
exit session
        ↓
fresh client session
        ↓
...
        ↓
Status: COMPLETE
        ↓
runner exits
```

The default hard ceiling is **2 hours per individual client session**, not two hours for the whole roadmap:

```sh
roadmap-runner roadmap.md --timeout 2h
```

Examples:

```sh
roadmap-runner roadmap.md --timeout 45m
roadmap-runner roadmap.md --timeout 3h
```

A timed-out worker is terminated and the next iteration starts with a fresh context from the current filesystem state.

Unexpected client failures stop the runner rather than retrying forever.

## Roadmap progress tracking

Roadmap modification is intentional.

The roadmap is both the implementation specification and the durable state shared between fresh sessions. The accepted worker prompt is stored separately in `prompt.md` and asks the worker to maintain:

- stable acceptance-gate checkboxes;
- child checkboxes when a gate is too large for one invocation;
- a compact Current handoff;
- checked-item implementation / verification / deployment evidence;
- deferred gates and unblock conditions;
- dated iteration history;
- one top-level status.

Normal work keeps:

```md
Status: IN_PROGRESS
```

Completion requires:

```md
Status: COMPLETE
```

A single blocked task does **not** stop the runner. The prompt requires the worker to inspect other remaining gates and continue anything useful that can still advance.

Only when no remaining gate or prerequisite can materially advance may it set:

```md
Status: BLOCKED
```

The runner then exits with code `3`.

Resolve the recorded external blocker, return the roadmap to `Status: IN_PROGRESS`, and start the same command again.

## Fresh contexts

Sessions are never resumed.

For Codex, Roadmap Runner uses the accepted invocation from the previous shell implementation:

```text
codex exec
--dangerously-bypass-approvals-and-sandbox
--json
--skip-git-repo-check
--ephemeral
--cd <pwd>
```

The JSON stream is filtered so normal terminal output stays concise while errors remain visible.

The worker prompt explicitly disables implementation subagents. Long throughput comes from repeated fresh sessions, not from one 8–10 hour nested agent call.

## Options

```text
roadmap-runner <roadmap-file> [options]

--client <name>        codex, claude, gemini, grok, kimi, muse
--timeout <duration>   default: 2h
--model <model>        optional model override
--effort <level>       optional Codex reasoning effort override
--client-bin <path>    override selected client executable
--help
--version
```

Environment equivalents:

```text
ROADMAP_CLIENT
ROADMAP_TIMEOUT
ROADMAP_MODEL
ROADMAP_EFFORT
ROADMAP_CLIENT_BIN
```

For backward compatibility, `ROADMAP_CODEX` is also accepted as the executable override.

## Examples

Codex with a higher reasoning effort:

```sh
roadmap-runner architecture/roadmap.md --effort high
```

Claude:

```sh
roadmap-runner architecture/roadmap.md --client claude
```

Gemini with a model override:

```sh
roadmap-runner architecture/roadmap.md --client gemini --model <model>
```

## Requirements

- Node.js 18+
- at least one supported CLI installed and authenticated

No Python, GNU `timeout`, jq, daemon, database, task registry, or plugin installation is required.

The secondary client adapters assume the same native CLI authentication approach as Campfire.

## Development

```sh
npm test
npm install -g .
roadmap-runner path/to/roadmap.md
```

The tests do not call live models. They validate duration/status handling and the exact adapter argument construction, including the accepted Codex unattended flags.

## Design

The runner deliberately does not maintain its own task database or hidden roadmap state. It does not create worktrees, commits, or pushes automatically, and it does not choose one Git repository as the workspace root.

Provider-specific behavior lives in small adapters under `lib/clients.js`. The roadmap loop and prompt are shared, so future CLI support should require adding an adapter rather than duplicating the runner.

## License

MIT.
