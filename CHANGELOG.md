# Changelog

## 0.12.3 — 2026-10-25

- Remove default same-task conversation and productive-attempt caps. Supply recent-run lookbacks for worker assessment of semantic repetition; matching failures and repeated timeouts no longer automatically defer tasks or dispatch recovery. Preserve source-bound worker blocked decisions and prior evidence.
- Allow three resolver attempts per blocked episode, retaining prior failure evidence and stopping immediately on an explicit stopped decision. Add configurable attempt limits and native park/stop policies before resolver dispatch.
- Bind check receipts to tasks, operations and stages. Gate dependent checks on current successful prerequisite receipts, verify repair edits against changed failing inputs, and require a reason for forced reruns. Preserve matching failed and timed-out results without turning them into passing evidence.
- Validate source and progress control headers before readiness or client launch. Add atomic, source-bound handoff updates that reject stale or invalid candidates without replacing prior content.
- Accept ordered JSON queue entries with custom progress paths through CLI `--queue-spec`, matching the MCP queue shape.
- Add prepared fixtures for failed edits, three-attempt recovery, module-to-content failures, field/type/authorization drift, service timeout limits, compilation interruptions, source inventory changes, review invalidation and queue handoff continuity. Automated verification uses local fixtures and fake clients only.

## 0.12.2 — 2026-10-25

- Publish a GitHub-only test build with updated package and CLI version metadata. Implementation behavior is unchanged from 0.12.1, including longer work sessions, eight-turn continuation and intermediate checkpoints that preserve ongoing work.

## 0.12.1 — 2026-10-25

- Keep Codex same-task conversations for up to eight successful turns. Aggregate input usage, including repeated cached context, no longer triggers a default 65,536-token reset; explicit usage budgets and scope/failure boundaries remain enforced.
- Let ordinary roadmap workers use their configured session time, reserving time for checkpointing, instead of imposing a fixed 40-minute implementation limit. Preserve explicit finite-plan budgets.
- Continue through the selected task's implementation and permitted verification phase. Save intermediate checkpoints while working; completing one operation, fixture or file does not end a session while authorized ready work remains.
- Accept `NOT_STARTED` as a runnable source status without treating its transition to `IN_PROGRESS` as a requirements amendment. Preserve this behavior across queued roadmaps.
- Keep roadmaps together by default; validate both task and file dependency graphs, acceptance prerequisites and queue handoffs before proposing a split.
- Fix the queue regression to use controller-recorded state paths and verify conversation state exists before completion and clears afterward.

## 0.12.0 — 2026-10-25

- Share task parsing across validation and dispatch, fix general task-ID boundaries, and focus ordinary structured roadmaps on one selected task with its shared constraints.
- Continue productive partial tasks with bounded fairness; retain legacy selection when structure or handoff data is insufficient.
- Add session-bound worker outcomes, small deterministic task packets, source-bound shared findings, and scoped check/review receipts. Record command results directly, reuse compatible evidence, and explain invalidation without automatically closing acceptance.
- Defer repeated unchanged failed operations before another worker starts; keep unrelated tasks eligible. Preserve partial quota outcomes and prior failure evidence across recovery.
- Distinguish normal finite-plan exhaustion from blockers and target legacy handoff compaction below 8 KiB while retaining the 32 KiB trigger.
- Verify checkpoint acknowledgments against fresh worker results. Enable bounded Codex same-task conversation reuse by default, with explicit opt-out, fresh scope boundaries, four-turn and 65,536 observed-input-token caps, and saved state cleared after each completed roadmap in a queue.
- Add first-command/edit timings and bounded request fingerprints in cold detail evidence; keep event and recent-summary payloads small.
- Update Zod to 4.6.7 to address GHSA-mrhx-c7xc-m3w5.

## 0.11.0 — 2026-10-24

