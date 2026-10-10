# Task contract

Each parent task has a stable ID and checkbox, concrete deliverable, observable acceptance, purpose, inputs/context pointers, affected paths or symbols, true prerequisite IDs (or `none`), permitted independent work, session scope, implementation substeps, validation substeps, evidence location/result and interrupted-work handoff.

Dependencies refer to validated parent IDs. Epics are headings; they do not implicitly depend on every preceding epic. Keep implementation and validation subcheckboxes inside their task. Tick the parent only after both pass with evidence.

Write each parent and substep checkbox as a standalone Markdown task-list item on its own line: `- [ ] ID Description` or `- [x] ID Description`. Put labels such as `Implementation:` and `Validation:` on separate lines, with a blank line before the list. Inline checkboxes in prose, headings or table cells are unsupported; use plain text there or move the work into a task-list item. Normalize inline checkboxes to this syntax when revising an existing roadmap.

`- [ ]` means unfinished; `- [x]` means implemented and validated. Blocked, skipped, needs-input and failed-check tasks remain unchecked. Record `BLOCKED`, `SKIPPED`, `NEEDS_INFO` or `PROBLEM` with task ID, reason, unblock condition and bounded retry trigger in progress. A skipped prerequisite never unlocks dependents. COMPLETE covers every required task at the current source revision. The controller explicitly excludes out-of-scope work.

Record executed/passed/failed/skipped counts where meaningful. A skipped check cannot prove its acceptance. Prefer a narrow behavior check, followed by the affected integration boundary. Investigations name a question, time bound and concrete decision/output; supported decisions lead to implementation tasks.
