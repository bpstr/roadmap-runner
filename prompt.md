Work on this implementation roadmap:

{{ROADMAP}}

Tracking file (progress / delivery evidence):

{{PROGRESS_FILE}}

Tracking mode: {{TRACKING_MODE}}
Cold history (do not bulk-load): {{HISTORY_DIR}}

Read applicable repository instructions. Preserve concurrent edits, unfinished
files, original task IDs, acceptance criteria, historical failures and immutable
runner snapshots. Use Git only in the owning repositories. Do not use subagents,
start another runner, change permissions, deploy or publish without authorization.
Automated AI checks use deterministic fixtures and mocked transports; never load
credentials into tests, record live fixtures or spend provider credits.

1. Recover the current outcome.

Read the compact handoff and current supervisor correction. When Runner context
names a finite execution authority, read only the selected original task snapshot
and named batch/prerequisite evidence. That batch determines this invocation's
scope and actual owning roadmap/task. Otherwise read the pinned source snapshot
once and select one ready original task from the existing dependency graph.
The live roadmap owns acceptance checkboxes; the snapshot is the immutable authority
for this session's criteria. It overrides conflicting handoff prose. An empty
handoff or missing checklist is not completion.

On recovery inspect the recorded unfinished paths and exact next action before
further discovery. Reuse compatible generation, compilation and check receipts.
Investigate only a named missing dependency or changed input. Cap initial discovery
at five minutes; if that cannot establish the prerequisite, record its existing
owner, evidence and unblock condition and return for rotation/replanning.
A fresh context does not justify repository-wide scans or unchanged checks.

Reconcile genuine requirement amendments against their changed criteria. Preserve
valid proof and concurrent edits. Delivery/status updates alone do not change
requirements. Read the live file before each targeted edit. Concise delivery prose
belongs inside standalone `<!-- roadmap-runner:delivery:start -->` and
`<!-- roadmap-runner:delivery:end -->` markers. Requirements, dependencies,
priorities and acceptance checkboxes remain outside those markers.
Reconciliation never postpones a scheduled supervisor.

2. Implement one finite deliverable.

Record the deliverable, original task/operation IDs, implementation boundary,
necessary prerequisites and completion/checkpoint criteria in Current handoff.
Use the configured 30–45-minute implementation budget and soft deadline in Runner
context. This is a ceiling, not a minimum. Finish the named outcome or save exact
remaining functionality at the soft deadline, leaving time before hard termination.
Check the clock after commands; avoid work that cannot finish before checkpointing.

Discovery within accepted scope updates missing work under its existing owner.
Temporary steps belong in the current batch plan, without new checkboxes or
scheduling tasks. Keep the original baseline denominator fixed. Put proposed new
scope aside for a controller decision. Generator activity, notes and decomposition
alone are not the promised user-visible outcome.

If a prerequisite is unavailable, retain its gate and exact unblock condition once
and return so the controller can select another ready outcome. Repeated timeout or
unchanged-outcome attempts require corrective review and an explicit revised plan.

3. Apply the current verification phase.

User/repository phase rules take precedence. During development-before-qualification,
perform only permitted source review, formatting, generation and production
compilation. Keep test/qualification and mixed acceptance checkboxes open.
Otherwise choose the smallest affected checks before running them, batch repairs,
retain failures and rerun only invalidated/failed coverage. Record concrete shared
impact before widening. A new session or commit does not invalidate passing proof.
Inspect final executed/passed/failed/skipped counts. Prepared, compiled, verified
and deployed are distinct states; skipped checks are not passes.

For integration implement the actual transport/domain boundary and canonical
fixtures. A prepared component does not prove missing end-to-end behavior. Source
delivery does not qualify runtime, endpoint performance, consumers or deployment.

4. Save the result and stop.

Update the original owner's implementation state and exact missing functionality
separately from verification. In finite-plan mode update only the selected batch
and existing baseline entries; record the requested hand-authored source evidence.
Tick an acceptance checkbox only after all its criteria and required validation
pass. Reopen it when concrete evidence invalidates the receipt.

Replace the handoff in place, keeping it below 32 KiB (32768 UTF-8 bytes; measure
with `wc -c`). At or above 32 KiB the runner archives it and starts separate
compaction. Move details into referenced evidence files; if it still reaches the
limit, save the state and exit for compaction. Handoff size alone is not a reason
to set BLOCKED. Keep only current outcome,
implemented prerequisites, remaining functionality, blockers, next action and
specific evidence/history pointers. Retrieve historical details on demand. Keep
one current supervisor review and point to deferred gates in their existing owners.
The source roadmap may be up to 256 KiB (262144 bytes), inclusive. Preserve its
requirements; never compress or truncate the source to fit the handoff budget.

Before the soft checkpoint deadline save edited paths, exact remaining work, the
next command/action and reusable/failed evidence, then exit. Preserve partial files
on interruption. A controller snapshot preserves recorded state; it cannot infer
missing work that you have not written down.

For current attention use one line in Deferred gates:
`- BLOCKED TASK-ID: reason | Unblock: condition | Retry: changed input`, or the same
form with NEEDS_INFO, PROBLEM or SKIPPED. Remove resolved flags. A local deferral
does not block unrelated ready work.

Maintain exactly one opening status line before the first second-level heading:
`Status: IN_PROGRESS`, `Status: BLOCKED` or `Status: COMPLETE`. COMPLETE means all
original acceptance passed, never merely that the current batches delivered.
BLOCKED means no authorized useful work remains under the current plan. Explicit
blocked recovery permits one attempt after the recorded input changes. Summarize
functionality, evidence, remaining work and exit reason concisely.
