Work on this implementation roadmap:

{{ROADMAP}}

Tracking file (progress / delivery evidence):

{{PROGRESS_FILE}}

Tracking mode: {{TRACKING_MODE}}

Archived progress snapshots (cold history; do not bulk-load):

{{HISTORY_DIR}}

This is one fresh-context iteration. The live roadmap owns task checkbox states
and concise delivery status. The source roadmap snapshot named in Runner context
is the immutable authority for this session's goal, scope, constraints and
acceptance criteria. Preserve that snapshot. Controller requirement changes take
effect on the next iteration. The separate tracking file holds bounded evidence,
blockers, progress notes and handoffs, with references to roadmap task IDs rather
than a competing checklist. Prior tracking snapshots remain in cold history.
Read repository instructions and preserve unrelated changes.

- Tick verified tasks directly in the live roadmap, and reopen tasks when concrete
  evidence invalidates acceptance. Update its concise status at each batch boundary.
  Read the current live file before each targeted edit; preserve concurrent controller
  edits, original task IDs, criteria, dependencies and scope. Keep detailed evidence
  and handoffs in the separate tracking file. Never edit runner-owned snapshots.
- At the start of EVERY iteration, re-read the source roadmap before trusting the
  current handoff. Map the active gate and every proposed child back to an original
  requirement. If tracking text conflicts with the source, the source wins. Remove
  the drift from active state instead of carrying it forward.
- When Runner context requires roadmap reconciliation, first compare the current
  source revision with the checklist, evidence, priorities and latest supervisor
  target. Preserve valid evidence and IDs; reopen changed acceptance criteria,
  add new gates, retire removed gates from active work, and replace stale handoffs.
  Do not treat old COMPLETE/BLOCKED as valid for revised requirements. Set status
  anew after reconciliation, even when no implementation is needed. This authorizes only live roadmap task-state/status updates; keep snapshots,
  acceptance criteria, scope, side-effect permissions and budgets unchanged.
- Keep the tracking file as bounded working memory, not an append-only journal.
  Replace Current handoff, Batch plan, Latest supervisor review and current evidence
  summaries in place. Do not paste raw CLI output, diffs, test logs, repeated prose,
  old handoffs or completed iteration narratives into it.
- Historical snapshots live under the archive directory above. Do not read the
  archive by default. Consult one specific older snapshot only when current state
  references it or when evidence is genuinely needed to resolve uncertainty.
- Put any necessary bounded child checkboxes in the owning live roadmap under
  their original parent, preserving the original acceptance bar. Use stable task
  IDs in the handoff rather than a second checklist.
- Keep original gate IDs and criteria, or a stable source heading/text reference
  when IDs are absent. Evidence summaries should be short references to durable
  artifacts (commit, test command/result, file, receipt), not copies of those artifacts.

Supervisor handoff:

- Read the Latest supervisor review in the tracking file before choosing the next
  batch. Apply its next delivery target when still supported by current evidence;
  this is a scoped batch adjustment, never permission to weaken original criteria.
  If new facts invalidate it, record the evidence and replacement before coding.
- Test the review's measurable next-run expectation and report what changed. Do
  not repeat unchanged discovery or failed checks merely to produce activity.
  Preserve only the current review and its actionable reason in hot state; older
  versions are already retained by runner-owned archived snapshots.

Select the acceptance gate:

1. Read the source roadmap and its live Markdown checkbox checklist, then
   compact current handoff in the tracking file. Consult historical entries for
   evidence, not as a competing task list. If no checklist exists, create it in
   the live roadmap from the original roadmap's acceptance gates without changing
   their scope or deleting history. An empty tracking scaffold is not completion.
2. Resume the current handoff active unchecked gate. If none is named, choose the first
   dependency-ready unchecked gate in roadmap order. Before editing, state its
   exact checkbox ID/text, acceptance criteria and necessary prerequisites.
   Obey any stricter per-iteration rule written in the roadmap itself. For example,
   if the roadmap says each run may process only one checkbox, do not complete,
   check, or otherwise process a second checkbox in the same invocation.
3. Compare the current handoff and latest supervisor review with the actual
   repository state. Do not load prior iteration narratives merely to reconstruct
   chronology. Resolve the missing active-gate dependency when it is authorized
   and feasible; size or difficulty alone is not a blocker. If it needs unavailable access, an external service, user
   judgment or another unmet dependency, leave its checkbox open and record the
   evidence, unblock condition and next ready checkbox. Continue other useful
   authorized work in this invocation if coding has not started, or hand it off
   for the next iteration after finishing the current coherent batch.
4. Revisit a deferred gate only when its unblock condition changes or a planned
   bounded retry is due. Keep a compact deferred-gates list in the handoff so
   fresh contexts do not repeat discovery or silently forget the original gate.
   Resume it when ready; do not replace its criteria with smaller adjacent tests.

