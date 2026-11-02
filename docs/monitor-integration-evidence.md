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
