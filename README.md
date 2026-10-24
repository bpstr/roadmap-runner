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

There is one Node CLI implementation with versioned worker (`prompt.md`) and resolver (`resolver.md`) prompts, so installed copies can be refreshed with the same npm command.

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
blocker recovery runs occur between worker batches. See [agent integration](docs/agent-integration.md)
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

Each worker receives one named deliverable with a finite implementation boundary,
a 30–45-minute implementation budget, completion criteria and an exact checkpoint.
Keep prerequisite discovery to five minutes. Reuse compatible evidence; a new
session or status note does not justify repeating unchanged checks. Original
acceptance remains open wherever required verification is deferred.

The default hard timeout remains 90 minutes for compatibility. It is a ceiling,
not the implementation target. The prompt supplies an absolute soft deadline at
the batch budget (40 minutes by default), leaving at least five minutes or 15% of
the configured timeout for checkpointing. At that deadline the runner archives
the current handoff and writes a checkpoint request. The CLI prompt requires the
worker to save exact remaining functionality, edited files, evidence and its next
command, then exit. Noninteractive clients must follow that prompt; the request
file does not itself send a new chat message. Hard termination sends SIGTERM,
then escalates after three seconds and verifies descendant cleanup.

Workers check prior attempts and the handoff before choosing work. Repeated
failures with unchanged relevant inputs set BLOCKED. A global blocker, failed
worker, two consecutive hard timeouts or exhausted finite plan dispatches a
resolver. The resolver repairs the cause and resumes workers, or records STOPPED
and ends the runner. Useful partial work continues without periodic supervisors.
See [recovery runs](RECOVERY.md) for the decision contract and restart behavior.

### Finite implementation plans

Use the existing progress authority for a fixed task/operation baseline and at
most three current batches. Its single `roadmap-runner-execution` JSON block has
`version: 1`, `denominator`, `operationDenominator`, original `parents`, original
`operations`, and `batches`. Each parent records `id`, `roadmap`, `operations`,
`implementation` (`not_started`, `partial`, `implemented`, `blocked`), `missing`
and `evidence`; verification stays separate. Each operation has `id` and `owner`.
Each batch names `id`, `task`, `roadmap`, `implementation`, `budgetMinutes`
(30/35/40/45), `deliverable`, `boundary`, `completion`, `checkpoint`,
`prerequisites` and existing `sourcePointers`. Optional `prerequisiteEvidence`
contains `{path, sha256}` records that must still match. Paths are workspace-relative.

```sh
roadmap-runner start docs/owning-roadmap.md --execution-plan docs/progress.md \
  --progress-file .roadmap-runner/current/progress.md --timeout 45m \
  --resolver-timeout 10m
```

The controller selects actual owning roadmaps across dependencies, rotates ready
outcomes after checkpoints, and stops when the finite plan is exhausted. It never
adds planning children or treats generated/status-only work as implementation.
To record delivery, update the batch and original owner and supply
`implementationEvidence: [{path, sha256}]`; at least one declared source pointer
must have changed since the first attempt. Those first-attempt hashes survive
recovery, so unfinished implementation need not be rewritten. Generated files,
tests and delivery notes cannot supply that evidence. A failed/timed-out attempt
cannot bypass recovery by marking its batch implemented.

The baseline identity is frozen in `execution-state.json`; scope expansion needs
an explicit controller migration. No serial queue may accompany an execution
plan. The entire authority is never injected: selected contracts are limited to
32 KiB, original task snapshots to 24 KiB, and review summaries to 16 KiB. Large
source/evidence history remains available by targeted path. Startup reports the
loaded prompt revision; replacing installed files does not update a running process.

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
successfully. All entries use the same workspace, client, model and resolver
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

## Recovery runs

Every worker begins with a loop check against recent runs and the current handoff.
An evidenced repetition blocks the runner and dispatches a resolver. The resolver
uses roadmap evidence to repair the blocker, records the changed condition and
next action, and clears the way for more workers. When it cannot unblock useful
work, it sets STOPPED and ends the entire runner, leaving queued work pending.

```sh
roadmap-runner docs/roadmap.md --resolver-timeout 10m
```

Recovery is automatic for global blockers. Regular supervisors are removed.
See [recovery runs](RECOVERY.md) for persisted evidence, resolver decisions,
transport retries and explicit recovery after STOPPED.

## Roadmap progress tracking

The source roadmap owns **task checkboxes, acceptance criteria and concise delivery status**. Workers tick tasks only after their original criteria pass, reopen tasks invalidated by concrete evidence, and preserve unrelated controller edits. A fixed read-only snapshot binds each session to its acceptance criteria; controller requirement changes are adopted between sessions. Checkbox/status updates alone do not trigger scope reconciliation. A tracking-file COMPLETE cannot finish a run while live roadmap tasks remain unchecked. Requirements-only sources may be up to **256 KiB** (262144 UTF-8 bytes), inclusive; larger sources are rejected unchanged at every boundary. The runner never compresses or truncates the source roadmap. Keep execution history in the separate handoff.

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

`progress.md` holds current work, blockers, next steps, the latest recovery decision
and short evidence pointers. Its limit is **below 32 KiB** (32768 UTF-8 bytes).
At or above **32 KiB**, the runner
archives the original and starts a separate compaction session before the next
worker or resolver. The compactor moves detailed evidence to files by task ID or
links to specific archived snapshots, preserving unresolved obligations and prior
validation. It must leave the status unchanged and reduce the handoff below 32 KiB.
Every worker, resolver and compactor receives the limits and instructions to move
details into referenced evidence files. Handoff size alone is not a reason to set
BLOCKED. Compaction runs before terminal status checks, preserving genuine blockers.
If it fails that check, the runner stops with the original archive preserved.
Compaction does not count as an implementation iteration.
It uses the shorter of the worker and resolver timeouts; an expired compaction
stops the run with its original snapshot available for recovery.