5. Before coding, write a Batch plan in the current handoff: one concrete outcome,
   original parent gate, related child IDs, shared harness/setup, combined checks
   and explicit session exit criteria. Size this plan for roughly 60 minutes of
   implementation. Newly discovered children remain steps toward this outcome;
   completing one child cannot redefine the selected batch as finished.
6. For integration work, compose the required canonical harness first, including
   real middleware, transport and source families required by the selected proof.
   Reuse it across related cases in the same session. If an essential boundary
   remains prepared, carry that gap as unfinished batch work and address it before
   final validation when feasible. A narrower prepared test is prerequisite
   evidence, not a reason to defer the missing integration boundary indefinitely.

Implement and verify:

- Target roughly 60 minutes of implementation per invocation, excluding initial
  discovery and final verification. This is a planning target, not a hard deadline
  or a minimum to fill with unnecessary work. Plan several related ready child
  tasks under one parent gate that share code, context and verification.
- The default total worker-session budget is **90 minutes**:
  discovery, implementation, feature verification and compact handoff all fit
  inside it. Use that allowance to deliver a meaningful feature or coherent
  milestone, not isolated fragments followed by another bootstrap. The approximate
  60-minute implementation target is a planning aid, not a mandatory exit point.
  Leave time for verification and handoff before the configured timeout; do not
  assume an extra hour for those steps or wait for forced termination. This is
  not a minimum duration and does not change the configured runner timeout.
  Stricter roadmap limits and the actual configured timeout always take precedence.
  Do not change those settings or add unrelated work just to fill the allowance.
- Keep the declared batch outcome stable. Revise it only for an evidenced change
  in requirements/dependencies or a real blocker, and record the reason. Completing
  a new nested checkbox or one source-family case is not a session exit criterion.
- A checkbox is a progress unit, not a session boundary. After finishing a child,
  continue the next related ready child in the same session until the planned
  batch is complete or the remaining session budget must be reserved for
  verification and handoff. Finish the current coherent coding unit within that
  budget; do not stop just because one small checkbox is done or begin an unrelated
  major gate to fill time. If the feature remains incomplete, record its exact
  next implementation step and pending verification rather than claiming completion.
- If a gate is too large, break it into ordered, independently verifiable child
  checkboxes with stable IDs under the same parent. Complete a coherent group
  per run. Size and difficulty require decomposition, not deferral. Stop earlier
  if the parent gate closes, no related authorized work can advance, or a stricter
  explicit roadmap run limit applies. Leave unfinished children for the handoff.
- A local prerequisite or prepared component test does not close an end-to-end
  gate. Keep the parent unchecked until its full stated criteria pass; record
  prerequisite progress with child checkboxes under that parent. Child completion
  is measurable progress, not a replacement for the full parent acceptance gate.
- Add follow-up checkboxes for discoveries, repairs and missing verification only
  when necessary to satisfy an original requirement. Each must identify its
  original parent ID, the exact acceptance criterion it serves, a concrete result
  and verification. Keep scope, permissions and completion standards unchanged.
  Record unrelated opportunities separately as out of scope; do not add them to
  the actionable checklist or treat them as completion dependencies.
- **Implementation before feature verification.** Do not spend an iteration merely
  rerunning the active feature's acceptance/integration tests. Implement the
  planned feature/batch first; run its feature-level verification once the batch
  is believed complete enough to satisfy the selected criteria.
- A failed feature check is durable evidence, not an invitation to immediately
  rerun it. Across iterations, do not rerun the same failed feature check until
  implementation materially changes code/configuration relevant to that failure.
  Record the failed check and the required implementation change in Current handoff.
- After a feature check fails, the next useful action is normally implementation
  or repair. A verification-only next iteration is allowed only when the roadmap
  task itself is explicitly verification/diagnosis/reproduction work, or when a
  concrete external/environmental condition changed and rerunning the check is
  necessary to distinguish that change. Record that exception explicitly.
- Finish the selected coding batch before validation; do not run the same checks
  after each child. Validate the completed batch once, collect related failures,
  finish the repair batch, and rerun only failed or invalidated checks **after a
  relevant repair**. Reuse passing evidence for unchanged code and environments.
- Inspect executed, passed, failed and skipped counts. A skipped check is not a
  pass. Distinguish prepared tests, actual integration and deployed behavior.
- Use existing authorization for tests and side effects. An unchecked deployment
  or live-provider gate does not itself authorize publication or spending.
- Do not use subagents. Use Git only inside the applicable repositories.

Update the roadmap and handoff, then stop this invocation:

- In the live roadmap, maintain - [ ] for incomplete gates and - [x] only for
  gates whose stated acceptance criteria passed. Reconcile existing tracking-only
  completions against their receipts before ticking the corresponding roadmap task.
  Keep original parents open until every original criterion passes. Record evidence
  references and unresolved criteria in the handoff; remove duplicate tracking checklists.
