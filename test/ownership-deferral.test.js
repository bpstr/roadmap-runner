import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLifecycle } from '../dist/lifecycle.js';
import { TaskMemory } from '../lib/task-memory.js';

// Prepared executable only: no provider transport, credentials or live calls.
function preparedClient(config) {
  const fs = require('node:fs');
  const prompt = process.argv.at(-1);
  const role = prompt.match(/^Runner role: (.+)$/m)[1];
  const calls = fs.existsSync('calls.json') ? JSON.parse(fs.readFileSync('calls.json', 'utf8')) : [];
  const binding = role === 'WORKER' ? JSON.parse(prompt.match(/^Result binding: (.+)$/m)[1]) : null;
  calls.push({ role, task: binding?.taskId, resumed: process.argv.includes('resume') });
  fs.writeFileSync('calls.json', JSON.stringify(calls));
  if (calls.length > 4) throw new Error('Ownership return must not be dispatched repeatedly');
  if (role === 'RESOLVER') {
    if (!prompt.includes('worker_requested_deferral')) throw new Error('Missing explicit deferral evidence');
    fs.writeFileSync(JSON.parse(prompt.match(/^Resolution decision file: (.+)$/m)[1]), JSON.stringify({
      resolutionId: prompt.match(/^Resolution ID: (.+)$/m)[1], outcome: 'stopped',
      evidence: 'Prepared external prerequisite is unavailable.', nextAction: 'Wait for the prerequisite owner.' }));
    return;
  }
  const deferred = config.broad || binding.taskId === 'A-01';
  if (!prompt.includes(config.broad ? 'Selection scope: broad roadmap.' : 'Selection scope: controller-selected task.')) {
    throw new Error('Worker must know whether a per-task controller can rotate its scope');
  }
  if (!prompt.includes('Repeated ownership returns')) throw new Error('Missing semantic ownership-return review');
  const result = { ...binding, operation: 'prepared-owner-return', outcome: deferred ? config.outcome : 'verified',
    completed: deferred ? [] : ['Independent task delivered'], remaining: deferred ? ['External adoption'] : [],
    nextAction: deferred ? 'Retry after the external owner delivers adoption.' : '',
    changedFiles: [], receiptIds: [], findings: [], ...(deferred ? { scheduling: 'defer' } : {}) };
  fs.writeFileSync(JSON.parse(prompt.match(/^Optional structured result file: (.+)$/m)[1]), JSON.stringify(result));
  if (!deferred) fs.writeFileSync('roadmap.md', fs.readFileSync('roadmap.md', 'utf8').replace('- [ ] B-01', '- [x] B-01'));
  fs.writeFileSync('progress.md', 'Status: IN_PROGRESS\n\n## Current handoff\nExternal ownership gate unchanged.\n');
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'prepared-thread-' + calls.length }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 10 } }));
}

function fixture(t, { broad = false, outcome = 'reused' } = {}) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-ownership-return-'));
  t.after(() => fs.rmSync(workdir, { recursive: true, force: true }));
  const roadmap = path.join(workdir, 'roadmap.md'), progress = path.join(workdir, 'progress.md');
  fs.writeFileSync(roadmap, '# Prepared roadmap\n\n' + (broad ? '- [ ] Remaining adoption\n' :
    ['A-01', 'B-01'].map(id => `### Task ${id}\n- [ ] ${id} Deliver operation\nDependencies: none\nAcceptance: prepared behavior.\n`).join('\n')));
  fs.writeFileSync(progress, 'Status: IN_PROGRESS\n\n## Current handoff\nStart the prepared task.\n');
  const client = path.join(workdir, 'prepared.cjs');
  fs.writeFileSync(client, '#!/usr/bin/env node\n(' + preparedClient.toString() + ')(' + JSON.stringify({ broad, outcome }) + ');\n', { mode: 0o755 });
  const tracking = { stateDir: path.join(workdir, 'state'), evidenceDir: path.join(workdir, 'state/evidence'), file: progress };
  const memory = new TaskMemory({ workdir, tracking, roadmap });
  let sessionNumber = 0;
  const save = (scheduling, processResult = { code: 0 }, workerOutcome = outcome) => {
    const binding = { version: 1, sessionId: `prepared-session-${++sessionNumber}`, taskId: 'A-01', criteriaRevision: 'v1' };
    const prepared = memory.prepare(binding);
    fs.writeFileSync(prepared.resultFile, JSON.stringify({ ...binding, operation: 'prepared-return', outcome: workerOutcome,
      scheduling, completed: [], remaining: ['External adoption'], nextAction: 'Retry after adoption changes.',
      changedFiles: [], receiptIds: [], findings: [] }));
    return memory.consume({ ...binding, resultFile: prepared.resultFile, processResult });
  };
  return { workdir, roadmap, progress, memory, save, options: { roadmap, progressFile: progress, client: 'codex',
    executable: client, timeout: '5s', resolverTimeout: '5s', sessionContinuation: true, notify: 'off' } };
}