Existing large handoffs receive the same compaction step on their next run. The
**128 KiB** emergency read limit remains: files above it stop the runner for manual
repair. No requirements are automatically truncated, and no Codex token-window,
tool-output or auto-compaction settings are changed.

`history/*.md.gz` preserves full boundary snapshots outside the default model
context. `history.jsonl` is a runner-owned index. Workers and resolvers must not
bulk-load history merely to reconstruct chronology; they retrieve a specific older
snapshot only when current evidence requires it.

Workers and resolvers can retrieve files in `evidence/` or search `history.jsonl`
by iteration/time and decompress the selected `.md.gz` snapshot. This supports gate
verification, conflicting-state investigation and failed-attempt diagnosis without
reloading completed-task narratives on every iteration.

`sessions.jsonl` records each worker, resolver and compactor attempt, including
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
scope-sensitive. Delivery-only updates can therefore preserve compatible attempt evidence; genuine requirements changes still require worker reconciliation.
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
logs, repeated old handoffs and superseded recovery plans in the active progress
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

`BLOCKED` pauses workers and automatically dispatches a resolver. Use it when
no authorized work remains ready or a repeated failed attempt needs intervention.
Task-local blockers belong in Deferred gates while independent work continues.
A successful resolver clears the cause, records evidence and resumes workers.
An unresolved blocker becomes `Status: STOPPED`, ending the runner with exit 75
and reason `stopped`. Later queue entries remain pending.

After supplying the missing input, explicitly retry the stopped recovery:

```sh
roadmap-runner start roadmap.md --recover-blocked --json
```

MCP uses `recoverBlocked: true`. This dispatches a resolver. Restarting without
that option preserves STOPPED and makes no new agent call. Completion and loop
assessment remain agent assertions; prepared tests verify orchestration.

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
32 KiB compaction trigger and 128 KiB emergency limit apply to custom
progress files.

The progress file's opening-header status controls continuation: COMPLETE exits
successfully after pending reconciliation and worker verification; BLOCKED
dispatches a resolver; STOPPED ends the runner. Open roadmap checkboxes prevent
completion. Interrupted, capacity-only and quota-only sessions still require a
successful worker before trusting their completion claims.

The runner rejects a progress path that resolves to the source itself, including
symlink/hard-link aliases. Missing, unreadable, non-file or oversized sources still
stop explicitly without restoring files. Ordinary roadmap content edits do not.

## External controller updates

**Roadmap edits no longer stop the runner.** An external controller can correct
drift, revise priorities, add requirements or remove superseded work in the live
source file while execution continues. No flag, watcher, daemon or new API is needed.

The active worker or resolver keeps its fixed, runner-owned source snapshot.
Once that session ends, the runner checks the live roadmap again, records its new
SHA-256 revision, and tells the next worker to reconcile the latest requirements
before selecting work. Multiple edits between boundaries coalesce to the latest
published contents. The next worker preserves valid evidence and stable IDs,
reopens changed criteria, adds new gates, retires removed gates from active work,
and replaces drifted handoffs and outdated recovery decisions.

Old `COMPLETE` state cannot stop the loop while reconciliation is pending.
A global BLOCKED state dispatches a resolver against current roadmap evidence.
Pending reconciliation clears only after a successful worker on that revision.
Timeouts, capacity failures, cancellation and old sessions cannot acknowledge a
newer revision. Resolver decisions preserve the pending worker verification.


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

Worker and built-in resolver prompts still forbid source edits, weakened criteria
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

`--execution-plan <path>` (or `ROADMAP_EXECUTION_PLAN`) selects a finite plan in the existing progress authority.

```text
roadmap-runner <roadmap-file> [options]

--client <name>        codex, claude, gemini, grok, kimi, muse
--progress-file <path> override bounded progress-state path; workers never edit source
--timeout <duration>   default: 90m
--resolver-timeout <duration> blocker recovery limit; default 10m
--recover-blocked     explicitly retry a stopped recovery
--supervisor-every <n> deprecated; no scheduled reviews
--supervisor-timeout <duration> deprecated resolver-timeout alias
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
ROADMAP_RESOLVER_TIMEOUT
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
running while paused. Worker and resolver sessions share the incident deadline.
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
`Status: BLOCKED` dispatches a resolver. If recovery cannot clear the cause, STOPPED
ends the runner with exit 75 and keeps later queue entries pending.

Workers check prior attempts for repetition before selecting work. They cite the
failed operation, unchanged relevant inputs and specific receipts when blocking.
Open acceptance items may span any number of useful sessions. Recent evidence
persists across restart. Legacy idle-budget and supervisor cadence settings do
not disable worker loop checks or automatic recovery.

Set `ROADMAP_NOTIFY_BIN`
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

A timed-out resolver or missing recovery decision stops the runner with evidence
preserved. Failed workers dispatch a resolver; unavailable prerequisites may
require user action before an explicit recovery retry.

See [agent integration](docs/agent-integration.md) for `start`, `stop`, `status`, local MCP and explicit app setup. The bundled [roadmap design skill](skills/write-runner-roadmap/SKILL.md) includes task contracts and a template. Automatic chat wake-up and agent dispatch remain outside this release.
