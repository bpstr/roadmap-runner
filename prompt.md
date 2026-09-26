Work on this implementation roadmap:

{{ROADMAP}}

This is one fresh-context iteration. The roadmap and current filesystem are the
handoff to the next session. The working directory may contain multiple repositories.
Read repository instructions and preserve unrelated changes.

Select the acceptance gate:

1. Read the maintained Markdown checkbox checklist and compact current handoff
   near the top of the roadmap. Consult historical entries for evidence, not as
   a competing task list. If no checklist exists, create one from the original roadmap
   existing acceptance gates without changing their scope or deleting history.
2. Resume the current handoff active unchecked gate. If none is named, choose the first
   dependency-ready unchecked gate in roadmap order. Before editing, state its
   exact checkbox ID/text, acceptance criteria and necessary prerequisites.
   Obey any stricter per-iteration rule written in the roadmap itself. For example,
   if the roadmap says each run may process only one checkbox, do not complete,
   check, or otherwise process a second checkbox in the same invocation.
3. Compare the last two iteration records. Resolve the missing active-gate
   dependency when it is authorized and feasible; size or difficulty alone is
   not a blocker. If it needs unavailable access, an external service, user
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
   and explicit session exit criteria. Size this plan for roughly 30 minutes of
   implementation. Newly discovered children remain steps toward this outcome;
   completing one child cannot redefine the selected batch as finished.
6. For integration work, compose the required canonical harness first, including
   real middleware, transport and source families required by the selected proof.
   Reuse it across related cases in the same session. If an essential boundary
   remains prepared, carry that gap as unfinished batch work and address it before
   final validation when feasible. A narrower prepared test is prerequisite
   evidence, not a reason to defer the missing integration boundary indefinitely.

Implement and verify:

- Target roughly 30 minutes of implementation per invocation, excluding initial
  discovery and final verification. This is a planning target, not a hard deadline
  or a minimum to fill with unnecessary work. Plan several related ready child
  tasks under one parent gate that share code, context and verification.
- Keep the declared batch outcome stable. Revise it only for an evidenced change
  in requirements/dependencies or a real blocker, and record the reason. Completing
  a new nested checkbox or one source-family case is not a session exit criterion.
- A checkbox is a progress unit, not a session boundary. After finishing a child,
  continue the next related ready child in the same session until the planned
  batch is complete or roughly 30 implementation minutes have elapsed. Finish
  the current coherent coding unit, then validate and hand off; do not stop just
  because one small checkbox is done or begin an unrelated major gate to fill time.
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
- Finish the selected coding batch before validation; do not run the same checks
  after each child. Validate the completed batch once, collect related failures,
  finish the repair batch, and rerun only failed or invalidated checks. Reuse
  passing evidence for unchanged code and environments.
- Inspect executed, passed, failed and skipped counts. A skipped check is not a
  pass. Distinguish prepared tests, actual integration and deployed behavior.
- Use existing authorization for tests and side effects. An unchecked deployment
  or live-provider gate does not itself authorize publication or spending.
- Do not use subagents. Use Git only inside the applicable repositories.

Update the roadmap and stop this invocation:

- Maintain - [ ] for incomplete gates and - [x] only for gates whose stated
  acceptance criteria passed. Preserve IDs, unresolved criteria and dated failures.
- Maintain a compact Checked-item status log in the roadmap for every existing
  checked item: ID, current implemented/verified/deployed status, evidence link,
  and last status change or review date. Carry forward valid prior evidence without
  rerunning unchanged checks. Log newly checked children and each status transition
  in the dated iteration record. If new evidence invalidates a checked item,
  reopen it with the reason and retain its previous completion/failure history.
  A checked local prerequisite does not imply its parent or deployment is complete.
- Replace a compact Current handoff near the top with: active checkbox, criteria
  closed this iteration, remaining criteria, blocker/dependency, verification
  results (including skips), deferred gates with unblock conditions, and the
  exact next ready checkbox. Preserve historical records below it. Continue the
  unfinished active gate unless its documented blocker makes another gate ready.
- Record approximate discovery, implementation and verification durations plus
  child tasks completed in the dated iteration record. Use observed timings or
  label estimates; do not invent measurements. This makes bootstrap overhead
  and batch size assessable across runs. Include the loaded prompt revision and
  declared batch outcome. State the session exit reason: outcome achieved,
  implementation target reached, concrete blocker, or explicit roadmap limit.
  If exiting before the target with an unfinished outcome, explain why the related
  next child cannot be completed now; a passing narrow test alone is insufficient.
- Summarize concrete changes and checks; explain any scope change. If no gate
  closed, identify the material prerequisite advanced and how it reduces the
  remaining work. Repeated rediscovery, extra notes or adjacent tests alone
  are not progress toward the active gate.
- Before declaring the entire roadmap blocked, inspect ALL remaining unchecked
  gates and their dependencies for useful authorized implementation, repair or
  verification work. One blocked gate, a failed check, a hard task or one
  no-progress attempt is not enough: diagnose and repair, or move to a genuinely
  ready gate with the deferral recorded. Avoid repeatedly running unchanged checks.
- Set Status: BLOCKED only when no remaining gate or prerequisite can materially
  advance within existing authorization and available resources. Record every
  remaining gate blocking dependency and the exact external unblock action.
  Otherwise keep Status: IN_PROGRESS and hand off the next actionable checkbox.
- Set Status: COMPLETE only when every original gate and its required in-scope
  follow-up/child checkboxes are implemented and verified. New children must neither
  broaden original scope nor hide unfinished original acceptance criteria.
  Otherwise use Status: IN_PROGRESS when material progress permits continuation.
  Maintain exactly one of these status lines in the opening header, after an
  optional # title and before the first ## (or deeper) section heading, outside
  code fences. Historical status lines belong in sections below the header.
