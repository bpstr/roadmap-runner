import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCheckpointAcknowledgment } from '../lib/checkpoint.js';
import { runClient } from '../lib/runner.js';

function fixture(t) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-ack-'));
  t.after(() => fs.rmSync(workdir, { recursive: true, force: true }));
  const file = path.join(workdir, 'checkpoint-ack.json');
  const resultFile = path.join(workdir, 'worker-result.json');
  const options = { requestId: 'prepared-session-id', resultFile, workdir, requestedAt: Date.now() - 100,
    taskId: 'API-01.1', criteriaRevision: 'criteria-v1' };
  const result = { version: 1, sessionId: options.requestId, taskId: options.taskId,
    criteriaRevision: options.criteriaRevision, outcome: 'partial', changedFiles: ['unfinished.ts'], nextAction: 'Finish the return branch.' };
  const ack = { version: 1, requestId: options.requestId, resultFile };
  const save = () => { fs.writeFileSync(resultFile, JSON.stringify(result)); fs.writeFileSync(file, JSON.stringify(ack)); };
  save();
  return { workdir, file, resultFile, options, result, ack, save };
}

test('checkpoint acknowledgment is bound to fresh result, task and criteria, with derived handoff fields', t => {
  const f = fixture(t);
  const value = readCheckpointAcknowledgment(f.file, f.options);
  assert.equal(value.requestId, f.options.requestId);
  assert.deepEqual(value.editedPaths, ['unfinished.ts']);
  assert.equal(value.nextAction, f.result.nextAction);
  for (const override of [{ requestId: 'another-session' }, { taskId: 'API-01.2' }, { criteriaRevision: 'changed' },
    { resultFile: path.join(f.workdir, 'another-result.json') }, { requestedAt: Date.now() + 10000 }]) {
    assert.equal(readCheckpointAcknowledgment(f.file, { ...f.options, ...override }), null);
  }
  fs.utimesSync(f.resultFile, new Date(0), new Date(0));
  assert.equal(readCheckpointAcknowledgment(f.file, f.options), null, 'stale worker result cannot acknowledge a new request');
});

test('malformed, oversized, mismatched and out-of-workspace acknowledgments are ignored', t => {
  const f = fixture(t);
  f.ack.requestId = 'stale-request'; f.save();
  assert.equal(readCheckpointAcknowledgment(f.file, f.options), null);
  f.ack.requestId = f.options.requestId;
  f.result.changedFiles = ['../outside.ts']; f.save();
  assert.equal(readCheckpointAcknowledgment(f.file, f.options), null);
  f.result.changedFiles = ['unfinished.ts']; f.result.sessionId = 'stale-session'; f.save();
  assert.equal(readCheckpointAcknowledgment(f.file, f.options), null);
  f.result.sessionId = f.options.requestId; f.result.nextAction = ''; f.save();
  assert.equal(readCheckpointAcknowledgment(f.file, f.options), null);
  f.result.nextAction = 'Finish branch'; f.save();
  fs.writeFileSync(f.file, '{');
  assert.equal(readCheckpointAcknowledgment(f.file, f.options), null);
  fs.writeFileSync(f.file, ' '.repeat(65537));
  assert.equal(readCheckpointAcknowledgment(f.file, f.options), null);
});

test('runner-supplied external result paths work; final-component symlinks and invalid extra schema do not', t => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-ack-external-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const externalFile = path.join(outside, 'result.json');
  fs.writeFileSync(externalFile, JSON.stringify(f.result));
  fs.writeFileSync(f.file, JSON.stringify({ ...f.ack, resultFile: externalFile }));
  assert.ok(readCheckpointAcknowledgment(f.file, { ...f.options, resultFile: externalFile }));
  assert.equal(readCheckpointAcknowledgment(f.file, { ...f.options, resultFile: externalFile, validateResult: () => false }), null);
  if (process.platform !== 'win32') {
    fs.rmSync(f.resultFile); fs.symlinkSync(externalFile, f.resultFile);
    fs.writeFileSync(f.file, JSON.stringify(f.ack));
    assert.equal(readCheckpointAcknowledgment(f.file, f.options), null);
  }
});

