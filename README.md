![Roadmap Runner — Iterate, Track, Deliver](https://raw.githubusercontent.com/bpstr/roadmap-runner/main/docs/assets/roadmap-runner-cover.webp)

# Roadmap Runner

Run a long Markdown implementation roadmap through fresh coding-agent CLI sessions until it is complete.

The goal is to start one command, let it keep working for **8–10 hours or longer** on a large roadmap without human approval prompts, and have it stop automatically when the roadmap is finished.

Each implementation batch gets a fresh CLI session. The source roadmap remains immutable; a bounded progress file plus the filesystem form the hot handoff. Runner-owned archived snapshots preserve history without feeding an ever-growing delivery log back into every session.

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

There is one Node CLI implementation with versioned worker (`prompt.md`) and supervisor (`supervisor.md`) prompts, so installed copies can be refreshed with the same npm command.

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
child finishes. **Implementation comes before feature verification:** the worker
must not burn fresh iterations rerunning the same acceptance/integration test while
the relevant implementation is unchanged. A failed feature test becomes durable
evidence; the next iteration normally implements or repairs the missing behavior,
and the failed test may be rerun only after a relevant artifact changes. Explicit
verification/diagnostic roadmap tasks and changed external/environmental conditions
are narrow exceptions. Checks run after the coding batch, with failed checks repeated
after repairs. Runs can finish earlier when the parent closes or no related work is
actionable. Explicit stricter roadmap run limits still apply.

Before coding, the worker records a Batch plan with the outcome, parent gate,
related child IDs, shared setup, checks and exit criteria. Completing a child or
adding a smaller follow-up does not redefine that outcome. Integration batches
compose the required canonical harness first and reuse it across source families.

Startup output and each worker prompt include the loaded prompt hash. This lets
logs distinguish older cached instructions from current ones. The handoff includes
the batch outcome and an explicit exit reason, particularly when ending early.

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

## Supervisor checkpoints

By default, a fresh supervisor reviews progress after every five successful or
timed-out worker sessions, before another worker starts. Capacity-only retries
are excluded; completed or globally blocked roadmaps stop without an extra review.

```sh
roadmap-runner docs/roadmap.md --progress-file docs/delivery-evidence.md \
  --supervisor-every 5 --supervisor-timeout 10m
# Disable this extra review session:
roadmap-runner docs/roadmap.md --supervisor-every 0
```

The supervisor compares bounded run outputs and progress snapshots with actual
delivery evidence. It diagnoses healthy, slow, stuck or uncertain progress and
may adjust the next batch's target, order or prerequisite work—not original
requirements or acceptance criteria. The next worker consumes the review from
the tracking file. Source-preservation rules apply to both roles.

See [periodic supervision](SUPERVISION.md) for cadence/restart semantics, the
review contract, output retention/privacy and failure behavior. Reviews reuse
the selected CLI/model and add inference work; log files are not redacted.

## Roadmap progress tracking

The source roadmap is now **requirements-only and immutable by default**. This is
intentional: a long run must not slowly rewrite its own goal while accumulating
megabytes of delivery narration. A source larger than **512 KiB** is rejected before
launch as a likely polluted context file; restore or prepare a compact requirements-
only roadmap instead of feeding historical delivery logs back into the model.

Without `--progress-file`, Roadmap Runner creates workspace-local state under:

```text
.roadmap-runner/<roadmap-name>-<stable-path-id>/
  progress.md
  history.jsonl
  history/*.md.gz
```

`progress.md` is bounded hot state. It contains the current checklist, handoff,
concise evidence references, deferred gates and latest supervisor review. It is
capped at **128 KiB**. If a worker makes it larger, the runner first archives the
boundary snapshot and then stops instead of feeding the oversized file into another
fresh context.

`history/*.md.gz` preserves full boundary snapshots outside the default model
context. `history.jsonl` is a runner-owned index. Workers and supervisors must not
bulk-load history merely to reconstruct chronology; they retrieve a specific older
snapshot only when current evidence requires it.

The accepted worker prompt is stored separately in `prompt.md` and asks the worker to maintain:

- stable acceptance-gate checkboxes;
- child checkboxes when a gate is too large for one invocation;
- a compact Current handoff;
- checked-item implementation / verification / deployment evidence;
- deferred gates and unblock conditions;
- concise current evidence references;
- one top-level status.

It explicitly forbids append-only iteration narratives, copied diffs, raw CLI/test
logs, repeated old handoffs and superseded supervisor plans in the active progress
file. At every iteration it re-reads the immutable source roadmap; when progress
state conflicts with source scope or acceptance criteria, the source wins.

Put exactly one status line in the opening header, after an optional `#` title
and before the first `##` (or deeper) section heading. Fenced examples and status
lines in later sections are not control state. Duplicate or malformed header
statuses stop with an error. A progress file with no header status defaults to
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

## Choose a custom progress path

Source preservation is the default. Use `--progress-file` only when you want the
bounded active state at a specific path:

```sh
roadmap-runner docs/roadmap.md --progress-file docs/delivery-evidence.md
# Equivalent environment setting:
ROADMAP_PROGRESS_FILE=docs/delivery-evidence.md roadmap-runner docs/roadmap.md
```

Paths are resolved from the current workspace, not from the roadmap directory.
The CLI option overrides the environment setting. With neither set, the internal
`.roadmap-runner/.../progress.md` path is used.

In all modes the roadmap is the read-only requirements source. The worker reads
both files, but puts its checklist, child tasks, batch plan, handoff, verification
evidence, deferrals and status only in the progress file. Iteration history is
runner-owned cold history, not an append-only section in active model context.
Original gate IDs/criteria and stricter run limits remain authoritative; source
instructions to update progress are redirected to this separate file.

A missing progress file (and its parent directories) is created with an
`IN_PROGRESS` scaffold. The worker derives its checklist from the source; the
scaffold is not proof of completion. An existing progress file is reused without
being truncated or reset. Restart with the same roadmap/path to resume. The 128 KiB
hot-state cap applies to custom progress files too.

Only the progress file's opening-header status controls continuation:
`COMPLETE` exits successfully and `BLOCKED` exits with code 3. The roadmap's
own status/checkboxes are ignored as runtime state and may stay unchanged even
when delivery is finished. The same header format rules apply. To unblock work,
update the progress file, not the source roadmap.

The runner rejects a progress path that resolves to the source itself, including
symlink/hard-link aliases. It checks the source's byte hash before each iteration
and after each worker returns, including failed or timed-out runs. A detected
change, deletion or unreadable source stops the runner without starting another
worker or silently restoring files. Inspect the change yourself; another tool
or a human may have made it.

This is an instruction plus an iteration-boundary integrity check, **not an OS
write sandbox**: approval-free clients retain their filesystem permissions, and
transient edits between checks cannot be prevented. Source hashes are captured
for the current runner invocation only. Use one evidence file per roadmap; when
requirements change between invocations, reconcile existing evidence and return
its status to `IN_PROGRESS`, or choose a new progress file. An existing `COMPLETE`
remains an agent assertion, not an automatic check against revised requirements.

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
--progress-file <path> override bounded progress-state path; source is always preserved
--timeout <duration>   default: 2h
--supervisor-every <n>  review every n workers (1-20); default 5, 0 disables
--supervisor-timeout <duration> review timeout; default 10m
--model <model>        optional model override
--effort <level>       optional Codex reasoning effort override
--client-bin <path>    override selected client executable
--help
--version
```

Environment equivalents:

```text
ROADMAP_CLIENT
ROADMAP_PROGRESS_FILE
ROADMAP_SUPERVISOR_EVERY
ROADMAP_SUPERVISOR_TIMEOUT
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

The same example can exercise preserved-source mode in the disposable workspace:

```sh
roadmap-runner roadmap.md --progress-file delivery-evidence.md
```

A compliant run still takes three worker iterations, but the original three
checkboxes stay unchanged and completion is recorded in `delivery-evidence.md`.
Without the option, the same behavior uses the internal bounded progress path.
The integration test checks source bytes as well as iteration count.

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

The runner deliberately does not maintain a task database. It does maintain small
workspace-local orchestration state so requirements, hot progress and historical
evidence have different lifecycles. The roadmap is the immutable goal; progress.md
is bounded working memory; compressed boundary snapshots are cold audit history.
It does not create worktrees, commits, or pushes automatically, and it does not
choose one Git repository as the workspace root.

Provider-specific behavior lives in small adapters under `lib/clients.js`. The roadmap loop and prompt are shared, so future CLI support should require adding an adapter rather than duplicating the runner.

## License

MIT.

## Temporary Codex capacity failures

If Codex exits with code 1 and reports only the recognized "Selected model is at
capacity" error, the runner waits five minutes and retries the same model. It
allows ten retries after the initial failed attempt, then exits with code 75.
Partial work and progress checkboxes are preserved; capacity does not mark the
delivery state blocked or complete. Other errors stop without retrying. This recovery
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
