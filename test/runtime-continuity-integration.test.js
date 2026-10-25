import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLifecycle } from '../dist/lifecycle.js';
import { parseArgs, runClient } from '../lib/runner.js';

const firstThread = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const secondThread = '0199a213-81c0-7800-8aa1-bbab2a035a54';

function fixture(t, { mode = 'continuation', malformed = false, missingResume = false } = {}) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-continuity-integration-'));
  t.after(() => fs.rmSync(workdir, { recursive: true, force: true }));
  const roadmap = path.join(workdir, 'roadmap.md');
  const progress = path.join(workdir, 'progress.md');
  const count = mode === 'continuation' ? 2 : 1;
  fs.writeFileSync(roadmap, '# Prepared roadmap\n\n' + Array.from({ length: count }, (_, index) =>
    `### Task API-01.${index + 1}\n- [ ] API-01.${index + 1} Deliver fixture ${index + 1}\nDependencies: none\nAcceptance: prepared criterion ${index + 1}.\n`).join('\n'));
  fs.writeFileSync(progress, 'Status: IN_PROGRESS\n\n## Current handoff\nStart the prepared task.\n');
  fs.writeFileSync(path.join(workdir, 'source.ts'), 'export const value = 0;\n');
  const client = path.join(workdir, 'prepared-client.cjs');
  fs.writeFileSync(client, `#!/usr/bin/env node
const fs = require('node:fs');
const mode = ${JSON.stringify(mode)}, malformed = ${JSON.stringify(malformed)}, missingResume = ${JSON.stringify(missingResume)};
const prompt = process.argv.at(-1);
if (!prompt.includes('Runner role: WORKER')) process.exit(97);
const binding = JSON.parse(prompt.match(/^Result binding: (.+)$/m)[1]);
const resultFile = JSON.parse(prompt.match(/^Optional structured result file: (.+)$/m)[1]);
const invocations = fs.existsSync('invocations.json') ? JSON.parse(fs.readFileSync('invocations.json', 'utf8')) : [];
invocations.push({ args: process.argv.slice(2, -1), binding });
fs.writeFileSync('invocations.json', JSON.stringify(invocations));
const n = invocations.length;
if (n > 4) process.exit(98);
const thread = binding.taskId === 'API-01.1' ? ${JSON.stringify(firstThread)} : ${JSON.stringify(secondThread)};
if (missingResume && n === 2 && process.argv.includes('resume')) {
  console.error('Error: no rollout found for thread id ' + thread);
  process.exit(1);
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: thread }));
const finish = () => {
  const partial = mode === 'continuation' && n === 1;
  fs.writeFileSync('source.ts', 'export const value = ' + n + ';\\n');
  const result = { ...binding, operation: 'prepared-edit', outcome: partial ? 'partial' : 'verified',
    completed: ['Completed prepared source step'], remaining: partial ? ['Finish prepared criterion'] : [],
    nextAction: partial ? 'Finish the current source branch.' : 'Reconcile the completed acceptance.',
    changedFiles: ['source.ts'], receiptIds: [], findings: [] };
  if (malformed) delete result.operation;
  fs.writeFileSync(resultFile, JSON.stringify(result));
  if (!partial) fs.writeFileSync('roadmap.md', fs.readFileSync('roadmap.md', 'utf8').replace('- [ ] ' + binding.taskId, '- [x] ' + binding.taskId));
  const complete = !fs.readFileSync('roadmap.md', 'utf8').includes('- [ ]');
  fs.writeFileSync('progress.md', 'Status: ' + (complete ? 'COMPLETE' : 'IN_PROGRESS') + '\\n\\n## Current handoff\\nPrepared next action preserved.\\n');
  if (mode === 'checkpoint') {
    const ackFile = JSON.parse(prompt.match(/^Checkpoint acknowledgment file: (.+)$/m)[1]);
    fs.writeFileSync(ackFile, JSON.stringify({ version: 1, requestId: binding.sessionId, resultFile }));
  }
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 128, cached_input_tokens: 64, output_tokens: 32 } }));
};
if (mode === 'checkpoint') {
  const requestFile = JSON.parse(prompt.match(/^Checkpoint request file: (.+)$/m)[1]);
  const timer = setInterval(() => { if (fs.existsSync(requestFile)) { clearInterval(timer); finish(); } }, 16);
} else finish();
`, { mode: 0o755 });
  const options = { ...parseArgs([], {}), roadmap, progressFile: progress, executable: client,
    client: 'codex', notify: 'off', timeout: mode === 'checkpoint' ? '2s' : '5s', sessionContinuation: mode === 'continuation' };
  return { workdir, roadmap, progress, client, options, invocations: () => JSON.parse(fs.readFileSync(path.join(workdir, 'invocations.json'), 'utf8')) };
}

