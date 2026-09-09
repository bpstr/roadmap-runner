# Roadmap Runner procedure

## Purpose

Run a long Markdown roadmap as fresh, bounded Codex workers without keeping a model-backed coordinator alive. The shell waits without consuming model tokens; the roadmap and checked-out files provide durable context.

## Roadmap as queue

Use existing checkboxes as the work queue. Do not add a parallel state machine, cursor, active-batch record, or ledger. If executable work exists only as prose or a milestone table, normalize the affected scope into stable checkboxes before implementation.

An unchecked item remains pending. Check it only after its acceptance criteria, required documentation, and narrow validation pass. Add the shell run ID and concise evidence to the existing delivery record or directly under the completed item.

For interrupted or failed work, leave the item unchecked and add only the evidence needed to resume or understand the blocker. External-only gates remain unchecked and identified; they do not prevent later independent local work.

## One worker run

Each fresh worker:

1. Reads the roadmap, owning specifications, repository instructions, relevant diffs, and recent delivery evidence.
2. Reconciles partial changes or unsupported checked items. It resumes an unchecked item with matching partial changes before selecting another.
3. Classifies remaining work as locally eligible, waiting on a dependency, decision-blocked, or external-only.
4. Selects the earliest dependency-ready local item. It may group up to three items only when they share one ownership and validation boundary.
5. Implements only that batch, updates required documentation and contracts, and runs the narrow deterministic local validation required by its acceptance criteria.
6. Inspects the diff and evidence, checks completed items, records the run ID and validation evidence, and leaves incomplete items unchecked.
7. Returns the fixed six-line control response. It uses `continue` only when another local batch is eligible.

If the batch cannot finish in one focused invocation, retain its partial changes, leave it unchecked, record minimal continuation evidence, and return a retryable failure. The next worker reconciles that item first.

## Status meanings

- `continue`: this batch is settled and another locally eligible item exists.
- `local_complete`: authorized local implementation is exhausted but non-local gates remain.
- `complete`: every roadmap criterion, including non-local acceptance, is proven.
- `blocked`: no independent local work remains and operator action is required.
- `failed`: the invocation could not settle safely.

The default local boundary permits checked-out file changes and deterministic local validation. It excludes pushes, pull requests, hosted CI, publication, deployment, production activation or provider mutation, production credentials, and paid or live provider calls unless the user and repository instructions explicitly authorize them.

## Recovery

The shell holds a per-roadmap lock and writes transcripts under `.codex/roadmap-runs/`. A clean exit removes the lock. A later launch recovers a stale lock only when both its supervisor and worker processes are gone.

Fresh sessions are intentional. The next worker recovers from unchecked items, repository diffs, roadmap evidence, and retained transcripts. Normal next-batch execution does not use `codex exec resume`.

The shell rejects a response unless it has exactly six lines, the expected protocol marker and run ID, a recognized status, a safe batch ID, `roadmap_updated=yes`, and a valid retry flag. It also verifies that the roadmap changed and contains the run ID.

A superseded `roadmap-execution` block may remain from the older coordinator design. The shell will not start while that block says `state: running`. Once the old process settles, preserve useful evidence in the checklist or delivery record and remove the obsolete block.
