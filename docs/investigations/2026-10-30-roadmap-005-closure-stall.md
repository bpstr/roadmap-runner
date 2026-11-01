# Roadmap 005: long-running work without acceptance closure

- Status: Evidence prepared; controller remediation proposed, not implemented
- Owner: Roadmap Runner maintainers; initiating assistant owns invocation and monitoring choices
- Reviewed: 2026-10-30
- Runtime: 0.12.4; observed prompt revision `a579bdce0ca4`
- Repository inspected: `3e6478644d727404bd4317f1723d6e11e3b0f3aa`
- Evidence: [timeline](../evidence/closure-stall-20261030/timeline.json), [summary](../evidence/closure-stall-20261030/summary.json), [parser replay](../evidence/closure-stall-20261030/task-index-analysis.json), [code identities](../evidence/closure-stall-20261030/code-identities.json)

## What happened

Two managed runs remained on the same roadmap for more than 20 hours combined.
The first run delivered recorded acceptance closures early, then continued for
hours without another original criterion closing. The second run added more
contributions without closing any original criterion. Both ended through explicit
stop requests, not automatic recognition of the acceptance plateau.

| Run, abbreviated | UTC interval | Duration | Worker turns | Original implementation checkboxes |
| --- | --- | --- | --- | --- |
| `c55f64d76ea0…` | Oct 29 17:59:56–Oct 30 07:08:56 | 13h 09m | 13 | 0/17 → 10/17; last closure at 22:26:48, after turn 6 |
| `ddb0a93744ed…` | Oct 30 11:16:39–18:29:38 | 7h 13m | 12 | 10/17 → 10/17 |

The plateau comprises **19 subsequent worker turns and 15h 55m of managed-run
wall time** across these two runs: 8h 42m at the end of the overnight run plus
7h 13m in the later run. There was a 4h 08m gap between the runs; these are not
claims of one uninterrupted 20-hour execution. Intermediate failed launches in
that gap are not included in those totals.

The first six turns did close ten original criteria. The record therefore does
not support calling the entire overnight run useless. Nor does an open checkbox
alone prove that an individual implementation slice was unnecessary. The failure
was allowing an expanding sequence of slices to continue without independently
checking its finite relationship to acceptance or escalating the plateau.

The later run reported eleven `implemented` outcomes and one `partial` outcome,
142 receipt references and 240 changed-file references, while remaining at 10/17.
Those are worker reports and references, not 142 independently accepted milestones
or 240 distinct files. Its operation labels predominantly identify two existing
criteria, with no evidence that every contribution was unrelated to the roadmap.
The controller did not establish whether the contributions were sufficient,
bounded, overlapping, or displacing the next closable outcome.

## How this was established

The reconstruction joins each `runner.turn_starting`, `runner.task_result` and
`runner.turn_finished` event to its structured worker result and archived full
source roadmap. Before/after source states were recovered for every turn, with
no missing source comparisons. The original seventeen implementation IDs were
counted separately from six later webhook parent/subtask boxes. Their requirement
texts did not change in the recovered comparisons. Checkbox closure is an observed
source-state transition, not an independent correctness verdict.

All 26 unique recovered source versions were replayed through the current task
parser. Thirteen use the unsupported-for-focused-dispatch flat format. The other
thirteen have task headings but six orphan checkboxes; the final selected contract
also exceeds 24 KiB. **None qualified for focused controller selection.** The
observed events confirm one synthetic task ID for the entire roadmap in both runs.

The private evidence collection retains source/event/result paths and SHA-256
digests in the Assign workspace under
`.codex/qualification-evidence/roadmap-runner-stall-20261030/`. This repository
contains selected structured facts only: no private source bodies, transcripts,
customer payloads or credentials. The earlier Assign review also found an import
cycle and 81 fixture compilation diagnostics; those were repaired separately.
They demonstrate why reported local progress cannot substitute for closure checks,
but this investigation does not attribute every diagnostic to these two runs.

## Confirmed enabling conditions

