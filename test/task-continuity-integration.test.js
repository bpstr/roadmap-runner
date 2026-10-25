import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/roadmap-runner.js', import.meta.url));
const verificationModule = new URL('../lib/verification.js', import.meta.url).href;
const taskSection = id => `### Task ${id} — Deliver the operation\n\n- [ ] ${id} Deliver and validate the operation.\n\n` +
  'Purpose: A working operation.\nContext: service.ts.\nDependencies: none.\nSession scope: One operation.\n' +
  `Acceptance: ${id} operation works.\n\nImplementation:\n- [ ] ${id}-I1 Implement operation.\n\n` +
  `Validation:\n- [ ] ${id}-V1 Validate operation.\n\nEvidence: handoff.md.\nHandoff: Exact next action.\nBlocked behavior: Continue independent work.\n`;

// Serialized into a deterministic child executable; no provider transport,
// credentials, live fixtures or model calls are available to this client.
async function preparedClient(config) {
  const fs = require('node:fs');
  const assert = require('node:assert/strict');
  const crypto = require('node:crypto');
  const prompt = process.argv.at(-1);
  const role = prompt.match(/^Runner role: (.+)$/m)[1];
  const binding = role === 'WORKER' ? JSON.parse(prompt.match(/^Result binding: (.+)$/m)[1]) : null;
  const resultFile = role === 'WORKER' ? JSON.parse(prompt.match(/^Optional structured result file: (.+)$/m)[1]) : null;
  const packetFile = role === 'WORKER' ? JSON.parse(prompt.match(/^Task continuation packet \(\d+ bytes\): (.+)$/m)[1]) : null;
  const packet = packetFile ? JSON.parse(fs.readFileSync(packetFile, 'utf8')) : null;
  const task = binding?.taskId || null;
  const calls = fs.existsSync('calls.json') ? JSON.parse(fs.readFileSync('calls.json', 'utf8')) : [];
  calls.push({ role, task, packet, binding });
  fs.writeFileSync('calls.json', JSON.stringify(calls));
  assert.ok(calls.length <= 12, 'prepared scenario must terminate within its bounded calls');
  const handoff = (status, action) => fs.writeFileSync(config.progress, `# Handoff\nStatus: ${status}\n\n## Current handoff\n${action}\n`);
  const complete = id => {
    const text = fs.readFileSync(config.roadmap, 'utf8');
    fs.writeFileSync(config.roadmap, text.replace(new RegExp(`- \\[ \\] (${id}(?:-[A-Z]\\d+)?)(?= )`, 'g'), '- [x] $1'));
    handoff(fs.readFileSync(config.roadmap, 'utf8').includes('- [ ]') ? 'IN_PROGRESS' : 'COMPLETE', `Delivered ${id}; preserve existing evidence.`);
  };
  const writeResult = overrides => fs.writeFileSync(resultFile, JSON.stringify({ ...binding,
    operation: `deliver-${task}`, outcome: 'partial', completed: [], remaining: [], nextAction: '',
    changedFiles: [], receiptIds: [], findings: [], ...overrides }));

  if (role === 'RESOLVER') {
    assert.ok(['duplicate-failure', 'semantic-loop'].includes(config.mode), 'ordinary completion and malformed optional results must not spawn a resolver');
    assert.equal(calls.filter(call => call.role === 'RESOLVER').length, 1);
    assert.match(fs.readFileSync(config.roadmap, 'utf8'), /- \[x\] B-01 /, 'independent B completes before resolving A');
    fs.writeFileSync('dependency.txt', 'repaired prerequisite\n');
    handoff('IN_PROGRESS', 'Input dependency.txt changed. Retry the A-01 operation once.');
    fs.writeFileSync(JSON.parse(prompt.match(/^Resolution decision file: (.+)$/m)[1]), JSON.stringify({
      resolutionId: prompt.match(/^Resolution ID: (.+)$/m)[1], outcome: 'resolved',
      evidence: 'Changed dependency.txt to the repaired prerequisite.', nextAction: 'Retry A-01 against the changed dependency.' }));
    return;
  }
  assert.equal(role, 'WORKER');
  const attempt = calls.filter(call => call.task === task).length;

  if (config.mode.startsWith('finite-')) {
    const authority = JSON.parse(fs.readFileSync('authority.md', 'utf8').match(/```roadmap-runner-execution\n([\s\S]*?)\n```/)[1]);
    const batch = authority.batches.find(batch => batch.id === prompt.match(/^Named deliverable: (.+)$/m)[1]);
    fs.writeFileSync('service.ts', 'export const delivered = true;\n');
    batch.implementation = 'implemented';
    batch.implementationEvidence = [{ path: 'service.ts', sha256: crypto.createHash('sha256').update(fs.readFileSync('service.ts')).digest('hex') }];
    authority.parents.find(parent => parent.id === batch.task).implementation = 'implemented';
    fs.writeFileSync('authority.md', '```roadmap-runner-execution\n' + JSON.stringify(authority) + '\n```\n');
    handoff('IN_PROGRESS', 'Finite implementation window delivered; original acceptance is still open.');
    if (['finite-quota', 'finite-capacity'].includes(config.mode) && attempt === 1) {
      writeResult({ outcome: 'implemented', completed: ['Implementation delivered'], changedFiles: ['service.ts'],
        remaining: ['Validate implementation'], nextAction: 'Validate the implementation already saved in service.ts.' });
      console.log(JSON.stringify({ type: 'error', message: config.mode === 'finite-capacity' ?
        'Selected model is at capacity' : "You've hit your limit · resets at " + new Date(Date.now() + 256).toISOString() }));
      process.exitCode = 1;
    }
    return;
  }

  assert.equal(prompt.match(/^Selected roadmap task: (.+)$/m)[1], task);
  if (config.mode === 'continuity' && task === 'A-01' && attempt === 1) {
    const { runVerification } = await import(config.verificationModule);
    const check = await runVerification({ taskId: task, criteriaRevision: binding.criteriaRevision,
      command: [process.execPath, '-e', 'require("node:fs").appendFileSync("check-executions", "run\\n")'],
      inputs: ['dependency.txt'], config: [], environment: [], runtime: { node: process.version }, coverageComplete: true },
    { workdir: process.cwd() });
    assert.equal(check.receipt.exitCode, 0);
    fs.writeFileSync('unfinished.ts', 'export const helper = true;\n');
    handoff('IN_PROGRESS', 'A-01: helper delivered. Finish exported operation; reuse prerequisite receipt.');
    writeResult({ completed: ['Helper created'], remaining: ['Finish exported operation'],
      nextAction: { instruction: 'Finish exported operation', file: 'unfinished.ts', symbol: 'operation' },
      changedFiles: ['unfinished.ts'], receiptIds: [check.receipt.id] });
    return;
  }
  if (config.mode === 'continuity' && task === 'A-01') {
    assert.equal(attempt, 2);
    assert.equal(packet.priorOutcome.nextAction.instruction, 'Finish exported operation');
    assert.deepEqual(packet.priorOutcome.remaining, ['Finish exported operation']);
    assert.equal(packet.receipts[0].status, 'reusable');
    assert.equal(packet.receipts[0].exitCode, 0);
    complete(task); writeResult({ outcome: 'verified', completed: ['A-01 accepted'], receiptIds: [packet.receipts[0].id] });
    return;
  }

  if (config.mode === 'malformed' || config.mode === 'stale') {
    if (attempt === 1) {
      handoff('IN_PROGRESS', 'Legacy handoff: finish the remaining exported operation.');
      if (config.mode === 'malformed') fs.writeFileSync(resultFile, '{broken');
      else writeResult({ sessionId: 'an-older-session', outcome: 'verified', completed: ['Stale completion claim'] });
      return;
    }
    assert.equal(attempt, 2);
    assert.equal(packet.priorOutcome, null, 'invalid or stale optional result is not accepted');
    assert.match(fs.readFileSync(config.progress, 'utf8'), /Legacy handoff: finish/);
    complete(task);
    return;
  }

  if (['duplicate-failure', 'semantic-loop'].includes(config.mode)) {
    if (task === 'A-01' && fs.readFileSync('dependency.txt', 'utf8') === 'unavailable prerequisite\n') {
      const lookback = JSON.parse(prompt.match(/^Run history lookback: (.+)$/m)[1]);
      if (config.mode === 'semantic-loop' && attempt <= 3) {
        fs.writeFileSync('service.ts', 'export const renamedRetry = ' + attempt + ';\n');
        handoff('IN_PROGRESS', 'Renamed the same handshake retry; diagnose whether this is repetition.');
        writeResult({ operation: 'renamed-handshake-' + attempt, completed: ['Inspected retry route'],
          changedFiles: ['service.ts'], remaining: ['Establish the same prerequisite handshake'], nextAction: 'Try the handshake again.' });
        return;
      }
      if (config.mode === 'semantic-loop') {
        assert.equal(lookback.records.filter(record => record.task === task).length, 3);
        assert.equal(new Set(lookback.records.map(record => record.operation)).size, 3);
        assert.match(prompt, /Judge semantic repetition across runs/);
      }
      handoff('IN_PROGRESS', 'A-01 deferred: prerequisite unavailable; B-01 remains independent.');
      writeResult({ operation: 'load-prerequisite', outcome: 'blocked', remaining: ['Available prerequisite'],
        nextAction: 'History review identified the same failed prerequisite handshake. Repair it before retrying.', failure: { signature: 'prerequisite-unavailable',
          inputPaths: ['dependency.txt'], coverageComplete: config.mode !== 'semantic-loop', retryCondition: 'Repair the prerequisite handshake' } });
      return;
    }
    if (task === 'B-01' && attempt === 1 && config.mode === 'duplicate-failure') {
      handoff('IN_PROGRESS', 'B-01 checkpoint; one exact source step remains.');
      writeResult({ remaining: ['Finish independent operation'], nextAction: 'Finish B-01 operation.' });
      return;
    }
    if (task === 'A-01') {
      assert.equal(attempt, config.mode === 'semantic-loop' ? 5 : 2);
      assert.equal(packet.blockerAssessment, false, 'acknowledged repair permits worker reassessment');
      assert.equal(fs.readFileSync('dependency.txt', 'utf8'), 'repaired prerequisite\n');
    }
    complete(task); writeResult({ outcome: 'verified', completed: [`${task} accepted`] });
    return;
  }

  complete(task); writeResult({ outcome: 'verified', completed: [`${task} accepted`] });
}

