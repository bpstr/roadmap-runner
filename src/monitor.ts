import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { acquirePublisher } from "./monitor-lock.js";
import { fileURLToPath } from "node:url";
import {
  atomicJson,
  privateDir,
  sanitize,
  type RunRecord,
} from "./run-state.js";
import {
  monitorConfig,
  monitorRoot,
  probe,
  saveMonitorConfig,
  type MonitorConfig,
} from "./monitor-config.js";
const version = JSON.parse(
  fs.readFileSync(
    fileURLToPath(new URL("../package.json", import.meta.url)),
    "utf8",
  ),
).version;
const MAX_BYTES = 1024 * 1024;
const meaningful = new Set([
  "runner.started",
  "runner.turn_starting",
  "runner.task_result",
  "runner.queued",
  "runner.roadmap_completed",
  "runner.roadmap_deferred",
  "runner.queue_deferred",
  "runner.blocked",
  "runner.unblocked",
  "runner.needs_attention",
  "runner.progress_review_required",
  "runner.progress_reviewed",
  "runner.failed",
  "runner.completed",
  "runner.stopped",
  "runner.plan_exhausted",
  "runner.usage_paused",
  "runner.usage_resumed",
  "runner.capacity_wait",
  "runner.capacity_exhausted",
  "runner.recovery_wait",
  "runner.recovery_retry",
  "runner.progress_updated",
]);
export const monitorText = (value: unknown) =>
  sanitize(String(value ?? ""))
    .replace(/rm_[a-f0-9]{16}_[a-f0-9]{64}/g, "[REDACTED]")
    .replace(
      /(?:[A-Za-z]:[\\/]|\/(?:Users|home|private|tmp|var|etc|Volumes|workspace|opt)\/)[^\s,;]*/g,
      "[private path]",
    )
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 256);
const reference = (value: any) =>
  typeof value === "string" ? monitorText(value).slice(0, 128) : null;
const reason = (value: any, fallback = "runner_status") =>
  typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value)
    ? value
    : fallback;
