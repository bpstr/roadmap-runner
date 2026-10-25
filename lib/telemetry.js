import { createHash } from 'node:crypto';
import { validProviderThreadId } from './continuation.js';

function checkpointMetrics(checkpoint) {
  if (!checkpoint) return null;
  const { requested, requestId, at, deadlineMs, saved, acknowledged, acknowledgedAt } = checkpoint;
  const acknowledgment = checkpoint.acknowledgment ? {
    requestId: checkpoint.acknowledgment.requestId, resultFile: checkpoint.acknowledgment.resultFile,
  } : undefined;
  return { requested, requestId, at, deadlineMs, saved, acknowledged, acknowledgedAt, acknowledgment,
    ...(checkpoint.error ? { error: String(checkpoint.error).slice(0, 512) } : {}),
    ...(checkpoint.acknowledgmentError ? { acknowledgmentError: String(checkpoint.acknowledgmentError).slice(0, 512) } : {}) };
}

// Provider receipts only: absent usage is unknown, never inferred from file size.
export function sessionMetrics(result, { client, effort, startedAt, elapsedMs, before, after }) {
  return {
    client, model: result.model ?? null, modelSource: result.modelSource ?? null,
    configuredEffort: effort || null, startedAt, elapsedMs,
    usage: result.usage ?? null, usageReports: result.usageReports ?? 0,
    usageComplete: result.usageComplete ?? false,
    timing: result.timing ?? null,
    checkpoint: checkpointMetrics(result.checkpoint),
    providerThreadId: result.providerThreadId ?? null,
    cleanupIncomplete: result.cleanupIncomplete ?? false,
    contextBytes: { before, after },
  };
}

// Observed wall time, not inferred model activity. Silent intervals can be
// inference, networking or inactivity; they are explicitly unattributed.
export function activityTracker(now = () => performance.now(), { workdir = '' } = {}) {
  const started = now(); let last = started; let lastOutput = started;
  let firstOutputMs = null; let longestSilenceMs = 0; let stopping = false;
  let firstCommandMs = null; let firstEditMs = null; let fingerprintsTruncated = false;
  const active = new Map(); const counts = {};
  const commands = new Map(); const reads = new Map();
  const fingerprinted = new Set();
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
  };
  const fingerprint = item => {
    const key = typeof item.id === 'string' ? `${item.type}:${item.id}` : null;
    if (!key || fingerprinted.has(key)) return;
    let collection; let request;
    if (item.type === 'command_execution' && typeof item.command === 'string' && item.command.length <= 65536) {
      collection = commands; request = [workdir, item.command];
    } else if (item.type === 'mcp_tool_call' && ['read_file', 'read_text_file', 'read_file_lines'].includes(item.tool) &&
        item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments)) {
      collection = reads; request = [workdir, item.server || '', item.tool, canonical(item.arguments)];
    } else return;
    const serialized = JSON.stringify(request);
    if (serialized.length > 65536 || fingerprinted.size >= 4096) { fingerprintsTruncated = true; return; }
    fingerprinted.add(key);
    const sha256 = createHash('sha256').update(serialized).digest('hex');
    if (!collection.has(sha256) && collection.size >= 256) { fingerprintsTruncated = true; return; }
    collection.set(sha256, (collection.get(sha256) || 0) + 1);
  };
  const buckets = { commandMs: 0, toolMs: 0, editMs: 0, shutdownMs: 0, unattributedMs: 0 };
  const advance = () => {
    const time = now();
    const kind = stopping ? 'shutdown' : ['command', 'tool', 'edit'].find(k => [...active.values()].includes(k));
    buckets[(kind || 'unattributed') + 'Ms'] += time - last; last = time;
    return time;
  };
  return {
    output() {
      const time = now(); firstOutputMs ??= time - started;
      longestSilenceMs = Math.max(longestSilenceMs, time - lastOutput); lastOutput = time;
    },
    observe(event) {
      const time = advance();
      const item = event.item;
      if (!item) return;
      const kind = { command_execution: 'command', mcp_tool_call: 'tool', file_change: 'edit' }[item.type];
      if (['item.started', 'item.completed'].includes(event.type)) {
        if (kind === 'command') firstCommandMs ??= time - started;
        // A completed file-change event is observed evidence of an edit; output
        // and reasoning alone must not become time-to-first-edit measurements.
        if (kind === 'edit' && event.type === 'item.completed' && item.status !== 'failed') firstEditMs ??= time - started;
        fingerprint(item);
      }
      if (event.type === 'item.started' && kind) { active.set(item.id, kind); counts[kind] = (counts[kind] || 0) + 1; }
      if (event.type === 'item.completed') {
        if (kind && !active.has(item.id)) counts[kind] = (counts[kind] || 0) + 1;
        active.delete(item.id);
        if (['reasoning', 'agent_message'].includes(item.type)) counts[item.type] = (counts[item.type] || 0) + 1;
      }
    },
    shutdown() { advance(); stopping = true; },
    result() {
      const time = advance();
      return { ...Object.fromEntries(Object.entries(buckets).map(([k,v]) => [k, Math.round(v)])),
        elapsedMs: Math.round(time - started), firstOutputMs: firstOutputMs === null ? null : Math.round(firstOutputMs),
        firstCommandMs: firstCommandMs === null ? null : Math.round(firstCommandMs),
        firstEditMs: firstEditMs === null ? null : Math.round(firstEditMs),
        longestSilenceMs: Math.round(Math.max(longestSilenceMs, time - lastOutput)), counts,
        repeatedCommands: [...commands.values()].reduce((sum, count) => sum + count - 1, 0),
        repeatedReads: [...reads.values()].reduce((sum, count) => sum + count - 1, 0),
        fingerprintsTruncated,
        repetitionAttribution: 'same observed request; not proof of unchanged inputs or redundant work',
        pendingKinds: [...new Set(active.values())], attribution: 'observed-client-events; silence-is-not-proof-of-inactivity' };
    },
    // Full fingerprint lists belong in a detail receipt, never in bounded
    // session events, history metadata or the recent-runs context summary.
    evidence() {
      return { version: 1, commandFingerprints: [...commands].map(([sha256, count]) => ({ sha256, count })),
        readFingerprints: [...reads].map(([sha256, count]) => ({ sha256, count })), fingerprintsTruncated,
        attribution: 'same observed request; not proof of unchanged inputs or redundant work' };
    },
  };
}