test('ownership deferral persists without receipts and can be reconsidered after acknowledged repair', t => {
  const f = fixture(t);
  const saved = f.save('defer');
  assert.equal(saved.warning, null);
  const restored = new TaskMemory({ workdir: f.workdir, tracking: { stateDir: path.join(f.workdir, 'state'),
    evidenceDir: path.join(f.workdir, 'state/evidence'), file: f.progress }, roadmap: f.roadmap });
  assert.equal(restored.assessedBlocker('A-01', 'v1').reason, 'worker_requested_deferral');
  const assessment = f.memory.assessedBlocker('A-01', 'v1');
  assert.equal(assessment.reason, 'worker_requested_deferral');
  assert.equal(assessment.provenance, 'agent-assessment');
  assert.equal(f.memory.latest('A-01').scheduling, 'defer');
  assert.equal(f.memory.contextFor('A-01', 'v1').packet.priorOutcome.scheduling, 'defer');
  assert.equal(f.memory.assessedBlocker('A-01', 'v2'), false);
  f.memory.acknowledgeResolution('A-01', 'v1', 'prepared-repair');
  assert.equal(f.memory.assessedBlocker('A-01', 'v1'), false);
});

test('unknown scheduling values are rejected and interrupted deferrals do not suppress work', t => {
  const f = fixture(t);
  assert.equal(f.save('invented').outcome, null);
  f.save('defer', { code: 130, interrupted: true });
  assert.equal(f.memory.assessedBlocker('A-01', 'v1'), false);
});

test('reused outcomes without explicit deferral stay compatible and do not manufacture loop verdicts', t => {
  const f = fixture(t);
  assert.equal(f.save(undefined).warning, null);
  assert.equal(f.memory.assessedBlocker('A-01', 'v1'), false);
  assert.equal(f.save('continue').warning, null);
  assert.equal(f.memory.assessedBlocker('A-01', 'v1'), false);
});

for (const outcome of ['reused', 'partial']) test(`${outcome} ownership return rotates to independent work before recovery`, async t => {
  const f = fixture(t, { outcome });
  const events = [];
  const result = await runLifecycle(f.options, { workdir: f.workdir, onEvent: event => events.push(event) });
  assert.equal(result.reason, 'stopped');
  const calls = JSON.parse(fs.readFileSync(path.join(f.workdir, 'calls.json'), 'utf8'));
  assert.deepEqual(calls.map(call => [call.role, call.task]), [['WORKER', 'A-01'], ['WORKER', 'B-01'], ['RESOLVER', undefined]]);
  assert.ok(calls.every(call => !call.resumed), 'deferring a task must not carry its conversation into another task or resolver');
  assert.equal(events.find(event => event.type === 'runner.task_result').scheduling, 'defer');
  assert.match(fs.readFileSync(f.roadmap, 'utf8'), /- \[ \] A-01/);
});

test('broad roadmap ownership return enters recovery instead of repeating the synthetic task', async t => {
  const f = fixture(t, { broad: true });
  const events = [];
  const result = await runLifecycle(f.options, { workdir: f.workdir, onEvent: event => events.push(event) });
  assert.equal(result.reason, 'stopped');
  const calls = JSON.parse(fs.readFileSync(path.join(f.workdir, 'calls.json'), 'utf8'));
  assert.deepEqual(calls.map(call => call.role), ['WORKER', 'RESOLVER']);
  assert.equal(events.find(event => event.type === 'runner.blocked').reason, 'worker_requested_deferral');
});
