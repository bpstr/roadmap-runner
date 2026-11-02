import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { trackingPaths } from '../lib/tracking.js';
import { RoadmapPlan } from '../lib/task-plan.js';
import { RunManager } from '../dist/run-manager.js';
import { runLifecycle } from '../dist/lifecycle.js';
import { parseArgs } from '../lib/runner.js';

const cli = fileURLToPath(new URL('../bin/roadmap-runner.js', import.meta.url));
// Serialized executable: only prepared file operations, never a provider client.
function preparedClient(mode) {
  const fs = require('node:fs');
  const assert = require('node:assert/strict');
  const prompt = process.argv.at(-1);
  const binding = JSON.parse(prompt.match(/^Result binding: (.+)$/m)[1]);
  const resultFile = JSON.parse(prompt.match(/^Optional structured result file: (.+)$/m)[1]);
  const calls = fs.existsSync('calls.json') ? JSON.parse(fs.readFileSync('calls.json')) : [];
  calls.push(binding); fs.writeFileSync('calls.json', JSON.stringify(calls));
  if (mode === 'slow') { setTimeout(() => {}, 20000); return; }
  const repaired = (mode === 'handoff' && calls.length > 1) || (mode === 'continue' && calls.length === 3);
  if (repaired && mode === 'handoff') {
    const packet = JSON.parse(fs.readFileSync(JSON.parse(prompt.match(/^Task continuation packet \(\d+ bytes\): (.+)$/m)[1])));
    assert.equal(packet.priorOutcome, null); assert.equal(packet.continuationSuperseded, true);
    assert.match(prompt, /current reviewed handoff supersedes historical nextAction/);
    assert.match(fs.readFileSync('progress.md', 'utf8'), /Reviewed repair handoff/);
  }
  if (repaired) fs.writeFileSync('roadmap.md', fs.readFileSync('roadmap.md', 'utf8').replace('[ ] DEMO', '[x] DEMO'));
  if (mode === 'churn') fs.appendFileSync('roadmap.md', `\nContribution note ${calls.length}.\n- [ ] GAP-${calls.length} Unreviewed supporting work.\n`);
  fs.writeFileSync(resultFile, JSON.stringify({ ...binding, operation: `supporting-operation-${calls.length}`, outcome: 'implemented',
    scheduling: 'continue', completed: ['Supporting work'], remaining: ['Original acceptance'], nextAction: 'Resume obsolete export checkpoint.',
    changedFiles: [], receiptIds: [], findings: [] }));
  fs.writeFileSync('progress.md', 'Status: ' + (repaired ? 'COMPLETE' : 'IN_PROGRESS') + '\nPrepared worker handoff.\n');
  // Independent fixture containment; the controller should park before this.
  if (calls.length > 8) process.exitCode = 99;
}
function fixture(t, mode = 'churn') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-closure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const roadmap = path.join(dir, 'roadmap.md'), progress = path.join(dir, 'progress.md'), client = path.join(dir, 'prepared.cjs');
  fs.writeFileSync(roadmap, 'Status: IN_PROGRESS\n- [ ] DEMO-01 Deliver the operation.\n');
  fs.writeFileSync(progress, 'Status: IN_PROGRESS\nInitial handoff.\n');
  fs.writeFileSync(client, `#!/usr/bin/env node\n(${preparedClient.toString()})(${JSON.stringify(mode)});\n`, { mode: 0o700 });
  const state = trackingPaths(roadmap, progress, dir);
  return { dir, roadmap, progress, client, state, ledger: () => JSON.parse(fs.readFileSync(path.join(state.stateDir, 'progress-ledger.json'))),
    events: () => fs.readFileSync(progress + '.events.jsonl', 'utf8').trim().split('\n').map(JSON.parse),
    run: (args = []) => spawnSync(process.execPath, [cli, roadmap, '--progress-file', progress, '--client-bin', client,
      '--no-session-continuation', '--notify', 'off', '--timeout', '3s', ...args], { cwd: dir,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', ROADMAP_STATE_DIR: path.join(dir, 'registry') }, encoding: 'utf8', timeout: 15000 }) };
}
const assertRun = (result, code) => { assert.ifError(result.error); assert.equal(result.status, code, result.stderr + result.stdout); };

test('default CLI policy passes repeated plateau reviews and reaches source completion', t => {
  const f = fixture(t, 'continue');
  assertRun(f.run(['--review-turns', '1']), 0);
  assert.equal(f.ledger().workerTurns, 3);
  assert.equal(f.ledger().reviews.length, 2);
  assert.equal(f.ledger().criteria[0].checked, true);
  assert.equal(f.ledger().pending, undefined);
  assert.equal(f.events().filter(e => e.type === 'runner.progress_reviewed' && e.reason === 'automatic_continue_policy' && e.authority === 'configured-policy').length, 2);
  assert.equal(f.events().some(e => e.type === 'runner.progress_review_required'), false);
});

test('direct lifecycle calls default to continuing through plateau reviews', async t => {
  const f = fixture(t, 'continue');
  const options = parseArgs([f.roadmap, '--progress-file', f.progress, '--client-bin', f.client,
    '--no-session-continuation', '--notify', 'off', '--timeout', '3s', '--review-turns', '1'], {});
  delete options.progressReviewPolicy;
  const result = await runLifecycle(options, { workdir: f.dir });
  assert.equal(result.code, 0);
  assert.equal(f.ledger().reviewPolicy, 'continue');
  assert.equal(f.ledger().reviews.length, 2);
  assert.equal(f.ledger().criteria[0].checked, true);
});

test('managed workers default to continue in options and status', async t => {
  const f = fixture(t, 'continue');
  const manager = new RunManager(f.dir, path.join(f.dir, 'managed-registry'));
  const run = await manager.start({ workspace: f.dir, roadmap: f.roadmap, progressFile: f.progress,
    notify: 'off', sessionContinuation: false, timeout: '3s', reviewTurns: 1 },
    { executable: f.client }, true);
  const status = await manager.status(run.id);
  assert.equal(status.reason, 'complete');
  assert.equal(status.options.progressReviewPolicy, 'continue');
  assert.equal(status.progress.reviewPolicy, 'continue');
  assert.equal(status.progress.pendingReview, null);
  assert.equal(f.ledger().reviews.length, 2);
});

test('broad workers park after four contributions despite changed hashes; restart cannot reset the review', t => {
  const f = fixture(t); assertRun(f.run(['--progress-review-policy', 'park']), 75);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'calls.json'))).length, 4);
  const event = f.events().find(e => e.type === 'runner.progress_review_required');
  assert.equal(event.reason, 'acceptance_plateau_turns'); assert.equal(event.attention, true); assert.equal(event.notificationMode, 'off');
  assert.equal(event.attentionFingerprint, event.reviewId);
  const growth = f.events().filter(e => e.type === 'runner.scope_changed');
  assert.equal(growth.length, 4); assert.equal(new Set(growth.map(e => e.attentionFingerprint)).size, 4);
  assert.ok(growth.every(e => e.attention && e.attentionFingerprint === e.sourceRevision));
  assert.equal(event.progress.additions.remaining, 4);
  assert.equal(event.progress.original.remaining, 1); assert.equal(event.progress.contributions.implemented, 4);
  assert.equal(event.progress.pendingReview.acknowledged, false); assert.ok(fs.existsSync(event.requestFile));
  assert.match(f.events().find(e => e.type === 'runner.started').runtime.bundleHash, /^[a-f0-9]{64}$/);
  assert.ok(f.events().filter(e => e.type === 'runner.turn_finished').every(e => e.progressScopeFile && e.criteriaRevision && e.runtimeBundleHash));
  assertRun(f.run(['--progress-review-policy', 'park', '--review-turns', '100', '--review-after', '12h', '--recover-blocked']), 75);
  assert.equal(new Set(f.events().filter(e => e.type === 'runner.scheduling' && e.mode === 'broad').map(e => e.runId)).size, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'calls.json'))).length, 4);
  assert.match(fs.readFileSync(f.roadmap, 'utf8'), /\[ \] DEMO/);
});

