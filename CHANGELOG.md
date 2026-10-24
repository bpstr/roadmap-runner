# Changelog

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
