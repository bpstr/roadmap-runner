# Codex Desktop blocker notification and recovery investigation

Investigated October 20, 2026. This PR supplies source-backed findings, an inert recovery-gate prototype and prepared tests. Live Desktop wakeup, scheduling and model dispatch are not verified or enabled. Runner terminal blockers, default attention alerts and explicit single-worker recovery are implemented separately in [PR #4](https://github.com/bpstr/roadmap-runner/pull/4); merge that prerequisite before connecting recovery dispatch.

## Findings

| Mechanism | Evidence | What remains unproven |
| --- | --- | --- |
| Runner OS attention alert | `src/notifications.ts` submits through terminal-notifier/notify-send and records success/failure; explicit off is respected. | An OS banner does not establish that an idle Codex chat received an event or began a turn. Live display/permissions must be tested separately. |
| Runner MCP state/events | `src/mcp.ts`, `src/events.ts` and the prepared legacy/modern tests cover tools, cursor replay and resource updates. Durable journals remain readable after a terminal blocker. | A resource update is not proof of an autonomous chat wakeup. No such wakeup was observed in this investigation. |
| Named plugin MCP Events | Official documentation describes event discovery, subscription and signed webhook delivery. Its test flow targets Work web, Work Cloud in Desktop, or a dot. [MCP Events](https://developers.openai.com/plugins/build/mcp-events) | Local Codex Desktop compatibility, callback availability and offline delivery need direct tests. Runner's local stdio resource notifications are not this webhook protocol. |
| Lifecycle hooks | Official hook events occur during turns, session starts/ends and interruption; SessionStart can add context. [Hooks](https://learn.chatgpt.com/docs/hooks) | No arbitrary external runner-event listener was established. A lifecycle callback should not be treated as an idle-chat scheduler. |
| Plugin-bundled hooks | Manually installed Desktop plugins can supply hooks; non-managed definitions require trust review. [Plugin packaging](https://developers.openai.com/plugins/build/plugins) | Packaging a hook does not establish a background trigger or make a public-directory plugin eligible to use it. |
| Scheduled follow-up | Official scheduled tasks can revisit an existing chat, or run standalone work; local jobs require the app/host to remain available. Findings appear in Scheduled. [Scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app) | A saved schedule is not evidence of actual execution, Desktop notification display, or access to this exact workspace. |

The recommended first experiment is a host-created scheduled follow-up using bounded status/event reads and a deterministic preflight. This is an engineering inference from the documented scheduler, not a claim of verified external-event wakeup. Investigate named MCP Events in parallel; do not require an unverified wakeup bridge to ship correct terminal-blocked behavior.

## Preserve the blocked boundary

Global BLOCKED means no remaining authorized work is ready. Exit the runner and retain its blocker IDs, evidence references, source revision, event cursor and unfinished queue. Individual task blockers remain deferrals while independent implementation continues. A host monitor may check a small named prerequisite, but must not repeatedly spend model sessions rediscovering unchanged inputs.

Use the source revision, task IDs and stable unblock-condition identity as the incident key. Exclude rewritten notes, cursor advancement, timestamps and new runner IDs from the identity. The actual unblock-input fingerprint must be computed from validated content or an explicit user response, never file mtime or arbitrary handoff prose.

When the input changes, claim one recovery job durably before dispatch. Start the same source/progress pair with `recoverBlocked: true`, notifications on and an incident/input-derived idempotency key. If it remains blocked, terminate again; a timer alone cannot renew the same attempt. Cap the incident at two changed-input attempts pending human review, with single-writer claims and existing workspace reservations preventing overlap.

## Prepared prototype and result

`examples/codex-recovery-gate.mjs` is a pure planner. It has no subprocess, network, filesystem or scheduler side effects. A host supplies a terminal-blocked observation and its previously saved checkpoint. The first observation establishes a baseline. Unchanged input returns wait; new verified input plus explicit recovery authorization returns one dispatch intent and a checkpoint claiming its key. The caller must atomically persist that checkpoint under an exclusive lock before invoking any dispatch transport.

Run:

```sh
node --test test/codex-recovery-gate.test.js
```

Five prepared tests establish: 100 unchanged observations produce zero dispatches; a changed input produces exactly one mocked request across serialized checkpoints; active work and missing authorization prevent dispatch; two changed-input attempts exhaust the incident budget across runner restarts; and a changed source/blocker establishes a new baseline rather than blindly dispatching. No actual model, Desktop chat, schedule, notification, hook or webhook is invoked.

This prototype does not validate an external input, persist/lock checkpoints, authenticate events, implement a host adapter or preserve multi-roadmap queue registration during a recovery handoff. Those are explicit implementation requirements before enabling automatic dispatch. A single-source restart must not silently discard later queued entries.

## Host experiment queue and acceptance

1. **Notification visibility.** Generate one prepared terminal-blocked event with default notifications enabled, then with explicit off, denied permission and a missing sender. Inspect OS display and persisted delivery results independently. Record sender/app versions and app state; an alert should identify the run and point to status without including credentials or raw worker output.
2. **MCP delivery.** Start a synthetic run in an authorized workspace, save the cursor, disconnect/reconnect and retrieve the terminal-blocked event exactly once. Check whether an idle Desktop chat actually starts a turn. If it does not, record that result rather than inferring a wakeup from server delivery.
3. **Scheduled fallback.** Use the host's schedule API/UI to create one explicitly authorized follow-up bound to workspace and run ID; do not edit private Desktop state or automation databases. First use a mocked recovery transport. Keep status/output bounded, inspect only the named unblock input, remain quiet when unchanged, and stop after completion, exhausted recovery budget, removed authorization or expiry. Verify a real scheduled execution, not merely registration.
4. **Named Events/hooks.** Test supported Work surfaces and local Codex separately. Capture actual discovery/subscription behavior, signature/replay rejection, expiry, offline recovery and trust setup. Determine whether the host can provide a verified inbound wakeup and whether a hook can help ingest a queued blocker when the user next resumes. Never manufacture a private notification or rely on an undocumented Desktop endpoint.
5. **Recovery handoff.** After mock acceptance, connect one bounded recovery job to PR #4's explicit recovery primitive using existing user scope. Record attempt count and preserved queue. Prove unchanged input, duplicate delivery, overlapping monitors and crash/restart cause no additional provider attempt. A real changed input may produce one worker; persistent BLOCKED ends that worker and returns attention to the host.

A host adapter is ready only when one supported trigger is verified end to end and these zero-duplicate-dispatch conditions hold. Until then, use durable event tracking and explicit recovery; do not restore the old BLOCKED polling loop.
