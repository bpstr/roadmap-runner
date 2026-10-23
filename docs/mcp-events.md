# Runner events and MCP integration investigation

Reviewed 2026-10-07. The event journal and notification hook are implemented. An
MCP server is now implemented; see [agent integration](agent-integration.md).
Automatic agent dispatch remains proposed and has not been live-tested. Prepared tests establish local runner behavior only.

Updated 2026-10-14: desktop notifications default off. MCP event reads and
resource subscriptions remain available independently; requesting macOS
permission does not opt a roadmap run into desktop alerts.

## Supported integration now

Every run writes append-only JSONL at `<progress-file>.events.jsonl`. Each event
has `version`, a unique `id`, UTC `at`, `type`, `roadmap`, and `progressFile`.
Task attention events contain stable task IDs and their statuses; reasons and
provider output stay in the progress/evidence files. The hook named by
`ROADMAP_NOTIFY_BIN` receives the same JSON on stdin. It executes directly,
without a shell, for at most ten seconds. Hook failure does not stop delivery.
This is a local executable interface; remote delivery is the hook's responsibility.

| Event | Meaning |
| --- | --- |
| `runner.turn_starting` | Worker, supervisor or compactor starts; includes `sessionId` and initial `contextBytes` |
| `runner.turn_finished` | Session result, elapsed time, model attribution, reported usage and before/after context-file sizes |
| `runner.blocked` | Current ready set exhausted; recovery continues |
| `runner.needs_attention` | Task blocked, skipped, problematic or needs an answer while other work can continue |
| `runner.unblocked` | Previously flagged attention cleared |
| `runner.stuck` | Current supervisor STUCK report or two unchanged workers; attention alert once per stagnation episode |
| `runner.progress_resumed` | Progress or source revision changed; clears stuck notification deduplication |
| `runner.recovery_wait` | Repeated unchanged progress state; bounded recheck backoff |
| `runner.usage_paused` | Worker/supervisor quota rejected; checkpoint saved |
| `runner.usage_resumed` | Reset wait ended; next session may run |
| `runner.usage_wait_expired` | Incident wait ceiling reached; exit 75 |
| `runner.supervisor_deferred` | Timed-out/incomplete review preserved; worker continues |
| `runner.failed` | Ordinary worker CLI failure; partial work preserved |
| `runner.queued` | A roadmap was appended to an active managed run |
| `runner.roadmap_completed` | Current roadmap completed; the managed run has another queued roadmap |
| `runner.completed` | The final roadmap completed; the managed queue is finished |

Managed run journals keep event sequences increasing across roadmap handoffs.
Each roadmap's progress-local journal retains its own sequence and completion
event. Use the managed run journal when monitoring the whole queue.

Session roles are `worker`, `supervisor` and `compactor`. Compactors use the last
worker iteration number (zero before the first worker) and a unique `sessionId`.
Each attempt also has a durable row in the tracking directory's `sessions.jsonl`;
managed artifacts expose it as `sessions`, and detailed evidence as `evidence`.
Finished events include `usage` (nullable), `usageReports`, `usageComplete`,
`model`, `modelSource` (`client`, `configured` or null), `configuredEffort`,
`startedAt`, `elapsedMs`, and `contextBytes.before/after` with `prompt`, `source`
and `progress` byte sizes. Usage fields are `inputTokens`, `cachedInputTokens`,
`outputTokens`, `reasoningOutputTokens` and `cacheCreationInputTokens`; unreported
fields remain null. Codex input includes cached tokens; Claude cache fields are
separate from input. Failed attempts retain available receipts with
`usageComplete: false`. These fields do not estimate monetary cost or peak context.

Repeated unchanged task attention is suppressed across restarts. A changed reason,
set of tasks or global status creates a new event. Hooks are best effort: the event
is recorded first, but a process crash can interrupt delivery. Consumers needing
reliable delivery must replay the journal and persist their own cursor/acknowledgment.
Repeated quota/backoff events are operational records; notification consumers should
filter them to avoid alerting on every recheck. The macOS example already filters
recovery rechecks.

## Implemented MCP event delivery

`roadmap_events` accepts `{ runId, cursor? }` and returns bounded journal pages
without worker output. Persist its returned cursor after consuming each page.
`eventsTruncated` requests another page; `cursorExpired` and `oldestCursor`
identify a gap caused by journal rotation, and `malformedRecords` counts skipped
damaged records. The same page is available at
`roadmap://<run-id>/events?cursor=<sequence>`.

