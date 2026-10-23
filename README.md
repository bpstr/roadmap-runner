![Roadmap Runner — Iterate, Track, Deliver](https://raw.githubusercontent.com/bpstr/roadmap-runner/main/docs/assets/roadmap-runner-cover.webp)

# Roadmap Runner

Run a long Markdown implementation roadmap through fresh coding-agent CLI sessions until it is complete.

The goal is to start one command, let it keep working for **8–10 hours or longer** on a large roadmap without human approval prompts, and have it stop automatically when the roadmap is finished.

Each implementation batch gets a fresh CLI session. Workers update verified task checkboxes and concise status directly in the roadmap. A separate bounded progress file holds evidence and handoffs. Controller changes to requirements are adopted between sessions. Runner-owned archived snapshots preserve history without feeding an ever-growing delivery log back into every session.

## Install

Install the published [npm package](https://www.npmjs.com/package/@bpstr/roadmap-runner):

```sh
npm install -g @bpstr/roadmap-runner
```

Update later:

```sh
npm install -g @bpstr/roadmap-runner@latest
```

For changes already committed to `main` but not yet published to npm:

```sh
npm install -g "github:bpstr/roadmap-runner#main"
```

Restart an already running process once after upgrading; code and prompts are
loaded at startup. After that, controller roadmap edits require no restart.

This installs:

```sh
roadmap-runner
```

There is one Node CLI implementation with versioned worker (`prompt.md`) and supervisor (`supervisor.md`) prompts, so installed copies can be refreshed with the same npm command.

The README cover is a small WebP tracked in `docs/assets/` so it stays with the repository. It is excluded from the npm package by the `files` allowlist. The banner uses an absolute GitHub URL so it also renders on npm, and registry installations download only the package tarball without the artwork or a Git checkout.

## Usage

Run from the workspace you want the agent to operate in:

```sh
cd /path/to/workspace
roadmap-runner docs/roadmap.md
```

The current `pwd` is always the workspace. It may contain multiple Git repositories.

### Example agent setup prompt

Managed runs and app setup require version `0.8.0` or newer. If npm's `latest`
version is older, use the GitHub installation command above. From your workspace,
register the runner with your coding agent:

```sh
roadmap-runner setup --app codex --scope project
roadmap-runner doctor --app codex --scope project
```

Then give your agent this prompt:

> Start a roadmap runner on ROADMAP.md and monitor it hourly.

The agent should start a managed run, retain its run ID, and create an hourly
monitor through the host's scheduler. Each check should read the run's status and
progress, report meaningful changes or required input, and end monitoring when the
run completes or stops. Hourly monitoring needs a separate host schedule; runner
supervisor checkpoints occur between worker batches. See [agent integration](docs/agent-integration.md)
for other supported apps and setup details.

After the host creates the hourly monitor, check its saved Codex registration with
`roadmap-runner doctor --monitor-id <automation-id> --run-id <run-id>`.
Include the absolute workspace and run ID in the monitor's prompt. Diagnostics
verify local MCP connectivity and saved hourly registration; scheduled execution
remains a separate host check.

### CLI clients

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

The worker targets roughly 60 minutes of implementation per session, followed by
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
guidance; the runner does not impose a 60-minute forced termination.

### Default session limit

The default is **90 minutes per worker session**. The intent is to allow enough
uninterrupted time to deliver a meaningful feature or coherent milestone, rather
than repeatedly paying for discovery and
handoff after tiny fragments of work. This is a practical tuning recommendation,
not a measured universal optimum.

```sh
roadmap-runner docs/roadmap.md --timeout 90m
# Equivalent environment setting:
ROADMAP_TIMEOUT=90m roadmap-runner docs/roadmap.md
```

This is the **total worker-session budget**, including discovery, implementation,
feature verification and the compact handoff. The approximate 60-minute
implementation target above is a planning aid within that budget, not a mandatory
stopping point. Continue related work toward
the declared outcome while leaving time for verification and handoff before the
configured timeout. If the feature cannot fit, leave an honest partial handoff;
do not weaken its acceptance criteria or label unverified work complete.

Ninety minutes is an allowance, **not a minimum duration**. Finish earlier when the
planned outcome is delivered, no related authorized work can advance, or a stricter
roadmap rule applies. Do not pad the session with repeated tests, unrelated work,
or verbose delivery logs. The one-checkbox smoke-test exception remains unchanged.

CLI and managed starts default to **90m**; `--timeout`, `ROADMAP_TIMEOUT`, or an
explicit managed timeout can override it. Timeout cleanup grace is additional.
Supervisor cadence and its separate timeout are unchanged: every five workers is
not an hourly review.

## Roadmap queues

### Split large plans before running

Workers reread the active roadmap every session. Breaking a huge file into small
tasks still leaves each worker with a huge input. For a large plan, write focused
roadmap files for coherent milestones, then queue those files in dependency order.
Keep the overall index with the controller and give each worker only the current
milestone, its constraints and concise references to prerequisite evidence.

Each file needs its own acceptance criteria, local validation and compact handoff.
Use separate progress files and keep full logs and past milestone histories out of
the next worker's required input. A blocked roadmap holds the queue, so place
independent implementation before externally blocked release work. Splitting and
progress migration are controller work; the runner does not partition inputs
automatically.

The bundled skill's [splitting strategy](skills/write-runner-roadmap/references/roadmap-splitting.md)
covers suggested input budgets, dependency boundaries, evidence handoffs and
revisions of an existing large plan.

### Start or extend a queue

Queue roadmaps in the order they should run:

```sh
roadmap-runner docs/first.md --queue docs/second.md --queue docs/third.md
# Detached execution with a run ID:
roadmap-runner start docs/first.md --queue docs/second.md --json
# Append to that active run:
roadmap-runner queue <run-id> docs/third.md --json
```

The next roadmap starts automatically after the current roadmap completes
successfully. All entries use the same workspace, client, model and supervisor
settings. Each roadmap has a separate progress file and history; `--progress-file`
on start applies to the first roadmap. The queue command accepts its own
`--progress-file` for the appended roadmap.

`status <run-id>` includes the ordered `queue`, each entry's state, and the
zero-based `queueIndex`. The run ID remains the same through every handoff, and
the workspace stays reserved until the run ends. Stopping or a terminal failure
ends the run with later entries still pending. A blocked roadmap continues its
existing recovery workflow and holds the queue until it completes.

Queues accept up to 100 distinct roadmaps. Paths and progress-file conflicts are
checked before launch or append. Managed queues persist across CLI or MCP
disconnection; they require the managed worker to remain alive. To continue after
a stopped or failed run, start a new run with the unfinished roadmaps.

## Continuous execution

One outer process can run for many hours:

```text
fresh client session
        ↓
read fixed roadmap snapshot + filesystem
        ↓
resume current acceptance gate
        ↓
implement one coherent gate / child batch
        ↓
verify
        ↓
update progress + handoff
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

The default execution limit is **90 minutes per individual client session**:

```sh
roadmap-runner roadmap.md --timeout 90m
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
timed-out worker sessions, before another worker starts. Capacity-only and quota-only
attempts are excluded. Completed roadmaps stop; blocked roadmaps continue through
recovery workers and scheduled reviews. Source changes first require a fresh worker
to reconcile the revised requirements.

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
the tracking file. Workers maintain roadmap task states; supervisors flag state/evidence discrepancies without checking implementation tasks.

See [periodic supervision](SUPERVISION.md) for cadence/restart semantics, the
review contract, output retention/privacy and failure behavior. Reviews reuse
the selected CLI/model and add inference work; log files are not redacted.

## Roadmap progress tracking

The source roadmap owns **task checkboxes, acceptance criteria and concise delivery status**. Workers tick tasks only after their original criteria pass, reopen tasks invalidated by concrete evidence, and preserve unrelated controller edits. A fixed read-only snapshot binds each session to its acceptance criteria; controller requirement changes are adopted between sessions. Checkbox/status updates alone do not trigger scope reconciliation. A tracking-file COMPLETE cannot finish a run while live roadmap tasks remain unchecked. A source larger than **128 KiB** is rejected at every
boundary as a likely polluted context file; restore or prepare a compact requirements-
only roadmap instead of feeding historical delivery logs back into the model.

Without `--progress-file`, Roadmap Runner creates workspace-local state under:

```text
.roadmap-runner/<roadmap-name>-<stable-path-id>/
  progress.md
  source-<progress-path-id>.json  # revision and pending reconciliation
  source-<progress-path-id>.md    # fixed requirements snapshot for the active session
  history.jsonl
  history/*.md.gz
  evidence/                     # detailed evidence, retrieved by task ID
  sessions.jsonl                # usage receipts and context sizes; cold history
```

`progress.md` holds current work, blockers, next steps, the latest supervisor target
and short evidence pointers. Its target is **below 16 KiB**. At **24 KiB**, the runner
archives the original and starts a separate compaction session before the next
worker or supervisor. The compactor moves detailed evidence to files by task ID or
links to specific archived snapshots, preserving unresolved obligations and prior
validation. It must leave the status unchanged and reduce the handoff below 16 KiB.
If it fails that check, the runner stops with the original archive preserved.
Compaction does not count as an implementation iteration or supervisor review.
It uses the shorter of the worker and supervisor timeouts; an expired compaction
stops the run with its original snapshot available for recovery.

Existing large handoffs receive the same compaction step on their next run. The
**128 KiB** emergency read limit remains: files above it stop the runner for manual
repair. No requirements are automatically truncated, and no Codex token-window,
tool-output or auto-compaction settings are changed.

`history/*.md.gz` preserves full boundary snapshots outside the default model
context. `history.jsonl` is a runner-owned index. Workers and supervisors must not
bulk-load history merely to reconstruct chronology; they retrieve a specific older
snapshot only when current evidence requires it.

Workers and supervisors can retrieve files in `evidence/` or search `history.jsonl`
by iteration/time and decompress the selected `.md.gz` snapshot. This supports gate
verification, conflicting-state investigation and failed-attempt diagnosis without
reloading completed-task narratives on every iteration.

`sessions.jsonl` records each worker, supervisor and compactor attempt, including
failed attempts: session/run IDs, role, iteration, elapsed time, configured or
client-reported model, and prompt/source/progress byte sizes before and after.
Codex completed-turn usage and Claude aggregate-result usage are retained as
reported. Missing usage is `null`; `usageComplete: false` marks missing receipts or
unsuccessful/interrupted sessions. Cached input is separate, and provider field
semantics are preserved: Codex includes cached input in input tokens, while Claude
reports cache reads/creation separately. These are usage receipts, not billed cost
or peak-context measurements. The same metrics appear in `runner.turn_finished`
events; managed run artifacts expose the evidence directory and session journal.

Keep delivery history out of requirements. When a short delivery note belongs in
the roadmap, delimit it explicitly:

```markdown
<!-- roadmap-runner:delivery:start -->
API-02.4: verified; detailed receipt in evidence/API-02.4.md.
<!-- roadmap-runner:delivery:end -->
```

Only prose inside valid, standalone blocks is excluded from scope reconciliation.
Keep criteria, priorities, dependencies and all task checkboxes outside them.
Malformed blocks, fenced examples and blocks containing checkboxes remain
scope-sensitive. Delivery-only updates can therefore preserve the supervisor
cadence; genuine requirements changes still require worker reconciliation.
Split large roadmaps into focused queue items rather than accumulating delivery
history in their requirements.

The accepted worker prompt is stored separately in `prompt.md` and asks the worker to maintain:

- stable acceptance-gate checkboxes in the live roadmap;
- bounded child checkboxes in the owning roadmap when needed;
- a compact Current handoff;
- checked-item implementation / verification / deployment evidence;
- deferred gates and unblock conditions;
- concise current evidence references;
- one top-level status.

It explicitly forbids append-only iteration narratives, copied diffs, raw CLI/test
logs, repeated old handoffs and superseded supervisor plans in the active progress
file. At every iteration it reads the current fixed source snapshot; when progress
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

When no remaining gate or prerequisite can materially advance in the current
session, the worker may set:

```md
Status: BLOCKED
```

`BLOCKED` is a terminal execution state: the runner preserves progress and stops
with exit 75 and reason `blocked`, without launching another worker or supervisor.
Use it only when no authorized work remains ready. A task-local blocker belongs in
Deferred gates while independent work continues under `IN_PROGRESS`.

After a recorded unblock input changes, request one recovery worker explicitly:

```sh
roadmap-runner start roadmap.md --recover-blocked --json
```

MCP uses `recoverBlocked: true`. If that worker remains blocked, the run stops
again; the option never starts an automatic recovery loop. A required verification
worker after an interrupted/quota session, or a changed source revision requiring
reconciliation, may still inspect stale terminal state before trusting it.

Completion remains an agent assertion: the runner reads the header status, not
independent proof of every acceptance criterion. The three-iteration mock test
verifies orchestration, not a live model's compliance with the prompt.

Resolve the recorded external blocker, return the progress file to `Status: IN_PROGRESS`, and start the same command again.

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

In all modes the roadmap is read-only to the worker. It reads the current source
snapshot and the progress file, but puts its checklist, child tasks, batch plan, handoff, verification
evidence, deferrals and status only in the progress file. Iteration history is
runner-owned cold history, not an append-only section in active model context.
Original gate IDs/criteria and stricter run limits remain authoritative; source
instructions to update progress are redirected to this separate file.

A missing progress file (and its parent directories) is created with an
`IN_PROGRESS` scaffold. The worker derives its checklist from the source; the
scaffold is not proof of completion. An existing progress file is reused without
being truncated or reset. Restart with the same roadmap/path to resume. The same
16 KiB target, 24 KiB compaction trigger and 128 KiB emergency limit apply to custom
progress files.

The progress file's opening-header status controls continuation when no source
revision needs reconciliation: `COMPLETE` exits successfully and `BLOCKED` stops
with exit 75; `--recover-blocked` explicitly permits one recovery worker. An interrupted, failed, capacity-only or quota-only session also requires a fresh
worker to verify any terminal status it left before trusting completion. The roadmap's
open checkboxes prevent completion even if the handoff says COMPLETE. The same
header format rules apply. To unblock work,
update the progress file; controller changes to the source trigger reconciliation instead.

The runner rejects a progress path that resolves to the source itself, including
symlink/hard-link aliases. Missing, unreadable, non-file or oversized sources still
stop explicitly without restoring files. Ordinary roadmap content edits do not.

## External controller updates

**Roadmap edits no longer stop the runner.** An external controller can correct
drift, revise priorities, add requirements or remove superseded work in the live
source file while execution continues. No flag, watcher, daemon or new API is needed.

The active worker or supervisor keeps its fixed, runner-owned source snapshot.
Once that session ends, the runner checks the live roadmap again, records its new
SHA-256 revision, and tells the next worker to reconcile the latest requirements
before selecting work. Multiple edits between boundaries coalesce to the latest
published contents. The next worker preserves valid evidence and stable IDs,
reopens changed criteria, adds new gates, retires removed gates from active work,
and replaces drifted handoffs and outdated supervisor targets.

Old `COMPLETE` state cannot stop the loop while reconciliation is pending.
`BLOCKED` stops execution after any required source reconciliation. A fresh worker takes precedence over a scheduled review; a review based
on superseded requirements cannot stop the new revision with stale status or a
missing handoff. Pending reconciliation clears only after a successful worker
session on that same revision. Timeouts, capacity failures, cancellation and old
sessions cannot acknowledge a newer revision. The worker must set status anew;
completion and semantic reconciliation remain agent assertions, not independently
verified proofs.

Revision metadata is bound to both source and progress paths and survives restarts.
An edit between invocations therefore reopens old terminal state on the next launch.
Existing progress bytes are never reset by the runner. Each detected change archives
the current progress with old/new source hashes in `history.jsonl`; historical
snapshots remain outside normal model context. On the first upgrade from a version
without revision metadata, the current source establishes the baseline: edits made
before that baseline cannot be detected retroactively. Manually reconcile such
legacy evidence or set its progress status to `IN_PROGRESS` before the first run.

Controllers should publish a **complete file atomically**, using a temporary sibling
and rename, rather than deleting or truncating the live roadmap in place. For example,
from the workspace root:

```sh
# Prepare the full corrected roadmap in docs/roadmap.md.next, then publish it:
mv docs/roadmap.md.next docs/roadmap.md
```

Use one runner per progress file. Controllers should edit the live roadmap only,
not concurrently overwrite worker-owned progress, snapshots or revision metadata.
The runner does not merge competing file writes, wait forever after completion,
or restart an already exited process when a later edit arrives. Run the same command
again in that case; persisted revision checks handle the changed requirements.

Worker and built-in supervisor prompts still forbid source edits, weakened criteria
and expanded permissions/budgets. The boundary check cannot identify who wrote an
edit and does not reject content merely because its author is unknown. This is
**not an OS write sandbox**: approval-free clients retain their filesystem access.
The external controller is a separately authorized actor, not a new permission for
an implementation worker to rewrite its own goal.

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
--progress-file <path> override bounded progress-state path; workers never edit source
--timeout <duration>   default: 90m
--supervisor-every <n>  review every n workers (1-20); default 5, 0 disables
--supervisor-timeout <duration> review timeout; default 10m
--model <model>        optional model override
--effort <level>       optional Codex reasoning effort override
--client-bin <path>    override selected client executable
--notify attention|off desktop alerts; default attention
--notify-on <events>   extra desktop alerts; requires --notify attention
--prevent-sleep        prevent idle system sleep for the entire run
--no-prevent-sleep     override ROADMAP_PREVENT_SLEEP
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
ROADMAP_NOTIFY        attention (default) or off
ROADMAP_PREVENT_SLEEP  set to 1 or true to prevent idle system sleep
```

For backward compatibility, `ROADMAP_CODEX` is also accepted as the executable override.

Use `roadmap-runner start docs/roadmap.md --prevent-sleep` to keep the machine
awake while the runner is active, including recovery waits and queued roadmap
handoffs. MCP callers can set `preventSleep: true` on `roadmap_start`. The default
is off; `--no-prevent-sleep` overrides the environment setting.

On macOS this uses `/usr/bin/caffeinate -i -w <runner-pid>` to prevent idle system
sleep while allowing the display to sleep. On Linux it uses `systemd-inhibit`
with an idle/sleep lock; systemd and permission to take that lock are required.
Other platforms report `unsupported_platform`. A missing or refused backend
produces a warning and `sleepInhibition.state: unavailable` in run status;
roadmap work continues. An active lock is released on completion, failure or
stop, and when the runner process exits. This option does not override lid
closure or an explicit request to sleep.

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

- Node.js 20+
- at least one supported CLI installed and authenticated

No Python, GNU `timeout`, jq, daemon, database or plugin installation is required. Managed runs use a private filesystem registry.

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
npm run check:package
npm install -g .
roadmap-runner path/to/roadmap.md
```

The tests do not call live models. They validate duration/status handling and the exact adapter argument construction, including the accepted Codex unattended flags.

GitHub CI runs the prepared tests and npm tarball checks on Linux and macOS with
Node.js 20, 22 and 24. Package checks exercise the extracted CLI's version/help
using locked local dependencies and remove their temporary tarball afterwards.
CI receives no provider credentials and never runs live inference.

## Design

The runner deliberately does not maintain a task database. It does maintain small
workspace-local orchestration state so requirements, hot progress and historical
evidence have different lifecycles. The roadmap is controller-managed requirements;
a fixed source snapshot defines each session, progress.md is bounded working memory; compressed boundary snapshots are cold audit history.
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
delivery state blocked or complete. Recognized usage limits use the separate durable
quota pause below. Other worker errors stop without retrying. Capacity recovery
applies only to the Codex adapter.

Ctrl-C stops the runner during the retry wait as well as during an active run.
The 90-minute per-run execution timeout remains separate from the retry wait.

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


## Durable usage-limit recovery

Claude runs with `--output-format stream-json --verbose` so rejected quota events
and error results are available even when the CLI returns zero. Codex structured
usage-limit failures are recognized too. Error-marked quota messages can supply
explicit ISO resets or local clocks with IANA zones, such as
`resets 2pm (Europe/Budapest)`. Ordinary model prose does not count as a quota event.
Structured reset timestamps take priority; simultaneous windows use the latest reset.

The runner preserves progress and writes `<progress-file>.recovery.json` before
waiting. A short/session limit without a usable reset uses five hours; an unknown
weekly limit uses the one-day bound. At a known reset within the allowed wait, it
starts a fresh session with the same configured client/model. The process remains
running while paused. Worker and supervisor sessions share the incident deadline.
A successful non-quota session clears that incident.

The default maximum is **24 hours per consecutive quota incident**, including
interrupt/restart time. Set `ROADMAP_USAGE_MAX_WAIT` to integer seconds from 1 to
86400 to shorten it. If the reset is at or beyond the deadline, the runner waits
only to the deadline, records `runner.usage_wait_expired`, and exits **75**. Restart
with the same paths after the recorded reset; the expired checkpoint will clear.
An unknown weekly reset requires a manual restart after its bounded retry time;
there is no indefinite weekly sleep or switch to another model/account.

Ctrl-C during a wait exits **130** and preserves the deadline/checkpoint. State is
not silently reset on restart. An invalid checkpoint stops with an explicit error.
Prepared tests verify parsing and recovery mechanics, not real provider reset behavior.

## Blocker flags, rechecks and notifications

Workers flag task-local problems in `## Deferred gates` while retaining unchecked
acceptance tasks. They continue independent ready work and revisit a deferred task
when its unblock condition changes or its bounded retry is due:

```markdown
- BLOCKED API-3: credential unavailable | Unblock: credential supplied | Retry: supplied
- NEEDS_INFO UI-2: choose export format | Unblock: user answer | Retry: answer arrives
- PROBLEM DATA-4: migration check failed | Unblock: repair passes | Retry: changed evidence
- SKIPPED API-4: depends on API-3 | Unblock: API-3 validated | Retry: prerequisite done
```

A skipped item remains incomplete and cannot unlock its dependent tasks. The
runner emits attention events for these flags even with `Status: IN_PROGRESS`.
An unchanged flag set produces one notification across restarts; a changed reason
or resolved blocker updates the event state. When the entire ready set is blocked,
`Status: BLOCKED` stops without another worker or supervisor, preserving the queue.
Its final `runner.blocked` event has `terminal: true`, and managed status retains
`roadmapState: blocked`, reason `blocked` and exit 75.

A current supervisor review with `Health: STUCK` triggers an attention alert.
The runner stops with exit **75** and reason `no_progress_limit` after **three
consecutive workers without completed checklist progress**, preserving progress,
receipts, archives and unfinished queued roadmaps. It emits a terminal
`runner.stuck` event followed by `runner.failed`, so this stop is visible in CLI,
managed status and MCP even when desktop notifications are disabled. Resolve the
blocker, then adopt a controller requirement amendment or use `--recover-blocked`
for one explicit recovery worker. An unchanged restart preserves the exhausted
budget and stops before another worker, supervisor or compactor.

With supervision enabled, two idle workers also trigger one small LLM loop check
before the next worker, including during repeated source reconciliation. It reuses
bounded recent source/progress snapshots, worker outcomes and the prior review,
with a maximum 60-second timeout. A current `Loop: DETECTED` verdict must cite at
least two observed iterations and concrete evidence; it immediately blocks the
runner (exit 75, terminal `runner.blocked`, reason `loop_detected`). Pending queue
entries remain untouched. An unchanged restart stays blocked; a controller
requirement amendment or explicit `--recover-blocked` permits recovery after repair.
`CLEAR`, `UNCERTAIN`, missing or invalid reports never renew the deterministic
budget. `--supervisor-every 0` disables LLM reviews while keeping the hard stop.

Progress means increasing the number of completed tasks in the authoritative
live roadmap, above the persisted high-water mark. Stable task IDs (or full labels
when no ID exists) identify distinct tasks. For a source without checkboxes, the
progress checklist supplies this measure. Reopening and rechecking the same tasks,
mirrored handoff checkboxes, changed notes, and new unchecked tasks do not reset
the budget. Fenced examples are ignored. A controller requirement amendment adopted
between sessions grants one fresh budget. Checkbox/status edits and source rewrites
during workers or supervisors, including hash-bearing delivery summaries, cannot
continually renew it. Delivery summaries belong in progress, outside the source.
This is a checklist-based
orchestration guard, not independent validation that claimed implementation is
correct. Workers should record validated implementation units as completed
children rather than stretching one unchecked unit across many sessions.

The counter persists across process restarts. An explicit restart permits a fresh
worker to verify changed external inputs; another no-progress result still uses
the retained counter. `ROADMAP_MAX_IDLE_WORKERS` adjusts the limit (1–100; default
3). After two idle workers, an attention alert and bounded backoff precede the
remaining attempt. `ROADMAP_RECOVERY_DELAY` and `ROADMAP_RECOVERY_MAX_DELAY`
control that delay in seconds (defaults 60 and 900; range 1–3600). Prose-only
handoffs also consume the budget; initialize a checklist and record validated
units rather than relying on narrative changes as progress.

Events are appended to `<progress-file>.events.jsonl`. Set `ROADMAP_NOTIFY_BIN`
to an executable's absolute path to receive each event's JSON on stdin. It is
invoked directly, without shell interpolation, with a ten-second timeout. Hook
failure is logged and does not halt roadmap work. Task IDs/statuses are included;
blocker reasons, model output and credentials are not included in event payloads.
Hooks should filter event types and avoid repeated alerts for recheck records.

Desktop attention alerts are on by default for CLI and MCP starts. Explicit
`--notify off`, `ROADMAP_NOTIFY=off`, or MCP `notify: "off"` disables them.
The permission command configures macOS authorization; it is separate from the
run preference. `--notify-on` selects extra event types and respects explicit off.

Runner events remain available with desktop alerts off. MCP clients can call
`roadmap_events` with `{ "runId": "<run-id>", "cursor": 0 }`, then persist the
returned cursor to replay new events after reconnecting. Clients can also read
and subscribe to `roadmap://<run-id>/events`, including a `?cursor=<sequence>`
URI. Legacy clients use `resources/subscribe`; modern clients use
`subscriptions/listen`. Resource updates identify the URI, and the client reads
the event page. See [MCP integration](docs/agent-integration.md#mcp-and-protocol-support).

Built-in attention delivery uses an installed `terminal-notifier` on macOS or
`notify-send` on graphical Linux. On macOS, install the backend with
`brew install terminal-notifier` before starting the runner. The runner searches
PATH and both Homebrew locations (`/opt/homebrew/bin` and `/usr/local/bin`), so
desktop apps with a restricted PATH can find it. Missing backends produce an
explicit diagnostic and a recorded delivery failure; failed submissions are not
saved as successfully delivered notification fingerprints.

With terminal-notifier 3, denied macOS authorization is recorded as
`permission_denied`. Request permission explicitly before a long run:

```sh
roadmap-runner notifications request-permission
```

The command allows up to two minutes for the macOS consent dialog and submits a
confirmation notification through terminal-notifier. If permission was already
denied, macOS does not show the dialog again; the command opens **System Settings
> Notifications** so you can enable **terminal-notifier**, then rerun the command.
It preserves the saved permission decision. Use `--json` for a structured result;
an unsuccessful request exits nonzero. The command is supported on macOS and does
not start a roadmap run. Use `terminal-notifier -diagnose` to inspect authorization
without sending a notification. A successful submission confirms that the
backend accepted the notification; Focus and other OS settings still determine
whether it appears. Use `--notify off` to disable delivery and
`--notify attention --notify-on runner.usage_paused` to request quota alerts. The older AppleScript
hook below opens Script Editor when its notifications are clicked:

```sh
ROADMAP_NOTIFY_BIN=/absolute/path/to/examples/notify-macos.js \
roadmap-runner docs/roadmap.md
```

The example uses `osascript`; OS notification settings determine display. It was
syntax-checked, not sent to Notification Center during automated validation.
Other hooks can provide a desktop notification or integrate with a configured
service. Delivery is best effort; durable consumers replay the journal with their
own saved cursor. No remote notification service is automatically configured.

A timed-out supervisor or missing written review is recorded and deferred while
workers continue. Ordinary client/authentication failures and false supervisor
completion remain explicit errors with preserved evidence.

See [agent integration](docs/agent-integration.md) for `start`, `stop`, `status`, local MCP and explicit app setup. The bundled [roadmap design skill](skills/write-runner-roadmap/SKILL.md) includes task contracts and a template. Automatic chat wake-up and agent dispatch remain outside this release.
