import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLifecycle } from '../dist/lifecycle.js';
import { parseArgs } from '../lib/runner.js';

// Serialized prepared executable: no provider transport or credential access.
function prepared(config) {
  const fs = require('node:fs');
  const assert = require('node:assert/strict');
  const prompt = process.argv.at(-1);
  const role = prompt.match(/^Runner role: (.+)$/m)[1];
  const calls = fs.existsSync('calls.json') ? JSON.parse(fs.readFileSync('calls.json', 'utf8')) : [];
  const binding = role === 'WORKER' ? JSON.parse(prompt.match(/^Result binding: (.+)$/m)[1]) : null;
  calls.push({ role, task: binding?.taskId, resumed: process.argv.includes('resume') });
  fs.writeFileSync('calls.json', JSON.stringify(calls));
  assert.ok(calls.length <= 10, 'prepared scenario must terminate');
  const handoff = status => fs.writeFileSync('progress.md', 'Status: ' + status + '\n## Current handoff\nPreserve prepared implementation and failed acceptance.\n');
  if (role === 'RESOLVER') {
    if (config.acknowledge && !/^Invalid result repair:/m.test(prompt)) {
      handoff('IN_PROGRESS');
      fs.writeFileSync(JSON.parse(prompt.match(/^Resolution decision file: (.+)$/m)[1]), JSON.stringify({
        resolutionId: prompt.match(/^Resolution ID: (.+)$/m)[1], outcome: 'resolved', retryTasks: ['A-01'],
        evidence: 'Explicit operator recovery acknowledges the external prerequisite for one reassessment', nextAction: 'Reassess A-01 once' }));
      return;
    }
    const repair = JSON.parse(prompt.match(/^Invalid result repair: (.+)$/m)[1]);
    assert.match(prompt, /Do not implement product changes/);
    const raw = JSON.parse(fs.readFileSync(repair.evidenceFile, 'utf8'));
    if (config.kind === 'paths') raw.failure = { ...raw.failure, inputPaths: ['input.txt'], coverageComplete: false };
    else raw.nextAction.command = ['node', '--test', 'prepared.test.js'];
    if (config.repair === 'escalate') raw.outcome = 'verified';
    if (config.repair !== 'missing') fs.writeFileSync(repair.repairFile, JSON.stringify(raw));
    handoff('IN_PROGRESS');
    fs.writeFileSync(JSON.parse(prompt.match(/^Resolution decision file: (.+)$/m)[1]), JSON.stringify({
      resolutionId: prompt.match(/^Resolution ID: (.+)$/m)[1], outcome: 'resolved', evidence: 'Prepared metadata repair only', nextAction: 'Reassess valid continuation' }));
    return;
  }
  const file = JSON.parse(prompt.match(/^Optional structured result file: (.+)$/m)[1]);
  const raw = { ...binding, operation: 'prepared-operation', outcome: 'partial', scheduling: 'defer', completed: ['Prepared implementation'],
    remaining: ['Owner prerequisite'], changedFiles: [], receiptIds: [], findings: [], nextAction: { instruction: 'Wait for owner repair', command: [] } };
  const attempt = calls.filter(call => call.task === binding.taskId).length;
  if (binding.taskId === 'A-01' && (attempt === 1 || config.repair === 'loop')) {
    if (config.kind === 'paths') { raw.nextAction.command = ['node']; raw.failure = { signature: 'owner gate', inputPaths: Array(129).fill('input.txt'), coverageComplete: true, retryCondition: 'Owner repairs input' }; }
    if (config.kind === 'outside') { raw.nextAction.command = ['node']; raw.failure = { signature: 'host gate', inputPaths: [require('node:os').tmpdir()], coverageComplete: true, retryCondition: 'Host operator repairs tool' }; }
    if (config.kind === 'argv') raw.nextAction.command = ['node', '--test', 'prepared.test.js'];
    if (config.repair === 'continue' || config.repair === 'loop') raw.scheduling = 'continue';
    if (config.completedSource) fs.writeFileSync('roadmap.md', fs.readFileSync('roadmap.md', 'utf8').replaceAll('- [ ]', '- [x]'));
    if (config.completedTask) fs.writeFileSync('roadmap.md', fs.readFileSync('roadmap.md', 'utf8').replace('- [ ] A-01', '- [x] A-01'));
    let bytes = JSON.stringify(raw);
    if (config.kind === 'malformed') bytes = '{broken';
    if (config.kind === 'stale') bytes = JSON.stringify({ ...raw, sessionId: 'foreign-session' });
    if (config.kind === 'oversized') bytes = 'x'.repeat(65537);
    fs.writeFileSync(file, bytes);
    handoff(config.completedSource ? 'COMPLETE' : 'IN_PROGRESS');
    return;
  }
  fs.writeFileSync('roadmap.md', fs.readFileSync('roadmap.md', 'utf8').replace('- [ ] ' + binding.taskId, '- [x] ' + binding.taskId));
  fs.writeFileSync(file, JSON.stringify({ ...raw, scheduling: 'continue', outcome: 'verified', nextAction: '' }));
  handoff(fs.readFileSync('roadmap.md', 'utf8').includes('- [ ]') ? 'IN_PROGRESS' : 'COMPLETE');
}

