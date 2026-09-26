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

## Batch size

The worker targets roughly 30 minutes of implementation per session, followed by
verification and the roadmap handoff. Discovery and verification time are separate
from that target; the per-run hard timeout still applies.

A checkbox is a progress unit, not a session boundary. Runs group several related
ready children under the same parent and continue within that group after a small
child finishes. Checks run after the coding batch, with only failed or invalidated
checks repeated after repairs. Runs can finish earlier when the parent closes or
no related work is actionable. Explicit stricter roadmap run limits still apply.

The dated handoff records approximate discovery, implementation and verification
durations so repeated bootstrap overhead can be assessed. The target is prompt
guidance; the runner does not impose a 30-minute forced termination.

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

The default execution limit is **2 hours per individual client session**, not two hours for the whole roadmap:

```sh
roadmap-runner roadmap.md --timeout 2h
```

Examples:

```sh
roadmap-runner roadmap.md --timeout 45m
roadmap-runner roadmap.md --timeout 3h
```

A timed-out worker is terminated and the next iteration starts with a fresh context from the current filesystem state.

On POSIX systems, timeout sends `SIGTERM` to the worker's process group, followed
by `SIGKILL` after a two-minute shutdown grace period when needed. Ctrl-C uses a
three-second grace period; a second interrupt forces termination immediately.
The runner drains output and retains pending escalation even if the CLI exits
before its child tools. It does not start the next iteration while that
escalation is pending. Shutdown grace is additional to the execution limit.

This covers descendants that remain in the worker's process group, not tools
that deliberately create a separate session or remote operations already sent.
Windows retains the existing `taskkill` fallback; the process-group regression
tests are POSIX-only.

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

Put exactly one status line in the opening header, after an optional `#` title
and before the first `##` (or deeper) section heading. Fenced examples and status
lines in later sections are not control state. Duplicate or malformed header
statuses stop with an error. A roadmap with no header status defaults to
`IN_PROGRESS`, allowing the worker to initialize it.

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

Completion remains an agent assertion: the runner reads the header status, not
independent proof of every acceptance criterion. The three-iteration mock test
verifies orchestration, not a live model's compliance with the prompt.

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

## Example roadmap

The repository includes a deliberately tiny three-step roadmap:

```text
examples/three-iteration-roadmap.md
```

Its special test rule is:

> each fresh runner invocation must process exactly one unchecked checkbox.

The roadmap starts with exactly three unchecked tasks, so a correct run must produce
exactly three worker iterations before reaching `Status: COMPLETE`.

For a live smoke test, copy it into a disposable workspace before running it:

```sh
tmp="$(mktemp -d)"
cp examples/three-iteration-roadmap.md "$tmp/roadmap.md"
cd "$tmp"

roadmap-runner roadmap.md
```

A successful live run should show exactly:

```text
iteration 1 -> EX-1
iteration 2 -> EX-2
iteration 3 -> EX-3
Status: COMPLETE
```

and create:

```text
example-output/one.txt
example-output/two.txt
example-output/three.txt
```

The automated test does **not** call a live model. It runs the real Roadmap Runner
process against `test/fixtures/mock-codex.js`, which completes exactly one checkbox
per invocation. The integration test asserts that the runner launches exactly three
iterations and only stops after the third checkbox is complete.

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

## Temporary Codex capacity failures

If Codex exits with code 1 and reports only the recognized "Selected model is at
capacity" error, the runner waits five minutes and retries the same model. It
allows ten retries after the initial failed attempt, then exits with code 75.
Partial work and roadmap checkboxes are preserved; capacity does not mark the
roadmap blocked or complete. Other errors stop without retrying. This recovery
currently applies only to the Codex adapter.

Ctrl-C stops the runner during the retry wait as well as during an active run.
The two-hour per-run execution timeout remains separate from the retry wait.

Settings use integer seconds and a consecutive-failure retry count:

```sh
ROADMAP_CAPACITY_RETRIES=10 \
ROADMAP_CAPACITY_DELAY=300 \
ROADMAP_CAPACITY_MAX_DELAY=300 \
roadmap-runner docs/roadmap.md
```

Set the retry count to zero to disable this recovery. If the initial delay is
smaller than the maximum, it doubles up to that maximum. Successful runs reset
the capacity retry counter. OAuth startup warnings do not themselves trigger a
retry or get repaired by this mechanism.