test('lifecycle resumes productive same-task work by provider ID and starts fresh at the next task', async t => {
  const f = fixture(t); const events = [];
  const result = await runLifecycle(f.options, { workdir: f.workdir, onEvent: event => events.push(event) });
  assert.equal(result.code, 0); assert.equal(result.reason, 'complete');
  const calls = f.invocations();
  assert.deepEqual(calls.map(call => call.binding.taskId), ['API-01.1', 'API-01.1', 'API-01.2']);
  assert.equal(calls[0].args.includes('resume'), false);
  assert.equal(calls[0].args.includes('--ephemeral'), false, 'first opt-in session must persist for later reuse');
  const resumeIndex = calls[1].args.indexOf('resume');
  assert.ok(resumeIndex > 0);
  assert.equal(calls[1].args[resumeIndex + 1], firstThread);
  assert.equal(calls[1].args.includes('--last'), false);
  assert.equal(calls[2].args.includes('resume'), false, 'task change must not inherit the preceding conversation');
  assert.deepEqual(events.filter(event => event.type === 'runner.turn_starting').map(event => event.continuation.resumed), [false, true, false]);
  assert.equal(events.some(event => event.role === 'resolver'), false);
});

test('a missing provider continuation falls back once to fresh execution of the same task', async t => {
  const f = fixture(t, { missingResume: true }); const events = [];
  const result = await runLifecycle(f.options, { workdir: f.workdir, onEvent: event => events.push(event) });
  assert.equal(result.code, 0); assert.equal(result.reason, 'complete');
  const calls = f.invocations();
  assert.deepEqual(calls.map(call => call.binding.taskId), ['API-01.1', 'API-01.1', 'API-01.1', 'API-01.2']);
  assert.deepEqual(calls.map(call => call.args.includes('resume')), [false, true, false, false]);
  assert.deepEqual(calls[1].binding, calls[2].binding, 'fresh transport retry retains the same structured-result binding');
  const fallbacks = events.filter(event => event.type === 'runner.continuation_fallback');
  assert.equal(fallbacks.length, 1);
  const failedAttempt = JSON.parse(fs.readFileSync(fallbacks[0].evidence, 'utf8'));
  assert.equal(failedAttempt.code, 1);
  assert.equal(failedAttempt.requestedThreadId, firstThread);
  assert.equal(failedAttempt.sessionId, calls[1].binding.sessionId);
  assert.equal(events.some(event => event.role === 'resolver' || event.type === 'runner.blocked'), false);
});

for (const malformed of [false, true]) test(`lifecycle checkpoint ${malformed ? 'rejects malformed result despite current IDs' : 'emits acknowledgment for a fresh bound worker result'}`, async t => {
  const f = fixture(t, { mode: 'checkpoint', malformed }); const events = [];
  const result = await runLifecycle(f.options, { workdir: f.workdir, onEvent: event => events.push(event) });
  assert.equal(result.code, 0); assert.equal(result.reason, 'complete');
  assert.equal(events.filter(event => event.type === 'runner.checkpoint_requested').length, 1);
  const acknowledgments = events.filter(event => event.type === 'runner.checkpoint_acknowledged');
  assert.equal(acknowledgments.length, malformed ? 0 : 1);
  const receipt = events.find(event => event.type === 'runner.turn_finished');
  assert.equal(receipt.checkpoint.acknowledged, !malformed);
  if (!malformed) assert.equal(receipt.checkpoint.acknowledgment.requestId, receipt.sessionId);
  else assert.equal(events.some(event => event.type === 'runner.task_result_invalid'), true);
});

test('resume-unavailable is limited to a missing explicit thread before any provider work', async t => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-resume-unavailable-'));
  t.after(() => fs.rmSync(workdir, { recursive: true, force: true }));
  for (const started of [false, true]) {
    const client = path.join(workdir, `client-${started}.cjs`);
    fs.writeFileSync(client, `#!/usr/bin/env node
${started ? `console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(firstThread)}}));` : ''}
console.error('Error: no rollout found for thread id ${firstThread}');
process.exitCode = 1;
`, { mode: 0o755 });
    const result = await runClient({ client: 'codex', executable: client, workdir, prompt: 'prepared resume failure',
      timeoutMs: 2000, persistSession: true, resumeSessionId: firstThread });
    assert.equal(result.code, 1);
    assert.equal(result.resumeUnavailable, !started);
  }
});
