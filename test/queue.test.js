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
const source = JSON.parse(prompt.match(/^Live roadmap[^:]*: (.+)$/m)[1]);
const progress = prompt.match(/Tracking file \\(progress \\/ delivery evidence\\):\\s*\\n\\s*([^\\n]+)/)[1].trim();
if (prompt.includes('Runner role: RESOLVER')) {
  if (fs.existsSync(source + '.repair')) {
    fs.writeFileSync(progress, fs.readFileSync(progress, 'utf8').replace(/BLOCKED|STOPPED/, 'IN_PROGRESS'));
    fs.writeFileSync(JSON.parse(prompt.match(/^Resolution decision file: (.+)$/m)[1]), JSON.stringify({
      resolutionId: prompt.match(/^Resolution ID: (.+)$/m)[1], outcome: 'resolved', evidence: 'Prepared prerequisite repaired', nextAction: 'Continue preserved FIFO' }));
    process.exit(0);
  }
  fs.writeFileSync(progress, 'Status: STOPPED\\n## Current handoff\\nDependency unavailable.\\n'); process.exit(0);
}
fs.appendFileSync(source + '.started', progress + '\\n');
if (fs.existsSync(source + '.fail')) process.exit(7);
if (fs.existsSync(source + '.loop') && fs.readFileSync(source + '.started', 'utf8').trim().split('\\n').length >= 3) { fs.writeFileSync(progress, 'Status: BLOCKED\\n'); process.exit(0); }
if (fs.existsSync(source + '.stall')) {
  fs.writeFileSync(progress, 'Status: IN_PROGRESS\\n## Tasks\\n- [ ] T01 build\\n## Current handoff\\nStill waiting ' + Date.now() + '\\n');
  process.exit(0);
}
if (fs.existsSync(source + '.blocked')) { fs.writeFileSync(progress, 'Status: BLOCKED\\n'); process.exit(0); }
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
    for (const source of roadmaps) if (fs.existsSync(source + '.reviewdir')) fs.rmSync(fs.readFileSync(source + '.reviewdir', 'utf8'), { recursive: true, force: true });
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
  fs.writeFileSync(second, '# second\nStatus: NOT_STARTED\n\n- [ ] Implement fixture\n');
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
  const final = await wait(async () => { const s = await f.manager.status(run.id); return ['exited', 'stopped'].includes(s.processState) && s; });
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