const label = (value: string) => monitorText(path.basename(value));
export function terminalOutcome(record: RunRecord) {
  if (record.reason === "complete" && record.roadmapState === "complete")
    return "completed";
  if (record.reason === "stopped") return "cancelled";
  if (record.reason === "deferred" || record.roadmapState === "deferred")
    return "deferred";
  if (
    [
      "blocked",
      "review_required",
      "awaiting_verification",
      "needs_next_batch",
    ].includes(record.reason) ||
    [
      "blocked",
      "review_required",
      "awaiting_verification",
      "needs_next_batch",
    ].includes(record.roadmapState)
  )
    return "needs_attention";
  return "failed";
}
export function projectMonitor(
  record: RunRecord,
  state: any,
  terminal = false,
  now = new Date().toISOString(),
) {
  const role = record.role ?? null;
  const worker = role === "worker";
  const task =
    worker && !/^roadmap-[a-f0-9]+$/.test(record.task ?? "")
      ? reference(record.task)
      : null;
  const run = {
    kind: record.queue?.length > 1 ? "queue" : "run",
    roadmap_label: label(record.roadmap),
    roadmap_state: record.roadmapState,
    wait_reason: reference(record.waitReason),
    reset_at: record.resetAt ?? null,
    deadline: record.deadline ?? null,
    role,
    iteration: record.iteration ?? null,
    task_id: task,
    batch_id: worker ? reference(record.batch) : null,
    session_id: reference(state.sessionId),
    source_revision: reference(record.sourceRevision),
    heartbeat_expected: !terminal,
    terminal,
    terminal_outcome: terminal ? terminalOutcome(record) : null,
    exit_code: record.exitCode ?? null,
    reason_code: terminal ? reason(record.reason, "worker_error") : null,
    ready_at: record.readyAt ?? null,
    ended_at: record.endedAt ?? (terminal ? now : null),
    last_progress_at: state.lastProgressAt ?? null,
  };
  let text: string;
  let source = "lifecycle";
  if (record.waitReason === "quota") {
    text = "Waiting for quota reset";
    source = "quota_wait";
  } else if (role === "resolver") {
    text = `Resolving a blocker${record.iteration != null ? ` · Iteration ${record.iteration}` : ""}`;
    source = "role";
  } else if (role === "compactor") {
    text = "Compacting the handoff";
    source = "role";
  } else if (worker && state.taskId === task && task && state.title) {
    text = `${state.phase === "verification" ? "Verifying" : "Working on"} ${task} · ${state.title}`;
    source = "selected_task";
  } else if (task) {
    text = `Working on ${task}${record.iteration != null ? ` · Iteration ${record.iteration}` : ""}`;
    source = "task_id";
  } else if (record.queue?.length > 1) {
    text = `Running ${label(record.roadmap)} · roadmap ${(record.queueIndex ?? 0) + 1} of ${record.queue.length}`;
    source = "queue";
  } else {
    text = `${terminal ? "Ended" : "Running"}${record.iteration != null ? ` iteration ${record.iteration}` : ""} · ${label(record.roadmap)}`;
  }
  const activity = {
    text: monitorText(text),
    source,
    observed_at: state.activityAt ?? record.createdAt,
    session_id: run.session_id,
    task_id: task,
    batch_id: run.batch_id,
    source_revision: run.source_revision,
  };
  const attention = (record.attentionTasks ?? [])
    .slice(0, 100)
    .map((id) => ({
      task_id: reference(id),
      source_identity: reference(record.sourceRevision) ?? "run",
      category: "input",
      reason_code: "requires_input",
      requires_attention: true,
      recovering: false,
    }));
  if (record.roadmapState === "blocked" && attention.length === 0)
    attention.push({
      task_id: null,
      source_identity: reference(state.blockIdentity) ?? "run",
      category: terminal ? "recovery_failed" : "blocker",
      reason_code: reason(state.blockReason, "blocked"),
      requires_attention: true,
      recovering: !terminal && role === "resolver",
    });
  if (
    terminal &&
    ["deferred", "needs_attention"].includes(run.terminal_outcome) &&
    attention.length === 0
  )
    attention.push({
      task_id: task,
      source_identity: "terminal",
      category: run.terminal_outcome === "deferred" ? "deferred" : "review",
      reason_code: run.reason_code,
      requires_attention: true,
      recovering: false,
    });
  const last = state.lastUpdate;
  const update =
    last &&
    last.task_id === task &&
    last.session_id === run.session_id &&
    last.source_revision === run.source_revision &&
    last.queue_index === record.queueIndex
      ? {
          text: last.text,
          source: "validated_task_result",
          observed_at: last.observed_at,
          session_id: last.session_id,
          task_id: last.task_id,
          source_revision: last.source_revision,
          outcome: last.outcome,
          ...(last.next_step ? { next_step: last.next_step } : {}),
        }
      : null;
  return {
    protocol_version: 1,
    kind: terminal ? "replay" : "snapshot",
    report_id: randomUUID(),
    source_run_id: record.id,
    report_sequence: ++state.sequence,
    observed_at: now,
    runner_version: version,
    process: {
      pid: record.pid ?? null,
      started_at: record.createdAt,
      state: record.processState,
      platform: process.platform,
      incarnation_id: state.incarnationId ?? null,
    },
    run,
    queue: record.queue
      ? {
          current_index: record.queueIndex ?? 0,
          entries: record.queue.map((item, index) => ({
            id: `q:${index}`,
            label: label(item.roadmap),
            state: item.state,
          })),
        }
      : null,
    activity: terminal ? null : activity,
    last_update: update,
    attention,
    events: [],
    history_gap: Boolean(state.historyGap),
  };
}
type State = {
  version: 1;
  connectionId: string;
  installationId?: string;
  sequence: number;
  events: any[];
  terminal?: any;
  initial?: any;
  historyGap?: boolean;
  [key: string]: any;
};
function outboxFile(config: MonitorConfig, id: string) {
  if (!/^[a-f0-9]{24}$/.test(id))
    throw new Error("Invalid monitoring run identity");
  return path.join(
    privateDir(path.join(monitorRoot(), "outbox", config.connectionId)),
    `${id}.json`,
  );
}
function load(file: string, config: MonitorConfig): State {
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (state.connectionId !== config.connectionId)
      throw new Error("Connection mismatch");
    return state;
  } catch {
    return {
      version: 1,
      connectionId: config.connectionId,
      installationId: config.installationId,
      sequence: 0,
      events: [],
      incarnationId: randomUUID(),
    };
  }
}
function persist(file: string, state: State) {
  while (
    Buffer.byteLength(JSON.stringify(state)) > MAX_BYTES &&
    state.events.length
  ) {
    state.events.shift();
    state.historyGap = true;
  }
  atomicJson(file, state);
}
export function prepareMonitor(record: RunRecord) {
  try {
    const config = monitorConfig();
    if (!config) return;
    saveMonitorConnection(config);
    const file = outboxFile(config, record.id);
    const state = load(file, config);
    state.initial ??= projectMonitor(record, state);
    persist(file, state);
  } catch {
    /* Monitoring cannot prevent launch. */
  }
}
function saveMonitorConnection(config: MonitorConfig) {
  privateDir(path.join(monitorRoot(), "connections"));
  atomicJson(
    path.join(monitorRoot(), "connections", `${config.connectionId}.json`),
    config,
  );
}
export class MonitorReporter {
  config: MonitorConfig;
  state: State;
  file: string;
  timer: any;
  pending: Promise<void> | null = null;
  closed = false;
  nextAttempt = 0;
  failures = 0;
  lastActivitySend = 0;
  transport: typeof fetch;
  diagnosed = false;
  release: (() => void) | null = null;
  constructor(
    public record: RunRecord,
    options: {
      config?: MonitorConfig;
      transport?: typeof fetch;
      timers?: boolean;
    } = {},
  ) {
    this.config = options.config ?? monitorConfig();
    if (!this.config) throw new Error("Monitoring disabled");
    this.transport = options.transport ?? fetch;
    saveMonitorConnection(this.config);
    this.file = outboxFile(this.config, record.id);
    this.release = acquirePublisher(this.file);
    if (!this.release) throw new Error("Publisher already active");
    this.state = load(this.file, this.config);
    this.state.incarnationId = randomUUID();
    this.state.activityAt = new Date().toISOString();
    if (options.timers !== false) {
      this.schedule();
      void this.send();
    }
  }
  schedule() {
    if (this.closed) return;
    this.timer = setTimeout(
      () => {
        void this.send();
        this.schedule();
      },
      60000 * (0.9 + Math.random() * 0.2),
    );
    this.timer.unref?.();
  }
  event(event: any) {
    try {
      const binding = `${this.record.queueIndex}|${event.role ?? this.record.role}|${event.sessionId ?? this.state.sessionId}|${event.task ?? this.record.task}|${event.sourceRevision ?? this.record.sourceRevision}`;
      if (
        event.type === "runner.turn_starting" ||
        (this.state.binding && this.state.binding !== binding)
      ) {
        this.state.title = null;
        this.state.lastUpdate = null;
      }
      if (event.type === "runner.turn_starting") {
        this.state.sessionId = reference(event.sessionId);
        this.state.taskId = reference(event.task);
        this.state.title =
          event.role === "worker" && event.activityTitle
            ? monitorText(event.activityTitle)
            : null;
        this.state.phase = event.activityPhase;
        this.state.activityAt = event.at;
      }
      this.state.binding = binding;
      const activityBinding = JSON.stringify([
        this.record.queueIndex,
        this.record.role,
        this.state.sessionId,
        this.record.task,
        this.record.waitReason,
        this.state.title,
      ]);
      if (this.state.activityBinding !== activityBinding) {
        this.state.activityAt = event.at;
        this.state.activityBinding = activityBinding;
      }
      if (event.type === "runner.blocked") {
        this.state.blockIdentity =
          reference(event.sourceRevision) ?? reference(event.id);
        this.state.blockReason = reason(event.reasonCode, "blocked");
      }
      if (event.type === "runner.task_result" && event.operation) {
        this.state.lastUpdate = {
          text: monitorText(event.operation),
          observed_at: event.resultObservedAt ?? event.at,
          session_id: reference(event.sessionId),
          task_id: reference(event.task),
          source_revision: reference(event.sourceRevision),
          queue_index: this.record.queueIndex,
          outcome: reference(event.outcome) ?? "unknown",
          ...(event.nextRecordedStep
            ? { next_step: monitorText(event.nextRecordedStep) }
            : {}),
        };
      }
      if (event.type === "runner.progress_updated")
        this.state.lastProgressAt = event.at;
      if (meaningful.has(event.type)) {
        const safe = {
          id: reference(event.id),
          sequence: event.sequence,
          type: event.type,
          observed_at: event.at,
          session_id: reference(event.sessionId),
          task_id: reference(event.task),
          batch_id: reference(event.batch),
          source_revision: reference(event.sourceRevision),
          reason_code: reason(event.reasonCode),
          ...(event.type === "runner.task_result" && event.operation
            ? {
                text: monitorText(event.operation),
                outcome: reference(event.outcome) ?? "unknown",
              }
            : {}),
        };
        this.state.events.push(safe);
        this.state.initial ??= projectMonitor(this.record, this.state);
        persist(this.file, this.state);
        const routine =
          event.type === "runner.task_result" ||
          event.type === "runner.progress_updated";
        if (!routine || Date.now() - this.lastActivitySend >= 16000) {
          this.lastActivitySend = Date.now();
          void this.send();
        }
      }
    } catch {
      /* No event can break roadmap work. */
    }
  }
  changed() {
    this.state.title = null;
    this.state.lastUpdate = null;
    this.state.sessionId = null;
    this.state.taskId = null;
    this.state.activityAt = new Date().toISOString();
    void this.send();
  }
  async send() {
    if (this.pending || Date.now() < this.nextAttempt) return this.pending;
    this.pending = this.deliver()
      .catch(() => {})
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
  async request(report: any) {
    const body = JSON.stringify(report);
    if (Buffer.byteLength(body) > 65536)
      throw Object.assign(new Error("payload_limit"), { status: 400 });
    const response = await this.transport(this.config.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(4000),
      redirect: "error",
    });
    if (!response.ok)
      throw Object.assign(new Error("delivery_failed"), {
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
      });
    const accepted = await response.json();
    if (
      this.config.installationId &&
      accepted.installation_id !== this.config.installationId
    )
      throw Object.assign(new Error("installation_mismatch"), { status: 401 });
    return accepted;
  }
  async verify() {
    if (this.config.verified) return;
    const result = await probe(this.config, this.transport);
    if (
      this.state.installationId &&
      this.state.installationId !== result.installation_id
    )
      throw Object.assign(new Error("installation_mismatch"), { status: 401 });
    this.config = {
      ...this.config,
      verified: true,
      installationId: result.installation_id,
    };
    this.state.installationId = result.installation_id;
    saveMonitorConnection(this.config);
    const active = monitorConfig();
    if (active?.connectionId === this.config.connectionId)
      saveMonitorConfig(this.config);
  }
  async deliver() {
    try {
      await this.verify();
      // Generate a current observation immediately before sending. No live heartbeat backlog.
      const report = this.closed
        ? this.state.terminal
        : projectMonitor(this.record, this.state);
      if (!report) return;
      this.state.replayBase = report;
      persist(this.file, this.state);
      await this.request(report);
      delete this.state.initial;
      if (this.state.events.length) {
        const replay = {
          ...report,
          kind: "replay",
          report_id: randomUUID(),
          events: [],
        };
        for (const event of this.state.events.slice(0, 32)) {
          const candidate = [...replay.events, event];
          if (
            Buffer.byteLength(
              JSON.stringify({ ...replay, events: candidate }),
            ) > 65536
          )
            break;
          replay.events = candidate;
        }
        if (replay.events.length) {
          await this.request(replay);
          const delivered = new Set(replay.events.map((e) => e.id));
          this.state.events = this.state.events.filter(
            (e) => !delivered.has(e.id),
          );
        }
      }
      if (
        report.run.terminal &&
        this.state.terminal?.report_sequence === report.report_sequence &&
        this.state.events.length === 0
      ) {
        delete this.state.terminal;
        delete this.state.replayBase;
      }
      this.failures = 0;
      this.nextAttempt = 0;
      persist(this.file, this.state);
      this.diagnostic("accepted");
    } catch (error) {
      this.failures++;
      let retry =
        error.status === 401 || error.status === 403 || error.status === 400
          ? 900000
          : Math.min(300000, 5000 * 2 ** Math.min(this.failures, 6)) *
            (0.8 + Math.random() * 0.4);
      if (error.retryAfter) {
        const seconds = Number(error.retryAfter);
        const requested = Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(error.retryAfter) - Date.now();
        if (Number.isFinite(requested))
          retry = Math.max(retry, Math.min(requested, 3600000));
      }
      this.nextAttempt = Date.now() + retry;
      this.diagnostic(
        error.status === 401 || error.status === 403
          ? "credential_rejected"
          : error.status === 400
            ? "protocol_rejected"
            : "unreachable",
      );
      persist(this.file, this.state);
    }
  }
  diagnostic(result: string) {
    try {
      atomicJson(path.join(monitorRoot(), "delivery.json"), {
        at: new Date().toISOString(),
        result,
      });
    } catch {}
    if (result !== "accepted" && !this.diagnosed) {
      this.diagnosed = true;
      console.error(
        `Roadmap monitoring: ${result}; execution continues. Use monitor status for diagnostics.`,
      );
    }
  }
  async finish() {
    this.closed = true;
    clearTimeout(this.timer);
    this.state.terminal = projectMonitor(this.record, this.state, true);
    persist(this.file, this.state);
    await Promise.race([
      (async () => {
        await this.pending;
        this.nextAttempt = 0;
        await this.send();
      })(),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 4500);
        timer.unref?.();
      }),
    ]);
    if (this.pending)
      void this.pending.finally(() => {
        this.release?.();
        this.release = null;
      });
    else {
      this.release?.();
      this.release = null;
    }
  }
}
export function attachMonitor(record: RunRecord) {
  try {
    if (!monitorConfig()) return null;
    return new MonitorReporter(record);
  } catch {
    return null;
  }
}
export async function failedMonitorLaunch(record: RunRecord) {
  try {
    const reporter = attachMonitor({
      ...record,
      reason: "launch_failed",
      exitCode: 1,
      endedAt: new Date().toISOString(),
      processState: "exited",
    });
    await reporter?.finish();
  } catch {}
}
export async function flushMonitor(maxStreams = 32) {
  const config = monitorConfig();
  if (!config) return { enabled: false, attempted: 0 };
  if (maxStreams === 1 && !config.verified)
    return { enabled: true, attempted: 0 };
  const dir = path.join(monitorRoot(), "outbox", config.connectionId);
  let attempted = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { enabled: true, attempted };
  }
  for (const name of names.filter((n) => /^[a-f0-9]{24}\.json$/.test(n))) {
    if (attempted >= maxStreams) break;
    const state = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    if (!state.terminal && !state.events.length) continue;
    const report = state.terminal ?? state.replayBase ?? state.initial;
    if (!report) continue;
    // Historical flush uses the stored envelope only. It never claims exited publishers are live.
    const transport = await import("./monitor-replay.js");
    await transport.flushStored(config, path.join(dir, name), state);
    attempted++;
  }
  return { enabled: true, attempted };
}