- Remove regular supervisor sessions. Workers begin with a loop check using previous runs, the current handoff and referenced evidence; repeated failures with unchanged relevant inputs set BLOCKED.
- Automatically dispatch a resolver for global blockers, failed workers, repeated hard timeouts and exhausted finite plans. Require a fresh evidence-backed decision and cleared blocker before resuming workers.
- Add persistent STOPPED when recovery cannot unblock useful work, including failed, timed-out or invalid resolver outcomes. Stop the entire runner and preserve pending queue entries; explicit recovery retries with a resolver.
- Add resolver timeout configuration, role/status reporting and recovery instructions. Preserve quota/capacity waits, compaction, checkpoints and legacy attempt evidence; retain deprecated supervisor options as compatibility inputs.

Validation uses prepared local clients only and does not establish live model detection or repair quality.

## 0.10.8 — 2026-10-24

- Raise the handoff limit to 32 KiB and automatically archive and compact at or above that boundary, including before terminal status checks. Preserve genuine blockers and original evidence.
- Tell every worker, supervisor and compactor the exact byte limits, how to move details into referenced evidence, and that handoff size alone is not a reason to set BLOCKED.
- Keep source roadmaps up to 256 KiB unchanged during compaction; larger sources are rejected without compression or truncation.
- Raise the selected execution batch summary limit from 12 KiB to 32 KiB so retained implementation and recovery evidence can fit in the next worker's context.

## 0.10.7 — 2026-10-24

- Allow requirements-only source roadmaps up to 256 KiB at startup and between sessions. Keep the separate handoff's 16 KiB target, 24 KiB compaction trigger and 128 KiB emergency ceiling unchanged.

## 0.10.6 — 2026-10-24

- Compare named implementation inputs, receipts and handoffs for retry loops. Attempt counters request review; checkbox completion never establishes progress.
- Migrate both prior supervisor checkpoint formats while preserving cross-owner evidence.
- Bound aggregate review summaries and persist supervision cadence across restart; pending requirements and delivery notes cannot starve review.
- Add fixed task/operation execution baselines, three-batch dependency selection, source delivery evidence, rotation and corrective reviews of actual implementation/handoff outcomes.
- Add soft checkpoints, retained unfinished-source recovery, observed activity timing and verified process-group cleanup; preserve source snapshots and failed evidence.
- Keep Codex token limits and the default hard timeout unchanged. Finite batches use 30–45-minute implementation budgets.

## 0.10.5 — 2026-10-24

- Remove checkbox-count and workspace-fingerprint stop conditions. Productive work can continue across sessions while acceptance items remain open.
- Review repeated failed attempts at the configured supervisor interval, including during source-hash reconciliation. Require the repeated operation, failure, unchanged relevant inputs and concrete receipts before a loop stop.
- Preserve one worker reconciliation attempt ahead of a due review after requirement edits; further hash rewrites cannot postpone review.
- Persist recent attempt evidence and review cadence across restarts. Retire idle-budget settings while retaining quota waits, global BLOCKED, explicit recovery and queued work.

## 0.10.4 — 2026-10-23

- Add a small supervisor LLM loop check after two idle workers. Compare bounded prior progress, source snapshots and worker outcomes; block immediately on a current, evidenced loop verdict. Keep the deterministic stop budget, pending queues and blocked state across unchanged restarts. Cap the extra check at 60 seconds and one per stagnation episode; supervision-off still disables model reviews.
- Preserve the exhausted deterministic worker budget across unchanged restarts without launching another session. Allow one explicit recovery worker or a new bounded budget after controller requirement changes.
- Compact handoffs above 24 KiB in a separate session targeting 16 KiB. Preserve detailed evidence and pending reconciliation; compact before a due supervisor or loop assessment. Ignore valid marked delivery notes when comparing requirements.
- Stop if the source roadmap changes during compaction, preserving both files for inspection before restart. A compactor cannot silently grant a fresh worker budget by rewriting requirements.
- Record session roles, elapsed time, context bytes and available client usage receipts in durable events and session history. Keep missing usage unknown.

## 0.10.3 — 2026-10-23