Subscribe to an event resource with legacy `resources/subscribe`, or modern
`subscriptions/listen` using `notifications.resourceSubscriptions`. Resource
updates preserve the subscribed URI, including a cursor query. Read the page
after an update and replay from the saved cursor after reconnecting. Legacy
unsubscribe and modern listen cancellation stop updates. These interfaces work
when desktop alerts are off or the desktop backend is unavailable.

## What MCP can do

An MCP server can expose `roadmap://<run-id>/state`, let a connected client subscribe,
and emit `notifications/resources/updated` when task state changes. The client
then reads the resource. The host decides whether to include that state in an agent's
context or present it to the user. This supports observability; it does not specify
starting an idle agent turn. See the official
[MCP Resources specification](https://modelcontextprotocol.io/specification/2025-11-25/server/resources).

MCP elicitation can request structured input from a supporting connected host. It
requires capability negotiation and a host user interface. It should be an optional
way to collect an answer to a specific blocker, with cancellation preserving the
blocker. It cannot be assumed available in every coding client. See
[MCP Elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation).

For actual Codex execution, a bridge can initialize Codex App Server, create or
resume a thread, then explicitly submit `turn/start`. This is an application-owned
control path, separate from MCP resource notifications. Treat this as an integration
with a running app-server process, not permission to inject messages into arbitrary
existing desktop chats. Other coding clients need their own supported execution
adapter. See [Codex App Server](https://learn.chatgpt.com/docs/app-server).

## Proposed bridge roadmap

### Epic MCP-1 — Read-only event adapter

- [x] MCP-1.1 Implement run registration bound to a specific workspace and progress path; expose bounded state and cursor-based event reads through an official MCP SDK.
- [x] MCP-1.2 Implement resource subscribe/unsubscribe; notify only on a state transition, keeping model output out of notification payloads.
- [x] MCP-1.3 Validate with prepared JSON-RPC clients: capability negotiation, disconnect/reconnect, partial trailing journal records and event replay.

### Epic MCP-2 — Durable notification delivery

- [ ] MCP-2.1 Persist consumer cursor, event acknowledgment and retry state; deduplicate by event ID and blocker fingerprint.
- [ ] MCP-2.2 Queue task questions by stable task ID; keep independent roadmap tasks runnable while awaiting answers.
- [ ] MCP-2.3 Validate restart and hook failure with deterministic fixtures; verify no event is silently dropped or repeatedly dispatched.

### Epic MCP-3 — Authorized agent wake-up

- [ ] MCP-3.1 Add an explicitly configured Codex App Server adapter; bind permitted workspace/thread, model, tools and dispatch scope before execution.
- [ ] MCP-3.2 Serialize one recovery turn per run; dispatch only on new information, changed prerequisites or a due bounded retry. A blocked event alone must not recursively create recovery agents.
- [ ] MCP-3.3 Gate dispatch on the runner's quota checkpoint and existing waiting deadline; preserve the one-day weekly ceiling and never switch accounts/models to evade it.
- [ ] MCP-3.4 Apply user answers through the runner's controller-owned roadmap/source revision mechanism. Preserve task IDs, checkbox evidence and unresolved dependencies.
- [ ] MCP-3.5 Validate all dispatch, cancellation, duplicate-event and quota cases through mocked transports. Any meaningful live dogfood is a separate workflow requiring exact real content, request/spend caps and a stop condition before inference.

The implementation now provides managed control and local resource subscriptions alongside the journal/hook boundary.
Building these bridge epics does not block ongoing roadmap execution. Public hosting,
remote authentication and production rollout belong after local bridge validation.

## Reference comparison

The Assign reference scripts were inspected locally after checking the official
Assign MCP search (which did not contain these script resources):

- `assign-infra/scripts/claude-roadmap-runner.py`: structured rejected-limit events, explicit zoned reset clocks, durable limit metadata.
- `claude-assign-todo-loop.py`: keep externally blocked and failed-check task sets, inspect the next task and preserve incomplete task state.
- `codex-roadmap-loop.sh`: capacity backoff and signal handling; its terminal global-BLOCKED behavior is superseded by this runner's recovery loop.

No Assign data was modified. No live model or notification was dispatched during validation.
