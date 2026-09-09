# Shared-worktree parallel execution — investigation only

Status: **Not implemented.** Version 0.1.0 always runs one Codex implementation
worker. There is no hidden worker-count switch, second scheduler or branching
strategy. This document evaluates a later 2–3-worker mode without requiring new
branches or separate worktrees.

## Verdict

Feasible for carefully separated changes, but a file saying “I am working on task
A” only solves part of duplicate assignment. It does not make shared filesystem
edits, test environments, Git operations or interface changes conflict-free.
A deterministic dispatcher can solve scheduling without an LLM coordinator; the
hard part is defining and enforcing safe simultaneous writes.

A useful first experiment would be two workers in disjoint application modules,
with shared files and integration checks explicitly serialized. Do not assume a
2–3x gain. Repeated initialization, file-lock waits, dependencies, integration
repair and test serialization can erase the benefit. Measure validated throughput
and tokens per accepted task, not just the number of busy agent processes.

## Why worker announcements are insufficient

Two workers can read the same unchecked task before either writes a claim. Even
if they choose distinct tasks, both may update package.json, a lockfile, a router,
a shared type, a migration manifest or the central roadmap. They may overwrite
an edit made since their last file read. A whole-repository formatter can modify
another worker's files despite the apparent task boundary.

Tests introduce a different collision class: the same database, ports, temp paths,
cache directory or generated output can interfere even when source paths differ.
A test run can observe another worker's half-applied change. Passing tests from
that transient worktree are not automatically evidence of a stable final state.

The Git index and working tree are mutable shared state. Letting each worker
stage/commit while another edits can mix ownership or snapshot incomplete work.
Avoiding branches removes merge conflicts, not filesystem or semantic conflicts.
Git's own worktree documentation explains how separate worktrees normally isolate
working-tree-specific state such as HEAD and the index [1]. This proposal does NOT
require that isolation; it must compensate for its absence deliberately.

## Minimum viable coordination for a later experiment

**Atomic claims, owned by code.** The shell/helper must claim tasks under an
exclusive lock using read-modify-write of the coordination state. A worker cannot
reserve a task merely by announcing it in its prompt. Include task ID, worker/run
ID, process identity, lease/fencing generation, dependency state and claim time.
Kernel nonblocking locks can serialize the claim operation on a local filesystem
[2]. Keep the lock inode stable; do not delete/recreate it to clear “stale” claims.

**Known readiness.** Ordered Markdown alone does not prove two tasks are
independent. Mark phase barriers and explicit dependencies, or approve independent
sections in advance. Keep task IDs stable and give each worker only its claimed
slice. A completed child may unlock a parent; it does not prove an independent
cross-module task is ready. Do not ask every model to repeatedly reread the whole
roadmap and infer concurrent readiness.

**Write ownership.** Claims also need reserved file/path scopes and shared
resources. Require an atomic scope extension before touching another file.
Imports, dependency manifests, lockfiles, migrations, API schemas, shared routers,
generated assets and repository-wide formatting generally need global ownership.
Advisory scopes only work when tools cooperate; strong guarantees require actual
write mediation or isolation, not just a more emphatic prompt.

**One Markdown writer.** Workers should never concurrently toggle/reformat the
roadmap. Keep the v0.1.0 model: workers return typed completion receipts, and one
deterministic writer validates and applies checkbox changes under a lock. Claims
belong in compact coordination state, completed progress in the original Markdown.

**Verification barriers.** Before an integration check, stop new claims, have
active writers reach a safe boundary, and ensure no relevant files/resources can
change during verification. Only accept completion against a stable state. Source
file leases alone do not isolate databases or test ports. A global check failure
should block dependent work and produce bounded repair, not a third agent
replanning the entire roadmap.

**Recovery that does not create overlapping writers.** A missed heartbeat is not
proof that the old worker has stopped. Do not steal its task while it can still
write. Terminate and confirm exit, or use an enforceable fencing mechanism before
reassigning it. Expiry fields in JSON are not fencing: the old model will not
magically stop when a timestamp changes. Preserve partial edits and receipts;
never blindly roll back a dead worker's paths while another worker uses them.

**Explicitly serialized Git and destructive actions.** Keep automatic Git commits,
resets, branch operations, deployment and production mutations out of the first
parallel experiment. This preserves the requested single-worktree approach without
inventing a complicated branch/merge orchestrator.

## Proposed experimental boundary, not implementation

Begin with two workers, independent approved sections, disjoint write scopes, one
central checkbox writer and serialized integration verification. Stop on scope
conflicts rather than allowing “best effort” simultaneous changes. Do not enable
three workers until a repeatable two-worker benchmark demonstrates useful gains.

Benchmark against the exact same single-worker roadmap/model/effort and acceptance
tests. Track accepted tasks per hour, total input/output and cached tokens, duplicate
work, scope violations, dependency mistakes, flaky test collisions, manual repair
time, and recovery after terminating a worker. Include adversarial cases where
independent-looking tasks share a lockfile, generated schema, test DB, import hub
or previously read file. Speed improvements count only after final integration
validation and review, not when all models merely report completion.

## Implication for the current release

The current architecture leaves a reasonable extension point: typed batch receipts,
one authoritative Markdown writer, durable checkpoints and deterministic process
control. It intentionally does not add leases, heartbeats, ownership schemas,
dependency inference, messaging or parallel code paths “for later”. The single-worker
version remains small enough to reason about and debug before a concurrency mode
is justified by evidence.

## References

[1] [Git worktree documentation](https://git-scm.com/docs/git-worktree).

[2] [Python fcntl/flock documentation](https://docs.python.org/3/library/fcntl.html).

The conflict scenarios and proposed restrictions above are engineering analysis,
not empirical claims of measured speedup or a claim that advisory locks alone
provide isolation.
