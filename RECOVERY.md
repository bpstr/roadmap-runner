# Recovery runs

From 0.11.0, Roadmap Runner dispatches workers, blocker resolvers and handoff
compactors. Regular supervisor sessions are removed.

Each worker starts with its task continuation packet, using the handoff for legacy
obligations and the recent-runs summary when diagnosing ambiguous state or failure.
Workers receive a recent-run lookback and assess whether the same work has been
repeated without a credible changed condition. Counts, matching signatures,
source hashes, timeouts and open acceptance items do not decide this. An explicit
worker blocked outcome defers that task while independent ready work continues.
An explicit `scheduling: "defer"` can park an exhausted roadmap pass and continue
later queue entries with acceptance still open. An unchanged deferred queue exits
once with reason `deferred`; it does not need a diagnostic resolver session.
A successful resolver authorizes reassessment, preserving the previous evidence.
For explicitly deferred tasks it names only repaired task IDs in `retryTasks`;
unrelated ownership deferrals stay parked.
Global `Status: BLOCKED` means no useful authorized alternative remains.

A global blocker pauses workers and dispatches a resolver automatically. From
0.12.2, unsuccessful recovery permits three resolver attempts in the same blocked
episode (including the first). Configure `--resolver-attempts`,
`ROADMAP_RESOLVER_ATTEMPTS` or MCP `resolverAttempts` from 1 to 10. Each retry
receives the original resolution ID and earlier failure evidence. Workers do not
run between attempts. Quota/capacity waits retain their separate budgets. An
explicit stopped decision ends recovery immediately.

Use `--blocked-policy park` or `stop` (MCP `blockedPolicy`) to return before any
resolver is dispatched. Park retains BLOCKED; stop persists STOPPED. An explicit
`--recover-blocked` authorizes recovery through either policy once, after the
concrete repair or missing input is supplied. The default policy is `resolve`. This
also applies to failed clients. Repeated timeouts return to a worker for history
assessment; they do not automatically dispatch a resolver. Normal finite
plan exhaustion returns `needs_next_batch` or `awaiting_verification` without a
resolver; exit 0 records a successful scheduling boundary, not acceptance completion.
These states do not advance a queued roadmap. Task-local blockers allow independent
ready work to continue. Quota and
capacity rejections use the existing bounded waits and preserve the session role.

The resolver reads the roadmap, handoff and attempt evidence, repairs what it can
within the user's authority, and verifies the affected behavior. To resume, it
must clear global BLOCKED/STOPPED headers, set the handoff to IN_PROGRESS and write
a fresh JSON decision with the current resolution ID, `outcome: "resolved"`,
evidence and the exact next action. A finite execution plan must have a ready
batch. The next worker verifies the repair before claiming completion. Resolver
decisions cannot waive acceptance criteria.

If the cause remains unresolved, the resolver sets `Status: STOPPED` and records
what the user must supply. A failed or timed-out resolver, missing or stale decision,
or uncleared blocker consumes an attempt and stops the runner at budget exhaustion.
The runner saves STOPPED durably,
returns exit 75 with reason `stopped`, and leaves later queued roadmaps pending.
Restarting the same run inputs does not dispatch another session. After addressing
the cause, `--recover-blocked` or MCP `recoverBlocked: true` explicitly retries with
a resolver. Use a fresh idempotency key for a new managed recovery attempt.
Ctrl-C exits 130 and preserves unfinished work and the pending blocker.

Resolvers default to a ten-minute limit, bounded by the worker hard timeout.
Configure `--resolver-timeout`, `ROADMAP_RESOLVER_TIMEOUT` or MCP `resolverTimeout`.
Legacy `--supervisor-timeout` and `supervisorTimeout` remain timeout aliases;
`--supervisor-every` and `supervisorEvery` are accepted without dispatching reviews.
The zero cadence value does not disable worker loop checks or recovery.

Recent worker receipts persist in `runs.json` and bounded evidence summaries;
older `supervision.json` checkpoints migrate on use. Detailed failed evidence and
archived handoffs remain available. Resolver sessions have their own session IDs,
metrics, events and archived handoffs. Handoffs still compact at 32 KiB before a
session or terminal status check, now targeting below 8 KiB; source roadmaps retain
their 256 KiB limit. Useful partial outcomes from quota-interrupted sessions remain
in task memory and recent evidence, without counting capacity rejection as a failed
operation. See [task continuity](docs/task-continuity.md) for the structured contract.

Prepared local clients validate orchestration and state transitions. They do not
establish live model loop-detection or repair quality.
