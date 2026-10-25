import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunEvidence, boundedText, OUTPUT_BYTES, RUN_SUMMARY_BYTES } from '../lib/run-evidence.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const evidenceDir = path.join(dir, 'evidence'); fs.mkdirSync(evidenceDir);
  return { dir, config: { roadmap: '/source', tracking: { file: path.join(dir, 'progress'), stateDir: dir, evidenceDir } } };
}
const record = (runs, iteration, text = 'output') => {
  const output = runs.capture(); output.write('stdout', text);
  runs.record({ iteration, result: { code: 0, checkpoint: { requested: true, acknowledged: true,
    acknowledgment: { requestId: `checkpoint-${iteration}`, resultFile: 'result.json', editedPaths: ['transport.js'], nextAction: 'Finish transport response' } } }, output, before: 'handoff before', after: 'handoff after',
    sourceBefore: 'source', sourceAfter: 'source', implementationBefore: { 'transport.js': 'a' }, implementationAfter: { 'transport.js': 'b' } });
};
test('bounded capture retains short output and bounded head/tail plus omissions', () => {
  const short = boundedText(); short.write('abc'); assert.deepEqual(short.value(), { head: 'abc', tail: '', bytes: 3, omittedBytes: 0 });
  const large = boundedText(); large.write('a'.repeat(OUTPUT_BYTES * 5));
  assert.equal(Buffer.byteLength(large.value().head + large.value().tail), OUTPUT_BYTES);
  assert.equal(large.value().omittedBytes, OUTPUT_BYTES * 4);
});
test('rolling evidence and checkpoint survive restart without loading detail into the summary', t => {
  const f = fixture(t); const runs = new RunEvidence(f.config);
  for (let i = 1; i <= 30; i++) record(runs, i, 'x'.repeat(OUTPUT_BYTES * 10));
  assert.ok(fs.statSync(runs.evidenceFile).size <= RUN_SUMMARY_BYTES);
  assert.equal(runs.records.length, 20);
  const restarted = new RunEvidence(f.config); assert.deepEqual(restarted.records, JSON.parse(JSON.stringify(runs.records)));
  const detail = JSON.parse(fs.readFileSync(runs.records.at(-1).evidence));
  assert.equal(detail.stdout.omittedBytes, OUTPUT_BYTES * 9);
  assert.deepEqual(detail.implementationAfter, { 'transport.js': 'b' });
  assert.deepEqual(detail.checkpoint.acknowledgment, { requestId: 'checkpoint-30', resultFile: 'result.json',
    editedPaths: ['transport.js'], nextAction: 'Finish transport response' });
});
test('worker lookback retains semantic attempts and cold evidence across restart within its context budget', t => {
  const f = fixture(t), runs = new RunEvidence(f.config);
  for (let iteration = 1; iteration <= 12; iteration++) {
    const output = runs.capture(); output.write('stderr', 'Prepared handshake failure');
    runs.record({ iteration, sessionId: `session-${iteration}`, task: 'API-32', sourceRevision: `churn-${iteration}`,
      result: { code: 0 }, output, before: 'notes', after: 'new notes', outcome: {
        operation: `renamed-retry-${iteration}`, criteriaRevision: 'original-criteria', outcome: 'partial', completed: ['Inspected handshake'],
        remaining: ['Establish the same prerequisite handshake'], nextAction: 'Try the handshake again',
        changedFiles: ['notes.txt'], failure: { signature: `surface-message-${iteration}`, inputPaths: ['transport.js'], retryCondition: 'Repair transport' },
      } });
  }
  const view = runs.lookback(); assert.ok(Buffer.byteLength(JSON.stringify(view)) <= 8192);
  assert.equal(view.authority, 'context-only; worker assesses repetition');
  assert.equal(view.records.at(-1).iteration, 12); assert.equal(view.records.length, 8); assert.equal(view.omittedRecords, 4);
  assert.equal(view.records.at(-1).operation, 'renamed-retry-12');
  assert.equal(view.records.at(-1).roadmap, '/source');
  assert.equal(view.records.at(-1).criteriaRevision, 'original-criteria');
  assert.equal(view.records.at(-1).remaining[0], 'Establish the same prerequisite handshake');
  assert.ok(view.records.every(record => fs.existsSync(record.evidence)));
  assert.deepEqual(new RunEvidence(f.config).lookback(), view);
});
for (const inline of [true, false]) test(`legacy ${inline ? 'inline' : 'pointer'} supervisor evidence migrates without dispatching review`, t => {
  const f = fixture(t); const runs = new RunEvidence(f.config); record(runs, 1);
  const saved = JSON.parse(fs.readFileSync(runs.checkpointFile));
  if (inline) saved.records = saved.records.map(r => JSON.parse(fs.readFileSync(r.evidence)));
  fs.writeFileSync(path.join(f.dir, 'supervision.json'), JSON.stringify(saved)); fs.unlinkSync(runs.checkpointFile);
  const migrated = new RunEvidence(f.config);
  assert.equal(migrated.records.length, 1); assert.ok(fs.existsSync(migrated.records[0].evidence));
  record(migrated, 2); assert.ok(fs.existsSync(migrated.checkpointFile));
});
test('quota and capacity rejections are excluded from implementation attempts', t => {
  const f = fixture(t); const runs = new RunEvidence(f.config);
  for (const result of [{ code: 1, usageLimit: {} }, { code: 1, retryableCapacity: true }]) runs.record({ result });
  assert.equal(runs.records.length, 0); assert.equal(runs.usagePauses, 1); assert.equal(runs.capacityRetries, 1);
});

test('quota after useful work retains semantic continuation but cannot count as a repeated failure', t => {
  const f = fixture(t); const runs = new RunEvidence(f.config);
  const output = runs.capture(); output.write('stdout', 'partial implementation');
  const outcome = { taskId: 'API-32', operation: 'pagination', outcome: 'partial', completed: ['parser'],
    remaining: ['response'], nextAction: { instruction: 'Encode response cursor' }, receiptIds: [] };
  runs.record({ iteration: 1, result: { code: 1, usageLimit: {} }, output, before: 'before', after: 'after', outcome });
  assert.equal(runs.records.length, 1);
  assert.equal(runs.records[0].task, 'API-32');
  assert.equal(runs.records[0].outcome.nextAction, 'Encode response cursor');
  assert.equal(runs.records[0].failureLoopEligible, false);
  const resumed = new RunEvidence(f.config);
  assert.equal(resumed.usagePauses, 1); assert.equal(resumed.records.length, 1);
});
