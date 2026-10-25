import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskMemory, TASK_PACKET_BYTES, WORKER_RESULT_BYTES } from '../lib/task-memory.js';
import { recordReview } from '../lib/verification.js';

function fixture(t) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-task-memory-'));
  t.after(() => fs.rmSync(workdir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workdir, 'source.js'), 'export const value = 1;\n');
  const tracking = { stateDir: path.join(workdir, '.roadmap-runner', 'roadmap'),
    evidenceDir: path.join(workdir, '.roadmap-runner', 'roadmap', 'evidence'), file: path.join(workdir, 'progress.md') };
  fs.writeFileSync(tracking.file, 'Status: IN_PROGRESS\n## Deferred gates\nPreserve the independent release obligation.\n');
  const memory = new TaskMemory({ workdir, tracking, roadmap: path.join(workdir, 'roadmap.md') });
  let count = 0;
  const save = (changes = {}, processResult = { code: 0 }) => {
    const expected = { sessionId: `session-${++count}`, taskId: 'API-32', criteriaRevision: 'criteria-v1' };
    const prepared = memory.prepare(expected);
    const raw = { version: 1, ...expected, operation: 'pagination', outcome: 'partial', completed: ['Cursor parser'],
      remaining: ['Encode response cursor'], nextAction: { instruction: 'Use the existing codec', file: 'source.js', symbol: 'value' },
      changedFiles: ['source.js'], receiptIds: [], findings: [], ...changes };
    fs.writeFileSync(prepared.resultFile, JSON.stringify(raw));
    return { ...memory.consume({ ...expected, resultFile: prepared.resultFile, processResult }), prepared, raw, expected };
  };
  return { workdir, tracking, memory, save };
}

test('typed continuation survives restart and preserves all existing handoff obligations', t => {
  const f = fixture(t); const handoff = fs.readFileSync(f.tracking.file, 'utf8');
  const saved = f.save(); assert.equal(saved.warning, null);
  const resumed = new TaskMemory({ workdir: f.workdir, tracking: f.tracking, roadmap: path.join(f.workdir, 'roadmap.md') });
  assert.deepEqual(resumed.latest('API-32').nextAction, saved.raw.nextAction);
  const packet = resumed.contextFor('API-32', 'criteria-v1').packet;
  assert.deepEqual(packet.priorOutcome.remaining, ['Encode response cursor']);
  assert.equal(packet.priorResultFile, saved.prepared.resultFile);
  assert.equal(fs.readFileSync(f.tracking.file, 'utf8'), handoff);
  assert.equal(resumed.contextFor('API-32', 'criteria-v2').packet.criteriaChanged, true);
});

test('missing, oversized, stale-session and symlinked result files fall back without creating delivery state', t => {
  const f = fixture(t);
  const expected = { sessionId: 'missing', taskId: 'API-32', criteriaRevision: 'criteria-v1' };
  const prepared = f.memory.prepare(expected);
  assert.match(f.memory.consume({ ...expected, resultFile: prepared.resultFile }).warning, /legacy handoff/);
  const stale = f.save({ sessionId: 'old-session' });
  assert.equal(stale.outcome, null); assert.match(stale.warning, /stale/);
  fs.writeFileSync(prepared.resultFile, 'x'.repeat(WORKER_RESULT_BYTES + 1));
  assert.equal(f.memory.consume({ ...expected, resultFile: prepared.resultFile }).outcome, null);
  fs.unlinkSync(prepared.resultFile);
  fs.symlinkSync(f.tracking.file, prepared.resultFile);
  assert.equal(f.memory.consume({ ...expected, resultFile: prepared.resultFile }).outcome, null);
  assert.equal(f.memory.latest('API-32'), null);
});

test('findings are shared observations and invalidate when their named source changes', t => {
  const f = fixture(t);
  f.save({ findings: [{ id: 'codec-location', summary: 'The codec lives in source.js', sourcePaths: ['source.js'] }] });
  const otherTracking = { ...f.tracking, stateDir: path.join(f.workdir, '.roadmap-runner', 'other') };
  const other = new TaskMemory({ workdir: f.workdir, tracking: otherTracking, roadmap: path.join(f.workdir, 'other.md') });
  assert.equal(other.contextFor('API-64', 'another').packet.findings[0].status, 'reusable-observation');
  assert.equal(other.contextFor('API-64', 'another').packet.findings[0].authority, false);
  fs.writeFileSync(path.join(f.workdir, 'source.js'), 'changed implementation');
  assert.equal(other.contextFor('API-64', 'another').packet.findings[0].status, 'invalidated');
});