function fixture(t, config = {}) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-invalid-result-'));
  t.after(() => fs.rmSync(workdir, { recursive: true, force: true }));
  const task = (id, dependencies = 'none') => `### Task ${id}\n- [ ] ${id} Deliver prepared behavior\nDependencies: ${dependencies}\nAcceptance: prepared behavior works.\n\n`;
  fs.writeFileSync(path.join(workdir, 'roadmap.md'), '# Prepared roadmap\nStatus: IN_PROGRESS\n\n' + task('A-01') + task('B-01') + task('A-02', 'A-01'));
  fs.writeFileSync(path.join(workdir, 'input.txt'), 'unchanged prerequisite');
  fs.writeFileSync(path.join(workdir, 'progress.md'), 'Status: IN_PROGRESS\n## Current handoff\nBegin prepared work.\n');
  const executable = path.join(workdir, 'prepared.cjs');
  fs.writeFileSync(executable, '#!/usr/bin/env node\n(' + prepared.toString() + ')(' + JSON.stringify(config) + ');\n', { mode: 0o755 });
  const options = { ...parseArgs([], {}), roadmap: path.join(workdir, 'roadmap.md'), progressFile: path.join(workdir, 'progress.md'),
    executable, client: 'codex', notify: 'off', preventSleep: false, timeout: '5s', resolverTimeout: '5s',
    resolverAttempts: 2, reviewTurns: 1, progressReviewPolicy: 'continue', ...config.options };
  const events = [];
  return { workdir, events, options,
    run: () => runLifecycle(options, { workdir, managedSleep: true, onEvent: event => events.push(event) }),
    calls: () => JSON.parse(fs.readFileSync(path.join(workdir, 'calls.json'), 'utf8')) };
}

for (const kind of ['outside', 'malformed', 'stale', 'oversized', 'argv']) test(`${kind} result permits independent work and preserves the dispatch fence on restart`, async t => {
  const f = fixture(t, { kind });
  assert.equal((await f.run()).reason, 'deferred');
  assert.deepEqual(f.calls().map(call => [call.role, call.task]), [['WORKER', 'A-01'], ['WORKER', 'B-01']]);
  const invalid = f.events.find(event => event.type === 'runner.task_result_invalid');
  if (kind === 'argv') assert.equal(invalid, undefined, 'bounded argv is valid and nonexecuted');
  else {
    assert.equal(invalid.reason, 'waiting_external_input');
    assert.ok(invalid.diagnostic.code);
    assert.ok(fs.existsSync(invalid.rejectedEvidenceFile));
    assert.equal(invalid.repeatedDispatchCount, 1);
  }
  if (kind !== 'argv') {
    const source = path.join(f.workdir, 'roadmap.md');
    fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('### Task B-01',
      '<!-- roadmap-runner:delivery:start -->\nHandoff: selected-task delivery annotation changed.\n<!-- roadmap-runner:delivery:end -->\n\n### Task B-01') + '\nHandoff: unrelated source prose changed.\n');
  }
  if (kind !== 'argv') fs.appendFileSync(path.join(f.workdir, 'progress.md'), '\nNew progress annotation.\n');
  assert.equal((await f.run()).reason, 'deferred');
  assert.equal(f.calls().length, 2, 'restart, prose churn and automatic renewal cannot repeat the product worker');
  assert.match(fs.readFileSync(path.join(f.workdir, 'roadmap.md'), 'utf8'), /- \[ \] A-02/);
});