- Keep active progress below 96 KiB, with a hard runner limit of 128 KiB. When Runner context requests compaction, compact before implementation; preserve all gate IDs, criteria, checkbox states, unresolved blockers and current evidence references. Never put removed iteration prose into the source roadmap. If required state cannot fit, report the context blocker rather than deleting requirements.
- Maintain compact Checked-item evidence only for acceptance gates whose current
  state matters: ID, implemented/verified/deployed state, a short evidence reference,
  and last relevant change. Do not accumulate one prose log entry per iteration.
  If new evidence invalidates a checked item, reopen it with the current reason;
  the runner-owned archive retains earlier snapshots.
- Replace Current handoff near the top with: active checkbox, criteria closed this
  iteration, remaining criteria, blocker/dependency, concise verification results
  including skips, deferred gates with unblock conditions, and the exact next ready
  checkbox. Delete superseded handoff prose rather than moving it into a history
  section. Continue the unfinished active gate unless its documented blocker makes
  another gate ready.
- Keep timing and exit information concise in the current handoff: approximate
  discovery/implementation/verification durations when useful, loaded prompt
  revision, declared batch outcome and exit reason. Do not create a growing dated
  iteration-history section; the runner archives each boundary snapshot separately.
  If exiting early with an unfinished outcome, explain only the current reason.
- Summarize concrete changes and checks; explain any scope change. If no gate
  closed, identify the material prerequisite advanced and how it reduces the
  remaining work. Repeated rediscovery, extra notes or adjacent tests alone
  are not progress toward the active gate.
- Treat task-local blockers as deferrals. Record evidence, the exact unblock
  condition and a retry trigger, then use the existing dependency map to select
  another ready implementation unit. Keep Status: IN_PROGRESS while any useful
  authorized implementation or necessary repair can advance.
- Avoid repeated scans: read the active source/current handoff once, then inspect
  only named changed inputs and the active code boundary. Reuse the recorded
  prerequisite audit; do not recursively inventory sibling repositories, search
  the same cache, rehash unchanged receipts or rewrite unchanged blocker notes.
  Resolve repository instructions at the workspace and ancestor paths, not by
  enumerating unrelated checkouts. A new scan needs a concrete changed input or
  an explicitly recorded unresolved question it will answer.
- If Runner context says Blocked recovery mode: YES, this is one explicitly
  requested recovery worker (or required verification after an interrupted run).
  Check the supplied changed unblock input once. If it resolves the blocker,
  implement/verify the next ready unit and set IN_PROGRESS. If it does not, retain
  BLOCKED with the existing evidence and stop; do not invent preparation work or
  repeat discovery to occupy another session.
- In the bounded `## Deferred gates` section, flag each problematic task using one
  line: `- BLOCKED TASK-ID: reason | Unblock: exact condition | Retry: trigger`,
  `- NEEDS_INFO TASK-ID: question | Unblock: required answer | Retry: answer arrives`,
  `- PROBLEM TASK-ID: failed check | Unblock: repair | Retry: changed evidence`, or
  `- SKIPPED TASK-ID: dependency | Unblock: prerequisite | Retry: prerequisite done`.
  Keep these task IDs stable, remove the flag when resolved, and leave the task's
  acceptance checkbox unchecked until implementation and validation both pass.
  A deferral is visible unfinished work. Prefer independent ready tasks over a
  repeated attempt on unchanged blockers; ask one precise question when input is needed.
- Status: BLOCKED stops the runner without another worker or supervisor. Use it
  only when the existing dependency audit shows no useful authorized work remains.
  Record each unresolved blocker, its owner, exact unblock condition and retry
  trigger once. Keep blocked/failed/skipped criteria unchecked. An external
  controller can request one recovery worker with --recover-blocked after inputs
  change; elapsed time alone is not an unblock signal. Rewriting notes is not progress.
- Set Status: COMPLETE only when every original gate and its required in-scope
  follow-up/child checkboxes are implemented and verified. New children must neither
  broaden original scope nor hide unfinished original acceptance criteria.
  Otherwise use Status: IN_PROGRESS when material progress permits continuation.
  Mirror the current overall state in exactly one machine status line in the
  tracking file opening header for recovery control. Task completion remains in
  the live roadmap. Place that line after an
  optional # title and before the first ## (or deeper) section heading, outside
  code fences. Historical status lines belong in sections below the header.

When Runner context says Recovery verification required: YES, re-evaluate the
persisted terminal status and acceptance evidence before trusting prior completion.
The last session may have failed, timed out or exhausted quota after editing state.
Preserve proven work and flags, validate remaining criteria, then continue ready tasks.
