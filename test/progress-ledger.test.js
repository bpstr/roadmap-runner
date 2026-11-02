import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProgressLedger, criterionSnapshot, progressSettings, readProgressStatus, runtimeIdentity } from '../lib/progress-ledger.js';

function fixture(t, text = '- [ ] DEMO-01 Deliver the operation.\n', options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const roadmap = path.join(dir, 'roadmap.md'), handoff = path.join(dir, 'progress.md');
  fs.writeFileSync(roadmap, text); fs.writeFileSync(handoff, 'Status: IN_PROGRESS\nCurrent handoff.\n');
  let now = Date.parse('2026-10-30T00:00:00Z');
  const config = { roadmap, tracking: { stateDir: dir, evidenceDir: path.join(dir, 'evidence'), file: handoff }, options, now: () => now };
  const ledger = new ProgressLedger(config);
  return { dir, roadmap, handoff, ledger, config, advance: ms => { now += ms; }, turn: (outcome = 'implemented', ms = 100) => {
    ledger.beginSession('worker', 10000); now += ms; ledger.finishSession(ms, outcome); return ledger.observe();
  } };
}

test('eleven contributions, renamed operations and prose churn do not close or reset the original baseline', t => {
  const f = fixture(t, undefined, { reviewTurns: 11 });
  for (let i = 0; i < 11; i++) { fs.appendFileSync(f.roadmap, `\nEvidence note ${i}.\n`); f.turn(); }
  assert.equal(f.ledger.reason(), 'acceptance_plateau_turns');
  assert.deepEqual(f.ledger.summary().original, { total: 1, remaining: 1, missing: 0, closed: 0 });
  assert.equal(f.ledger.summary().contributions.implemented, 11);
  const restarted = new ProgressLedger({ ...f.config, options: { reviewTurns: 100, reviewAfter: '12h' } });
  assert.equal(restarted.reason(), 'acceptance_plateau_turns');
  assert.equal(restarted.summary().workerTurns, 11);
});

test('finite reviewed subgaps can reduce the window; additions, removals and toggling cannot replenish it', t => {
  const f = fixture(t, undefined, { reviewTurns: 2 });
  f.turn(); fs.appendFileSync(f.roadmap, '- [ ] GAP-01 Required prerequisite.\n'); f.turn();
  assert.equal(f.ledger.reason(), 'acceptance_plateau_turns');
  const request = f.ledger.requestReview(f.ledger.reason());
  const key = f.ledger.state.criteria.find(item => item.kind === 'addition').key;
  const decision = { version: 1, reviewId: request.id, sourceRevision: request.sourceRevision, decision: 'extend',
    reason: 'Inspect and close the finite prerequisite.', gapKeys: [key], additionalTurns: 2, additionalActiveTime: '1h' };
  const file = path.join(f.dir, 'review.json'); fs.writeFileSync(file, JSON.stringify(decision));
  assert.equal(f.ledger.applyReview(file), true); assert.equal(f.ledger.applyReview(file), false);
  fs.writeFileSync(f.roadmap, fs.readFileSync(f.roadmap, 'utf8').replace('[ ] GAP', '[x] GAP'));
  assert.equal(f.turn().closures, 1); assert.equal(f.ledger.summary().turnsSinceReduction, 0);
  assert.equal(f.ledger.summary().original.closed, 0);
  fs.writeFileSync(f.roadmap, '- [x] GAP-01 Required prerequisite.\n- [x] NEW-01 Already completed addition.\n');
  f.turn(); assert.equal(f.ledger.summary().original.missing, 1); assert.equal(f.ledger.summary().turnsSinceReduction, 1);
  fs.writeFileSync(f.roadmap, '- [ ] GAP-01 Required prerequisite.\n'); f.turn();
  fs.writeFileSync(f.roadmap, '- [x] GAP-01 Required prerequisite.\n');
  assert.equal(f.turn().closures, 0); assert.equal(f.ledger.reason(), 'acceptance_plateau_turns');
});

test('review is source-bound, acknowledged explicitly, and does not erase cumulative time or closure age', t => {
  const f = fixture(t, undefined, { reviewTurns: 1 }); f.turn();
  const pending = f.ledger.requestReview(f.ledger.reason());
  const file = path.join(f.dir, 'review.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, reviewId: pending.id, sourceRevision: 'stale', decision: 'extend', reason: 'Review', gapKeys: [], additionalTurns: 1, additionalActiveTime: '1h' }));
  assert.throws(() => f.ledger.applyReview(file), /current request/);
  assert.equal(f.ledger.summary().pendingReview.acknowledged, false);
  f.advance(5000); const before = f.ledger.summary();
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), sourceRevision: pending.sourceRevision }));
  f.ledger.applyReview(file);
  assert.equal(f.ledger.summary().activeMs, before.activeMs);
  assert.equal(f.ledger.summary().closureAgeMs, before.closureAgeMs);
  assert.equal(f.ledger.state.reviews.length, 1); assert.equal(f.ledger.summary().pendingReview, null);
});

