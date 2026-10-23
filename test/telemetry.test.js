import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { usageTracker } from "../lib/telemetry.js";
import { runClient } from "../lib/runner.js";

test("Codex usage sums completed-turn receipts and leaves missing fields unknown", () => {
  const tracker = usageTracker("configured-model");
  tracker.observe({ type: "turn.started", model: "reported-model" }, "codex-json");
  for (const input of [100, 200]) tracker.observe({ type: "turn.completed", usage: {
    input_tokens: input, cached_input_tokens: 80, output_tokens: 12,
  } }, "codex-json");
  assert.deepEqual(tracker.result(true), {
    model: "reported-model", modelSource: "client", usageReports: 2, usageComplete: true,
    usage: { inputTokens: 300, cachedInputTokens: 160, outputTokens: 24, reasoningOutputTokens: null, cacheCreationInputTokens: null },
  });
  assert.equal(tracker.result(false).usageComplete, false);
});

test("Claude uses aggregate result usage without double counting assistant receipts", () => {
  const tracker = usageTracker();
  tracker.observe({ type: "assistant", usage: { input_tokens: 999, output_tokens: 999 } }, "claude-json");
  tracker.observe({ type: "system", subtype: "init", model: "fixture-model" }, "claude-json");
  tracker.observe({ type: "result", usage: { input_tokens: 50, output_tokens: 20,
    cache_read_input_tokens: 100, cache_creation_input_tokens: 30 } }, "claude-json");
  assert.deepEqual(tracker.result(true).usage, { inputTokens: 50, outputTokens: 20,
    cachedInputTokens: 100, cacheCreationInputTokens: 30, reasoningOutputTokens: null });
  assert.equal(tracker.result().model, "fixture-model");
});

test("missing, invalid and unsupported usage cannot become zero-cost receipts", () => {
  const tracker = usageTracker();
  for (const usage of [undefined, {}, { input_tokens: -1, output_tokens: 2 }, { input_tokens: "12", output_tokens: 2 }]) {
    tracker.observe({ type: "turn.completed", usage }, "codex-json");
  }
  tracker.observe({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }, "text");
  assert.deepEqual(tracker.result(true), { model: null, modelSource: null, usage: null, usageReports: 0, usageComplete: false });
});

test("runClient retains split JSON usage on failure without claiming complete accounting", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-usage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "client.cjs");
  fs.writeFileSync(file, `#!/usr/bin/env node
process.stdout.write('{"type":"turn.completed","usage":');
setTimeout(() => { process.stdout.write('{"input_tokens":123,"cached_input_tokens":80,"output_tokens":7}}'); process.exitCode = 9; }, 10);
`, { mode: 0o755 });
  const result = await runClient({ client: "codex", executable: file, workdir: dir, prompt: "fixture", timeoutMs: 2000 });
  assert.equal(result.code, 9);
  assert.equal(result.usage.inputTokens, 123);
  assert.equal(result.usage.cachedInputTokens, 80);
  assert.equal(result.usageComplete, false);
});
