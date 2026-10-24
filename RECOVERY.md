# Recovery runs

From 0.11.0, Roadmap Runner dispatches workers, blocker resolvers and handoff
compactors. Regular supervisor sessions are removed.

Each worker starts by reading the current handoff and the bounded recent-runs
summary. It compares attempted operations, failures and relevant implementation
or prerequisite inputs. It follows specific evidence pointers when needed.
Two or more failed attempts with unchanged relevant inputs require a global
`Status: BLOCKED` handoff with the cited attempts and unblock condition. Useful
partial work can continue; counters, checkbox totals and note changes alone do
not establish a loop. Loop assessment remains an agent judgment.

A global blocker pauses workers and dispatches a resolver automatically. This
also applies to failed workers, two consecutive hard timeouts and exhausted finite
plans. Task-local blockers allow independent ready work to continue. Quota and
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
or uncleared blocker also stops the runner. The runner saves STOPPED durably,
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
session or terminal status check; source roadmaps retain their 256 KiB limit.

Prepared local clients validate orchestration and state transitions. They do not
establish live model loop-detection or repair quality.
