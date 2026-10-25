# Roadmap splitting and queues

Workers reread the active source roadmap in each fresh session. Smaller tasks inside
one huge file still make every worker read that file. Keep one roadmap unless a
concrete context budget or independent delivery boundary warrants separate files.
When splitting is justified, prepare it before execution; the runner's queue advances between complete roadmap files and does not
automatically partition a large source. Workers preserve source requirements and report a
context blocker to the controller when further splitting is needed.

## Choose the boundary and input budget

- Choose boundaries from prerequisites and independently verifiable outcomes.
  Task count, milestone count and file size alone do not establish a safe cut.
  Preserve a coherent file when splitting would introduce backward prerequisites.
- Budget for the active source, current progress, repository instructions and the
  code needed for the next batch. Leave room for implementation and verification;
  a source that barely fits the context window is already too large.
- Cut along dependency edges into independently verifiable outcomes. Keep a change
  with its focused delivery check and enough integration work to leave a usable intermediate
  state. Session-sized tasks remain necessary inside each file.
- Keep the overall plan in a controller-owned index: ordered paths, outcomes,
  prerequisites, progress paths and evidence locations. Pass the focused roadmap
  path to the runner. Keep the index outside the queue and outside required worker
  reading; headings or links to split files do not make a giant master file small.

## Preserve context and acceptance

Each split file carries its own goal, constraints, required acceptance, task
contracts and focused local validation under [the testing policy](task-contract.md#testing-policy). Use precise paths, symbols or document sections for
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

End each milestone with a compact handoff of its focused delivery evidence in its progress file:
delivered interfaces/paths, check selectors and results, evidence locations and
remaining limitations. Reuse compatible evidence; a milestone boundary does not
require another test run. The next file references the relevant evidence only. Avoid
copying the predecessor's full checklist or progress history into the next input.
Completion applies to that file; completion of the whole plan requires every
required file and final integration acceptance to pass.

## Preflight the complete proposed split

Before recommending a queue, check all proposed files together and record the
result in the controller index:

1. Map each original task and acceptance requirement to exactly one owning file.
   Preserve IDs and completed evidence. Resolve missing or duplicate owners before
   replacing the original roadmap.
2. Build the task graph from real prerequisites, including those implied by
   acceptance, validation, fixtures, entry conditions and handoffs. Resolve missing
   references and cycles before converting cross-file IDs into prose conditions;
   rewriting a dependency does not remove it.
3. Build the file graph: if a task in B needs an output from A, add A → B.
   Check this graph separately for cycles. An acyclic task graph can become cyclic
   when tasks are grouped: a1 → b1 → a2 is acyclic, but putting a1 and a2 in A and
   b1 in B creates A → B → A. Keep this chain together or cut it into three ordered
   files. Renumbering files or deleting the dependency cannot repair the grouping.
4. Topologically order the files and verify every prerequisite belongs to the same
   file or an earlier one. Each file's COMPLETE must be achievable before starting
   its successor. Earlier acceptance must use its focused delivery evidence;
   plan-wide integration or release acceptance belongs to its later owning task.
   If an actual required gate prevents that separation, merge or recut the work.
5. Check the rendered files for valid header statuses, standalone checkboxes,
   unique IDs, resolvable local dependency IDs, explicit earlier-file entry
   conditions and distinct source/progress paths. Use the installed runner's
   supported status syntax; `IN_PROGRESS` is a compatible initial header even
   before work has begun. Keep completed evidence linked to its actual source;
   creating a fresh file does not reset completed work or prove new acceptance.

Publish the split recommendation only after these checks pass. If they fail,
retain the original roadmap and report the concrete cycle, missing prerequisite
or acceptance conflict. A blocked split is a design problem for the controller;
it is not a reason to start a worker or resolver to repair the plan.

## Order and operate the queue

Queues are serial. Order files by true prerequisites, with independent local work
before an externally blocked release or qualification file. A blocked current
roadmap holds later entries; queueing unrelated work behind it does not make that
work eligible. Within a file, workers can still select other ready tasks. Use a
final testing file (or bounded testing files when needed for context) after ALL
functional roadmaps for test development, comprehensive cases and justified
cross-milestone validation. Give each testing requirement one owner in the index;
do not append a testing epic or duplicate full test cases and broad runs after each
functional roadmap. Keep a fixture or minimal check required by earlier delivery
with that earlier work, even when broader coverage is deferred. Functional files finish with their focused delivery checks
and do not wait for final testing. Preserve required final acceptance, reuse prior
evidence and put any required release work after its applicable testing gates,
with authority and entry conditions explicit.

For an authorized run, use repeated CLI `--queue` options or the MCP start tool's
ordered `queue` entries. Append through CLI `queue` or MCP `roadmap_enqueue` only
when execution is authorized and the new entry's prerequisites fit the existing
order. All entries share workspace, client/model and resolver settings; use
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
