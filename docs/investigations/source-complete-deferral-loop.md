# Source-complete deferral queue loop

- Status: Fixed locally; prepared regression verified
- Owner: Roadmap Runner maintainers
- Last reviewed: 2026-10-29
- Related: [Task continuity](../task-continuity.md), [verification record](../evidence/source-complete-deferral-loop/validation.json)

A managed queue repeatedly selected a source-complete roadmap whose worker had
explicitly deferred remaining acceptance. The next roadmap stayed pending for
41 minutes 23 seconds. The retained event history contains 100,628 deferrals and
100,627 subsequent starts. These were controller transitions, not agent turns.

`deferredRoadmapReady` treated an absence of unchecked source boxes as an
unconditional retry trigger. The deferred source already had that state, so
every queue boundary selected it again before pending work. The lifecycle
correctly returned the unchanged deferral without dispatching an agent, but the
queue immediately retried it. The synchronous transitions also starved signal,
control-socket and timer processing. Authenticated stop was unavailable, and
SIGTERM did not stop the affected worker. After process identity was rechecked,
SIGKILL contained the loop. The next roadmap was started manually with its four
remaining queue entries and existing execution settings.

Deferral manifests now capture source and task completion baselines. A later
completion transition can permit reassessment; completion already recorded at
deferral cannot. Older manifests remain readable and require a known retry
trigger instead of assuming a completion transition. The worker also yields to
the event loop at each queue boundary so stop/control I/O can run even when a
lifecycle returns immediately.

The prepared regression failed before the readiness repair because the run never
finished. After repair, the deferred source remains parked, the next entry runs
once, and a restart does not dispatch unchanged work. Separate cases cover a
later completion transition, legacy manifests and task completion already saved
at deferral. An attempted structured fixture expected deferral after all its
acceptance had completed; that incorrect expectation was removed and its failed
receipt retained. The structured completed-baseline condition is checked directly.

All new checks use local prepared clients. They establish controller behavior,
not provider quality or application/runtime qualification. Existing unrelated
source edits were preserved and included at the requester's explicit instruction.
