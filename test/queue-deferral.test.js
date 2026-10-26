import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunManager } from '../dist/run-manager.js';
import { readRun } from '../dist/run-state.js';

// Each client process runs this prepared script. There is no provider transport.
function preparedClient(config) {
  const fs = require('node:fs');
  const path = require('node:path');
  const prompt = process.argv.at(-1);
  const source = JSON.parse(prompt.match(/^Live roadmap[^:]*: (.+)$/m)[1]);
  const progress = prompt.match(/Tracking file \(progress \/ delivery evidence\):\s*\n\s*([^\n]+)/)[1].trim();
  const role = prompt.match(/^Runner role: (.+)$/m)[1];
  const binding = role === 'WORKER' ? JSON.parse(prompt.match(/^Result binding: (.+)$/m)[1]) : null;
  const calls = fs.existsSync('calls.json') ? JSON.parse(fs.readFileSync('calls.json', 'utf8')) : [];
  calls.push({ source: path.basename(source), role, task: binding?.taskId, resumed: process.argv.includes('resume') });
  fs.writeFileSync('calls.json', JSON.stringify(calls));
  if (calls.length > 10) throw new Error('Unchanged deferred work must not loop');
  if (role === 'RESOLVER') {
    if (!config.globalBlocker) throw new Error('A deferral must not require recovery');
    fs.writeFileSync('repaired', 'yes');
    fs.writeFileSync(progress, 'Status: IN_PROGRESS\n');
    fs.writeFileSync(JSON.parse(prompt.match(/^Resolution decision file: (.+)$/m)[1]), JSON.stringify({
      resolutionId: prompt.match(/^Resolution ID: (.+)$/m)[1], outcome: 'resolved',
      evidence: 'Prepared independent B-01 repair.', nextAction: 'Continue B-01.',
      ...(config.retryTasks ? { retryTasks: config.retryTasks } : {}) }));
    return;
  }
  const first = path.basename(source) === 'first.md';
  const ready = fs.readFileSync('owner.txt', 'utf8') === 'delivered';
  const deferred = config.allDeferred || (first && (config.broad || binding.taskId === 'A-01') && !ready);
  const blocked = config.globalBlocker && binding.taskId === 'B-01' && !fs.existsSync('repaired');
  const result = { ...binding, operation: 'prepared-queue-pass', outcome: blocked ? 'blocked' : deferred ? 'reused' : 'verified',
    completed: deferred || blocked ? [] : ['Prepared contribution delivered'], remaining: deferred ? ['Owner adoption'] : [],
    nextAction: deferred ? 'Reassess after owner.txt is delivered.' : blocked ? 'Repair the independent B-01 input.' : '',
    changedFiles: [], receiptIds: [], findings: [], ...(deferred ? { scheduling: 'defer',
      ...(config.noInputs ? {} : { failure: { signature: 'owner-adoption', inputPaths: ['owner.txt'],
        coverageComplete: true, retryCondition: 'Reassess after owner.txt changes.' } }) } : {}) };
  fs.writeFileSync(JSON.parse(prompt.match(/^Optional structured result file: (.+)$/m)[1]), JSON.stringify(result));
  if (!deferred && !blocked) {
    const text = fs.readFileSync(source, 'utf8');
    fs.writeFileSync(source, config.broad ? text.replaceAll('- [ ]', '- [x]') : text.replace('- [ ] ' + binding.taskId, '- [x] ' + binding.taskId));
    if (!first && config.deliverOwner) fs.writeFileSync('owner.txt', 'delivered');
    if (!first && config.changeCriteria) {
      fs.writeFileSync('first.md', fs.readFileSync('first.md', 'utf8').replace('Acceptance: prepared contribution.', 'Acceptance: consume the repaired owner.'));
      fs.writeFileSync('owner.txt', 'delivered');
    }
    if (!first && config.unrelatedCriteria) fs.appendFileSync('first.md', '\nB-01 receipt annotation.\n');
  }
  const complete = !fs.readFileSync(source, 'utf8').includes('- [ ]');
  fs.writeFileSync(progress, 'Status: ' + (blocked ? 'BLOCKED' : complete ? 'COMPLETE' : 'IN_PROGRESS') + '\n## Current handoff\nPrepared queue pass.\n');
}

async function waitFor(read, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Prepared run did not finish');
}