test('reviewed repair handoff supersedes obsolete continuation, with history retained', t => {
  const f = fixture(t, 'handoff'); assertRun(f.run(['--progress-review-policy', 'park', '--review-turns', '1']), 75);
  const ledger = f.ledger(), review = path.join(f.dir, 'review.json');
  fs.writeFileSync(f.progress, 'Status: IN_PROGRESS\nReviewed repair handoff. Close DEMO-01.\n');
  fs.writeFileSync(review, JSON.stringify({ version: 1, reviewId: ledger.pending.id, sourceRevision: ledger.sourceRevision,
    decision: 'extend', reason: 'Reviewed repair supersedes export checkpoint.', gapKeys: [ledger.criteria[0].key], additionalTurns: 2, additionalActiveTime: '1h' }));
  assertRun(f.run(['--progress-review-policy', 'park', '--progress-review', review]), 0);
  assert.equal(f.ledger().reviews.length, 1); assert.equal(f.ledger().workerTurns, 2);
  assert.equal(f.ledger().criteria[0].checked, true);
  assert.ok(f.events().some(e => e.type === 'runner.handoff_reconciled'));
  const history = fs.readdirSync(path.join(f.state.stateDir, 'task-memory')).map(file => JSON.parse(fs.readFileSync(path.join(f.state.stateDir, 'task-memory', file))));
  assert.equal(history[0].records.length, 2); assert.equal(history[0].records[0].outcome.nextAction, 'Resume obsolete export checkpoint.');
});

