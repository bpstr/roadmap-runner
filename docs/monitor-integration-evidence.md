# Monitor integration evidence — 2 November 2026

Baseline: `862e0fb` / 0.12.6. Companion monitor: separate `roadmap-monitor` checkout, protocol v1. These are working-tree changes, not a published npm feature.

The change adds a private config/reporter/outbox, one managed-worker publisher, safe selected-task titles and validated result fields. It filters monitoring credentials from provider/hook/verification children. It does not alter prompts, selection/recovery/completion rules or provider APIs.

Validation plan: build TypeScript; new config/projection/outbox tests; prepared foreground/detached/queue integration; existing task-selection and queue-deferral selectors for the affected accessor/lifecycle paths. Monitoring is explicitly disabled for unrelated prepared checks. All providers are local prepared scripts; no paid API, proxy, credential loading or live dogfood.

Results so far: runner build passed; seven monitor unit tests passed; after adding attributed result history, one affected result-binding test passed. Prepared integration passed for foreground, detached and two-roadmap queue. Foreground used one prepared invocation with reporting either off or on; queue used two, detached one. Provider children did not inherit the write-key variable. The test command remained probe-only. Nineteen captured envelopes also passed the monitor’s actual v1 schema.

The first integration fixture lacked `Acceptance:` metadata and correctly used broad scheduling, invalidating its expected selected-task title. The corrected valid-selection fixture passed. Failure evidence is retained in the monitor checkout’s ignored artifacts. No provider-quality or actual mobile push claim follows from these checks.

Selected existing checks: `ROADMAP_MONITOR=off ROADMAP_NOTIFY=off node --test test/task-selection.test.js test/queue-deferral.test.js`. Scope justification: the title accessor augments returned selection metadata, and the reporter attaches at shared queue event/finalization boundaries. Other passing evidence is retained; no full runner suite is required.

Release gates remain: publish the reporter-enabled npm version, confirm package-update identity/config/outbox persistence, deploy the monitor and qualify real Home Screen iPhone notification display. See the separate monitor’s deployment guide. No external deployment or live-content dogfood is implied by this record.

Existing affected selectors completed: **43 passed, zero failed/skipped**, approximately 12 seconds. The full runner suite was not run.

Two final focused configuration/automatic-history tests passed after limiting launch-time retry to one verified stream. One additional journal-budget test passed: optional monitor fields are omitted if they would overflow an otherwise valid 8 KiB event; the asynchronous reporter still receives source metadata. Native oversized events still fail as before. Final TypeScript build passed.

A focused source-edit test passed for captured title/source-revision binding. Dispatch forwards title/phase only when the already-loaded selection hash matches the actual session source revision; otherwise it keeps the honest ID fallback. No additional file scan is introduced.


## Native attention reporting patch — 0.13.1, 3 November 2026

The requester approved a native runner fix and GitHub release 0.13.1 after the monitor-side compatibility repair. Preserve the original attention flag status in an allowlisted additive `attentionItems` run-state field while keeping `attentionTasks` compatible. Native snapshots distinguish active repairs/recovery from explicit `NEEDS_INFO` requests (`user_input`). Waiting, blocked and terminal issues regain attention; unblocked events and queue transitions clear both projections. Older ID-only state remains readable. No provider, prompt, scheduling or desktop-notification behavior changes. Existing worker processes load the new code on a subsequent launch.

Verification plan: one TypeScript build, focused monitor unit/integration selectors (including four new state/attention regressions), actual monitor-v1 parsing of captured prepared reports plus new flag variants, packaged CLI/tarball verification, then the existing GitHub CI matrix. No local full-suite run is needed. A push to main explicitly triggers the full Node 20/22/24 Linux/macOS test/package gates in `.github/workflows/ci.yml`; wait for those before publishing the GitHub release. Use only local prepared clients, mocked monitor HTTP and isolated state; no provider calls, real telemetry, real pushes or edits to running workers. Completion requires the published v0.13.1 GitHub release pointing to the checked commit, with package and validation/checksum assets. The user requested GitHub publication; npm publication is outside this release's scope.

Local patch checks passed: TypeScript build; 15 focused monitor unit/integration tests, zero failures/skips; the actual companion monitor's v1 schema accepted all 17 captured prepared reports plus six native state scenarios (active, resolver, blocked, waiting, terminal and legacy). Its ingestion compatibility rule preserved the native `user_input` alert. Packaged CLI verification passed for 92 files, preserving saved configuration and retained outbox state. Logs and capture/protocol evidence are retained in the companion monitor checkout's ignored `artifacts/runner-0131-*` files. No local full suite was run; unchanged recovery/scheduling evidence is retained, with the existing CI matrix as the publication gate.

Release isolation: a concurrent Git-management task changed the shared checkout to 0.14.0 during final packaging. The mismatch was caught before pushing or publishing. Its tarball is retained as rejected evidence under the companion monitor's ignored artifacts; it is not a 0.13.1 candidate. The shared checkout's work was preserved, and the attention-only release moved to branch `release/native-attention-0.13.1` in an isolated worktree based on 9d92b42. Because the compiled/package inputs were concurrently changed, rebuild and repeat only the affected 15-test and package/protocol selectors against the isolated source. Dispatch the existing CI workflow on this release branch, preserving its six full test/package gates; do not modify the other task's main checkout or release.

The isolated source passed the same affected checks: 15 tests, zero failures/skips, 17 prepared envelopes and six native protocol scenarios, with a clean 0.13.1 build. Packaged CLI/config/outbox verification passed on the isolated package. The rejected mixed-checkout tarball was never published.