test('live source completion survives restart, unlocks a dependent once and advances the preserved queue', async t => {
  const f = fixture(t); const [first, second] = f.roadmaps;
  const source = '# Completion contract\nStatus: IN_PROGRESS\n\n' +
    '### Task DOC-01 Parent\n- [ ] DOC-01 Verify parent fixture.\nDependencies: none.\nAcceptance: Parent fixture passes.\n\n' +
    '### Task DOC-02 Dependent\n- [ ] DOC-02 Verify dependent fixture.\nDependencies: DOC-01.\nAcceptance: Dependent fixture passes.\n';
  fs.writeFileSync(first, source);
  const progress = [path.join(f.workspace, 'parent-evidence.md'), path.join(f.workspace, 'next-evidence.md')];
  fs.writeFileSync(f.worker, `#!${process.execPath}
import fs from 'node:fs';
import assert from 'node:assert/strict';
const prompt = process.argv.at(-1);
assert.ok(!prompt.includes('Runner role: RESOLVER'), 'no recovery redispatch for completed work');
const file = JSON.parse(prompt.match(/^Live roadmap[^:]*: (.+)$/m)[1]);
const progress = prompt.match(/Tracking file \\(progress \\/ delivery evidence\\):\\s*\\n\\s*([^\\n]+)/)[1].trim();
let source = fs.readFileSync(file, 'utf8');
if (source.includes('DOC-01')) {
  const task = source.includes('- [ ] DOC-01') ? 'DOC-01' : 'DOC-02';
  const snapshot = fs.readFileSync(JSON.parse(prompt.match(/^Selected original task snapshot: (.+)$/m)[1]), 'utf8');
  assert.ok(snapshot.includes('- [ ] ' + task), 'scheduler selected the expected original task');
  fs.appendFileSync(file + '.tasks', task + '\\n');
  source = source.replace('- [ ] ' + task, '- [x] ' + task);
  fs.writeFileSync(file, source);
  fs.writeFileSync(progress, 'Status: ' + (task === 'DOC-01' ? 'STOPPED' : 'COMPLETE') + '\\nParent fixture evidence retained.\\n');
} else {
  fs.appendFileSync(file + '.tasks', 'next\\n');
  fs.writeFileSync(file, source.replace('- [ ]', '- [x]'));
  fs.writeFileSync(progress, 'Status: COMPLETE\\nNext queued source verified.\\n');
}
`);
  const queue = [{ roadmap: second, progressFile: progress[1] }];
  const run = await f.start(queue, undefined, { progressFile: progress[0], sessionContinuation: false });
  const stopped = await wait(async () => { const s = await f.manager.status(run.id); return ['exited', 'stopped'].includes(s.processState) && s; });
  assert.equal(stopped.reason, 'stopped');
  assert.deepEqual(stopped.queue.map(item => item.state), ['stopped', 'pending']);
  assert.equal(fs.readFileSync(first + '.tasks', 'utf8'), 'DOC-01\n');
  assert.equal(fs.existsSync(second + '.tasks'), false);
  const history = fs.readFileSync(progress[0], 'utf8');
  fs.writeFileSync(progress[0], history.replace('Status: STOPPED', 'Status: IN_PROGRESS'));
  const manager = new RunManager(f.workspace, f.registry);
  const resumed = await manager.start({ workspace: f.workspace, roadmap: first, queue,
    progressFile: progress[0], sessionContinuation: false, notify: 'off' }, { executable: f.worker });
  f.runs.push(resumed.id);
  const final = await wait(async () => { const s = await manager.status(resumed.id); return s.processState === 'exited' && s; });
  assert.equal(final.exitCode, 0, final.output || final.reason);
  assert.deepEqual(final.queue.map(item => item.state), ['complete', 'complete']);
  assert.deepEqual(final.queue.map(item => item.progressFile), progress.map(file => fs.realpathSync(file)));
  assert.equal(fs.readFileSync(first + '.tasks', 'utf8'), 'DOC-01\nDOC-02\n');
  assert.equal(fs.readFileSync(second + '.tasks', 'utf8'), 'next\n');
  assert.equal(fs.readFileSync(first, 'utf8').replaceAll('[x]', '[ ]'), source);
  assert.match(fs.readFileSync(progress[0], 'utf8'), /Parent fixture evidence retained/);
  assert.equal((await f.manager.status(run.id)).reason, 'stopped', 'original stopped run remains recorded');
});

test('default Codex continuation resumes within each roadmap and clears before the next queue entry', async t => {
  const f = fixture(t); const [first, second] = f.roadmaps;
  fs.writeFileSync(f.worker, `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const prompt = process.argv.at(-1);
const source = JSON.parse(prompt.match(/^Live roadmap[^:]*: (.+)$/m)[1]);
const progress = prompt.match(/Tracking file \\(progress \\/ delivery evidence\\):\\s*\\n\\s*([^\\n]+)/)[1].trim();
const callsFile = source + '.calls';
const calls = fs.existsSync(callsFile) ? JSON.parse(fs.readFileSync(callsFile, 'utf8')) : [];
calls.push(process.argv.slice(2, -1)); fs.writeFileSync(callsFile, JSON.stringify(calls));
console.log(JSON.stringify({ type: 'thread.started', thread_id: path.basename(source, '.md') + '-thread' }));
const finish = complete => {
  if (complete) fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('- [ ]', '- [x]'));
  fs.writeFileSync(progress, 'Status: ' + (complete ? 'COMPLETE' : 'IN_PROGRESS') + '\\n\\n## Current handoff\\nFinish prepared work.\\n');
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 128, cached_input_tokens: 0, output_tokens: 32 } }));
};
if (calls.length === 1) finish(false);
else if (calls.length === 2) {
  const timer = setInterval(() => { if (fs.existsSync(source + '.release')) { clearInterval(timer); finish(true); } }, 20);
} else process.exit(98);
`);
  const run = await f.start([{ roadmap: second }]);
  assert.equal(readRun(f.registry, run.id).options.sessionContinuation, true);
  const calls = file => fs.existsSync(file + '.calls') ? JSON.parse(fs.readFileSync(file + '.calls', 'utf8')) : [];
  const continuationFile = queueIndex => {
    const record = readRun(f.registry, run.id);
    assert.equal(record.queueIndex, queueIndex);
    return path.join(path.dirname(record.artifacts.evidence), 'continuation.json');
  };
  await wait(() => calls(first).length === 2);
  const firstState = continuationFile(0);
  assert.equal(fs.existsSync(firstState), true, 'first conversation exists before roadmap completion');
  assert.equal(calls(first)[0].includes('resume'), false);
  assert.ok(calls(first)[1].includes('first-thread'));
  f.release(first);
  await wait(() => calls(second).length === 2);
  const secondState = continuationFile(1);
  assert.notEqual(secondState, firstState);
  assert.equal(fs.existsSync(firstState), false, 'first conversation is released before queue advancement');
  assert.equal(fs.existsSync(secondState), true, 'second conversation exists before roadmap completion');
  assert.equal(calls(second)[0].includes('resume'), false);
  assert.ok(calls(second)[1].includes('second-thread'));
  assert.equal(calls(second).flat().includes('first-thread'), false);
  f.release(second);
  const final = await wait(async () => { const s = await f.manager.status(run.id); return s.processState === 'exited' && s; });
  assert.equal(final.reason, 'complete');
  assert.equal(fs.existsSync(firstState), false);
  assert.equal(fs.existsSync(secondState), false, 'final conversation is released after roadmap completion');
});

