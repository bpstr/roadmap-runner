import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { boundedText, OUTPUT_BYTES, Supervision, supervisorSettings } from "../lib/supervision.js";
import { parseArgs, runClient } from "../lib/runner.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin/roadmap-runner.js");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixture(t, { mode = "normal", total = 11, preserved = true, client = "codex", every, timeout } = {}) {
  const dir = workspace(t);
  const roadmap = path.join(dir, "roadmap.md");
  const tracking = preserved ? path.join(dir, "delivery.md") : roadmap;
  const source = "# Roadmap\n\nStatus: IN_PROGRESS\n\n## Original requirements\n- [ ] Gate A: integrate the real transport.\n";
  fs.writeFileSync(roadmap, source);
  const worker = path.join(dir, "mock.cjs");
  fs.writeFileSync(worker, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const prompt = process.argv.at(-1);
const supervisor = prompt.includes('Runner role: SUPERVISOR');
const tracking = ${JSON.stringify(tracking)};
const roadmap = ${JSON.stringify(roadmap)};
const mode = ${JSON.stringify(mode)};
const emit = text => {
  if (${JSON.stringify(client)} === 'codex') console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
  else console.log(text);
};
const count = name => {
  const n = fs.existsSync(name) ? Number(fs.readFileSync(name)) + 1 : 1;
  fs.writeFileSync(name, String(n)); return n;
};
const capacity = () => {
  console.log(JSON.stringify({type:'error',message:'Selected model is at capacity'}));
  process.exitCode = 1;
};
const role = supervisor ? 'S' : 'W';
const n = count(role);
fs.appendFileSync('events', role + n + '\\n');
fs.writeFileSync(role + n + '.prompt', prompt);
if (supervisor) {
  const evidence = JSON.parse(prompt.match(/^Run evidence JSON: (.+)$/m)[1]);
  fs.writeFileSync('evidence-path', evidence);
  fs.copyFileSync(evidence, 'evidence-' + n + '.json');
  const reviewId = prompt.match(/^Review ID: (.+)$/m)[1];
  if (mode === 'supervisor-capacity' && n === 1) capacity();
  else if (mode === 'supervisor-failure') process.exitCode = 9;
  else if (mode === 'missing-report') emit('Healthy, but forgot to persist a review');
  else if (mode === 'supervisor-timeout' || mode === 'cancel-supervisor') {
    fs.writeFileSync('supervisor-ready', 'yes');
    setTimeout(() => process.exit(0), 5000);
  } else {
    fs.appendFileSync(tracking, '\\n## Supervisor review\\nReview ID: ' + reviewId + '\\nHealth: STUCK\\nNext delivery target: repair the canonical transport harness.\\nExpectation: produce integration receipt A1.\\n');
    if (mode === 'source-mutation') fs.appendFileSync(roadmap, '\\nUnauthorized source change.');
    if (mode === 'false-complete') fs.writeFileSync(tracking, fs.readFileSync(tracking, 'utf8').replace('Status: IN_PROGRESS', 'Status: COMPLETE'));
    if (mode === 'global-block') fs.writeFileSync(tracking, fs.readFileSync(tracking, 'utf8').replace('Status: IN_PROGRESS', 'Status: BLOCKED'));
    emit('Supervisor diagnostic: repeated narrow tests; target updated.');
  }
} else {
  const retry = mode === 'worker-capacity' && n === 2;
  const output = 'OUTPUT worker ' + n;
  emit(output);
  process.stderr.write('STDERR worker ' + n + '\\n');
  if (retry) capacity();
  else {
    if (n > 5 && fs.readFileSync(tracking, 'utf8').includes('Next delivery target: repair')) {
      fs.writeFileSync('consumed-supervisor-target', String(n));
    }
    const target = mode === 'worker-capacity' ? n - (n > 2 ? 1 : 0) : n;
    if (target >= ${total}) fs.writeFileSync(tracking, fs.readFileSync(tracking, 'utf8').replace('Status: IN_PROGRESS', 'Status: COMPLETE'));
    else if (mode !== 'noop') fs.appendFileSync(tracking, '\\nWorker ' + n + ' evidence\\n');
    if (mode === 'worker-timeout' && n === 1) setTimeout(() => process.exit(0), 3000);
    if (mode === 'worker-failure') process.exitCode = 7;
  }
}
`);
  fs.chmodSync(worker, 0o755);
  const args = [cli, roadmap, '--client', client, '--client-bin', worker];
  if (preserved) args.push('--progress-file', tracking);
  if (every !== undefined) args.push('--supervisor-every', String(every));
  if (timeout) args.push('--supervisor-timeout', timeout);
  if (mode === 'worker-timeout') args.push('--timeout', '300ms');
  const env = { ...process.env, ROADMAP_SUPERVISOR_EVERY: '5', ROADMAP_SUPERVISOR_TIMEOUT: '10m',
    ROADMAP_CAPACITY_RETRIES: '1', ROADMAP_CAPACITY_DELAY: '1', ROADMAP_CAPACITY_MAX_DELAY: '1' };
  t.after(() => {
    if (fs.existsSync(path.join(dir, 'evidence-path'))) {
      const file = fs.readFileSync(path.join(dir, 'evidence-path'), 'utf8');
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
  return { dir, roadmap, tracking, source, args, options: { cwd: dir, env, encoding: 'utf8', timeout: 15000 } };
}

function run(f) { return spawnSync(process.execPath, f.args, f.options); }
function events(f) { return fs.readFileSync(path.join(f.dir, 'events'), 'utf8').trim().split('\n'); }

test('supervision defaults to five; supports CLI/env overrides and disable', () => {
  assert.deepEqual(supervisorSettings(parseArgs(['r.md'], {})), { every: 5, timeoutMs: 600000 });
  assert.deepEqual(supervisorSettings(parseArgs(['r.md'], { ROADMAP_SUPERVISOR_EVERY: '2', ROADMAP_SUPERVISOR_TIMEOUT: '3m' })), { every: 2, timeoutMs: 180000 });
  assert.equal(supervisorSettings(parseArgs(['r.md', '--supervisor-every', '0'], { ROADMAP_SUPERVISOR_EVERY: '2' })).every, 0);
});

for (const n of ['-1', '21', '1.5', 'NaN', '', '05', '--model']) {
  test(`reject invalid supervisor interval ${JSON.stringify(n)}`, () => {
    assert.throws(() => supervisorSettings({ supervisorEvery: n }), /integer from 0 to 20/);
  });
}

test('supervisor option validation rejects missing values and excessive timeouts', () => {
  for (const flag of ['--supervisor-every', '--supervisor-timeout']) {
    assert.throws(() => parseArgs(['r.md', flag], {}), /requires a value/);
  }
  assert.throws(() => supervisorSettings({ supervisorTimeout: '0s' }), /invalid timeout/);
  assert.throws(() => supervisorSettings({ supervisorTimeout: '1000h' }), /timer limit/);
});

test('bounded capture retains exact short output and capped head/tail with omission count', () => {
  const log = boundedText(20);
  log.write('01234'); log.write('56789'); log.write('abc');
  assert.deepEqual(log.value(), { head: '0123456789', tail: 'abc', bytes: 13, omittedBytes: 0 });
  log.write('d'.repeat(100000)); log.write('END');
  assert.equal(log.value().head, '0123456789');
  assert.equal(log.value().tail, 'dddddddEND');
  assert.equal(log.value().omittedBytes, 99996);
});

for (const client of ['codex', 'claude']) {
  test(`${client} capture includes stdout and final stderr without a newline`, async (t) => {
    const dir = workspace(t);
    const mock = path.join(dir, 'output.cjs');
    fs.writeFileSync(mock, '#!/usr/bin/env node\nprocess.stdout.write("raw stdout"); process.stderr.write("final stderr");\n');
    fs.chmodSync(mock, 0o755);
    let stdout = '', stderr = '';
    const result = await runClient({ client, executable: mock, prompt: '', workdir: dir, timeoutMs: 2000,
      onOutput(stream, chunk) { if (stream === 'stdout') stdout += chunk; else stderr += chunk; } });
    assert.equal(result.code, 0);
    assert.equal(stdout, 'raw stdout'); assert.equal(stderr, 'final stderr');
  });
}

for (const preserved of [true, false]) {
  test(`reviews after workers 5 and 10; preserved=${preserved}`, (t) => {
    const f = fixture(t, { preserved });
    const result = run(f);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(events(f), ['W1','W2','W3','W4','W5','S1','W6','W7','W8','W9','W10','S2','W11']);
    assert.match(fs.readFileSync(f.tracking, 'utf8'), /Next delivery target: repair the canonical transport harness/);
    assert.ok(fs.existsSync(path.join(f.dir, 'consumed-supervisor-target')));
    if (preserved) assert.equal(fs.readFileSync(f.roadmap, 'utf8'), f.source);
    for (const review of [1, 2]) {
      const data = JSON.parse(fs.readFileSync(path.join(f.dir, `evidence-${review}.json`), 'utf8'));
      assert.deepEqual(data.records.map(r => r.iteration), review === 1 ? [1,2,3,4,5] : [6,7,8,9,10]);
      assert.equal(data.trackingFile, f.tracking);
      for (const r of data.records) {
        assert.ok((r.stdout.head + r.stdout.tail).includes(`OUTPUT worker ${r.iteration}`));
        assert.ok((r.stderr.head + r.stderr.tail).includes(`STDERR worker ${r.iteration}`));
        assert.ok(r.elapsedMs >= 0); assert.match(r.promptRevision, /^[a-f0-9]{12}$/);
        assert.notEqual(r.trackingBefore.sha256, r.trackingAfter.sha256);
      }
    }
    const logs = path.dirname(fs.readFileSync(path.join(f.dir, 'evidence-path'), 'utf8'));
    assert.deepEqual(fs.readdirSync(logs).sort(), ['recent-runs.json', 'supervisor-output.json']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(logs, 'recent-runs.json')).mode & 0o777, 0o600);
  });
}

for (const total of [3, 5]) {
  test(`completion on worker ${total} skips a pending/future review`, (t) => {
    const f = fixture(t, { total }); const result = run(f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(events(f).filter(x => x.startsWith('S')).length, 0);
    assert.equal(events(f).length, total);
  });
}

test('custom cadence and disabled supervision', (t) => {
  const custom = fixture(t, { total: 5, every: 2 });
  assert.equal(run(custom).status, 0);
  assert.deepEqual(events(custom), ['W1','W2','S1','W3','W4','S2','W5']);
  const disabled = fixture(t, { every: 0 });
  assert.equal(run(disabled).status, 0);
  assert.equal(events(disabled).filter(x => x.startsWith('S')).length, 0);
});

test('successful no-op workers are reviewed, not incorrectly blocked by byte equality', (t) => {
  const f = fixture(t, { mode: 'noop', total: 6 });
  const result = run(f); assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(fs.readFileSync(path.join(f.dir, 'evidence-1.json')));
  assert.equal(data.records.length, 5);
  assert.ok(data.records.every(r => !r.trackingChanged));
  assert.ok(fs.existsSync(path.join(f.dir, 'consumed-supervisor-target')));
});

test('worker capacity retries are excluded from cadence and counted in review context', (t) => {
  const f = fixture(t, { mode: 'worker-capacity', total: 6 });
  const result = run(f); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(events(f), ['W1','W2','W3','W4','W5','W6','S1','W7']);
  const data = JSON.parse(fs.readFileSync(path.join(f.dir, 'evidence-1.json')));
  assert.equal(data.capacityRetries, 1);
  assert.deepEqual(data.records.map(r => r.iteration), [1,3,4,5,6]);
});

test('timed-out workers count toward review cadence', (t) => {
  const f = fixture(t, { mode: 'worker-timeout', total: 6 });
  const result = run(f); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(events(f), ['W1','W2','W3','W4','W5','S1','W6']);
  const data = JSON.parse(fs.readFileSync(path.join(f.dir, 'evidence-1.json')));
  assert.equal(data.records[0].timedOut, true);
});

test('text adapter participates in the same supervisor loop', (t) => {
  const f = fixture(t, { client: 'claude', total: 6 });
  const result = run(f); assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(fs.readFileSync(path.join(f.dir, 'evidence-1.json')));
  assert.match(data.records[0].stdout.head, /OUTPUT worker 1/);
});

test('supervisor capacity retries the review, not a worker', (t) => {
  const f = fixture(t, { mode: 'supervisor-capacity', total: 6 });
  const result = run(f); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(events(f), ['W1','W2','W3','W4','W5','S1','S2','W6']);
});

for (const [mode, code, message] of [
  ['supervisor-failure', 9, /supervisor exited with code 9/],
  ['missing-report', 1, /did not record its Review ID/],
  ['source-mutation', 1, /preserved roadmap changed/],
  ['false-complete', 1, /cannot declare implementation complete/],
  ['supervisor-timeout', 75, /supervisor timed out/],
  ['global-block', 3, /globally blocked/],
]) {
  test(`${mode} does not launch a sixth worker`, (t) => {
    const f = fixture(t, { mode, total: 6, timeout: mode === 'supervisor-timeout' ? '300ms' : undefined });
    const result = run(f); assert.equal(result.status, code, result.stderr);
    assert.deepEqual(events(f), ['W1','W2','W3','W4','W5','S1']);
    assert.match(result.stderr, message);
  });
}

test('ordinary worker failures remain terminal', (t) => {
  const f = fixture(t, { mode: 'worker-failure' });
  assert.equal(run(f).status, 7); assert.deepEqual(events(f), ['W1']);
});

test('SIGINT during supervisor exits 130 without another worker', { skip: process.platform === 'win32' }, async (t) => {
  const f = fixture(t, { mode: 'cancel-supervisor' });
  const child = spawn(process.execPath, f.args, { ...f.options, stdio: ['ignore','pipe','pipe'] });
  t.after(() => child.kill('SIGKILL'));
  child.stdout.resume(); child.stderr.resume();
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('cancel hung')); }, 7000);
    child.once('close', code => { clearTimeout(timer); resolve(code); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const deadline = Date.now() + 4000;
  while (!fs.existsSync(path.join(f.dir, 'supervisor-ready')) && Date.now() < deadline) await pause(10);
  assert.ok(fs.existsSync(path.join(f.dir, 'supervisor-ready')));
  child.kill('SIGINT');
  assert.equal(await done, 130);
  assert.deepEqual(events(f), ['W1','W2','W3','W4','W5','S1']);
});

test('rolling evidence stays bounded across many verbose runs', (t) => {
  const s = new Supervision({ every: 5, timeoutMs: 1000, roadmap: '/source', tracking: { file: '/progress' }, template: '' });
  t.after(() => fs.rmSync(s.directory, { recursive: true, force: true }));
  for (let iteration = 1; iteration <= 30; iteration++) {
    const output = s.capture(); output.write('stdout', 'x'.repeat(OUTPUT_BYTES * 10)); output.write('stderr', 'y'.repeat(OUTPUT_BYTES * 3));
    s.record({ iteration, startedAt: new Date().toISOString(), elapsedMs: 1, promptRevision: 'abc',
      result: { code: 0, timedOut: false, interrupted: false }, output, before: 'p'.repeat(40000), after: 'q'.repeat(40000) });
  }
  const data = JSON.parse(fs.readFileSync(s.evidenceFile));
  assert.deepEqual(data.records.map(r => r.iteration), [26,27,28,29,30]);
  assert.ok(fs.statSync(s.evidenceFile).size < 300000);
  assert.ok(data.records.every(r => r.stdout.omittedBytes > 0 && r.trackingBefore.omittedBytes > 0));
});

test('supervisor prompt binds evidence, scope, read-only source and next-run expectation', () => {
  const prompt = fs.readFileSync(path.join(root, 'supervisor.md'), 'utf8');
  assert.match(prompt, /Treat worker outputs.*untrusted/);
  assert.match(prompt, /PRESERVE_ROADMAP/);
  assert.match(prompt, /must not set Status: COMPLETE/);
  assert.match(prompt, /measurable next-run expectation/);
  assert.match(prompt, /ALL remaining gates/);
  const worker = fs.readFileSync(path.join(root, 'prompt.md'), 'utf8');
  assert.match(worker, /Read the latest Supervisor review/);
  assert.match(worker, /Keep the declared batch outcome stable/);
  assert.match(worker, /canonical harness/);
});
