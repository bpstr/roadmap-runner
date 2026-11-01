# Closure-stall controller remediation

Incident: [Roadmap 005 closure stall](2026-10-30-roadmap-005-closure-stall.md).
The incident report, historical failed evidence and original reproduction remain unchanged.

## Implementation decisions

- Keep source checkbox observations separate from contribution outcomes and receipts. The first monitored source is the original baseline. Later requirements are additions; changed or removed requirements remain unresolved in the baseline. Source closure is an observation, not independent correctness qualification.
- Persist cumulative active execution time, worker turns, last original closure and scope additions outside the eight-turn lookback. Surrounding prose, fresh sessions and source hashes do not replenish budgets. Interrupted sessions retain a conservative active-time charge.
- Default to parking after four worker turns or three hours of active execution without measured reduction, or twelve hours of cumulative active execution. Limit the next client timeout to the remaining active allowance. Every client role consumes active time. Quota/capacity idle waits do not.
- Require an explicit source-bound review file for a bounded extension. Preserve its reason and acknowledgment. Only original criteria and an explicitly reviewed finite set of added subgaps can replenish the progress window; scope growth alone cannot.
- Surface broad/focused/finite scheduling, specific fallback causes, runtime bundle identity and progress state in events/status. A desktop submission or journal read is not review acknowledgment. A plateau parks even when desktop notifications are off.
- Reconcile external handoff edits before scheduling. Superseded task outcomes remain historical evidence; current handoff instructions take precedence. Client continuation is also reset.

## Validation plan

Use prepared local executables and deterministic clocks only; no provider transport,
credential loading, fixture recording or live dogfood. The Assign paid-inference policy
was read before test changes; its superseding prohibition applies.

Selected completion checks:

1. New progress-ledger unit tests: stable baseline, eleven contributions without closure, scope additions/removal, restart and crash accounting, finite review binding/extensions, closure age and approved subgaps.
2. Prepared controller regressions: default plateau parking, restart without budget reset, explicit extension, current handoff precedence, cumulative timeout and managed status with notifications disabled.
3. Affected existing tests: task selection/memory/continuity, continuation/restart, runner argument parsing, managed event/status and recovery/queue integration. Build TypeScript once before these compiled-runtime tests.
4. Focused documentation/link and whitespace checks. Check package contents because a new runtime module is shipped under the existing `lib` inclusion.

No full-suite gate is required: the change affects dispatch/progress/memory/status,
not all client adapters, verification receipt implementations or setup flows.
Widen only if selected failures reveal an affected dependency. Keep command logs and
counts under `docs/evidence/closure-stall-remediation/`; do not overwrite historical evidence.

## Results

Initial new regressions: 10 passed, one handoff fixture assertion failed because
the prompt contains the handoff path rather than its body. The fixture now reads
that file; the isolated retry passed. Both logs are retained.

Before the affected compatibility batch: persisted-state validation was hardened
and managed status propagation changed. Those changes invalidate the earlier new
ledger/controller results, so rerun those two files together with the affected
selection, task memory, optional memory, continuation, argument parsing, managed
MCP/status/notification, recovery and queue integration selectors. This is a
bounded compatibility batch, not the application full suite. The shared lifecycle
and persisted state affect each selected workflow; a single plateau regression
cannot establish their compatibility. Expected cost: local prepared processes,
approximately two minutes, zero provider requests.

Affected batch: 172 tests, 168 passed and four failed. Two queue assertions assumed
all events fit the first bounded page; they now follow the existing event cursor.
Two worker/conversation continuity fixtures deliberately exceed the new default
review allowance; those fixtures now declare finite allowances of 8 and 20 turns,
respectively. The new default-parking regression remains unchanged. These failures
concern fixture assumptions; no production edit is required to correct them.
Retry only the four failed tests and retain all other passing results.

The four isolated retries passed. A final source inspection identified three narrow
gaps: warn about retained broad scheduling on each new invocation, reject malformed
pending-review state/source binding, and state current-handoff precedence explicitly
alongside recovery context. These changes affect the new progress unit/controller
regressions; rerun those only after building. Reuse the other 161 passing compatibility
results. Package verification must include the final runtime bundle, so repeat that
specific package check after the build (its prepack hook performs the required build).

The final eleven progress regressions pass. Because emitting retained scheduling
on startup can add an event to resumed managed histories, also rerun the specific
managed-start/event-order and source-completion/restart queue cases; the remaining
compatibility evidence remains valid. No other input or dependency changed.

Notification inspection found that distinct future plateau/scope-growth alerts need
distinct fingerprints for the existing notifier's deduplication contract. Set plateau
fingerprints to review IDs and scope-growth fingerprints to source revisions. Strengthen
the existing broad-worker regression with one unreviewed scope addition per turn and
check independent durable attention fingerprints. Rebuild and rerun only that case and
managed parked-status coverage. Reuse the package layout/help check and other passing
checks: neither packaging inputs nor CLI help changed.

The scope-growth variant passed its plateau, growth and attention checks, then failed
an overly strict assertion of two total scheduling events: added task diagnostics
legitimately cause additional scheduling updates. Assert that both invocation IDs
announce broad scheduling instead. The managed-status case passed. Preserve that
failed run and retry only the corrected broad-worker case; production code is unchanged.

## Final outcome

All 172 distinct selected cases pass using final affected results plus compatible
retained evidence; zero skipped cases. The corrected attention retry passed.
TypeScript build, package layout/version/help, new documentation links, historical
artifact hashes and whitespace checks pass. The package contains the progress module
and all new CLI flags. Failed attempts remain in the evidence directory. No full suite,
paid inference, deployment, publication or commit was performed.

Evidence: [validation](../evidence/closure-stall-remediation/validation.json),
[runtime identity](../evidence/closure-stall-remediation/runtime-final.json),
[hygiene](../evidence/closure-stall-remediation/hygiene.json).

Monitoring starts with the first ledger initialization; historical incident totals are
preserved as evidence, not silently reconstructed into its new budget. Runtime closure
counts observe source checkboxes; they do not independently qualify implementation.
The existing containment run `1f13ece1c31b16b9e862aa7b` remains running and was not
restarted. New safeguards apply to newly started/restarted controllers.

Disk space remains low (approximately 5 GiB free). The inspected session directories
are small: compiled runtime about 220 KiB, evidence below 200 KiB, and npm logs about
104 KiB. Build output and qualification evidence were preserved. No inactive large
session artifact was found; no unrelated cache, project, source, credential, database
or active-service cleanup was attempted. Removed paths: none; reclaimed bytes: zero.