test('cumulative active time caps a long client session and parks without a second worker', t => {
  const f = fixture(t, 'slow'); assertRun(f.run(['--progress-review-policy', 'park', '--max-active-time', '300ms', '--review-after', '5s']), 75);
  assert.equal(f.ledger().workerTurns, 1); assert.ok(f.ledger().activeMs >= 300);
  assert.equal(f.ledger().pending.reason, 'active_time_budget');
});

test('fallback diagnostics distinguish flat format, orphan checkboxes and oversized focused contracts', t => {
  const f = fixture(t); fs.mkdirSync(f.state.stateDir, { recursive: true });
  const plan = new RoadmapPlan(f.roadmap, f.dir, f.state);
  assert.ok(plan.scheduling.reasons.some(r => r.code === 'flat_format'));
  const section = '### Task DEMO-01\n- [ ] DEMO-01 Deliver.\nDependencies: none.\nAcceptance: Works.\n';
  fs.writeFileSync(f.roadmap, '- [ ] ORPHAN-01 Validate.\n' + section); plan.read();
  assert.ok(plan.scheduling.reasons.some(r => r.code === 'orphan_checkboxes' && r.count === 1));
  fs.writeFileSync(f.roadmap, section + 'a'.repeat(25 * 1024)); plan.read();
  assert.ok(plan.scheduling.reasons.some(r => r.code === 'oversized_contract' && r.bytes > r.limitBytes));
  fs.writeFileSync(f.roadmap, section); plan.read(); assert.equal(plan.scheduling.mode, 'focused');
});

test('managed status retains parked review, scheduling and runtime identity when desktop delivery is disabled', async t => {
  const f = fixture(t), registry = path.join(f.dir, 'managed-registry');
  const manager = new RunManager(f.dir, registry);
  const run = await manager.start({ workspace: f.dir, roadmap: f.roadmap, progressFile: f.progress, notify: 'off', sessionContinuation: false, timeout: '3s', progressReviewPolicy: 'park' }, { executable: f.client }, true);
  const status = await manager.status(run.id);
  assert.equal(status.reason, 'review_required'); assert.equal(status.roadmapState, 'review_required');
  assert.equal(status.waitReason, 'progress_review'); assert.equal(status.queue[0].state, 'review_required');
  assert.equal(status.scheduling.mode, 'broad'); assert.equal(status.progress.activeMs, f.ledger().activeMs);
  assert.equal(status.progress.pendingReview.acknowledged, false); assert.equal(status.notificationMode, 'off');
  assert.equal(status.scheduledSupervision, false); assert.match(status.runtime.bundleHash, /^[a-f0-9]{64}$/);
});
