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

test('missing results retain legacy handoff; oversized, stale and symlinked results fence without delivery state', t => {
  const f = fixture(t);
  const expected = { sessionId: 'missing', taskId: 'API-32', criteriaRevision: 'criteria-v1' };
  const prepared = f.memory.prepare(expected);
  assert.match(f.memory.consume({ ...expected, resultFile: prepared.resultFile }).warning, /legacy handoff/);
  const stale = f.save({ sessionId: 'old-session' });
  assert.equal(stale.outcome, null); assert.equal(stale.rejection.diagnostic.code, 'invalid_binding');
  fs.writeFileSync(prepared.resultFile, 'x'.repeat(WORKER_RESULT_BYTES + 1));
  assert.equal(f.memory.consume({ ...expected, resultFile: prepared.resultFile }).outcome, null);
  fs.unlinkSync(prepared.resultFile);
  fs.symlinkSync(f.tracking.file, prepared.resultFile);
  assert.equal(f.memory.consume({ ...expected, resultFile: prepared.resultFile }).outcome, null);
  fs.unlinkSync(prepared.resultFile);
  fs.symlinkSync(path.join(f.workdir, 'missing-target'), prepared.resultFile);
  const dangling = f.memory.consume({ ...expected, resultFile: prepared.resultFile });
  assert.equal(dangling.rejection.diagnostic.code, 'unsafe_evidence_file');
  assert.ok(f.memory.assessedBlocker('API-32', 'criteria-v1'));
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

test('failure counts do not block tasks; a recorded worker assessment defers them until reassessment', t => {
  const f = fixture(t);
  const failure = { signature: 'missing-cursor', inputPaths: ['source.js'], coverageComplete: true, retryCondition: 'Repair cursor encoding' };
  for (let run = 0; run < 12; run++) {
    f.save({ failure }); assert.equal(f.memory.assessedBlocker('API-32', 'criteria-v1'), false);
  }
  f.save({ outcome: 'blocked', failure: { ...failure, coverageComplete: false },
    nextAction: 'Lookback shows repeated encoding attempts. Repair cursor encoding before retrying.' });
  assert.equal(f.memory.assessedBlocker('API-32', 'criteria-v1').provenance, 'agent-assessment');
  fs.writeFileSync(path.join(f.workdir, 'unrelated.txt'), 'unrelated change');
  assert.ok(f.memory.assessedBlocker('API-32', 'criteria-v1'));
  fs.writeFileSync(path.join(f.workdir, 'source.js'), 'source hash churn alone does not clear an agent assessment');
  assert.deepEqual(f.memory.blockedTaskIds({ 'API-32': 'criteria-v1' }), ['API-32']);
  assert.equal(f.memory.assessedBlocker('API-32', 'criteria-v2'), false);
  f.memory.acknowledgeResolution('API-32', 'criteria-v1', 'resolution-1');
  assert.equal(f.memory.assessedBlocker('API-32', 'criteria-v1'), false);
  f.save({ failure, outcome: 'implemented' });
  assert.equal(f.memory.assessedBlocker('API-32', 'criteria-v1'), false);
});

test('unknown dependency coverage and quota interruptions do not manufacture failure loops', t => {
  const f = fixture(t);
  const failure = { signature: 'missing', inputPaths: ['source.js'], retryCondition: 'Supply dependency' };
  f.save({ failure }); f.save({ failure });
  assert.equal(f.memory.assessedBlocker('API-32', 'criteria-v1'), false);
  const quota = f.save({ outcome: 'verified', failure: { ...failure, coverageComplete: true } }, { code: 1, usageLimit: {} });
  assert.equal(quota.outcome.outcome, 'partial'); assert.equal(quota.outcome.reportedOutcome, 'verified');
  assert.equal(quota.record.failureLoopEligible, false);
  assert.equal(f.memory.assessedBlocker('API-32', 'criteria-v1'), false);
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

test('command suggestions accept bounded argv without executing it', t => {
  const f = fixture(t);
  const valid = f.save({ scheduling: 'defer', nextAction: { command: ['node', '--test', 'fixture.test.mjs'] } });
  assert.deepEqual(valid.outcome.nextAction.command, ['node', '--test', 'fixture.test.mjs']);
  assert.equal(f.memory.assessedBlocker('API-32', 'criteria-v1').reason, 'worker_requested_deferral');
  for (const command of [[], [''], [['node']], [12], Array(129).fill('node'), Array(3).fill('x'.repeat(3000))]) {
    const rejected = f.save({ nextAction: { command } });
    assert.equal(rejected.outcome, null);
    assert.equal(rejected.rejection.diagnostic.field, 'nextAction.command');
    assert.equal(rejected.rejection.repairable, true);
  }
});

test('rejected metadata keeps immutable bytes and a fence across epochs, acknowledgments and restart', t => {
  const f = fixture(t);
  const saved = f.save({ scheduling: 'defer', failure: { signature: 'gate', inputPaths: Array(129).fill('source.js'),
    coverageComplete: true, retryCondition: 'Owner repairs the prerequisite' } });
  assert.equal(saved.outcome, null);
  assert.deepEqual(saved.rejection.diagnostic, { code: 'invalid_list', field: 'failure.inputPaths', actual: 129, limit: 128 });
  assert.equal(fs.readFileSync(saved.rejection.evidenceFile, 'utf8'), JSON.stringify(saved.raw));
  fs.writeFileSync(saved.prepared.resultFile, '{}');
  const resumed = new TaskMemory({ workdir: f.workdir, tracking: f.tracking, roadmap: path.join(f.workdir, 'roadmap.md') });
  resumed.handoffEpoch = 25;
  resumed.acknowledgeResolution('API-32', 'criteria-v1', 'ordinary-ack');
  assert.equal(resumed.assessedBlocker('API-32', 'criteria-v1').state, 'invalid_result_repair');
  assert.equal(resumed.assessedBlocker('API-32', 'criteria-v2'), false);
  assert.equal(resumed.latest('API-32'), null);
  assert.equal(fs.readFileSync(saved.rejection.evidenceFile, 'utf8'), JSON.stringify(saved.raw));
});

test('metadata-only repair validates the copy and cannot change binding, outcome or failed evidence', t => {
  const f = fixture(t);
  const saved = f.save({ scheduling: 'defer', nextAction: { command: [] } });
  const repair = f.memory.beginInvalidRepair('API-32', 'criteria-v1', saved.rejection.fingerprint, 2);
  const corrected = { ...saved.raw, nextAction: { command: ['node', '--test'] } };
  for (const change of [{ taskId: 'foreign' }, { outcome: 'verified' }, { receiptIds: ['check-forged'] }, { scheduling: 'continue' }]) {
    fs.writeFileSync(repair.repairFile, JSON.stringify({ ...corrected, ...change }));
    assert.equal(f.memory.repairInvalid(repair), null);
    assert.ok(f.memory.assessedBlocker('API-32', 'criteria-v1'));
  }
  fs.writeFileSync(repair.repairFile, JSON.stringify(corrected));
  assert.equal(f.memory.repairInvalid(repair).outcome.scheduling, 'defer');
  assert.equal(f.memory.assessedBlocker('API-32', 'criteria-v1').provenance, 'agent-assessment');
  assert.equal(fs.readFileSync(saved.rejection.evidenceFile, 'utf8'), JSON.stringify(saved.raw));
});

test('oversized prerequisite repair must mark its reduced scope incomplete', t => {
  const f = fixture(t);
  const saved = f.save({ scheduling: 'defer', failure: { signature: 'gate', inputPaths: Array(129).fill('source.js'),
    coverageComplete: true, retryCondition: 'Owner repairs the prerequisite' } });
  const repair = f.memory.beginInvalidRepair('API-32', 'criteria-v1', saved.rejection.fingerprint, 1);
  const corrected = { ...saved.raw, failure: { ...saved.raw.failure, inputPaths: ['source.js'] } };
  fs.writeFileSync(repair.repairFile, JSON.stringify(corrected));
  assert.equal(f.memory.repairInvalid(repair), null);
  corrected.failure.coverageComplete = false;
  fs.writeFileSync(repair.repairFile, JSON.stringify(corrected));
  assert.ok(f.memory.repairInvalid(repair));
  fs.writeFileSync(path.join(f.workdir, 'source.js'), 'changed');
  assert.ok(f.memory.assessedBlocker('API-32', 'criteria-v1'), 'truncated input coverage cannot prove readiness');
});

test('repair budgets survive successful repairs, changed error categories and handoff epochs', t => {
  const f = fixture(t);
  const first = f.save({ nextAction: { command: [] } });
  const repair = f.memory.beginInvalidRepair('API-32', 'criteria-v1', first.rejection.fingerprint, 1);
  fs.writeFileSync(repair.repairFile, JSON.stringify({ ...first.raw, nextAction: { command: ['node'] } }));
  assert.ok(f.memory.repairInvalid(repair));
  f.save({ nextAction: { command: 12 } }); // Different validation category cannot erase the first budget.
  f.memory.handoffEpoch = 8;
  const repeated = f.save({ nextAction: { command: [] } });
  assert.equal(repeated.rejection.repeatedDispatchCount, 2);
  assert.equal(f.memory.beginInvalidRepair('API-32', 'criteria-v1', repeated.rejection.fingerprint, 1), null);
});

test('outside-workspace references park without traversal, while changed complete workspace inputs permit reassessment', t => {
  const f = fixture(t);
  const outside = f.save({ scheduling: 'defer', failure: { signature: 'host tool', inputPaths: [os.tmpdir()],
    coverageComplete: true, retryCondition: 'Host owner repairs the tool' } });
  assert.equal(outside.rejection.diagnostic.code, 'unsafe_reference');
  assert.equal(outside.rejection.repairable, false);
  assert.deepEqual(outside.rejection.inputPaths, []);
  assert.equal(f.memory.assessedBlocker('API-32', 'criteria-v1').state, 'waiting_external_input');
  const saved = f.save({ nextAction: { command: [] }, failure: { signature: 'workspace gate', inputPaths: ['source.js'],
    coverageComplete: true, retryCondition: 'source.js changes' } });
  assert.ok(f.memory.assessedBlocker('API-32', 'criteria-v1'));
  fs.writeFileSync(path.join(f.workdir, 'source.js'), 'changed prerequisite');
  assert.equal(f.memory.assessedBlocker('API-32', 'criteria-v1'), false);
  const valid = f.save({ scheduling: 'defer', nextAction: 'Wait for the remaining owner' });
  assert.ok(valid.outcome);
  assert.ok(f.memory.assessedBlocker('API-32', 'criteria-v1'), 'a valid later deferral still applies');
  assert.ok(fs.existsSync(saved.rejection.evidenceFile));
});

test('external prerequisite observations are bounded and never grant readiness authority', t => {
  const f = fixture(t);
  const saved = f.save({ scheduling: 'defer', externalPrerequisites: [{ description: 'Input helper unavailable', owner: 'Host operator',
    retryCondition: 'Operator confirms a repaired installation', authority: true }] });
  assert.equal(saved.outcome.externalPrerequisites[0].authority, false);
  assert.ok(f.memory.assessedBlocker('API-32', 'criteria-v1'));
  assert.equal(f.save({ externalPrerequisites: Array(17).fill({}) }).outcome, null);
});

test('128 declared inputs remain valid and unreadable safety state fails closed', t => {
  const f = fixture(t);
  const valid = f.save({ scheduling: 'defer', failure: { signature: 'gate', inputPaths: Array(128).fill('source.js'),
    coverageComplete: true, retryCondition: 'source.js changes' } });
  assert.ok(valid.outcome);
  f.save({ nextAction: { command: [] } });
  fs.writeFileSync(f.memory.rejectionFile('API-32'), '{}');
  assert.throws(() => f.memory.assessedBlocker('API-32', 'criteria-v1'), /safety fence is unreadable/);
});