test('saving a checkpoint request alone never reports acknowledgment', async t => {
  const f = fixture(t);
  const client = path.join(f.workdir, 'client.cjs');
  fs.writeFileSync(client, '#!/usr/bin/env node\nsetTimeout(() => {}, 320);\n', { mode: 0o755 });
  const result = await runClient({ client: 'codex', executable: client, workdir: f.workdir,
    prompt: 'prepared checkpoint', timeoutMs: 3000, checkpointAtMs: 50,
    checkpointRequestId: f.options.requestId, onCheckpoint: () => 'saved-request.json',
    readCheckpointAck: request => readCheckpointAcknowledgment(f.file, { ...f.options, requestedAt: request.at }) });
  assert.equal(result.code, 0);
  assert.equal(result.checkpoint.requested, true);
  assert.equal(result.checkpoint.saved, 'saved-request.json');
  assert.equal(result.checkpoint.acknowledged, false, 'pre-request files are stale');
});

test('fresh worker acknowledgment is recorded and does not terminate the client', async t => {
  const f = fixture(t);
  fs.rmSync(f.file); fs.rmSync(f.resultFile);
  const requestFile = path.join(f.workdir, 'request.json');
  const marker = path.join(f.workdir, 'finished-after-ack');
  const client = path.join(f.workdir, 'client.cjs');
  fs.writeFileSync(client, `#!/usr/bin/env node
const fs = require('node:fs');
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(requestFile)})) return;
  clearInterval(timer);
  fs.writeFileSync(${JSON.stringify(f.resultFile)}, ${JSON.stringify(JSON.stringify(f.result))});
  fs.writeFileSync(${JSON.stringify(f.file)}, ${JSON.stringify(JSON.stringify(f.ack))});
  setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'finished'), 500);
}, 20);
`, { mode: 0o755 });
  let acknowledgments = 0;
  const result = await runClient({ client: 'codex', executable: client, workdir: f.workdir,
    prompt: 'prepared checkpoint', timeoutMs: 3000, checkpointAtMs: 50, checkpointAckPollMs: 250,
    checkpointRequestId: f.options.requestId,
    onCheckpoint: request => { fs.writeFileSync(requestFile, JSON.stringify(request)); return requestFile; },
    readCheckpointAck: request => readCheckpointAcknowledgment(f.file, { ...f.options, requestedAt: request.at }),
    onCheckpointAck: () => { acknowledgments++; } });
  assert.equal(result.code, 0);
  assert.equal(result.checkpoint.acknowledged, true);
  assert.equal(result.checkpoint.acknowledgment.nextAction, f.result.nextAction);
  assert.equal(acknowledgments, 1);
  assert.ok(fs.existsSync(marker), 'acknowledgment must not kill the worker before it exits');
});

test('an acknowledgment written immediately before exit is read without waiting for the next poll', async t => {
  const f = fixture(t);
  fs.rmSync(f.file); fs.rmSync(f.resultFile);
  const requestFile = path.join(f.workdir, 'request.json');
  const client = path.join(f.workdir, 'client.cjs');
  fs.writeFileSync(client, `#!/usr/bin/env node
const fs = require('node:fs');
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(requestFile)})) return;
  clearInterval(timer);
  fs.writeFileSync(${JSON.stringify(f.resultFile)}, ${JSON.stringify(JSON.stringify(f.result))});
  fs.writeFileSync(${JSON.stringify(f.file)}, ${JSON.stringify(JSON.stringify(f.ack))});
}, 20);
`, { mode: 0o755 });
  const result = await runClient({ client: 'codex', executable: client, workdir: f.workdir,
    prompt: 'prepared final acknowledgment', timeoutMs: 3000, checkpointAtMs: 50,
    checkpointAckPollMs: 4000, checkpointRequestId: f.options.requestId,
    onCheckpoint: request => { fs.writeFileSync(requestFile, JSON.stringify(request)); return requestFile; },
    readCheckpointAck: request => readCheckpointAcknowledgment(f.file, { ...f.options, requestedAt: request.at }) });
  assert.equal(result.code, 0);
  assert.equal(result.checkpoint.acknowledged, true);
});
