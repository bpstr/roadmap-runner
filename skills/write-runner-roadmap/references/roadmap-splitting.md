# Roadmap splitting and queues

Workers reread the active source roadmap in each fresh session. Smaller tasks inside
one huge file still make every worker read that file. Split the source before
execution; the runner's queue advances between complete roadmap files and does not
automatically partition a large source. Workers preserve the source and report a
context blocker to the controller when further splitting is needed.

## Choose the boundary and input budget

- Keep one coherent milestone or integration boundary per file. A useful starting
  target is 5–10 parent tasks and roughly 10–20 KiB of source per file; these are
  authoring guidelines, not runner limits. Split earlier when tasks need unrelated
  context, and keep a larger tightly coupled unit only with an explicit reason.
- Budget for the active source, current progress, repository instructions and the
  code needed for the next batch. Leave room for implementation and verification;
  a source that barely fits the context window is already too large.
- Cut along dependency edges into independently verifiable outcomes. Keep a change
  with its validation and enough integration work to leave a usable intermediate
  state. Session-sized tasks remain necessary inside each file.
- Keep the overall plan in a controller-owned index: ordered paths, outcomes,
  prerequisites, progress paths and evidence locations. Pass the focused roadmap
  path to the runner. Keep the index outside the queue and outside required worker
  reading; headings or links to split files do not make a giant master file small.

## Preserve context and acceptance

Each split file carries its own goal, constraints, required acceptance, task
contracts and local validation. Use precise paths, symbols or document sections for
additional context. Keep raw logs, full specifications, old roadmaps and historical
handoffs behind targeted references rather than copying them into every file or
requiring workers to read them all.

Preserve stable task IDs and map every original requirement to its owning file in
the controller's index. Local `Dependencies:` name parent IDs in the same file.
Represent a prerequisite from an earlier file as a named entry condition: required
artifact or interface, its acceptance result and a precise evidence reference.
Before dependent implementation, verify that condition against the current
workspace. Record a missing or invalid prerequisite as a blocker; successful queue
advancement alone does not prove that a particular interface is still correct.

End each milestone with validation and a compact handoff in its progress file:
delivered interfaces/paths, validation command and result, evidence locations and
remaining limitations. The next file references the relevant evidence only. Avoid
copying the predecessor's full checklist or progress history into the next input.
Completion applies to that file; completion of the whole plan requires every
required file and final integration acceptance to pass.

## Order and operate the queue

Queues are serial. Order files by true prerequisites, with independent local work
before an externally blocked release or qualification file. A blocked current
roadmap holds later entries; queueing unrelated work behind it does not make that
work eligible. Within a file, workers can still select other ready tasks. Use a
final file for integration across milestones and any required release work, with
its authority and entry conditions explicit.

For an authorized run, use repeated CLI `--queue` options or the MCP start tool's
ordered `queue` entries. Append through CLI `queue` or MCP `roadmap_enqueue` only
when execution is authorized and the new entry's prerequisites fit the existing
order. All entries share workspace, client/model and supervisor settings; use
separate runs when those settings must differ. Give every entry a distinct source
and progress path; retain the run ID and inspect `queue` / `queueIndex` for the
active entry. For example, after execution is authorized:

```sh
roadmap-runner start docs/01-core.md --queue docs/02-cli.md --queue docs/03-integration.md --json
roadmap-runner status <run-id> --json
# Append a later milestone to the active run:
roadmap-runner queue <run-id> docs/04-release.md --json
```

When revising a large existing roadmap, the controller maps completed evidence and
unfinished acceptance to the split files and prepares their separate progress
state before starting a replacement run. Coordinate changes with the active run;
splitting files does not rewrite an existing queue or migrate its progress.
After a stopped or failed run, explicitly start a new run with the unfinished
files. Preserve completed evidence and required acceptance through that transition.
