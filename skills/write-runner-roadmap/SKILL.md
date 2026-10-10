---
name: write-runner-roadmap
description: Write, revise or decompose Markdown implementation roadmaps for fresh Roadmap Runner coding sessions, with dependencies, bounded tasks and observable acceptance.
---

# Write a runner roadmap

Produce a controller-owned source roadmap. Roadmap design does not authorize starting a runner. Workers record progress and evidence in their separate progress file.

1. Resolve repository instructions, destination, scope, existing implementation and deterministic validation commands. Preserve established formats and stable IDs when revising. Done: each requested outcome has observable acceptance; missing authority or facts have an owner and unblock condition.
2. Build the dependency graph and group coherent outcomes into epics. Separate true prerequisites from ordering preferences. Identify independent work beside each external dependency. Done: no cycle, missing dependency or whole-roadmap dependence on an unrelated release gate remains.
3. Split epics into session-sized tasks, normally 15–45 minutes plus local validation. Split by usable output or integration boundary; combine tightly coupled work that would otherwise leave a broken intermediate state. Done: each task is understandable from its own contract and named context.
4. Read [the task contract](references/task-contract.md) and fill every task field. For a new roadmap, adapt [the template](templates/roadmap.md); for revisions, preserve the controller's established format. Done: every task names deliverable, prerequisites, implementation steps, deterministic validation, evidence and interrupted-work handoff.
5. Order implementation before its validation. Keep integration checks beside the change they prove. Put deployment, production access, manual dogfood and release qualification in a final epic, with dependencies only where technically required. Done: external qualification does not block unrelated development.
6. Audit all tasks against the contract and dependency graph. Done: checkboxes follow the contract's standalone task-list syntax, IDs are unique, prerequisites exist, acceptance is observable, required fields are filled, deferred work stays unchecked and every requested outcome maps to work. Report unresolved design judgments to the controller.

Use prepared responses and mocked transports for automated AI validation. Meaningful live-content dogfood requires separate exact scope, a hard request/monetary cap and a stop condition before any provider call. Prepared checks establish mechanics, not model quality or launch qualification.
