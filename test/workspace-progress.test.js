import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspaceFingerprint } from '../lib/workspace-progress.js';
import { Recovery, recoverySettings } from '../lib/recovery.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-workspace-progress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir }).status, 0);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n');
  fs.writeFileSync(path.join(dir, 'feature.ts'), 'export const value = 0;\n');
  assert.equal(spawnSync('git', ['add', '.'], { cwd: dir }).status, 0);
  return { dir, snapshot: () => workspaceFingerprint(dir) };
}

test('implementation snapshots include staged, unstaged, untracked and deleted source bytes', t => {
  const f = fixture(t), initial = f.snapshot();
  fs.writeFileSync(path.join(f.dir, 'feature.ts'), 'export const value = 1;\n');
  const updated = f.snapshot();
  assert.notEqual(updated, initial);
  spawnSync('git', ['add', '.'], { cwd: f.dir });
  assert.equal(f.snapshot(), updated, 'staging is not progress');
  fs.writeFileSync(path.join(f.dir, 'new.test.ts'), 'test("new behavior");\n');
  const added = f.snapshot();
  assert.notEqual(added, updated);
  fs.unlinkSync(path.join(f.dir, 'feature.ts'));
  const deleted = f.snapshot();
  assert.notEqual(deleted, added);
  spawnSync('git', ['add', '-u'], { cwd: f.dir });
  assert.equal(f.snapshot(), deleted, 'staging a deletion is not new progress');
});

test('ignored artifacts, docs, logs, receipts, timestamps and excluded tracking do not count', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'tracking.json'), '{}');
  const snapshot = () => workspaceFingerprint(f.dir, [path.join(f.dir, 'tracking.json'), path.join(f.dir, 'registry')]);
  const initial = snapshot();
  for (const file of ['notes.md', 'worker.log', 'events.jsonl', 'ignored/model.py', 'evidence/result.json', 'docs/example.js', 'registry/runs/state.json']) {
    fs.mkdirSync(path.dirname(path.join(f.dir, file)), { recursive: true });
    fs.writeFileSync(path.join(f.dir, file), 'new evidence');
  }
  fs.writeFileSync(path.join(f.dir, 'tracking.json'), '{"iteration":2}');
  fs.utimesSync(path.join(f.dir, 'feature.ts'), new Date(), new Date());
  assert.equal(snapshot(), initial);
});

test('seen implementation states persist across restarts and repeated A/B states exhaust the budget', async t => {
  const f = fixture(t);
  const config = { tracking: { file: path.join(f.dir, 'progress.md') }, roadmap: path.join(f.dir, 'roadmap.md'),
    settings: { ...recoverySettings({}), delayMs: 1, maxDelayMs: 1 }, wait: async () => false };
  const a = f.snapshot();
  fs.writeFileSync(path.join(f.dir, 'feature.ts'), 'export const value = 1;\n');
  const b = f.snapshot();
  let recovery = new Recovery(config);
  await recovery.idle('- [ ] T1 acceptance', '- [ ] T1 acceptance', false, { before: a, after: b });
  assert.equal(recovery.state.idle, 0);
  recovery = new Recovery(config);
  await recovery.idle('', '', false, { before: b, after: a });
  await recovery.idle('', '', false, { before: a, after: b });
  await assert.rejects(recovery.idle('', '', false, { before: b, after: a }), e => e.reason === 'no_progress_limit');
  assert.equal(recovery.state.idle, 3);
});

test('runner exclusions resolve directory aliases including the macOS temporary directory alias', t => {
  const f = fixture(t);
  const alias = f.dir + '-alias';
  fs.symlinkSync(f.dir, alias, 'dir');
  t.after(() => fs.unlinkSync(alias));
  const snapshot = () => workspaceFingerprint(fs.realpathSync(f.dir), [path.join(alias, 'registry')]);
  const initial = snapshot();
  fs.mkdirSync(path.join(f.dir, 'registry'), { recursive: true });
  fs.writeFileSync(path.join(f.dir, 'registry', 'state.json'), '{"heartbeat":1}');
  assert.equal(snapshot(), initial);
});

test('missing observations cannot renew the idle budget', async t => {
  const f = fixture(t);
  const recovery = new Recovery({ tracking: { file: path.join(f.dir, 'progress.md') }, roadmap: path.join(f.dir, 'roadmap.md'), settings: recoverySettings({}) });
  await recovery.idle('', '', false, { before: null, after: f.snapshot() });
  assert.equal(recovery.state.idle, 1);
});