test('active-time budgets count every role, cap sessions and survive process interruption and restarts', t => {
  const f = fixture(t, undefined, { reviewAfter: '2s', maxActiveTime: '3s' });
  f.ledger.beginSession('resolver', 2000); f.advance(1000);
  assert.equal(readProgressStatus(f.ledger.file, f.config.now()).activeMs, 1000);
  assert.equal(f.ledger.state.activeMs, 0, 'status is read-only');
  const restart = new ProgressLedger(f.config);
  assert.equal(restart.summary().activeMs, 1000); assert.equal(restart.remainingMs(), 1000);
  restart.beginSession('compactor', 1000); f.advance(5000);
  const again = new ProgressLedger(f.config);
  assert.equal(again.summary().activeMs, 2000); assert.equal(again.reason(), 'acceptance_plateau_time');
  assert.match(again.state.interruptedAccounting, /conservatively/);
});

test('source closures survive more than eight turns and handoff reconciliation preserves the current epoch', t => {
  const f = fixture(t, '- [ ] DEMO-01 Deliver.\n- [ ] DEMO-02 Verify.\n', { reviewTurns: 100 });
  fs.writeFileSync(f.roadmap, '- [x] DEMO-01 Deliver.\n- [ ] DEMO-02 Verify.\n'); f.turn();
  const closure = f.ledger.summary().lastOriginalClosureAt;
  for (let i = 0; i < 12; i++) f.turn('partial');
  f.ledger.syncHandoff(); fs.writeFileSync(f.handoff, 'Status: BLOCKED\nCurrent handoff.\n');
  assert.equal(f.ledger.syncHandoff(), false, 'controller status alone is not a reviewed handoff');
  fs.writeFileSync(f.handoff, 'Status: IN_PROGRESS\nReviewed repair handoff.\n');
  assert.equal(f.ledger.syncHandoff(), true);
  const restart = new ProgressLedger(f.config); assert.equal(restart.state.handoffEpoch, 1);
  assert.equal(restart.summary().lastOriginalClosureAt, closure); assert.equal(restart.summary().turnsSinceReduction, 12);
});

test('invalid state fails closed; criterion extraction ignores fenced examples; runtime contents distinguish installations', t => {
  const f = fixture(t);
  assert.equal(criterionSnapshot('```md\n- [x] SAMPLE\n```\n- [ ] LIVE\n').length, 1);
  fs.writeFileSync(f.ledger.file, JSON.stringify({ ...f.ledger.state, pending: {} }));
  assert.throws(() => new ProgressLedger(f.config), /Cannot safely resume/);
  fs.writeFileSync(f.ledger.file, '{broken'); assert.throws(() => new ProgressLedger(f.config), /Cannot safely resume/);
  assert.throws(() => progressSettings({ reviewTurns: 0 }), /reviewTurns/);
  assert.throws(() => progressSettings({ reviewAfter: 'off' }), /invalid timeout/);
  for (const dir of ['bin', 'dist', 'lib']) fs.mkdirSync(path.join(f.dir, dir));
  for (const file of ['package.json', 'bin/roadmap-runner.js', 'prompt.md', 'resolver.md', 'compact.md', 'dist/lifecycle.js']) fs.writeFileSync(path.join(f.dir, file), '{}');
  const first = runtimeIdentity(f.dir); fs.writeFileSync(path.join(f.dir, 'dist/lifecycle.js'), 'changed');
  assert.notEqual(first.bundleHash, runtimeIdentity(f.dir).bundleHash);
});

test('default continue policy renews time and turn windows without closing criteria or approving additions', t => {
  const f = fixture(t, undefined, { reviewTurns: 1, reviewAfter: '1s', maxActiveTime: '1s' });
  assert.equal(f.ledger.summary().reviewPolicy, 'continue');
  fs.appendFileSync(f.roadmap, '- [ ] GAP-01 Unreviewed supporting work.\n');
  f.turn('partial', 1000);
  assert.equal(f.ledger.reason(), 'active_time_budget');
  const before = f.ledger.summary();
  const renewal = f.ledger.continueReview();
  assert.ok(fs.existsSync(renewal.request.requestFile));
  assert.ok(fs.existsSync(renewal.decisionFile));
  assert.equal(f.ledger.reason(), null);
  assert.equal(f.ledger.summary().activeMs, before.activeMs);
  assert.equal(f.ledger.summary().closureAgeMs, before.closureAgeMs);
  assert.deepEqual(f.ledger.summary().original, before.original);
  assert.equal(f.ledger.summary().approvedSubgaps, 0);
  assert.equal(f.ledger.state.reviews.length, 1);
  f.turn('partial', 1);
  assert.equal(f.ledger.reason(), 'acceptance_plateau_turns');
  f.ledger.continueReview();
  assert.equal(f.ledger.state.reviews.length, 2);
  assert.equal(f.ledger.summary().workerTurns, 2);
  assert.equal(readProgressStatus(f.ledger.file).reviewPolicy, 'continue');
  assert.equal(new ProgressLedger(f.config).summary().reviewPolicy, 'continue');
});

test('explicit park policy rejects automatic renewal and a default restart can acknowledge its request', t => {
  const f = fixture(t, undefined, { progressReviewPolicy: 'park', reviewTurns: 1 }); f.turn();
  const pending = f.ledger.requestReview(f.ledger.reason());
  assert.throws(() => f.ledger.continueReview(), /requires the continue policy/);
  assert.throws(() => progressSettings({ progressReviewPolicy: 'ignore' }), /progressReviewPolicy/);
  const restart = new ProgressLedger({ ...f.config, options: { reviewTurns: 1 } });
  assert.equal(restart.continueReview().request.id, pending.id);
  assert.equal(restart.reason(), null);
  assert.equal(restart.state.reviews.length, 1);
});
