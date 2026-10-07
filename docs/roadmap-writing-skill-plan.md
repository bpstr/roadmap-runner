# Roadmap writing skill plan

Proposed skill: `write-runner-roadmap`. This is a design and reviewable template,
not an installed skill. Apply Writing for Agents to its final instructions:
ordered steps with checkable completion criteria, one source of truth for task
semantics, and external references only for branches that need them.

## Trigger and scope

Use when asked to write, revise or decompose an implementation roadmap for fresh
coding-agent sessions. Output a controller-owned Markdown roadmap suitable for
roadmap-runner and small models. Preserve established paths/formats and stable
IDs during revisions. A running worker updates its progress file; the controller
owns source roadmap revisions.

## Planned workflow

1. Establish the goal, user-visible outcomes, current implementation, constraints,
   repository context and deterministic validation commands. Record unresolved
   facts as named blockers; ask only questions that change scope or authority.
   Done: every outcome has a clear acceptance condition and every uncertainty has
   an owner/unblock condition.
2. Build the dependency graph and group coherent outcomes into epics. Mark true
   prerequisite task IDs explicitly. Identify independent work for every external
   dependency. Done: no cycles, missing dependencies or whole-roadmap dependence
   on an unrelated external release requirement.
3. Break epics into tasks that fit one dedicated session, normally 15–45 minutes
   of focused implementation plus local validation. Split by concrete output or
   integration boundary. Done: each task can be understood from its own contract
   plus named context pointers, without reading unrelated epics.
4. Write each task's checkbox, stable ID, purpose, inputs, dependencies, affected
   paths/symbols, implementation steps, validation, evidence and next-session
   handoff. Define observable completion. Done: a smaller model can select the
   task, find the context, implement it and prove completion without guessing.
5. Order implementation before its validation. Keep essential integration checks
   beside the implementation they validate. Put deployment, production access,
   live-content dogfood and release qualification in a final epic, with dependencies
   only where technically necessary. Done: development can continue while an
   unrelated external qualification item is waiting.
6. Audit the entire structure against the rules below. Revise vague, oversized or
   misleading items. Done: all required fields are present, all task IDs unique,
   all dependent tasks name existing prerequisites, no skipped task claims success,
   and every user outcome maps to implementable/validatable work.

## Task contract

Use the [epic roadmap template](../examples/epic-roadmap.md). Keep implementation
and validation subcheckboxes inside each task; tick its parent only when both are
complete with evidence. Task dependencies refer to validated parent IDs. Epics
are headings rather than implicit dependencies on every previous epic.

Each task specifies:

- A concrete deliverable and acceptance condition, with relevant paths or symbols.
- Required context, true dependency IDs or `none`, and permitted independent work.
- Implementation substeps in execution order, followed by deterministic validation.
- Evidence location/result and a concise handoff for interrupted work.
- Blocker, unblock condition and bounded retry trigger if work is deferred.

Use one output per task where practical. Separate independently shippable changes;
combine tightly coupled changes only when splitting would require a broken
intermediate state. Do not make every test file or research note its own task.
Investigations have a specific question, time bound and decision/output, followed
by an implementation task when the evidence supports one.

## Completion, deferral and validation

`- [ ]` means unfinished; `- [x]` means implementation and validation passed.
Keep blocked, skipped, failed-check and needs-input tasks unchecked. Flag them in
progress with the runner's `BLOCKED`, `SKIPPED`, `PROBLEM` or `NEEDS_INFO` lines.
A skipped prerequisite never unlocks its dependents. Optional/out-of-scope release
work must be explicitly excluded by the controller rather than quietly counted as
complete. COMPLETE covers every required task for the current source revision.

Specify executed/passed/failed/skipped counts where meaningful. A skipped test
cannot satisfy the acceptance condition it was meant to prove. Prefer narrow
checks that test the changed behavior, then the relevant integration boundary.
Prepared provider transports are required for automated AI validation. Real model
quality, account limits and live delivery remain unverified by prepared tests.

## Skill packaging and acceptance

Proposed files: `SKILL.md` for the six-step workflow; `references/task-contract.md`
for the reusable contract; `templates/roadmap.md` for the example. The description
should trigger on writing, revising and decomposing runner roadmaps. Use normal
model invocation because other roadmap-producing workflows should discover it.
The final skill must resolve repository instructions and scope before writing.

Evaluate without inference calls using prepared roadmap examples and a deterministic
structure checker: unique checkbox IDs, dependency existence/cycles, required fields,
implementation-before-validation, and explicit release-only dependencies. A human
review checks whether acceptance is observable, session size is plausible and
independent work survives blockers. Do not claim a literal universally perfect
roadmap or small-model reliability until those contracts have been exercised.
