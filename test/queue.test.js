import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RunManager } from '../dist/run-manager.js';
import { readRun } from '../dist/run-state.js';

const cli = fileURLToPath(new URL('../bin/roadmap-runner.js', import.meta.url));
const wait = async check => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('Queue fixture deadline exceeded');
};
const fixture = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-queue-'));
  const registry = path.join(dir, 'registry'); const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  const roadmaps = ['first', 'second', 'third'].map(name => { const file = path.join(workspace, `${name}.md`); fs.writeFileSync(file, `# ${name}\n- [ ] Implement fixture\n`); return file; });
  const worker = path.join(dir, 'mock-client.mjs');
  fs.writeFileSync(worker, `#!${process.execPath}
import fs from 'node:fs';
const prompt = process.argv.at(-1);
const source = prompt.match(/Work on this implementation roadmap:\\s*\\n\\s*([^\\n]+)/)[1].trim();
const progress = prompt.match(/Tracking file \\(progress \\/ delivery evidence\\):\\s*\\n\\s*([^\\n]+)/)[1].trim();
fs.appendFileSync(source + '.started', progress + '\\n');
if (fs.existsSync(source + '.fail')) process.exit(7);
if (fs.existsSync(source + '.blocked')) fs.writeFileSync(progress, fs.readFileSync(progress, 'utf8').replace('IN_PROGRESS', 'BLOCKED'));
const timer = setInterval(() => {
  if (!fs.existsSync(source + '.release')) return;
  fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('- [ ] Implement fixture', '- [x] Implement fixture'));
  fs.writeFileSync(progress, fs.readFileSync(progress, 'utf8').replace(/IN_PROGRESS|BLOCKED/, 'COMPLETE'));
  clearInterval(timer);
}, 20);
`, { mode: 0o755 });
  const manager = new RunManager(workspace, registry); const runs = [];
  t.after(async () => {
    for (const id of runs) { try { await manager.stop(id); await wait(async () => ['exited', 'stopped', 'unknown'].includes((await manager.status(id)).processState)); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const start = async (queue, idempotencyKey, options = {}) => { const r = await manager.start({ workspace, roadmap: roadmaps[0], queue, idempotencyKey, notify: 'off', supervisorEvery: 0, ...options }, { executable: worker }); runs.push(r.id); return r; };
  const release = file => fs.writeFileSync(file + '.release', '');
  const started = file => fs.existsSync(file + '.started');
  const command = async args => {
    const child = spawn(process.execPath, [cli, ...args, '--workspace', workspace], { env: { ...process.env, ROADMAP_STATE_DIR: registry, ROADMAP_NOTIFY: 'off' } });
    let output = '', error = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => error += chunk);
    const code = await new Promise(resolve => child.once('exit', resolve)); assert.equal(code, 0, error); return output;
  };
  return { dir, workspace, registry, roadmaps, manager, worker, runs, start, release, started, command };
};

test('queued roadmaps advance in FIFO order, preserve separate progress, and keep global event cursors', async t => {
  const f = fixture(t); const [first, second, third] = f.roadmaps;
  const queue = [{ roadmap: second }, { roadmap: third }];
  const run = await f.start(queue, 'queue-start');
  assert.equal((await f.start(queue, 'queue-start')).id, run.id);
  await assert.rejects(f.start([{ roadmap: third }], 'queue-start'), /different options/);
  await wait(() => f.started(first)); assert.equal(f.started(second), false);
  assert.deepEqual(run.queue.map(item => item.state), ['running', 'pending', 'pending']);
  assert.equal(new Set(run.queue.map(item => item.progressFile)).size, 3);
  const cursor = (await f.manager.status(run.id)).cursor;
  f.release(first); await wait(() => f.started(second)); assert.equal(f.started(third), false);
  const active = await f.manager.status(run.id); assert.equal(active.roadmap, fs.realpathSync(second)); assert.equal(active.queueIndex, 1); assert.equal(active.roadmapState, 'in_progress');
  await assert.rejects(f.start([]), /reserved/);
  f.release(second); await wait(() => f.started(third)); f.release(third);
  const final = await wait(async () => { const s = await f.manager.status(run.id); return s.processState === 'exited' && s; });
  assert.equal(final.exitCode, 0); assert.equal(final.reason, 'complete');
  assert.deepEqual(final.queue.map(item => item.state), ['complete', 'complete', 'complete']);
  assert.equal(final.events.filter(event => event.type === 'runner.completed').length, 1);
  assert.equal(final.events.filter(event => event.type === 'runner.roadmap_completed').length, 2);
  assert.equal(final.events.filter(event => event.type === 'runner.started').length, 3);
  assert.deepEqual(final.events.map(event => event.sequence), final.events.map((_, i) => i + 1));
  const page = await f.manager.status(run.id, { cursor }); assert.ok(page.events.every(event => event.sequence > cursor));
  for (const file of f.roadmaps) assert.ok(!fs.readFileSync(file, 'utf8').includes('COMPLETE'));
  for (const lock of readRun(f.registry, run.id).locks) assert.equal(fs.existsSync(lock), false);
});

test('macOS sleep prevention spans queue handoff and releases at completion', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t); const [first, second] = f.roadmaps;
  const run = JSON.parse(await f.command(['start', first, '--queue', second, '--prevent-sleep', '--client', 'codex', '--client-bin', f.worker, '--supervisor-every', '0', '--json']));
  f.runs.push(run.id);
  assert.equal(run.options.preventSleep, true); assert.equal(run.sleepInhibition.state, 'active');
  f.release(first); await wait(() => f.started(second));
  assert.equal((await f.manager.status(run.id)).sleepInhibition.state, 'active');
  f.release(second);
  const final = await wait(async () => { const s = await f.manager.status(run.id); return s.processState === 'exited' && s; });
  assert.equal(final.sleepInhibition.state, 'released');
});