- Stop source-hash reconciliation loops: measure live-roadmap task completion, persist its high-water count, and prevent worker/supervisor source rewrites from renewing the stagnation budget. Controller requirement amendments adopted between sessions still grant one fresh budget. Preserve exhausted budgets across restarts and pending queues. Fixes #6.
- Enable desktop attention notifications by default, retaining explicit CLI/environment/MCP off switches and durable events when OS delivery is unavailable.
- Make global BLOCKED stop immediately (exit 75/reason blocked), preserving blocked status and pending queue entries. Permit one explicitly requested recovery worker after changed inputs with --recover-blocked or recoverBlocked; task-local deferrals still allow independent work.
- Instruct workers/supervisors to reuse dependency audits and avoid repeated repository/cache/receipt scans on unchanged blockers.

- Stop after three workers without completed checklist progress (configurable with `ROADMAP_MAX_IDLE_WORKERS`), preserving partial work and queued roadmaps. Exit 75 and expose `no_progress_limit` in terminal events and managed status.
- Ignore handoff/blocker prose churn when detecting checklist progress, so recovery workers and supervisor edits cannot indefinitely renew the budget. Preserve source-revision resets and bounded recovery for independent work.

## 0.10.2 — 2026-10-20

- Keep verified task checkmarks in the live roadmap and handoff/evidence in the bounded progress file. Prevent a progress-file COMPLETE status from closing unfinished roadmap tasks.
- Preserve reconciliation evidence across checkbox-only and status-only source edits while continuing to reconcile changed requirements between sessions.
- Default CLI and managed worker sessions to 90 minutes and target coherent 60-minute implementation batches, including time for focused verification and handoff.
- Update roadmap writing, splitting and template guidance to defer test development and comprehensive cases until after all functional roadmaps, use narrow delivery checks and reuse compatible evidence without repeated broad test runs.

## 0.10.1 — 2026-10-18

- Default desktop alerts to off for CLI and MCP starts; keep explicit opt-in independent of macOS permission requests. Runner journals, hooks and MCP events remain available.
- Add read-only MCP `roadmap_events` for bounded cursor replay, and deliver resource updates to cursor-bearing event subscriptions in both protocol eras, including cancellation and reconnect coverage.
- Add `notifications request-permission` to request macOS notification authorization with a confirmation alert, or open Notifications settings after a denial. Support structured results and cancellation without starting a roadmap run.
- Add opt-in `--prevent-sleep`, `ROADMAP_PREVENT_SLEEP=1` and MCP `preventSleep` support. Hold one sleep inhibitor across waits and queued roadmaps, expose its status, and release it when the run ends.
- Discover Homebrew's macOS notification backend when desktop apps supply a restricted PATH. Report denied notification authorization with System Settings guidance while preserving failed delivery history and allowing later submission attempts.
- Add roadmap splitting and queue guidance with suggested input budgets, milestone boundaries, cross-file prerequisites and compact evidence handoffs so workers read focused inputs.

## 0.10.0 — 2026-10-13

- Add FIFO roadmap queues with automatic handoff after successful completion. Use repeated `--queue` flags when starting, the `queue` command to append to an active run, or MCP `roadmap_enqueue`.
- Preserve one run ID, workspace reservation and event cursor across handoffs, with separate progress/history for each roadmap. Expose queue states in status and leave later entries pending after stop or failure.

## 0.9.0 — 2026-10-12

- Alert on a current supervisor `Health: STUCK` report or two consecutive workers with unchanged progress. Persist one alert per stagnation episode across restarts; clear it when progress or the source revision changes.
- Apply the 128 KiB context limit to source roadmaps as well as progress files. Sources between 128 and 512 KiB that older versions accepted now require manual compaction before starting or resuming. Files are preserved on rejection.
- Request progress compaction at 96 KiB before the next worker or supervisor proceeds. Preserve requirements, checkbox states, blockers and current evidence references; keep archived snapshots as cold history.
- Distinguish stuck and blocked desktop messages. Explain how to install the macOS notification backend, and avoid treating failed notification submissions as successfully delivered.

Validation uses prepared clients and mocked notification transports. It does not establish live provider quality or Notification Center display permissions.
