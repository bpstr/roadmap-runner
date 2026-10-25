import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLifecycle } from '../dist/lifecycle.js';
import { parseArgs } from '../lib/runner.js';
import { TaskMemory } from '../lib/task-memory.js';
import { trackingPaths } from '../lib/tracking.js';

function fixture(t) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-optional-memory-'));
  t.after(() => fs.rmSync(workdir, { recursive: true, force: true }));
  const roadmap = path.join(workdir, 'roadmap.md');
  const progressFile = path.join(workdir, 'progress.md');
  fs.writeFileSync(roadmap, '# Prepared roadmap\n\n### Task API-01.1\n- [ ] API-01.1 Deliver the fixture\nDependencies: none\nAcceptance: prepared source change.\n');
  fs.writeFileSync(progressFile, 'Status: IN_PROGRESS\n\n## Current handoff\nPreserve this legacy handoff until the prepared work completes.\n');
  const executable = path.join(workdir, 'prepared-client.cjs');
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const prompt = process.argv.at(-1);
fs.writeFileSync('invocation.json', JSON.stringify({ prompt, args: process.argv.slice(2, -1) }));
if (!prompt.includes('Runner role: WORKER') || /^Result binding:/m.test(prompt)) process.exit(97);
fs.writeFileSync('source.ts', 'export const prepared = true;\\n');
fs.writeFileSync('roadmap.md', fs.readFileSync('roadmap.md', 'utf8').replace('- [ ] API-01.1', '- [x] API-01.1'));
fs.writeFileSync('progress.md', 'Status: COMPLETE\\n\\n## Current handoff\\nPrepared legacy work completed.\\n');
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 32, output_tokens: 8 } }));
`, { mode: 0o755 });
  const options = { ...parseArgs([], {}), roadmap, progressFile, executable, client: 'codex', notify: 'off', timeout: '5s' };
  return { workdir, options };
}

async function assertLegacyCompletion(t, f) {
  const warnings = []; const events = [];
  t.mock.method(console, 'warn', (...values) => warnings.push(values.join(' ')));
  const result = await runLifecycle(f.options, { workdir: f.workdir, onEvent: event => events.push(event) });
  assert.equal(result.code, 0); assert.equal(result.reason, 'complete');
  const invocation = JSON.parse(fs.readFileSync(path.join(f.workdir, 'invocation.json'), 'utf8'));
  assert.equal(/^Result binding:/m.test(invocation.prompt), false);
  assert.equal(/^Optional structured result file:/m.test(invocation.prompt), false);
  assert.equal(events.filter(event => event.type === 'runner.turn_starting').length, 1);
  assert.equal(events.some(event => event.role === 'resolver' || event.type === 'runner.blocked'), false);
  assert.equal(events.some(event => event.type === 'runner.task_result'), false);
  assert.ok(warnings.some(message => /unavailable|disabled/i.test(message) && /handoff/i.test(message)), 'optional memory failure must warn and retain the legacy handoff');
  assert.equal(fs.readFileSync(path.join(f.workdir, 'source.ts'), 'utf8'), 'export const prepared = true;\n');
}

test('unavailable optional task-memory initialization preserves legacy execution', async t => {
  const f = fixture(t);
  const findings = path.join(f.workdir, '.roadmap-runner', 'findings');
  fs.mkdirSync(path.dirname(findings), { recursive: true });
  fs.writeFileSync(findings, 'Prepared obstruction: optional findings storage is unavailable.\n');
  await assertLegacyCompletion(t, f);
  assert.equal(fs.statSync(findings).isFile(), true, 'fallback must preserve the obstructing user file');
});

test('optional task-packet write failure after initialization preserves legacy execution', async t => {
  const f = fixture(t);
  const prepare = TaskMemory.prototype.prepare;
  let initialized = false;
  t.mock.method(TaskMemory.prototype, 'prepare', function (request) {
    initialized = fs.statSync(this.directory).isDirectory() && fs.statSync(this.sharedDirectory).isDirectory();
    // Obstruct only this optional packet's destination. The real atomic rename
    // fails while the legacy handoff and other runner evidence remain writable.
    fs.mkdirSync(path.join(this.tracking.evidenceDir, `task-packet-${request.sessionId}.json`));
    return prepare.call(this, request);
  });
  await assertLegacyCompletion(t, f);
  assert.equal(initialized, true);
});

test('optional conversation state write failure switches subsequent task work to fresh sessions', async t => {
  const f = fixture(t); const warnings = []; const events = [];
  t.mock.method(console, 'warn', (...values) => warnings.push(values.join(' ')));
  f.options.sessionContinuation = true;
  const locations = trackingPaths(f.options.roadmap, f.options.progressFile, f.workdir);
  const state = path.join(locations.stateDir, 'continuation.json');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(f.options.executable, `#!/usr/bin/env node
const fs = require('node:fs');
const prompt = process.argv.at(-1);
if (!prompt.includes('Runner role: WORKER')) process.exit(97);
const binding = JSON.parse(prompt.match(/^Result binding: (.+)$/m)[1]);
const resultFile = JSON.parse(prompt.match(/^Optional structured result file: (.+)$/m)[1]);
const calls = fs.existsSync('calls.json') ? JSON.parse(fs.readFileSync('calls.json', 'utf8')) : [];
calls.push({ args: process.argv.slice(2, -1), binding });
fs.writeFileSync('calls.json', JSON.stringify(calls));
if (calls.length > 2) process.exit(98);
const partial = calls.length === 1;
console.log(JSON.stringify({ type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' }));
fs.writeFileSync('source.ts', 'export const prepared = ' + calls.length + ';\\n');
fs.writeFileSync(resultFile, JSON.stringify({ ...binding, operation: 'prepared-edit', outcome: partial ? 'partial' : 'verified',
  completed: ['Prepared source step'], remaining: partial ? ['Finish prepared step'] : [], nextAction: partial ? 'Finish the source step.' : 'Acceptance is complete.',
  changedFiles: ['source.ts'], receiptIds: [], findings: [] }));
if (!partial) fs.writeFileSync('roadmap.md', fs.readFileSync('roadmap.md', 'utf8').replace('- [ ] API-01.1', '- [x] API-01.1'));
fs.writeFileSync('progress.md', 'Status: ' + (partial ? 'IN_PROGRESS' : 'COMPLETE') + '\\n\\n## Current handoff\\nPrepared source step preserved.\\n');
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 32, output_tokens: 8 } }));
`, { mode: 0o755 });
  const result = await runLifecycle(f.options, { workdir: f.workdir, onEvent: event => events.push(event) });
  assert.equal(result.code, 0); assert.equal(result.reason, 'complete');
  const calls = JSON.parse(fs.readFileSync(path.join(f.workdir, 'calls.json'), 'utf8'));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.includes('--ephemeral'), false);
  assert.equal(calls[1].args.includes('--ephemeral'), true);
  assert.equal(calls.some(call => call.args.includes('resume')), false);
  assert.deepEqual(calls.map(call => call.binding.taskId), ['API-01.1', 'API-01.1']);
  assert.equal(events.some(event => event.role === 'resolver' || event.type === 'runner.blocked'), false);
  assert.equal(warnings.filter(message => /conversation state unavailable/i.test(message)).length, 1);
  assert.equal(fs.statSync(state).isDirectory(), true, 'optional state failure must preserve the obstructing directory');
});