test('macOS sleep prevention releases when a queued run is stopped', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t); const [first, second] = f.roadmaps;
  const run = await f.start([{ roadmap: second }], undefined, { preventSleep: true });
  await wait(() => f.started(first));
  await f.manager.stop(run.id);
  const final = await wait(async () => { const s = await f.manager.status(run.id); return s.processState === 'stopped' && s; });
  assert.equal(final.sleepInhibition.state, 'released'); assert.equal(f.started(second), false);
});

test('CLI queue appends to an active run and rejects duplicates and terminal runs', async t => {
  const f = fixture(t); const [first, second] = f.roadmaps; const run = await f.start([]);
  const queued = JSON.parse(await f.command(['queue', run.id, second, '--json'])); assert.equal(queued.queue[1].state, 'pending');
  await assert.rejects(f.manager.enqueue(run.id, { roadmap: second }), /distinct/);
  f.release(first); await wait(() => f.started(second)); f.release(second);
  await wait(async () => (await f.manager.status(run.id)).processState === 'exited');
  await assert.rejects(f.manager.enqueue(run.id, { roadmap: f.roadmaps[2] }));
});

test('a blocked or failed roadmap never starts the next queued roadmap', async t => {
  for (const mode of ['blocked', 'fail']) {
    const f = fixture(t); const [first, second] = f.roadmaps; fs.writeFileSync(first + '.' + mode, '');
    const run = await f.start([{ roadmap: second }]); await wait(() => f.started(first));
    if (mode === 'blocked') {
      await wait(() => fs.readFileSync(run.progressFile, 'utf8').includes('BLOCKED')); await f.manager.stop(run.id);
    }
    const final = await wait(async () => { const s = await f.manager.status(run.id); return ['exited', 'stopped'].includes(s.processState) && s; });
    assert.equal(f.started(second), false); assert.equal(final.queue[1].state, 'pending');
    assert.equal(final.queue[0].state, mode === 'blocked' ? 'stopped' : 'failed');
    assert.equal(final.exitCode, mode === 'blocked' ? 130 : 7);
  }
});

test('all queue entries are validated before launch, including path and progress aliases', async t => {
  const f = fixture(t); const [first, second] = f.roadmaps;
  await assert.rejects(f.start([{ roadmap: second, progressFile: first }]), /separate/);
  await assert.rejects(f.start([{ roadmap: second, progressFile: '../outside.md' }]), /inside/);
  const alias = path.join(f.workspace, 'alias.md'); fs.symlinkSync(first, alias);
  await assert.rejects(f.start([{ roadmap: alias }]), /distinct/);
  const hardlink = path.join(f.workspace, 'hardlink.md'); fs.linkSync(first, hardlink);
  await assert.rejects(f.start([{ roadmap: second, progressFile: hardlink }]), /separate/);
  await assert.rejects(f.start([{ roadmap: 'missing.md' }]), /ENOENT/);
  assert.equal(f.started(first), false);
});

test('foreground CLI accepts repeated --queue flags and completes every roadmap', async t => {
  const f = fixture(t); for (const file of f.roadmaps) f.release(file);
  const output = await f.command([f.roadmaps[0], '--queue', f.roadmaps[1], '--queue', f.roadmaps[2], '--client-bin', f.worker, '--supervisor-every', '0']);
  assert.equal((output.match(/Roadmap complete after/g) || []).length, 3);
  assert.ok(f.roadmaps.every(f.started));
});

test('a queued source removed before handoff fails the run and preserves later entries', async t => {
  const f = fixture(t); const [first, second, third] = f.roadmaps;
  const run = await f.start([{ roadmap: second }, { roadmap: third }]);
  fs.rmSync(second); f.release(first);
  const final = await wait(async () => { const s = await f.manager.status(run.id); return s.processState === 'exited' && s; });
  assert.equal(final.exitCode, 1); assert.equal(final.queue[1].state, 'failed'); assert.equal(final.queue[2].state, 'pending');
  assert.equal(f.started(third), false);
});
