# Agent integration evidence

Implementation and deterministic validation, 2026-10-07. All provider execution
uses prepared mock CLIs; notification delivery uses stub transports. No paid
inference, live-content dogfood, real app/chat reaction or desktop visibility is
qualified by these results.

The initial validation accidentally submitted AppleScript desktop alerts on this
Mac. The user reported Script Editor opening from those notifications. The run
ended; the built-in macOS transport was changed to an optional installed
`terminal-notifier` without click actions, and test execution now disables both
ambient desktop delivery and external hooks. The correction is tested with stubs;
actual macOS visibility remains unverified.

The first regression evidence remains in `docs/evidence/agent-integration/`:
135 tests, 133 passed, 2 failed for additive event assertions. The next run had
135 tests, 129 passed, 6 failed for foreground canonical-path spelling. Those
failures drove assertion changes for terminal event coverage and preservation of
foreground source/progress path spelling. Canonical paths remain the managed lock
identity. The first integration pass had 12 tests, 8 passed, 4 failed; the second
had 12 tests, 10 passed, 2 failed. Prepared quota wording, canonical setup assertions
and the mock-client PATH were corrected. Failed results are preserved.

A subsequent full run passed all 149 tests with zero failed/cancelled/skipped.
The 56 targeted foreground compatibility tests and the later 16 integration tests
also passed. Final validation counts and disk hygiene follow below after completion.

| Plan task | Implemented boundary and deterministic evidence |
| --- | --- |
| INT-1 | Reusable lifecycle returns outcomes. Shared cancellation reaches worker/supervisor execution, quota/capacity/recovery waits and external hooks. Existing foreground recovery, supervisor, source revision and shutdown regressions pass. |
| INT-2 | Detached worker, private socket authentication, atomic workspace/progress locks, readiness and idempotency. Prepared processes cover concurrent starts, canonical aliases, reconnects, live/reused PID caution and an ignoring descendant terminated before stopped. |
| INT-3 | Managed dimensions, always-on normalized capture, redaction, bounded rotation, lifecycle events and cursor replay. Fixtures cover event order, malformed/trailing records, retention expiry and quota checkpoint preservation. |
| INT-4 | Optional macOS/Linux command transports, attention/explicit filters, persisted fingerprints and bounded async delivery. Stub cases cover deduplication across restart, timeout/missing backend/headless isolation, Linux submission, off mode and benign SKIPPED reasons. |
| INT-5 | Pinned released server SDK 2.3.1, explicit Node >=20, three strict-schema tools and resources. Prepared legacy/modern JSON-RPC proves stdout purity, option restrictions, resource reads, subscriptions, worker-control restriction and bounded output. |
| INT-6 | Codex/Claude/Grok adapters, two scopes, dry-run, conflict/no-op/backup handling and independently reported skill/connectivity outcomes. Temporary config fixtures preserve TOML comments and modified skills; staged skills 1.7.1 and actual no-inference MCP initialization/listing are exercised. The packaged skill passes the Skill Creator validator and deterministic structure checks. |
| INT-7 | Legacy subscribe/unsubscribe and modern subscription acknowledgements/URI updates pass prepared exchanges through the SDK's era-aware transport. Experimental named-event and host wake-up adapters remain conditional follow-up scope because no supported client contract was established. Polling is available. |

App configuration shapes were checked against current official Codex, Claude Code,
Grok Build and skills documentation linked from the integration guide. Prepared
protocol clients are interoperability evidence, not proof of live host loading,
project trust approval, notification visibility, idle-chat wake-up or small-model
roadmap quality. No user's actual app configuration was edited by validation.

## Final checks

- Full regression suite: **153 executed, 153 passed, 0 failed, 0 cancelled, 0 skipped**.
- After the final notification-state/readiness hardening: **20 integration checks executed, 20 passed, 0 failed/cancelled/skipped**. This includes preservation of damaged notification state, thrown transport isolation, and startup failure reported without claiming readiness.
- TypeScript build: passed. Skill Creator frontmatter/scaffold validation: passed.
- Structure fixtures additionally reject duplicate checkbox IDs, missing implementation/validation steps, cycles and development dependencies on release-only tasks.
- `git diff --check`: passed. npm audit: **0 vulnerabilities**.
- npm package dry-run includes the compiled lifecycle/worker/MCP/setup modules and all three skill assets. No real provider or desktop transport is exercised by these checks.

Logs and a source hash manifest are retained in `docs/evidence/agent-integration/`.
The full suite predates the two final hardening cases; the subsequent targeted
integration suite validates their final implementation without repeating unrelated
regressions.

## Setup diagnostics and CI — 2026-10-11

The read-only `doctor` command adds app configuration/skill inspection, strict
MCP initialization and tool-name checks, and saved Codex hourly-monitor inspection.
Prepared monitor fixtures cover missing/paused registrations, restricted cadence,
workspace/run mismatches, malformed/oversized files and paths escaping the local
automation directory. A local MCP exchange confirms no managed run is created.
User-scope fixtures cover `CODEX_HOME`; app configuration and saved monitor files
remain unchanged by inspection. Saved registration does not qualify host execution.

The first focused run had **8 executed, 4 passed, 4 failed, 0 skipped** because
macOS `/var` and `/private/var` aliases differed. The corrected checks accept the
explicit workspace alias and compare canonical MCP arguments. The subsequent
focused run had **8 executed, 8 passed, 0 failed/cancelled/skipped**.

The final full suite had **163 executed, 163 passed, 0 failed/cancelled/skipped**.
The npm tarball contained **53 files** and passed required-file/exclusion checks
plus extracted CLI version/help checks using the existing locked dependencies.
All checks use prepared coding clients and local transports; no inference or host
schedule was executed. Initial failure, final focused/full results and package
output are retained in `docs/evidence/setup-diagnostics/`.

The new GitHub workflow runs this suite and tarball check on Node 20/22/24,
Linux and macOS, without provider credentials. Hosted results are recorded by
GitHub Actions separately from these local results.

## Earlier integration-session disk hygiene

Removed 26 cache files created by this session and the inactive prepared-process registry at `/tmp/roadmap-runner-compat-registry`. Exact cache paths are recorded in [the cleanup manifest](evidence/agent-integration/disk-cleanup.json). Deleted file content totals 19,692,262 bytes; the cache files occupied 19,509,248 allocated bytes. Remaining data-volume space: 13.41 GiB. Source, Git history, node_modules (39 MiB), compiled package artifacts (128 KiB), all failure/pass evidence and unrelated processes/caches were preserved.

The largest inspected remaining cache is `~/.npm/_cacache` (about 1.1 GiB), shared with unrelated work. Broader removal requires user approval; this session did not expand cleanup to it.
