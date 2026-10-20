import test from 'node:test';
import assert from 'node:assert/strict';
import { planRecovery } from '../examples/codex-recovery-gate.mjs';
const blocked = { workspace: '/fixture', roadmap: '/fixture/roadmap.md', progressFile: '/fixture/progress.md',
  sourceRevision: 'source-one', blockerFingerprint: 'native-missing', unblockInputFingerprint: 'missing',
  processState: 'exited', roadmapState: 'blocked', reason: 'blocked', runId: 'first' };

test('unchanged blocked observations never dispatch despite note/cursor/run churn', () => {
  let checkpoint = planRecovery(blocked).checkpoint;
  let dispatches = 0;
  for (let i = 0; i < 100; i++) {
    const result = planRecovery({ ...blocked, runId: `run-${i}`, cursor: i, note: `scan-${i}` }, checkpoint, true);
    if (result.action === 'dispatch') dispatches++;
    checkpoint = result.checkpoint;
  }
  assert.equal(dispatches, 0);
});
test('changed verified input produces exactly one mocked recovery job', () => {
  let checkpoint = planRecovery(blocked).checkpoint;
  const supplied = { ...blocked, unblockInputFingerprint: 'verified-sha256-native-input' };
  const jobs = [];
  for (let i = 0; i < 5; i++) {
    const result = planRecovery(supplied, checkpoint, true);
    checkpoint = JSON.parse(JSON.stringify(result.checkpoint)); // Prepared durable-claim boundary.
    if (result.action === 'dispatch') jobs.push(result.request); // Mock host dispatch; no inference.
  }
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].recoverBlocked, true);
  assert.equal(jobs[0].notify, 'attention');
});
test('active work and missing authorization do not dispatch or consume recovery', () => {
  const checkpoint = planRecovery(blocked).checkpoint;
  const changed = { ...blocked, unblockInputFingerprint: 'supplied' };
  assert.equal(planRecovery({ ...changed, processState: 'running' }, checkpoint, true).action, 'wait');
  const refused = planRecovery(changed, checkpoint, false);
  assert.equal(refused.action, 'attention');
  assert.deepEqual(refused.checkpoint, checkpoint);
  assert.equal(planRecovery(changed, checkpoint, true).action, 'dispatch');
});
test('two changed-input attempts exhaust the incident budget across runner restarts', () => {
  let checkpoint = planRecovery(blocked).checkpoint;
  for (const input of ['bundle-one', 'bundle-two']) checkpoint = planRecovery({ ...blocked, unblockInputFingerprint: input }, checkpoint, true).checkpoint;
  const result = planRecovery({ ...blocked, runId: 'new-run', unblockInputFingerprint: 'bundle-three' }, JSON.parse(JSON.stringify(checkpoint)), true);
  assert.equal(result.action, 'attention');
  assert.equal(result.reason, 'recovery_budget_exhausted');
});
test('a source or blocker change establishes a fresh baseline rather than blind dispatch', () => {
  const checkpoint = planRecovery(blocked).checkpoint;
  assert.equal(planRecovery({ ...blocked, sourceRevision: 'source-two' }, checkpoint, true).action, 'observe');
  assert.equal(planRecovery({ ...blocked, blockerFingerprint: 'credential-missing' }, checkpoint, true).action, 'observe');
});
