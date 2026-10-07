# Example implementation roadmap

Status: IN_PROGRESS

## Goal and constraints

Deliver a usable local report exporter. Keep existing reports working. Use prepared
provider transports for automated checks. This example describes the task structure;
replace its paths, commands and criteria with those of the target repository.
The source roadmap is controller-owned; workers track evidence/checkmarks in the
runner's progress file. COMPLETE requires every required task below to be validated.

## Execution rules

Pick the first ready task whose named dependencies are implemented and validated.
Independent tasks in later epics are eligible immediately. Defer an external blocker,
leave its checkbox unchecked, record why/what unblocks it/when to retry, and select
another ready task. Preserve required acceptance criteria and stable task IDs.

## Epic EXP-1 — Export implementation

### Task EXP-1.1 — Encode a report as CSV

- [ ] EXP-1.1 Implement and validate CSV encoding.

Purpose: Users can export existing report rows without losing quoted or multiline fields.
Context: Report model and current serializer; inspect their actual symbols before editing.
Dependencies: none.
Session scope: One serializer boundary; target 30 minutes plus local validation.
Acceptance: Export has the required columns in documented order; quoted, empty and
multiline fields round-trip through a standards-compatible CSV parser.

Implementation:

- [ ] EXP-1.1-I1 Locate the report model and serializer entry point; document the column mapping.
- [ ] EXP-1.1-I2 Implement CSV escaping and encoding at that boundary, preserving existing output formats.

Validation:

- [ ] EXP-1.1-V1 Run deterministic round-trip checks for quotes, newlines, empty fields and Unicode.
- [ ] EXP-1.1-V2 Run the existing serializer regressions; record command and executed/passed/failed/skipped counts.

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

- [ ] EXP-1.2-V1 Run a prepared command fixture and compare the output to its expected CSV.
- [ ] EXP-1.2-V2 Exercise destination failure and the existing command behavior.

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

- [ ] EXP-2.1-V1 Compare documented syntax to the argument parser and planned CLI contract; run the help-output check.

Evidence: Updated help and syntax validation result.
Handoff: Any syntax mismatch requiring a controller decision.
Blocked behavior: Flag `NEEDS_INFO EXP-2.1` only for a concrete missing decision; continue EXP-1.1 if ready.

## Epic EXP-3 — Final local integration

### Task EXP-3.1 — Validate the complete export flow

- [ ] EXP-3.1 Validate export and help together.

Purpose: Ensure the implemented command and user instructions agree.
Context: EXP-1.1, EXP-1.2 and EXP-2.1 evidence.
Dependencies: EXP-1.2, EXP-2.1.
Session scope: One end-to-end local fixture; target 20 minutes.
Acceptance: A prepared report is exported using the documented command; parsed output matches the input rows.

Implementation:

- [ ] EXP-3.1-I1 Assemble the existing prepared report fixture and command invocation.

Validation:

- [ ] EXP-3.1-V1 Run the complete local flow; record comparison and exit status.
- [ ] EXP-3.1-V2 Run required repository checks; resolve relevant failures before ticking the parent.

Evidence: Local integration results and remaining limitations.
Handoff: Exact failed boundary if incomplete.
Blocked behavior: Repair the failed boundary; report any independent follow-up still feasible.

## Release follow-up (outside this implementation roadmap)

Publishing, production credentials and live-content qualification are separate
controller-scoped work. They do not block the local implementation tasks above.
If production deployment is part of the actual requested goal, make it a final
required epic with explicit dependencies and authority rather than hiding it here.
