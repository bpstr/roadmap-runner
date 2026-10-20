# Task contract

Each parent task has a stable ID and checkbox, concrete deliverable, observable acceptance, purpose, inputs/context pointers, affected paths or symbols, true prerequisite IDs (or `none`), permitted independent work, session scope, implementation substeps, validation substeps, evidence location/result and interrupted-work handoff.

Dependencies refer to validated parent IDs. Epics are headings; they do not implicitly depend on every preceding epic. Keep implementation and focused validation subcheckboxes inside their task; give deferred testing its own final tasks. Tick the parent only after its implementation and scoped validation pass with evidence. Functional task completion does not claim that deferred testing or release qualification has passed.

For split roadmaps, keep dependency IDs local to each file and describe earlier-file prerequisites as entry conditions with targeted evidence. Follow [roadmap splitting and queues](roadmap-splitting.md) for boundaries, input budgets and handoffs.

Write each parent and substep checkbox as a standalone Markdown task-list item on its own line: `- [ ] ID Description` or `- [x] ID Description`. Put labels such as `Implementation:` and `Validation:` on separate lines, with a blank line before the list. Inline checkboxes in prose, headings or table cells are unsupported; use plain text there or move the work into a task-list item. Normalize inline checkboxes to this syntax when revising an existing roadmap.

`- [ ]` means unfinished; `- [x]` means implemented and validated. Blocked, skipped, needs-input and failed-check tasks remain unchecked. Record `BLOCKED`, `SKIPPED`, `NEEDS_INFO` or `PROBLEM` with task ID, reason, unblock condition and bounded retry trigger in progress. A skipped prerequisite never unlocks dependents. COMPLETE covers every required task at the current source revision. The controller explicitly excludes out-of-scope work.

Record executed/passed/failed/skipped counts where meaningful. A skipped check cannot prove its acceptance. Investigations name a question, time bound and concrete decision/output; supported decisions lead to implementation tasks.

## Testing policy

Schedule test development, comprehensive test cases and broader regression or integration testing after all functional tasks, in a final testing epic or the final testing roadmap of a split sequence. Assign each distinct requirement one testing owner and reference it elsewhere rather than copying test cases or suite runs into every task or roadmap. Final testing remains required for overall completion, but functional tasks must not depend on it merely as an ordering convention. Preserve explicit repository, user and release gates at the boundary where they actually apply.

During delivery, prefer an existing targeted test, deterministic fixture or small manual check that proves the changed behavior. Select the smallest affected check and add an integration check only when the changed boundary needs it. Defer new test suites and full case matrices to final testing; add a minimal regression case earlier only when a concrete defect or risk requires it. Give each delivery check a bounded selector and expected time cost. Avoid broad suites, exhaustive cases and repeated or long test runs during delivery; if broader verification is truly required, record the concrete reason and applicable gate.

Reuse compatible passing evidence across tasks, sessions and roadmap handoffs. Before repeating a check, identify the changed input or dependency that invalidates its result; after a failure, rerun the failed or affected selection. A new session, commit, roadmap boundary or parent acceptance checkbox does not justify a fresh full run. Widen only for demonstrated wider impact or an explicit applicable gate, and stop once the selected completion condition passes.

Keep selectors, results, evidence references, reuse decisions, widening reasons and expected cost in the existing validation record or progress file. Count test authoring, execution and reporting in the task budget. Final testing fills remaining coverage gaps and validates cross-roadmap behavior using retained evidence where compatible; it does not repeat every earlier case or automatically require a full suite.
