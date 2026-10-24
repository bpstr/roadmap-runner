// Provider receipts only: absent usage is unknown, never inferred from file size.
export function sessionMetrics(result, { client, effort, startedAt, elapsedMs, before, after }) {
  return {
    client, model: result.model ?? null, modelSource: result.modelSource ?? null,
    configuredEffort: effort || null, startedAt, elapsedMs,
    usage: result.usage ?? null, usageReports: result.usageReports ?? 0,
    usageComplete: result.usageComplete ?? false,
    timing: result.timing ?? null,
    checkpoint: result.checkpoint ?? null,
    cleanupIncomplete: result.cleanupIncomplete ?? false,
    contextBytes: { before, after },
  };
}

// Observed wall time, not inferred model activity. Silent intervals can be
// inference, networking or inactivity; they are explicitly unattributed.
export function activityTracker(now = () => performance.now()) {
  const started = now(); let last = started; let lastOutput = started;
  let firstOutputMs = null; let longestSilenceMs = 0; let stopping = false;
  const active = new Map(); const counts = {};
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
      advance();
      const item = event.item;
      if (!item) return;
      const kind = { command_execution: 'command', mcp_tool_call: 'tool', file_change: 'edit' }[item.type];
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
        longestSilenceMs: Math.round(Math.max(longestSilenceMs, time - lastOutput)), counts,
        pendingKinds: [...new Set(active.values())], attribution: 'observed-client-events; silence-is-not-proof-of-inactivity' };
    },
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
