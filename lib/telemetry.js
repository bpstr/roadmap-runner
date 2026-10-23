// Provider receipts only: absent usage is unknown, never inferred from file size.
export function sessionMetrics(result, { client, effort, startedAt, elapsedMs, before, after }) {
  return {
    client, model: result.model ?? null, modelSource: result.modelSource ?? null,
    configuredEffort: effort || null, startedAt, elapsedMs,
    usage: result.usage ?? null, usageReports: result.usageReports ?? 0,
    usageComplete: result.usageComplete ?? false,
    contextBytes: { before, after },
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