// Kept separate from usage receipts: no identity is invented when a client does
// not emit a supported provider event. Only Codex currently supports resumption.
export function providerIdentityTracker() {
  let providerThreadId = null;
  return {
    observe(event, format) {
      if (format === 'codex-json' && event.type === 'thread.started' && validProviderThreadId(event.thread_id)) providerThreadId = event.thread_id;
    },
    result() { return { providerThreadId }; },
  };
}

export function usageTracker(configuredModel = "") {
  let model = configuredModel || null;
  let modelSource = model ? "configured" : null;
  let usage = null;
  let usageReports = 0;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    observe(event, format) {
      if (["thread.started", "turn.started", "system"].includes(event.type) &&
          typeof event.model === "string" && event.model.length <= 200) {
        model = event.model; modelSource = "client";
      }
      const codex = format === "codex-json" && event.type === "turn.completed";
      const claude = format === "claude-json" && event.type === "result";
      if ((!codex && !claude) || !event.usage) return;
      const raw = event.usage;
      const receipt = {
        inputTokens: count(raw.input_tokens),
        cachedInputTokens: count(codex ? raw.cached_input_tokens : raw.cache_read_input_tokens),
        outputTokens: count(raw.output_tokens),
        reasoningOutputTokens: count(raw.reasoning_output_tokens),
        cacheCreationInputTokens: count(raw.cache_creation_input_tokens),
      };
      if (receipt.inputTokens === null || receipt.outputTokens === null) return;
      // Claude's result already aggregates its session. Codex receipts are per turn.
      usage = !usage || claude ? receipt : Object.fromEntries(Object.keys(receipt).map(key =>
        [key, usage[key] === null || receipt[key] === null ? null : usage[key] + receipt[key]]));
      usageReports = claude ? 1 : usageReports + 1;
    },
    result(complete = false) {
      return { model, modelSource, usage, usageReports, usageComplete: Boolean(usage && complete) };
    },
  };
}
