# Task continuity and reusable evidence

The runner keeps Markdown as the acceptance authority while carrying structured
task state between sessions. A new worker receives the selected task, shared
constraints, previous outcome, exact next action and evidence validity. It can
continue useful work without reconstructing every earlier session.

## Focused dispatch

Ordinary roadmaps with unambiguous `### Task ID` sections use controller-selected
task snapshots. General IDs such as `AUTH-01` and `API-01.2` use one parser across
validation and dispatch. Fenced examples do not become tasks. Shared constraints
remain in each snapshot; unrelated task sections do not. Checkbox/status updates
and valid delivery-note blocks do not change a task's criteria revision.

Unknown dependencies, dependency cycles, orphan checklists, unsupported structure
or oversized selected contracts fall back to the existing whole-roadmap worker
selection path. The controller does not rewrite requirements to make them fit.
Finite execution plans continue using their declared original parents and batches.

A partial task with recorded useful progress and an exact next action stays
selected while its criteria and prerequisites remain valid and useful work remains.
There is no attempt-count cutoff. Missing/stale structured outcomes retain rotation. An implementation
outcome can move a normal task to focused verification; it never ticks acceptance.

## Worker result

When task memory is available, each worker receives an `Optional structured result file` and a `Result binding`.
Copy the binding exactly and write the result atomically at useful boundaries and
before exiting. The following is a schema example; use the current runner binding
and actual project paths rather than these illustrative values:

```json
{
  "version": 1,
  "sessionId": "copy-current-session-id",
  "taskId": "API-32",
  "criteriaRevision": "copy-current-criteria-revision",
  "operation": "implement-cursor-response",
  "outcome": "partial",
  "completed": ["Cursor parsing and query construction"],
  "remaining": ["Response cursor encoding"],
  "nextAction": {
    "file": "src/response.js",
    "symbol": "buildPageResponse",
    "instruction": "Encode the returned cursor using the existing codec."
  },
  "changedFiles": ["src/query.js"],
  "receiptIds": [],
  "findings": [
    {
      "summary": "Cursor encoding is centralized in the codec module.",
      "sourcePaths": ["src/cursor.js"]
    }
  ]
}
```

Supported outcomes are `partial`, `implemented`, `verified`, `reused` and `blocked`.
`nextAction` can also be a string. `completed`, `remaining`, `changedFiles`,
`receiptIds` and `findings` are required arrays, empty when appropriate. Receipt IDs
come from the check/review helpers below. Outcomes are agent statements about work;
acceptance remains in the original roadmap. An unsuccessful process cannot promote
an `implemented`, `verified` or `reused` claim into successful delivery.

Missing, invalid, oversized, stale or misbound results retain the existing Markdown
handoff. They do not dispatch a resolver or create a new completion requirement.
If optional task storage cannot be initialized or written, the runner warns once
and continues with that legacy handoff. An unavailable optional conversation cache
also falls back to fresh sessions.
The optional result limit is 64 KiB. The task packet is capped at 8 KiB and keeps
references to complete result evidence when details exceed that budget. Existing
legacy obligations remain available in the preserved handoff.

Source-bound findings are stored as observations with supporting file fingerprints.
A source change invalidates the finding. They do not become user instructions or
project policy. Shared lookup selects bounded recent candidates and checks only
their named sources, rather than scanning the repository each session.

### Failed operations

An outcome may include:

```json
{
  "failure": {
    "signature": "cursor-schema-mismatch",
    "inputPaths": ["src/cursor.js", "test/fixtures/cursors.json"],
    "coverageComplete": true,
    "retryCondition": "Repair the cursor schema or update the canonical fixture."
  }
}
```

Failure metadata supplies evidence for the worker's review, not an automatic loop
verdict. Every worker receives a bounded `Run history lookback` with recent tasks,
operations, outcomes, completed/remaining work, next actions, failures, input paths
and cold evidence pointers. It judges semantic repetition even when names, notes
or hashes change. Counts and repeated timeouts do not establish a loop.

A worker records its assessment and supporting attempts in the handoff and a
structured `outcome: "blocked"`, with an exact retry condition. The next task packet
includes `blockerAssessment` with provenance `agent-assessment`. This can defer the
task while independent work continues, without requiring matching hashes or
complete dependency coverage. Byte churn cannot clear that assessment. Changed
criteria or an acknowledged repair permits worker reassessment; prior evidence
remains available. Partial outcomes, including repeated failed attempts, never
become blocked merely because a counter crosses a threshold. Prepared fixtures
exercise this orchestration, not the quality of a live model's judgment.

## Runner-observed verification

Write a JSON specification inside the workspace, then run:

```sh
roadmap-runner check --spec checks/cursor.json
```

Example for a project using Node's test runner:

```json
{
  "taskId": "API-32",
  "criteriaRevision": "copy-current-criteria-revision",
  "command": ["node", "--test", "--test-reporter=tap", "test/cursor.test.js"],
  "cwd": ".",
  "inputs": ["src/cursor.js", "test/cursor.test.js", "test/fixtures"],
  "config": ["package.json", "package-lock.json"],
  "environment": ["NODE_ENV", "TZ"],
  "runtime": {"node": "record-the-project-runtime-version"},
  "coverageComplete": true,
  "format": "tap"
}
```

Adapt the scope to the actual check, including relevant transitive dependencies,
fixtures, generated inputs and configuration. `coverageComplete: true` is an
explicit declaration of scope, not dependency discovery by the runner. If coverage
is incomplete or unknown, leave it false: the command still executes, but its
result cannot become reusable proof. Empty config/environment arrays explicitly
declare that no additional inputs of that category affect the check.

Commands execute as argv with `shell: false`. Raw stdout/stderr are streamed into
private evidence files. The helper reports the receipt ID, artifact paths, observed
exit code, completion state and counts. Counts are extracted only for declared TAP
output; otherwise they remain null. Skipped checks remain skipped. A process that
times out, is aborted, changes its declared inputs, or leaves unconfirmed descendants
does not produce a successful reusable receipt even if its leader exits zero.

Reuse compares criteria revision, command, working directory, declared inputs,
configuration, environment value hashes, declared runtime and actual executable
identity. Inputs are recorded before and after the check. Identical in-flight
checks share a scope lock; inputs changed while waiting cause scope reassignment.
Unrelated repository changes do not invalidate a receipt.

The classifications are:

| Classification | Meaning |
| --- | --- |
| `reusable` | The completed command and all declared relevant inputs still match. |
| `invalidated` | A named input, criterion, command, configuration or freshness condition changed. |
| `unknown` | Coverage or trustworthy execution evidence is incomplete. |

A reusable failed check remains failed. Reusing its receipt avoids executing the
same known failure again. Set `force: true` and a nonempty `forceReason` for an
intentional rerun. A stable fully scoped timeout is also retained for failure
reuse; it never qualifies as a passing prerequisite. Mutable
external dependencies need `external: {"freshUntil": "<ISO timestamp>"}`; expired
external evidence is invalidated. A caller must declare such dependencies rather
than assuming local file hashes represent an external service's state.

Receipt reuse is scoped to the recorded check. It does not prove an entire feature
or close acceptance automatically. The existing finite implementation contract
still requires changed implementation source evidence; verification and reuse
outcomes do not bypass it.

### Repair authorization and staged checks (0.12.2)

Give a check stable `taskId`, `operation` and `stage` fields. These join criteria,
argv, cwd, runtime and declared inputs in its scope. Existing receipts without
the new binding remain historical evidence; they do not silently become cache hits.

An optional `prerequisites` array names check receipt IDs. Each prerequisite must
be a current, fully scoped, successful runner check for the same task and criteria.
Failed, interrupted, timed-out, stale or incomplete evidence rejects dispatch.
Use separate configuration, compile, module, mount, behavior and cleanup commands
in a project's recipe. Capture module/page errors at the stage where they occur.
The runner does not infer service contracts or browser readiness from a timeout.

For a repair, first run the edit as a check command. Declare its cwd and the same
consumed input paths as the failed check (including a directory scope when the
failed check consumes that directory). Then attach:

```json
{
  "repair": {
    "failedReceiptId": "check-<failed-check-uuid>",
    "editReceiptId": "check-<edit-check-uuid>"
  }
}
```

The edit must finish successfully; its before/after snapshots must verify the
relevant changed inputs. Failed edits and unrelated changes cannot authorize a
new probe. A changed, current successful `prerequisites` binding can instead
authorize a repaired dependency using `repair.failedReceiptId` without a separate
edit receipt. An unchanged check can return the original failed receipt without
dispatching. A byte change permits verification, not an assertion that the repair
is correct: preserve exact behavior assertions and any new failure stage.

Scope compiler checks to their actual source inventory and build inputs so a
fixture-only repair can retain compatible compiler evidence. Include directories
when additions/removals matter. Incomplete coverage remains unknown. Source review
findings stay assertions; changing source invalidates affected checks and requires
their smallest relevant rerun. Passing a command does not close review findings.

`test/fixtures/delivery-assurance.cjs` is a synthetic local recipe for field/type,
authorization, timeout-limit, compile-timeout, module and content drift. Prepared
compilation is explicitly simulated; it does not establish service compilation,
browser behavior or provider quality.

### Validated handoffs and queue continuation (0.12.2)