function fixture(t, config = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-queue-deferral-'));
  const registry = path.join(workspace, 'registry');
  const first = path.join(workspace, 'first.md'), second = path.join(workspace, 'second.md');
  const section = (id, dependency = 'none') => `### Task ${id}\n- [ ] ${id} Deliver behavior\nDependencies: ${dependency}\nAcceptance: prepared contribution.\n\n`;
  fs.writeFileSync(first, '# First\n\n' + (config.broad ? '- [ ] Owner adoption\n' : section('A-01') + section('A-02', 'A-01') + section('B-01')));
  fs.writeFileSync(second, '# Second\n\n' + (config.broad ? '- [ ] Owner delivery\n' : section('C-01')));
  fs.writeFileSync(path.join(workspace, 'owner.txt'), 'pending');
  const executable = path.join(workspace, 'prepared.cjs');
  fs.writeFileSync(executable, '#!/usr/bin/env node\n(' + preparedClient.toString() + ')(' + JSON.stringify(config) + ');\n', { mode: 0o755 });
  const manager = new RunManager(workspace, registry), runs = [];
  t.after(async () => {
    for (const id of runs) {
      await manager.stop(id);
      await waitFor(async () => ['exited', 'stopped', 'unknown'].includes((await manager.status(id)).processState));
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  const start = async () => {
    const run = await manager.start({ workspace, roadmap: first, progressFile: 'custom/first-progress.md',
      queue: [{ roadmap: second, progressFile: 'custom/second-progress.md' }], notify: 'off', notifyOn: ['runner.queue_deferred'], timeout: '5s', resolverTimeout: '5s' }, { executable });
    runs.push(run.id);
    const result = await waitFor(async () => { const state = await manager.status(run.id); return ['exited', 'stopped', 'unknown'].includes(state.processState) && state; });
    if (result.reason === 'stopped' || result.processState === 'unknown') {
      const output = fs.readFileSync(path.join(registry, 'runs', run.id, 'output.log'), 'utf8');
      assert.fail(`Prepared queue stopped: ${JSON.stringify({ calls: JSON.parse(fs.readFileSync(path.join(workspace, 'calls.json'), 'utf8')), output: output.slice(-5000) })}`);
    }
    return { ...result, events: fs.readFileSync(path.join(registry, 'runs', run.id, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
  };
  return { workspace, registry, first, second, manager, start, calls: () => JSON.parse(fs.readFileSync(path.join(workspace, 'calls.json'), 'utf8')) };
}

test('a deferred roadmap advances the queue and revisits its dependents only after the declared owner input changes', async t => {
  const f = fixture(t, { deliverOwner: true });
  const result = await f.start();
  assert.equal(result.reason, 'complete');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.queue.map(item => item.state), ['complete', 'complete']);
  assert.deepEqual(f.calls().map(call => call.task), ['A-01', 'B-01', 'C-01', 'A-01', 'A-02']);
  assert.ok(f.calls().every(call => call.role === 'WORKER' && !call.resumed));
  assert.equal(path.basename(result.queue[0].progressFile), 'first-progress.md');
  assert.equal(result.events.filter(event => event.type === 'runner.completed').length, 1);
  assert.equal(result.events.filter(event => event.type === 'runner.roadmap_deferred').length, 1);
});

test('unchanged deferred acceptance exits once with a deferred summary and survives a new managed run', async t => {
  const f = fixture(t);
  const result = await f.start();
  assert.equal(result.reason, 'deferred');
  assert.equal(result.roadmapState, 'deferred');
  assert.equal(result.queue[result.queueIndex].state, 'deferred');
  assert.equal(result.roadmap, result.queue[0].roadmap);
  assert.equal(result.artifacts.progress, result.queue[0].progressFile);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.queue.map(item => item.state), ['deferred', 'complete']);
  assert.deepEqual(f.calls().map(call => call.task), ['A-01', 'B-01', 'C-01']);
  assert.match(fs.readFileSync(f.first, 'utf8'), /- \[ \] A-01/);
  assert.match(fs.readFileSync(f.first, 'utf8'), /- \[ \] A-02/);
  assert.equal(result.events.filter(event => event.type === 'runner.completed').length, 0);
  assert.equal(result.events.filter(event => event.type === 'runner.queue_deferred').length, 1);
  assert.equal(result.events.at(-1).terminal, true);
  assert.equal(result.events.at(-1).attention, true);
  const restarted = await f.start();
  assert.equal(restarted.reason, 'deferred');
  assert.equal(f.calls().length, 3, 'a restart is not a changed prerequisite');
  for (const lock of readRun(f.registry, restarted.id).locks) assert.equal(fs.existsSync(lock), false);
  fs.writeFileSync(path.join(f.workspace, 'owner.txt'), 'delivered');
  const repaired = await f.start();
  assert.equal(repaired.reason, 'complete');
  assert.deepEqual(f.calls().slice(3).map(call => call.task), ['A-01', 'A-02']);
});

test('an entirely deferred queue makes one pass without resolver churn or repeated dispatch', async t => {
  const f = fixture(t, { allDeferred: true });
  const result = await f.start();
  assert.equal(result.reason, 'deferred');
  assert.deepEqual(result.queue.map(item => item.state), ['deferred', 'deferred']);
  assert.deepEqual(f.calls().map(call => call.task), ['A-01', 'B-01', 'C-01']);
});

test('broad roadmap deferral advances and reopens only after declared prerequisite changes', async t => {
  const f = fixture(t, { broad: true, deliverOwner: true });
  const result = await f.start();
  assert.equal(result.reason, 'complete');
  assert.deepEqual(f.calls().map(call => call.source), ['first.md', 'second.md', 'first.md']);
});

test('changed criteria permit a new deferred pass without manufacturing acceptance', async t => {
  const f = fixture(t, { changeCriteria: true, noInputs: true });
  const result = await f.start();
  assert.equal(result.reason, 'complete');
  assert.deepEqual(f.calls().map(call => call.task), ['A-01', 'B-01', 'C-01', 'A-01', 'A-02']);
});

test('unrelated source edits and undeclared owner changes leave deferred task criteria parked', async t => {
  const f = fixture(t, { unrelatedCriteria: true, noInputs: true, deliverOwner: true });
  const result = await f.start();
  assert.equal(result.reason, 'deferred');
  assert.deepEqual(f.calls().map(call => call.task), ['A-01', 'B-01', 'C-01']);
});

test('an unrelated resolver repair retains an unchanged ownership deferral', async t => {
  const f = fixture(t, { globalBlocker: true });
  const result = await f.start();
  assert.equal(result.reason, 'deferred');
  assert.deepEqual(f.calls().map(call => call.task || call.role), ['A-01', 'B-01', 'RESOLVER', 'B-01', 'C-01']);
});

test('a resolver can explicitly acknowledge only the named deferred task for reassessment', async t => {
  const f = fixture(t, { globalBlocker: true, retryTasks: ['A-01'] });
  const result = await f.start();
  assert.equal(result.reason, 'deferred');
  assert.equal(f.calls().filter(call => call.task === 'A-01').length, 2);
  assert.equal(f.calls().filter(call => call.role === 'RESOLVER').length, 1);
});