for (const kind of ['command', 'paths']) test(`${kind} metadata is repaired before another product worker and preserves deferral`, async t => {
  const f = fixture(t, { kind });
  assert.equal((await f.run()).reason, 'deferred');
  assert.deepEqual(f.calls().map(call => [call.role, call.task]), [['WORKER', 'A-01'], ['RESOLVER', undefined], ['WORKER', 'B-01']]);
  assert.equal(f.events.filter(event => event.type === 'runner.task_result_repaired').length, 1);
  assert.equal(f.events.some(event => event.type === 'runner.completed'), false);
});

test('safe repair can resume productive partial work', async t => {
  const f = fixture(t, { kind: 'command', repair: 'continue' });
  assert.equal((await f.run()).reason, 'complete');
  assert.deepEqual(f.calls().slice(0, 2).map(call => call.role), ['WORKER', 'RESOLVER']);
  assert.equal(f.calls().filter(call => call.role === 'RESOLVER').length, 1);
  assert.equal(f.calls().filter(call => call.task === 'A-01').length, 2);
  assert.equal(f.calls().some(call => call.resumed), false, 'rejected results end the previous conversation');
});

for (const repair of ['missing', 'escalate']) test(`${repair} repair stops at the configured budget without product redispatch`, async t => {
  const f = fixture(t, { kind: 'command', repair });
  assert.equal((await f.run()).reason, 'stopped');
  assert.deepEqual(f.calls().map(call => call.role), ['WORKER', 'RESOLVER', 'RESOLVER']);
  assert.equal(f.events.some(event => event.type === 'runner.task_result_repaired'), false);
});

test('unchanged invalid-result repair cannot renew its budget under automatic progress continuation', async t => {
  const f = fixture(t, { kind: 'command', repair: 'loop', options: { resolverAttempts: 1 } });
  assert.equal((await f.run()).reason, 'stopped');
  assert.equal(f.calls().filter(call => call.task === 'A-01').length, 2);
  assert.equal(f.calls().filter(call => call.role === 'RESOLVER').length, 1);
  assert.ok(f.events.some(event => event.type === 'runner.progress_reviewed' && event.reason === 'automatic_continue_policy'));
  assert.equal((await f.run()).reason, 'stopped');
  assert.equal(f.calls().filter(call => call.role === 'RESOLVER').length, 1);
});

for (const policy of ['park', 'stop']) test(`metadata recovery honors blocked policy ${policy}`, async t => {
  const f = fixture(t, { kind: 'command', options: { blockedPolicy: policy } });
  assert.equal((await f.run()).reason, policy === 'park' ? 'blocked' : 'stopped');
  assert.equal(f.calls().length, 1);
});

for (const kind of ['outside', 'command']) test(`${kind} rejected result cannot authorize completed-source fallback loops`, async t => {
  const f = fixture(t, { kind, completedSource: true });
  assert.equal((await f.run()).reason, 'stopped');
  assert.equal(f.calls().length, 1);
  // Simulate a crash after the rejection fence was saved but before recovery
  // state/status could be persisted. The fence alone must prevent completion.
  fs.rmSync(path.join(f.workdir, 'progress.md.recovery.json'));
  fs.writeFileSync(path.join(f.workdir, 'progress.md'), 'Status: COMPLETE\n## Current handoff\nPrepared stale completion claim.\n');
  assert.equal((await f.run()).reason, 'stopped');
  assert.equal(f.calls().length, 1);
});

test('a checked task with rejected output cannot unlock its unfinished dependents', async t => {
  const f = fixture(t, { kind: 'command', completedTask: true });
  assert.equal((await f.run()).reason, 'stopped');
  assert.equal(f.calls().length, 1);
  assert.match(fs.readFileSync(path.join(f.workdir, 'roadmap.md'), 'utf8'), /- \[ \] A-02/);
});

test('explicit recovery can acknowledge one exact fenced task without accepting its rejected outcome', async t => {
  const f = fixture(t, { kind: 'outside', acknowledge: true });
  assert.equal((await f.run()).reason, 'deferred');
  f.options.recoverBlocked = true;
  assert.equal((await f.run()).reason, 'complete');
  assert.equal(f.calls().filter(call => call.role === 'RESOLVER').length, 1);
  assert.equal(f.calls().filter(call => call.task === 'A-01').length, 2);
  assert.equal(f.events.some(event => event.type === 'runner.task_result_repaired'), false);
});
