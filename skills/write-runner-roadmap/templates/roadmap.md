# Example implementation roadmap

Status: IN_PROGRESS

## Goal and constraints

Deliver a usable local report exporter. Keep existing reports working. Use prepared
provider transports for automated checks. This example describes the task structure;
replace its paths, commands and criteria with those of the target repository.
The controller defines roadmap requirements; workers update verified checkmarks in
the live roadmap and track evidence/handoff in the runner's progress file.
COMPLETE requires every required task below to be validated.

## Execution rules

Pick the first ready task whose named dependencies are implemented and validated.
Independent tasks in later epics are eligible immediately. Defer an external blocker,
leave its checkbox unchecked, record why/what unblocks it/when to retry, and select
another ready task. Preserve required acceptance criteria and stable task IDs.
Use bounded, focused checks during functional delivery and reuse compatible passing
evidence. Record each selector, result, expected cost and any reason to widen or
repeat a check in progress. Put test development and comprehensive cases in the
final testing epic; for split plans, move that epic after all functional roadmaps
and reference its owning file instead of copying it into every roadmap. Final
testing is required for overall completion; functional tasks depend only on their
own focused checks and true prerequisites. Preserve explicit applicable gates.

## Epic EXP-1 — Export implementation

### Task EXP-1.1 — Encode a report as CSV

- [ ] EXP-1.1 Implement and validate CSV encoding.

Purpose: Users can export existing report rows without losing quoted or multiline fields.
Context: Report model and current serializer; inspect their actual symbols before editing.
Dependencies: none.
Session scope: One serializer boundary; target 30 minutes plus local validation.
Acceptance: Export has the required columns in documented order; a prepared quoted
field round-trips through a standards-compatible CSV parser. Comprehensive edge
cases belong to EXP-3.1.

Implementation:

- [ ] EXP-1.1-I1 Locate the report model and serializer entry point; document the column mapping.
- [ ] EXP-1.1-I2 Implement CSV escaping and encoding at that boundary, preserving existing output formats.

Validation:

- [ ] EXP-1.1-V1 Run one existing targeted round-trip fixture for the changed encoder; record its selector, result and executed/passed/failed/skipped counts. Budget: 1 minute.

Evidence: Progress file links to changed files and validation results.
Handoff: Remaining substep, relevant symbol, failing case and next precise action.
Blocked behavior: Flag `PROBLEM EXP-1.1` for failed validation; independent EXP-2.1 remains ready.

### Task EXP-1.2 — Connect export to the report command

- [ ] EXP-1.2 Implement and validate the CSV command option.

Purpose: Users can request CSV through the existing command.
Context: CLI argument parser, report loader and EXP-1.1 serializer.
Dependencies: EXP-1.1.
Session scope: One CLI integration boundary; target 30 minutes plus local validation.
Acceptance: The CSV option exports loaded rows and returns a useful error for an invalid destination.

Implementation:

- [ ] EXP-1.2-I1 Add the CSV option using the existing argument conventions.
- [ ] EXP-1.2-I2 Connect report loading to the validated encoder; report destination failures clearly.

Validation:

- [ ] EXP-1.2-V1 Run a prepared CSV command fixture and a targeted invalid-destination check; record selectors and results. Budget: 2 minutes. Reuse EXP-1.1 evidence for unchanged encoding behavior.

Evidence: Fixture result, error behavior and focused regression command/results.
Handoff: Next unresolved integration step and the exact input that reproduces it.
Blocked behavior: If EXP-1.1 is incomplete, flag `SKIPPED EXP-1.2`; select EXP-2.1.

## Epic EXP-2 — Independent help content

### Task EXP-2.1 — Explain supported export formats

- [ ] EXP-2.1 Write and validate help examples.

Purpose: Users can discover existing formats and the planned CSV option.
Context: Current CLI help, serializer format contract, EXP-1.2 acceptance condition.
Dependencies: none; drafting requires no production account or completed CSV implementation.
Session scope: A small help-text change; target 15 minutes plus validation.
Acceptance: Examples use the agreed option syntax and clearly identify availability.

Implementation:

- [ ] EXP-2.1-I1 Draft help text and one example per supported format.

Validation:

- [ ] EXP-2.1-V1 Compare documented syntax to the argument parser and planned CLI contract. Budget: 1 minute; no application suite is needed for this text change.

Evidence: Updated help and syntax validation result.
Handoff: Any syntax mismatch requiring a controller decision.
Blocked behavior: Flag `NEEDS_INFO EXP-2.1` only for a concrete missing decision; continue EXP-1.1 if ready.

## Epic EXP-3 — Final testing after all functionality

### Task EXP-3.1 — Add remaining coverage and validate the export flow

- [ ] EXP-3.1 Complete remaining export coverage and validate export and help together.

Purpose: Cover remaining export cases once and ensure the command and user instructions agree.
Context: EXP-1.1, EXP-1.2 and EXP-2.1 evidence.
Dependencies: EXP-1.2, EXP-2.1.
Session scope: Remaining regression cases and one local integration fixture; target 30 minutes including checks.
Acceptance: Quotes, newlines, empty fields and Unicode round-trip correctly;
existing formats still work; a report exported using the documented command
matches its input rows. Compatible delivery evidence counts toward these criteria.

Implementation:

- [ ] EXP-3.1-I1 Review retained EXP-1 and EXP-2 evidence; extend existing fixtures only for uncovered acceptance cases and assemble the documented command invocation.

Validation:

- [ ] EXP-3.1-V1 Run the added cases and one complete local flow; record selectors, comparison, counts and exit status. Budget: 3 minutes.
- [ ] EXP-3.1-V2 Identify any explicit repository or release gate and run only its outstanding required checks; otherwise close with focused results and retained evidence. Record the reason and expected cost before any wider run; resolve relevant failures before ticking the parent.

Evidence: Local integration results and remaining limitations.
Handoff: Exact failed boundary if incomplete.
Blocked behavior: Repair the failed boundary; report any independent follow-up still feasible.

## Release follow-up (outside this implementation roadmap)

Publishing, production credentials and live-content qualification are separate
controller-scoped work. They do not block the local implementation tasks above.
If production deployment is part of the actual requested goal, make it a final
required epic with explicit dependencies and authority rather than hiding it here.