Source and progress control headers are validated before readiness or model
dispatch, including queued entries. Errors identify the file and line.
`roadmap-runner update-handoff --spec update.json` accepts `roadmap`,
`progressFile`, `contents`, `expectedHash` (SHA-256 of current progress bytes) and
`sourceRevision` (SHA-256 of current source bytes). It validates the candidate and
both bindings before atomic replacement. Cooperating updates share a lock;
rejected or stale updates preserve the prior content.

CLI `--queue-spec queue.json` accepts the same ordered
`[{"roadmap":"next.md","progressFile":"custom-handoff.md"}]` entries as MCP
`roadmap_start.queue`. Supply the same progress paths when explicitly recovering
a blocked run so existing receipts and handoff evidence remain available. Park or
stop does not dispatch later entries or discard their order/dependencies.

## Scoped review continuity

Record an agent review with:

```sh
roadmap-runner record-review --spec checks/review.json
```

The specification contains `taskId`, `criteriaRevision`, `verdict`, `inputPaths`
and `findings`. A review receipt retains the inspected source fingerprints and
verdict as an agent assertion. Subsequent task packets identify changed source or
criteria and expose previous findings so a reviewer can assess the affected delta.
A review assertion never becomes a runner-observed test pass or an acceptance rule.

Both evidence helper commands are available to workers. Starting or controlling
another managed runner remains restricted by the existing worker-context check.

## Acknowledged checkpoints

The soft checkpoint request includes a request ID and exact result/acknowledgment
paths. After the request exists, refresh the structured worker result and atomically
write this acknowledgment to the supplied path:

```json
{
  "version": 1,
  "requestId": "copy-current-session-id",
  "resultFile": "/exact/runner/supplied/worker-result.json"
}
```

The runner checks freshness, identity, task/criteria binding, changed paths and the
same worker-result schema used at exit. It derives the edited paths and next action
from that result, avoiding a second copy. Saving a controller request alone is not
an acknowledgment. Polling begins only after the request, checks bounded files, and
performs a final read at process exit. An acknowledgment does not kill the worker;
the prompt requests a controlled exit and the existing hard timeout remains.

This file protocol is not live chat steering. Plain CLI clients must follow the
checkpoint instructions or write incremental results at natural work boundaries.

## Finite scheduling boundaries

Normal exhaustion of the authorized batch window returns `needs_next_batch` or
`awaiting_verification` with exit code 0. Managed status and the current queue item
retain that state. Open original acceptance is preserved, and later queued roadmaps
do not advance. Supply the next authorized batch or qualification work and start
again; a resolver is unnecessary when no diagnosis is required.

Unmet prerequisites, global blockers and failed clients retain resolver recovery.
Repeated hard timeouts return to a worker for a history assessment. A replacement requirement or interrupted attempt may
still need recovery before an exhausted plan can be accepted as a normal boundary.

## Codex conversation reuse

Codex conversation reuse is enabled by default. Disable it with
`--no-session-continuation`, `ROADMAP_SESSION_CONTINUATION=0`, or MCP
`sessionContinuation: false`. CLI flags override the environment setting.
Saved conversation state is cleared when each roadmap completes, before the next
queued roadmap starts. Only the current task conversation is retained.

Only explicit provider-reported Codex thread IDs are reused. Task, owner, batch
boundary, criteria, role, workspace, model, effort, executable and prompt changes
start a fresh conversation. A failed, interrupted, timed-out or quota-limited
client turn is not retained. Same-task reuse has no default turn cap;
missing usage telemetry alone does not end it. Aggregate
input tokens remain recorded as usage telemetry: they include cached context
repeated across requests and do not measure active context occupancy. This counter
does not impose a default continuation cutoff. Other adapters retain fresh sessions.
If Codex explicitly reports that the requested thread is unavailable before any
agent activity, the runner retains that failed transport receipt and retries the
same invocation once with fresh context. Other failures retain normal recovery.

## Observability and validation

Session receipts distinguish first output, first command and first edit times.
Bounded command and explicit file-read request fingerprints are retained in cold
detail evidence; event payloads contain compact counts. Repeated request text is
an observation and does not prove unchanged inputs or wasted work.

New events include `runner.task_result`, `runner.task_result_invalid`,
`runner.checkpoint_acknowledged`, `runner.continuation_fallback` and `runner.plan_exhausted`. Task packet receipt
classifications show reuse/invalidation reasons. Detailed outputs and failed
evidence remain available by reference.

Prepared fixture tests exercise the protocols and state transitions, including
task affinity, scoped invalidation, partial quota, stale results, duplicate checks,
descendant cleanup, checkpoint freshness and task/role conversation boundaries.
They make no live provider calls and do not establish a measured production speedup
or guarantee that a model declares complete dependency coverage correctly.