test('macOS sleep prevention spans queue handoff and releases at completion', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t); const [first, second] = f.roadmaps;
  const run = JSON.parse(await f.command(['start', first, '--queue', second, '--prevent-sleep', '--client', 'codex', '--client-bin', f.worker, '--supervisor-every', '0', '--json']));
  f.runs.push(run.id);
  assert.equal(run.options.preventSleep, true); assert.equal(run.sleepInhibition.state, 'active');
  f.release(first); await wait(() => f.started(second));
  assert.equal((await f.manager.status(run.id)).sleepInhibition.state, 'active');
  f.release(second);
  const final = await wait(async () => { const s = await f.manager.status(run.id); return ['exited', 'stopped'].includes(s.processState) && s; });
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
    const final = await wait(async () => { const s = await f.manager.status(run.id); return ['exited', 'stopped'].includes(s.processState) && s; });
    assert.equal(f.started(second), false); assert.equal(final.queue[1].state, 'pending');
    assert.equal(final.queue[0].state, 'stopped');
    assert.equal(final.exitCode, 75);
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
test('CLI queue specification preserves FIFO order and every custom progress path', async t => {
  const f = fixture(t); for (const file of f.roadmaps) f.release(file);
  const progress = f.roadmaps.map((_, index) => path.join(f.workspace, `custom-${index}.md`));
  const spec = path.join(f.workspace, 'queue.json');
  fs.writeFileSync(spec, JSON.stringify(f.roadmaps.slice(1).map((roadmap, index) => ({ roadmap, progressFile: progress[index + 1] }))));
  await f.command([f.roadmaps[0], '--progress-file', progress[0], '--queue-spec', spec, '--client-bin', f.worker]);
  for (let i = 0; i < f.roadmaps.length; i++) {
    assert.equal(fs.realpathSync(fs.readFileSync(f.roadmaps[i] + '.started', 'utf8').trim()), fs.realpathSync(progress[i]));
    assert.match(fs.readFileSync(progress[i], 'utf8'), /Status: COMPLETE/);
  }
});
test('authorized recovery preserves the blocked source/progress FIFO and retained receipts', async t => {
  const f = fixture(t); const [first, second, third] = f.roadmaps;
  const progress = f.roadmaps.map((_, index) => path.join(f.workspace, `resume-${index}.md`));
  const queue = [{ roadmap: second, progressFile: progress[1] }, { roadmap: third, progressFile: progress[2] }];
  fs.writeFileSync(first + '.blocked', '');
  const run = await f.start(queue, undefined, { progressFile: progress[0], blockedPolicy: 'park' });
  const parked = await wait(async () => { const value = await f.manager.status(run.id); return value.processState === 'exited' && value; });
  assert.deepEqual(parked.queue.map(item => item.state), ['blocked', 'pending', 'pending']);
  assert.equal(f.started(second), false); assert.equal(f.started(third), false);
  const receipt = path.join(f.workspace, 'retained-receipt.json'); fs.writeFileSync(receipt, '{"prepared":"passing earlier stage"}');
  fs.writeFileSync(first + '.repair', ''); fs.rmSync(first + '.blocked'); f.roadmaps.forEach(f.release);
  const resumed = await f.start(queue, undefined, { progressFile: progress[0], blockedPolicy: 'park', recoverBlocked: true });
  const final = await wait(async () => { const value = await f.manager.status(resumed.id); return value.processState === 'exited' && value; });
  assert.equal(final.exitCode, 0, final.output || final.reason);
  assert.deepEqual(final.queue.map(item => item.progressFile), progress.map(file => fs.realpathSync(file)));
  assert.deepEqual(final.queue.map(item => item.state), ['complete', 'complete', 'complete']);
  assert.equal(final.events.filter(event => event.type === 'runner.turn_starting' && event.role === 'resolver').length, 1);
  assert.equal(fs.readFileSync(receipt, 'utf8'), '{"prepared":"passing earlier stage"}');
  assert.equal(fs.readFileSync(second + '.started', 'utf8').trim().split('\n').length, 1);
  assert.equal(fs.readFileSync(third + '.started', 'utf8').trim().split('\n').length, 1);
});

