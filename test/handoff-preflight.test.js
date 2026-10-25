import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateHandoff, contentHash } from '../lib/handoff.js';
import { RunManager } from '../dist/run-manager.js';

const cli = fileURLToPath(new URL('../bin/roadmap-runner.js', import.meta.url));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-handoff-preflight-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const roadmap = path.join(dir, 'source.md'), progress = path.join(dir, 'progress.md');
  fs.writeFileSync(roadmap, '# Roadmap\nStatus: IN_PROGRESS\n## Work\n- [ ] Deliver\n');
  fs.writeFileSync(progress, '# Progress\nStatus: IN_PROGRESS\n## Handoff\nRetained evidence\n');
  const spec = () => ({ roadmap: 'source.md', progressFile: 'progress.md', sourceRevision: contentHash(fs.readFileSync(roadmap)), expectedHash: contentHash(fs.readFileSync(progress)), contents: '# Progress\nStatus: IN_PROGRESS\n## Handoff\nNext exact action\n' });
  return { dir, roadmap, progress, spec };
}

test('invalid progress fails before readiness or model dispatch and preserves all queue bytes', async t => {
  const f = fixture(t); fs.writeFileSync(f.progress, '# Progress\n\nStatus: INVALID\n');
  const later = path.join(f.dir, 'later.md'); fs.writeFileSync(later, 'Status: IN_PROGRESS\n- [ ] Later\n');
  const files = [f.roadmap, f.progress, later], before = files.map(file => fs.readFileSync(file, 'utf8'));
  const client = path.join(f.dir, 'client.cjs'); fs.writeFileSync(client, '#!/usr/bin/env node\nrequire("node:fs").appendFileSync("invocations", "1");\n', { mode: 0o755 });
  const manager = new RunManager(f.dir, path.join(f.dir, 'registry'));
  await assert.rejects(manager.start({ workspace: f.dir, roadmap: f.roadmap, progressFile: f.progress, queue: [{ roadmap: later }], notify: 'off' }, { executable: client }), /progress.md:3: invalid/);
  assert.equal(fs.existsSync(path.join(f.dir, 'invocations')), false);
  assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), before);
  assert.equal(fs.readdirSync(path.join(f.dir, 'registry', 'runs')).length, 0);
});

test('invalid queued source is rejected before the first model invocation', async t => {
  const f = fixture(t); const later = path.join(f.dir, 'later.md'); fs.writeFileSync(later, 'Status: INVALID\n');
  const manager = new RunManager(f.dir, path.join(f.dir, 'registry'));
  await assert.rejects(manager.start({ workspace: f.dir, roadmap: f.roadmap, queue: [{ roadmap: later }], notify: 'off' }), /later.md:1: invalid/);
  assert.equal(fs.readdirSync(path.join(f.dir, 'registry', 'runs')).length, 0);
});

test('handoff replacement validates candidate, stale progress and source criteria before writing', t => {
  const f = fixture(t); const initial = fs.readFileSync(f.progress, 'utf8'), spec = f.spec();
  assert.throws(() => updateHandoff({ ...spec, contents: '# Progress\nStatus: INVALID\n' }, { workdir: f.dir }), /progress.md:2/);
  assert.equal(fs.readFileSync(f.progress, 'utf8'), initial);
  assert.throws(() => updateHandoff({ ...spec, sourceRevision: 'stale' }, { workdir: f.dir }), /criteria binding/);
  const result = updateHandoff(spec, { workdir: f.dir }); assert.equal(result.sha256, contentHash(spec.contents));
  assert.throws(() => updateHandoff(spec, { workdir: f.dir }), /Stale handoff/);
  assert.equal(fs.readFileSync(f.progress, 'utf8'), spec.contents);
  assert.equal(fs.existsSync(f.progress + '.update.lock'), false);
  assert.equal(fs.readdirSync(f.dir).some(name => name.endsWith('.handoff')), false);
});

test('CLI exposes the same validated atomic handoff helper', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.dir, 'update.json'), JSON.stringify(f.spec()));
  const result = spawnSync(process.execPath, [cli, 'update-handoff', '--spec', 'update.json', '--workspace', f.dir], { encoding: 'utf8', env: {}, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).sha256, contentHash(f.spec().contents));
});

test('readiness rejects a terminal initialization failure even after readyAt; rapid completion is valid', async t => {
  const f = fixture(t), manager = new RunManager(f.dir, path.join(f.dir, 'registry'));
  let record = { id: 'prepared', readyAt: new Date().toISOString(), processState: 'unknown', reason: 'invalid progress state' };
  manager.get = () => record; manager.reconcile = async value => value;
  await assert.rejects(manager.ready('prepared'), /failed to initialize: invalid progress state/);
  record = { ...record, processState: 'exited', reason: 'complete', exitCode: 0 };
  assert.equal((await manager.ready('prepared')).exitCode, 0);
});