test('repetition requires matching declared failure inputs and a resolver starts a fresh attempt epoch', t => {
  const f = fixture(t);
  const failure = { signature: 'missing-cursor', inputPaths: ['source.js'], coverageComplete: true, retryCondition: 'Repair cursor encoding' };
  f.save({ failure }); assert.equal(f.memory.repeatFailure('API-32', 'criteria-v1'), false);
  f.save({ failure }); assert.equal(f.memory.repeatFailure('API-32', 'criteria-v1').attempts.length, 2);
  fs.writeFileSync(path.join(f.workdir, 'unrelated.txt'), 'unrelated change');
  assert.equal(f.memory.repeatFailure('API-32', 'criteria-v1').attempts.length, 2);
  f.memory.acknowledgeResolution('API-32', 'criteria-v1', 'resolution-1');
  assert.equal(f.memory.repeatFailure('API-32', 'criteria-v1'), false);
  f.save({ failure }); assert.equal(f.memory.repeatFailure('API-32', 'criteria-v1'), false);
  f.save({ failure }); assert.equal(f.memory.repeatFailure('API-32', 'criteria-v1').attempts.length, 2);
  fs.writeFileSync(path.join(f.workdir, 'source.js'), 'repaired input');
  assert.equal(f.memory.repeatFailure('API-32', 'criteria-v1'), false);
  f.save({ failure, outcome: 'implemented' });
  assert.equal(f.memory.repeatFailure('API-32', 'criteria-v1'), false);
});

test('unknown dependency coverage and quota interruptions do not manufacture failure loops', t => {
  const f = fixture(t);
  const failure = { signature: 'missing', inputPaths: ['source.js'], retryCondition: 'Supply dependency' };
  f.save({ failure }); f.save({ failure });
  assert.equal(f.memory.repeatFailure('API-32', 'criteria-v1'), false);
  const quota = f.save({ outcome: 'verified', failure: { ...failure, coverageComplete: true } }, { code: 1, usageLimit: {} });
  assert.equal(quota.outcome.outcome, 'partial'); assert.equal(quota.outcome.reportedOutcome, 'verified');
  assert.equal(quota.record.failureLoopEligible, false);
  assert.equal(f.memory.repeatFailure('API-32', 'criteria-v1'), false);
});

test('large continuation packets keep exact overflow evidence and stay within 8 KiB', t => {
  const f = fixture(t);
  const saved = f.save({ remaining: Array(64).fill('x'.repeat(512)), nextAction: 'a'.repeat(8192) });
  assert.equal(saved.warning, null);
  const { packetFile, packet } = f.memory.contextFor('API-32', 'criteria-v1');
  assert.ok(fs.statSync(packetFile).size <= TASK_PACKET_BYTES);
  assert.equal(JSON.parse(fs.readFileSync(packet.priorResultFile)).nextAction.length, 8192);
  assert.match(fs.readFileSync(f.tracking.file, 'utf8'), /independent release obligation/);
});

test('escaping source paths and receipt IDs are never accepted as reusable evidence', t => {
  const f = fixture(t);
  assert.equal(f.save({ changedFiles: ['../escape.js'] }).outcome, null);
  assert.equal(f.save({ receiptIds: ['../../secret'] }).outcome, null);
  fs.symlinkSync(os.tmpdir(), path.join(f.workdir, 'outside'));
  assert.equal(f.save({ findings: [{ summary: 'not read', sourcePaths: ['outside/missing-file'] }] }).outcome, null);
});

test('scoped review verdicts survive handoff with explicit trust and invalidation reasons', t => {
  const f = fixture(t);
  const { receipt } = recordReview({ taskId: 'API-32', criteriaRevision: 'criteria-v1', verdict: 'Cursor boundaries reviewed',
    inputPaths: ['source.js'], findings: ['Handle the empty page separately'] }, { workdir: f.workdir });
  f.save({ receiptIds: [receipt.id] });
  let review = f.memory.contextFor('API-32', 'criteria-v1').packet.receipts[0];
  assert.equal(review.status, 'unknown'); assert.equal(review.scopeStatus, 'reusable-observation');
  assert.equal(review.verdict, 'Cursor boundaries reviewed'); assert.equal(review.acceptanceAuthority, false);
  assert.deepEqual(review.findings, ['Handle the empty page separately']);
  fs.writeFileSync(path.join(f.workdir, 'source.js'), 'changed source');
  review = f.memory.contextFor('API-32', 'criteria-v1').packet.receipts[0];
  assert.equal(review.scopeStatus, 'invalidated'); assert.match(review.reason, /delta/);
  const changed = f.memory.contextFor('API-32', 'criteria-v2').packet;
  assert.equal(changed.receipts[0].reason, 'Review criteria changed');
  assert.match(changed.notes, /before resuming/);
});