function fixture(t, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-task-continuity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const roadmap = path.join(dir, 'roadmap.md'); const progress = path.join(dir, 'handoff.md');
  const ids = ['malformed', 'stale', 'finite-awaiting_verification', 'finite-quota', 'finite-capacity'].includes(mode) ? ['A-01'] : ['A-01', 'B-01'];
  fs.writeFileSync(roadmap, '# Roadmap\nStatus: IN_PROGRESS\n\n## Constraints\nKeep public interfaces stable.\n\n' + ids.map(taskSection).join('\n'));
  fs.writeFileSync(progress, '# Handoff\nStatus: IN_PROGRESS\n\n## Current handoff\nBegin selected task.\n');
  fs.writeFileSync(path.join(dir, 'service.ts'), 'export const delivered = false;\n');
  fs.writeFileSync(path.join(dir, 'dependency.txt'), 'unavailable prerequisite\n');
  const client = path.join(dir, 'prepared.cjs');
  fs.writeFileSync(client, '#!/usr/bin/env node\n(' + preparedClient.toString() + ')(' + JSON.stringify({ mode, roadmap, progress, verificationModule }) +
    ').catch(error => { console.error(error); process.exitCode = 1; });\n', { mode: 0o755 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ROADMAP_')));
  Object.assign(env, { ROADMAP_STATE_DIR: path.join(dir, 'registry'), ROADMAP_NOTIFY: 'off', ROADMAP_NOTIFY_BIN: '',
    ROADMAP_USAGE_MAX_WAIT: '8', ROADMAP_CAPACITY_DELAY: '1', ROADMAP_CAPACITY_MAX_DELAY: '1', ROADMAP_CAPACITY_RETRIES: '1' });
  const args = [cli, roadmap, '--progress-file', progress, '--client-bin', client, '--notify', 'off', '--timeout', '8s', '--resolver-timeout', '8s'];
  if (mode.startsWith('finite-')) {
    const authority = { version: 1, denominator: ids.length, operationDenominator: ids.length,
      parents: ids.map((id, index) => ({ id, roadmap: 'roadmap.md', operations: [`operation-${index}`], implementation: 'partial', missing: ['Deliver behavior'], evidence: [] })),
      operations: ids.map((id, index) => ({ id: `operation-${index}`, owner: id })),
      batches: [{ id: 'batch-A', task: 'A-01', roadmap: 'roadmap.md', implementation: 'partial', budgetMinutes: 40,
        deliverable: 'A implementation', boundary: 'service.ts', completion: 'Source delivered', checkpoint: 'Exact next source action', prerequisites: [], sourcePointers: ['service.ts'] }] };
    const file = path.join(dir, 'authority.md');
    fs.writeFileSync(file, '```roadmap-runner-execution\n' + JSON.stringify(authority) + '\n```\n');
    args.push('--execution-plan', file);
  }
  return { dir, roadmap, progress,
    run: () => spawnSync(process.execPath, args, { cwd: dir, env, encoding: 'utf8', timeout: 30000 }),
    calls: () => fs.existsSync(path.join(dir, 'calls.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'calls.json'), 'utf8')) : [],
    events: () => fs.readFileSync(progress + '.events.jsonl', 'utf8').trim().split('\n').map(JSON.parse) };
}

test('structured default task continuation dispatches A to A to B and carries reusable check evidence', t => {
  const f = fixture(t, 'continuity'); const result = f.run();
  assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
  assert.deepEqual(f.calls().map(call => call.task), ['A-01', 'A-01', 'B-01']);
  const second = f.calls()[1].packet;
  assert.deepEqual(second.priorOutcome.completed, ['Helper created']);
  assert.equal(second.receipts[0].status, 'reusable');
  assert.equal(fs.readFileSync(path.join(f.dir, 'check-executions'), 'utf8'), 'run\n', 'handoff does not rerun the prior check');
  assert.equal(f.events().at(-1).type, 'runner.completed');
});

for (const mode of ['malformed', 'stale']) test(`${mode} optional result retains legacy handoff without introducing a resolver`, t => {
  const f = fixture(t, mode); const result = f.run();
  assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
  assert.deepEqual(f.calls().map(call => [call.role, call.task]), [['WORKER', 'A-01'], ['WORKER', 'A-01']]);
  assert.equal(f.events().filter(event => event.type === 'runner.task_result_invalid').length, 1);
  assert.equal(f.events().at(-1).type, 'runner.completed');
});

test('worker-assessed blocker defers A while B finishes and only then invokes one repairing resolver', t => {
  const f = fixture(t, 'duplicate-failure'); const result = f.run();
  assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
  assert.deepEqual(f.calls().map(call => call.role === 'RESOLVER' ? 'RESOLVER' : call.task), ['A-01', 'B-01', 'B-01', 'RESOLVER', 'A-01']);
  const blocked = f.events().filter(event => event.type === 'runner.blocked');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].reason, 'agent_assessed_blocker');
  assert.equal(f.events().at(-1).type, 'runner.completed');
});
test('worker history review identifies a semantic loop despite renamed operations and source churn', t => {
  const f = fixture(t, 'semantic-loop'); const result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(f.calls().map(call => call.role === 'RESOLVER' ? 'RESOLVER' : call.task), ['A-01', 'A-01', 'A-01', 'A-01', 'B-01', 'RESOLVER', 'A-01']);
  assert.equal(f.events().filter(event => event.type === 'runner.blocked').length, 1);
});

for (const state of ['needs_next_batch', 'awaiting_verification']) test(`finite productive exhaustion reports ${state} with open acceptance and no resolver`, t => {
  const f = fixture(t, `finite-${state}`); const result = f.run();
  assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
  assert.deepEqual(f.calls().map(call => call.role), ['WORKER']);
  assert.match(fs.readFileSync(f.roadmap, 'utf8'), /- \[ \] A-01 /);
  const ended = f.events().find(event => event.type === 'runner.plan_exhausted');
  assert.equal(ended?.reason, state);
  assert.equal(ended?.terminal, true);
  assert.equal(f.events().some(event => event.type === 'runner.blocked'), false);
});

for (const mode of ['finite-quota', 'finite-capacity']) test(`${mode} after implementation resumes a worker without a resolver`, t => {
  const f = fixture(t, mode); const result = f.run();
  assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
  assert.deepEqual(f.calls().map(call => [call.role, call.task]), [['WORKER', 'A-01'], ['WORKER', 'A-01']]);
  assert.equal(f.calls()[1].packet.priorOutcome.outcome, 'partial', 'unsuccessful completion claim remains unaccepted');
  assert.equal(f.events().find(event => event.type === 'runner.plan_exhausted')?.reason, 'awaiting_verification');
  assert.equal(f.events().some(event => event.type === 'runner.blocked'), false);
  assert.match(fs.readFileSync(f.roadmap, 'utf8'), /- \[ \] A-01 /);
});
