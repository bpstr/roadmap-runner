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

Implement and verify:

- Complete one coherent acceptance gate or an explicit child task toward it,
  including necessary cross-repository changes and integration checks. If a gate
  is too large for one invocation, break it into ordered, independently verifiable
  child checkboxes with stable IDs under the same parent. Select the next ready
  child and finish it. Size and difficulty require decomposition, not deferral.
  Stop after the selected coherent gate or child batch is complete.
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
- Finish the coding batch before validation. Reuse passing evidence for unchanged
  code and environments; rerun only failed or invalidated checks after repairs.
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
  Maintain exactly one of these status lines near the top of the roadmap.