**RR-STALL-01 — Broad fallback removed per-task control.**
[The lifecycle selects no plan when parsing is unreliable](../../src/lifecycle.ts#L219)
and uses [one roadmap-derived fallback task ID](../../src/lifecycle.ts#L250).
The worker prompt explicitly delegates selection to the worker in that mode.
The fallback is documented in [task continuity](../task-continuity.md#focused-dispatch),
but it removes the controller's ability to measure individual task completion.
Starting a valid managed run did not establish that focused scheduling was active.

**RR-STALL-02 — Continuation and acceptance were different things, but only continuation governed dispatch.**
[Structured results](../../lib/task-memory.js#L35) validate identity, shape and
paths. They do not prove that `completed` claims reduce a remaining original
criterion. [Blocker assessment](../../lib/task-memory.js#L168) requires the worker
to declare `blocked` or `scheduling: defer`; ordinary `partial` and `implemented`
results do not trigger it. [Run history](../../lib/run-evidence.js#L159) is marked
context-only and explicitly leaves repetition judgment to the next worker.
That is the same decision-maker that selected and justified the preceding work.

**RR-STALL-03 — Session timeouts were not run or acceptance budgets.**
The overnight configuration used 90 minutes, the later run 45 minutes. These are
limits on each client invocation; [checkpointing requests a save before that limit](../../lib/checkpoint.js#L6).
[The lifecycle loops again after successful work](../../src/lifecycle.ts#L217)
and even continues after a timed-out worker. No worker in either incident run
reported `timedOut`; successful sessions repeatedly finished inside their limits.
The managed start schema exposes no cumulative run or acceptance-plateau budget.
The printed phrase `Timeout: ... per run` obscures that distinction.

**RR-STALL-04 — No independent periodic review remained.**
The configuration stored `supervisorEvery: 0`, but enabling that legacy option
would not fix this: the [README declares scheduled supervisors removed](../../README.md#L336).
The active lifecycle roles are worker, resolver and compactor. Resolver attempt
limits matter only after a blocker is raised; they do not bound successful
continuations. The [worker prompt](../../prompt.md#L28) asks the worker to detect
semantic repetition while warning that elapsed time, attempt counts and open
acceptance do not themselves prove a loop. There is no separate review trigger
when those signals accumulate.

**RR-STALL-05 — Attention existed in the journal, but recognition was not assured.**
The overnight run recorded seven `runner.needs_attention` events; the later run
recorded eight. They described blocked/problem/needs-info items, not an acceptance
plateau, and did not stop independent work. Both invocations explicitly set
`notify: off`; [the notification dispatcher returns immediately in that mode](../../src/notifications.ts#L57).
No desktop notification artifact exists for either run. MCP events can still be
read, but [resource updates do not guarantee waking an idle agent](../mcp-events.md#what-mcp-can-do).
No acknowledged external monitoring receipt was found in the inspected run records.
The initiating assistant's invocation disabled desktop alerts and did not establish
an independent progress monitor. This was a caller-side contributing failure too.

**RR-STALL-06 — Prose churn and short memory obscured the unchanged acceptance set.**
Every turn began with a different source revision, despite no original requirement
text changing in the reconstructed comparisons. The two runs used eight and three
criteria revisions respectively. [Requirements hashing](../../lib/task-index.js#L25)
includes prose outside valid delivery-note blocks. History presented to workers
is bounded to eight records, and persisted task memory is also bounded. An
unbounded plateau therefore lacked a durable acceptance baseline independent of
source hash, new operation labels, sessions and supporting evidence.

**RR-STALL-07 — A fresh client session did not reset stale task memory.**
During the later repair handoff, run `20e81b0c1984…` referred to obsolete unfinished
export work. Restarting with `sessionContinuation: false` as `882772c31ae6…`
still referred to that checkpoint. [Task packets](../../lib/task-memory.js#L240)
load the prior outcome and exact next action from progress-associated state even
for a fresh client session. Both short runs were explicitly stopped, with no
remaining child groups. Isolating the progress state while retaining the new
handoff started `1f13ece1c31b…` without that obsolete checkpoint. This is recovery
friction; it is not evidence of another twelve-hour run.

## Prepared reproduction

[The standalone reproduction](closure-stall-reproduction.mjs) supplies a local
executable as the client, forwards no credential environment and makes no model
or network request. A flat roadmap retains one unchecked criterion. Each prepared
worker adds a supporting file line and reports `partial`, `continue` and an exact
next action. Four workers run with the same criterion revision; none closes the
criterion, none is a resolver, and no `runner.progress_observed` event occurs.
The fixture writes `STOPPED` after call four to contain the experiment. The
controller did not reject the preceding continuation pattern.

This reproduces on both the repository and installed 0.12.4 CLI:
[repository result](../evidence/closure-stall-20261030/prepared-repository.json),
[installed result](../evidence/closure-stall-20261030/prepared-installed.json).
It demonstrates the control gap, not that useful partial work must always stop
after four sessions.

```sh
node docs/investigations/closure-stall-reproduction.mjs /path/to/local-evidence
```

The installed CLI and checkout both identify as 0.12.4 but differ in lifecycle
and prompt content. The incident logs' prompt hash matches the checkout, and the
observed resumed worker launches from this checkout's `dist/worker.js`. Relevant
hashes and both prepared outcomes are preserved; historical full runtime bundle
hashes were not recorded, so exact historical executable identity is a limitation.

## Fix requirements and regression acceptance

These are proposed controller changes, not authorization to weaken acceptance,
force false completion, discard useful partial work, or require human review of
every slice. Scope can grow when a source-proven prerequisite warrants it; that
growth needs finite accounting and must not silently reset the progress budget.

| Priority | Required behavior | Prepared acceptance case |
| --- | --- | --- |
| P1 | Expose and persist scheduling mode and fallback reason; warn before unattended broad mode. | Flat format, orphan boxes and oversized contracts report their exact loss of task-level control. |
| P1 | Maintain original criterion and finite subgap ledgers separately from contribution outcomes. | Eleven implemented contributions with no criterion/subgap reduction remain an observable plateau, not eleven task completions. |
| P1 | Add cumulative active-time and progress-review budgets, persisted across sessions/restarts. At a threshold, checkpoint and require a controller review or park under the selected policy. | The prepared continuation cannot run indefinitely; new hashes, renamed operations or fresh sessions do not reset the budget. Legitimate measured subgap reduction can justify a bounded extension. |
| P1 | Generate durable plateau/scope-growth attention independently of worker self-declaration, with an explicit delivery/acknowledgment policy for unattended runs. | An idle initiating chat and disabled desktop notifications cannot be mistaken for acknowledged monitoring. Test event persistence and missed-delivery visibility without a real desktop or model. |
| P1 | Give current reviewed handoff decisions precedence over stale continuation after reconciliation; preserve history. | A fresh session adopting a repair handoff does not resume a superseded export checkpoint from the same progress state. |
| P2 | Preserve criterion-level closure age, remaining subgap trend and scope additions outside short lookback retention. | More than eight turns, changed prose and process restart retain the same unresolved baseline and last accepted milestone. |
| P2 | Label timeout as per-session; expose total active time, time since acceptance progress, review budget and effective supervision in status. | A 45-minute configuration cannot imply a 45-minute overall stop. Deprecated supervisor settings report that no scheduled reviews occur. |
| P2 | Record executable/prompt bundle identity and scope-bound receipt provenance at start. | Same-version installations with different content are distinguishable; receipts and checkbox claims remain distinct from accepted closure. |

## Current containment and remaining exposure

Manual review repaired the recorded compilation problems and reconciled 132
source owners into a frozen, named gap list. The isolated resumed run
`1f13ece1c31b16b9e862aa7b` remains active. Its output observed at
2026-10-30 20:37 UTC reports two gap closures, reducing that list from 23 to 21,
with selected prepared checks and production compilation. That is a materially
better finite progress signal than a contribution label alone, although this
investigation has not independently requalified the new changes. The original
implementation count remains 10/17. The active work was preserved.

These handoff repairs do not implement any of the controller safeguards above.
There was no configured twelve-hour deadline that malfunctioned: cumulative
duration, acceptance stagnation and unattended recognition were not independently
bounded. A better worker handoff reduces the immediate risk without closing
this runner incident.

The earlier [source-complete deferral loop](source-complete-deferral-loop.md) is a
separate incident: rapid synchronous controller transitions without agent turns.
This incident contains real, long worker sessions. Fixing that queue spin did not
address acceptance stagnation in successful workers.

No production controller code was changed for this report. Verification was
limited to historical reconstruction, parser replay, two prepared reproductions,
artifact/link checks and whitespace checks; no application suite, paid inference,
deployment or external publication is claimed.