test('a queued source removed before handoff fails the run and preserves later entries', async t => {
  const f = fixture(t); const [first, second, third] = f.roadmaps;
  const run = await f.start([{ roadmap: second }, { roadmap: third }]);
  fs.rmSync(second); f.release(first);
  const final = await wait(async () => { const s = await f.manager.status(run.id); return ['exited', 'stopped'].includes(s.processState) && s; });
  assert.equal(final.exitCode, 1); assert.equal(final.queue[1].state, 'failed'); assert.equal(final.queue[2].state, 'pending');
  assert.equal(f.started(third), false);
});


test('LLM loop detection blocks managed execution and leaves queued work pending', async t => {
  const f = fixture(t); const [first, second] = f.roadmaps;
  fs.writeFileSync(first + '.stall', ''); fs.writeFileSync(first + '.loop', '');
  const previous = process.env.ROADMAP_RECOVERY_DELAY;
  let run;
  try {
    process.env.ROADMAP_RECOVERY_DELAY = '1';
    run = await f.start([{ roadmap: second }], undefined, { supervisorEvery: 2 });
  } finally {
    if (previous === undefined) delete process.env.ROADMAP_RECOVERY_DELAY; else process.env.ROADMAP_RECOVERY_DELAY = previous;
  }
  const final = await wait(async () => { const s = await f.manager.status(run.id); return ['exited', 'stopped'].includes(s.processState) && s; });
  assert.equal(final.exitCode, 75, final.output || final.reason); assert.equal(final.roadmapState, 'stopped');
  assert.deepEqual(final.queue.map(item => item.state), ['stopped', 'pending']);
  assert.equal(f.started(second), false);
  assert.equal(fs.readFileSync(first + '.started', 'utf8').trim().split('\n').length, 3);
  assert.ok(final.events.some(e => e.type === 'runner.blocked' && !e.terminal));
});


test('fully blocked managed runs stop once, retain stopped status, and leave the queue pending', async t => {
  const f = fixture(t); const [first, second] = f.roadmaps;
  fs.writeFileSync(f.worker, String.raw`#!/usr/bin/env node
import fs from 'node:fs';
const prompt = process.argv.at(-1);
const progress = prompt.split('Tracking file (progress / delivery evidence):')[1].trim().split('\n')[0];
fs.appendFileSync('attempts', prompt.includes('Runner role: RESOLVER') ? 'resolver\n' : 'worker\n');
fs.writeFileSync(progress, 'Status: BLOCKED\n## Tasks\n- [ ] T01 build\n## Deferred gates\n- BLOCKED T01: native input | Unblock: supplied | Retry: input changed\n');
`);
  const run = await f.start([{ roadmap: second }]);
  const final = await wait(async () => { const s = await f.manager.status(run.id); return ['exited', 'stopped'].includes(s.processState) && s; });
  assert.equal(final.exitCode, 75); assert.equal(final.reason, 'stopped');
  assert.equal(final.roadmapState, 'stopped');
  assert.deepEqual(final.queue.map(item => item.state), ['stopped', 'pending']);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'attempts'), 'utf8'), 'worker\nresolver\nresolver\nresolver\n');
  assert.equal(f.started(second), false);
  const lastPage = await f.manager.status(run.id, { cursor: readRun(f.registry, run.id).sequence - 1 });
  assert.equal(lastPage.events.at(-1).type, 'runner.stopped');
  for (const lock of readRun(f.registry, run.id).locks) assert.equal(fs.existsSync(lock), false);
});
