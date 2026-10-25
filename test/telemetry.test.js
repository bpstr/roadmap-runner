import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { usageTracker, activityTracker, sessionMetrics } from "../lib/telemetry.js";
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

test('activity separates first output, command and edit and fingerprints repeated observed requests', () => {
  let time = 0;
  const tracker = activityTracker(() => time, { workdir: '/workspace' });
  time = 8; tracker.output();
  time = 16;
  const first = { id: 'command-1', type: 'command_execution', command: 'rg needle src' };
  tracker.observe({ type: 'item.started', item: first });
  time = 32; tracker.observe({ type: 'item.completed', item: first });
  tracker.observe({ type: 'item.completed', item: { ...first, id: 'command-2' } });
  const read = { type: 'mcp_tool_call', server: 'files', tool: 'read_file', arguments: { path: 'a.ts', start: 1 } };
  tracker.observe({ type: 'item.completed', item: { ...read, id: 'read-1' } });
  tracker.observe({ type: 'item.completed', item: { ...read, id: 'read-2', arguments: { start: 1, path: 'a.ts' } } });
  time = 64;
  tracker.observe({ type: 'item.completed', item: { id: 'edit-failed', type: 'file_change', status: 'failed' } });
  assert.equal(tracker.result().firstEditMs, null);
  time = 128; tracker.observe({ type: 'item.completed', item: { id: 'edit-1', type: 'file_change', status: 'completed' } });
  const result = tracker.result();
  assert.equal(result.firstOutputMs, 8);
  assert.equal(result.firstCommandMs, 16);
  assert.equal(result.firstEditMs, 128);
  assert.equal(result.repeatedCommands, 1);
  assert.equal(result.repeatedReads, 1);
  assert.equal(tracker.evidence().commandFingerprints[0].count, 2, 'started/completed events count one command');
  assert.equal(JSON.stringify(tracker.evidence()).includes('needle'), false, 'fingerprints do not store command text');
  assert.match(result.repetitionAttribution, /not proof/);
});

test('unsupported output never becomes first-command or first-edit evidence and fingerprints remain bounded', () => {
  const tracker = activityTracker(() => 0);
  tracker.output();
  tracker.observe({ type: 'assistant', message: { content: 'I changed a file.' } });
  assert.equal(tracker.result().firstCommandMs, null);
  assert.equal(tracker.result().firstEditMs, null);
  for (let i = 0; i < 512; i++) tracker.observe({ type: 'item.completed', item: {
    id: `c-${i}`, type: 'command_execution', command: `command-${i}`,
  } });
  assert.equal(tracker.evidence().commandFingerprints.length, 256);
  assert.equal(tracker.result().fingerprintsTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(tracker.result())) < 1024, 'event/summary timing stays bounded independently of fingerprint count');
});

test('session checkpoint metrics retain acknowledgment proof pointers without copying large worker state', () => {
  const checkpoint = { requested: true, requestId: 'request-1', acknowledged: true,
    acknowledgment: { requestId: 'request-1', resultFile: '/workspace/result.json',
      editedPaths: Array.from({ length: 512 }, (_, i) => `src/file-${i}.ts`), nextAction: 'detail'.repeat(8192) } };
  const metrics = sessionMetrics({ checkpoint }, { client: 'codex', effort: '', startedAt: 'prepared', elapsedMs: 1, before: {}, after: {} });
  assert.deepEqual(metrics.checkpoint.acknowledgment, { requestId: 'request-1', resultFile: '/workspace/result.json' });
  assert.equal(metrics.checkpoint.acknowledged, true);
  assert.ok(Buffer.byteLength(JSON.stringify(metrics)) < 1024);
  assert.equal(checkpoint.acknowledgment.editedPaths.length, 512, 'full raw acknowledgment remains available to detail receipts');
});
