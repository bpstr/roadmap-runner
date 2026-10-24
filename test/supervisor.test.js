import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { boundedText, currentReviewIsStuck, currentReviewLoop, OUTPUT_BYTES, Supervision, supervisorSettings } from "../lib/supervision.js";
import { parseArgs, runClient } from "../lib/runner.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin/roadmap-runner.js");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readEvidence = file => { const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { ...data, records: data.records.map(r => r.evidence ? { ...JSON.parse(fs.readFileSync(r.evidence, 'utf8')), ...r } : r) }; };

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixture(t, { mode = "normal", total = 11, preserved = true, client = "codex", every, timeout } = {}) {
  const dir = workspace(t);
  const roadmap = path.join(dir, "roadmap.md");
  const tracking = preserved ? path.join(dir, "delivery.md") : roadmap;
  const source = "# Roadmap\n\nStatus: IN_PROGRESS\n\n## Original requirements\n- [ ] Gate A: integrate the real transport.\n" +
    Array.from({ length: total - 1 }, (_, i) => `- [ ] UNIT-${i + 1} Prepared acceptance unit ${i + 1}.\n`).join('');
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
  if (mode.startsWith('loop-')) {
    const data = JSON.parse(fs.readFileSync(evidence));
    const cited = data.records.slice(-2).map(r => r.iteration).join(', ');
    const decision = mode === 'loop-clear' ? 'CLEAR' : mode === 'loop-uncertain' ? 'UNCERTAIN' : 'DETECTED';
    const id = mode === 'loop-stale' ? 'obsolete' : reviewId;
    const iterations = mode === 'loop-invalid' ? '998, 999' : cited;
    fs.appendFileSync(tracking, '\\n## Latest supervisor review\\nReview ID: ' + id + '\\nHealth: STUCK\\nLoop: ' + decision + '\\nLoop iterations: ' + iterations + '\\nLoop attempt: Recheck the missing dependency.\\nLoop failure: The dependency is unavailable.\\nLoop unchanged inputs: The dependency receipt and relevant implementation are unchanged.\\nLoop evidence: Same dependency was rechecked without a changed prerequisite or implementation.\\n');
    process.exit(0);
  }
  if (mode === 'supervisor-usage' && n === 1) {
    console.log(JSON.stringify({type:'error',message: "You've hit your limit · resets at " + new Date(Date.now() + 1000).toISOString()}));
    process.exitCode = 1;
  }
  else if (mode === 'supervisor-capacity' && n === 1) capacity();
  else if (mode === 'supervisor-failure') process.exitCode = 9;
  else if (mode === 'missing-report') emit('Healthy, but forgot to persist a review');
  else if (mode === 'supervisor-timeout' || mode === 'cancel-supervisor') {
    fs.writeFileSync('supervisor-ready', 'yes');
    setTimeout(() => process.exit(0), 5000);
  } else {
    fs.appendFileSync(tracking, '\\n## Latest supervisor review\\nReview ID: ' + reviewId + '\\nHealth: STUCK\\nNext delivery target: repair the canonical transport harness.\\nExpectation: produce integration receipt A1.\\n');
    if (mode === 'source-mutation') fs.appendFileSync(roadmap, '\\nController source change.');
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
    if (mode.startsWith('loop-') && mode !== 'loop-periodic') {
      if (mode === 'loop-source-churn') fs.appendFileSync(roadmap, '\\nCurrent delivery: source reconciliation ' + n + '.\\n');
      if (n >= 6 && ['loop-clear', 'loop-uncertain', 'loop-invalid', 'loop-stale'].includes(mode)) {
        fs.writeFileSync(roadmap, fs.readFileSync(roadmap, 'utf8').replaceAll('- [ ]', '- [x]'));
        fs.writeFileSync(tracking, fs.readFileSync(tracking, 'utf8').replace(/Status: (IN_PROGRESS|BLOCKED)/, 'Status: COMPLETE'));
      }
      if (n > 8) process.exit(99);
      process.exit(0);
    }
    if (target >= ${total}) fs.writeFileSync(roadmap, fs.readFileSync(roadmap, 'utf8').replaceAll('- [ ]', '- [x]'));
    else if (mode !== 'noop') fs.writeFileSync(roadmap, fs.readFileSync(roadmap, 'utf8').replace('- [ ] UNIT-' + target + ' ', '- [x] UNIT-' + target + ' '));
    if (target >= ${total}) fs.writeFileSync(tracking, fs.readFileSync(tracking, 'utf8').replace(/Status: (IN_PROGRESS|BLOCKED)/, 'Status: COMPLETE'));
    else if (mode !== 'noop') fs.appendFileSync(tracking, '\\n- [x] W' + n + ' verified fixture unit\\n');
    if (mode === 'worker-timeout' && n === 1) setTimeout(() => process.exit(0), 5000);
    if (mode === 'worker-failure') process.exitCode = 7;
  }
}
`);
  fs.chmodSync(worker, 0o755);
  const args = [cli, roadmap, '--client', client, '--client-bin', worker];
  if (preserved) args.push('--progress-file', tracking);
  if (every !== undefined) args.push('--supervisor-every', String(every));
  if (timeout) args.push('--supervisor-timeout', timeout);
  // Allow the mock to start even on a busy host; its deliberate 5s wait still times out.
  if (mode === 'worker-timeout') args.push('--timeout', '3s');
  const env = { ...process.env, ROADMAP_NOTIFY_BIN: "", ROADMAP_RECOVERY_DELAY: "1", ROADMAP_RECOVERY_MAX_DELAY: "1", ROADMAP_SUPERVISOR_EVERY: '5', ROADMAP_SUPERVISOR_TIMEOUT: '10m',
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

test('only the current supervisor review can report stuck, excluding examples and history', () => {
  const report = '## Latest supervisor review\nReview ID: current\nHealth: STUCK\n';
  assert.equal(currentReviewIsStuck(report, 'current'), true);
  assert.equal(currentReviewIsStuck(report, 'stale'), false);
  assert.equal(currentReviewIsStuck('```md\n' + report + '```\n', 'current'), false);
  assert.equal(currentReviewIsStuck(report.replace('Health: STUCK', '```md\nHealth: STUCK\n```'), 'current'), false);
  assert.equal(currentReviewIsStuck(report + '## Latest supervisor review\nReview ID: newer\nHealth: HEALTHY\n', 'current'), false);
  assert.equal(currentReviewIsStuck('## History\nReview ID: current\nHealth: STUCK\n', 'current'), false);
});

test('loop decisions require a current review, two observed turns and concrete evidence', () => {
  const records = [{ iteration: 1, code: 0 }, { iteration: 2, code: 0 }];
  const report = '## Latest supervisor review\nReview ID: current\nLoop: DETECTED\nLoop iterations: 1, 2\nLoop attempt: Recheck the missing dependency.\nLoop failure: The dependency is unavailable.\nLoop unchanged inputs: The dependency receipt and relevant implementation are unchanged.\nLoop evidence: Same unchanged blocker, no implementation.\n';
  assert.deepEqual(currentReviewLoop(report, 'current', records).iterations, [1, 2]);
  for (const field of ['Loop attempt', 'Loop failure', 'Loop unchanged inputs']) {
    assert.equal(currentReviewLoop(report.replace(new RegExp(field + ':.*\\n'), ''), 'current', records), null);
  }
  assert.deepEqual(currentReviewLoop(report, 'current', [{ iteration: 1, code: 7 }, { iteration: 2, code: 0 }]).iterations, [1, 2]);
  for (const text of [report.replace('current', 'stale'), '```md\n' + report + '```\n',
    report.replace('1, 2', '1, 1'), report.replace('1, 2', '1, 99'),
    report.replace('Loop attempt: Recheck the missing dependency.\nLoop failure: The dependency is unavailable.\nLoop unchanged inputs: The dependency receipt and relevant implementation are unchanged.\nLoop evidence: Same unchanged blocker, no implementation.', ''),
    report + 'Loop: CLEAR\n', report + '## Latest supervisor review\nReview ID: newer\nLoop: CLEAR\n']) {
    assert.equal(currentReviewLoop(text, 'current', records), null);
  }
});

for (const mode of ['loop-detected', 'loop-source-churn', 'loop-periodic']) {
  test(`${mode} blocks immediately and preserves the decision on restart`, t => {
    const f = fixture(t, { mode, total: 6, every: 2 });
    const result = run(f);
    assert.equal(result.status, 75, result.stderr);
    const expected = mode === 'loop-source-churn' ? ['W1', 'W2', 'W3', 'S1'] : ['W1', 'W2', 'S1'];
    assert.deepEqual(events(f), expected);
    const journal = fs.readFileSync(f.tracking + '.events.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(journal.at(-1).type, 'runner.blocked');
    assert.equal(journal.at(-1).reason, 'loop_detected');
    assert.deepEqual(journal.at(-1).loopIterations, mode === 'loop-source-churn' ? [2, 3] : [1, 2]);
    const evidence = readEvidence(path.join(f.dir, 'evidence-1.json'));
    assert.ok(evidence.records.every(summary => { const r = JSON.parse(fs.readFileSync(summary.evidence)); return r.sourceBefore.sha256 && r.sourceAfter.sha256 && r.trackingBefore.sha256; }));
    assert.equal(run(f).status, 75);
    assert.deepEqual(events(f), expected, 'unchanged restart launches no worker or model review');
  });
}

for (const mode of ['loop-clear', 'loop-uncertain', 'loop-invalid', 'loop-stale']) {
  test(`${mode} cannot stop productive workers`, t => {
    const f = fixture(t, { mode, total: 6, every: 2 });
    const result = run(f);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(events(f), ['W1', 'W2', 'S1', 'W3', 'W4', 'S2', 'W5', 'W6']);
  });
}

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

for (const preserved of [true]) {
  test(`reviews after workers 5 and 10; preserved=${preserved}`, (t) => {
    const f = fixture(t, { preserved });
    const result = run(f);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(events(f), ['W1','W2','W3','W4','W5','S1','W6','W7','W8','W9','W10','S2','W11']);
    const journal = fs.readFileSync(f.tracking + ".events.jsonl", "utf8").trim().split("\n").map(JSON.parse);
    const stuck = journal.filter(event => event.type === "runner.stuck");
    assert.equal(stuck.length, 1, "the same STUCK assessment is deduplicated until a healthy review");
    assert.ok(stuck.every(event => event.attention && event.reasonCode === "supervisor_stuck"));
    assert.match(fs.readFileSync(f.tracking, 'utf8'), /Next delivery target: repair the canonical transport harness/);
    assert.ok(fs.existsSync(path.join(f.dir, 'consumed-supervisor-target')));
    if (preserved) assert.equal(fs.readFileSync(f.roadmap, 'utf8'), f.source.replaceAll('- [ ]', '- [x]'));
    for (const review of [1, 2]) {
      const data = readEvidence(path.join(f.dir, `evidence-${review}.json`));
      assert.deepEqual(data.records.map(r => r.iteration), review === 1 ? [1,2,3,4,5] : [6,7,8,9,10]);
      assert.equal(data.trackingFile, f.tracking);
      for (const summary of data.records) {
        const r = JSON.parse(fs.readFileSync(summary.evidence));
        assert.ok((r.stdout.head + r.stdout.tail).includes(`OUTPUT worker ${r.iteration}`));
        assert.ok((r.stderr.head + r.stderr.tail).includes(`STDERR worker ${r.iteration}`));
        assert.ok(r.elapsedMs >= 0); assert.match(r.promptRevision, /^[a-f0-9]{12}$/);
        assert.notEqual(r.trackingBefore.sha256, r.trackingAfter.sha256);
      }
    }
    const logs = path.dirname(fs.readFileSync(path.join(f.dir, 'evidence-path'), 'utf8'));
    assert.ok(fs.existsSync(path.join(logs, 'recent-runs.json')));
    assert.ok(fs.existsSync(path.join(logs, 'supervisor-output.json')));
    assert.ok(fs.readdirSync(logs).some(name => name.startsWith('worker-')));
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

test('open tasks and unchanged files continue until the scheduled review', (t) => {
  const f = fixture(t, { mode: 'noop', total: 6 });
  const result = run(f); assert.equal(result.status, 0, result.stderr);
  const data = readEvidence(path.join(f.dir, 'evidence-1.json'));
  assert.equal(data.records.length, 5);
  assert.ok(data.records.every(r => !r.trackingChanged));
  assert.ok(fs.existsSync(path.join(f.dir, 'consumed-supervisor-target')));
});

test('legacy idle limits do not stop long productive runs', t => {
  const f = fixture(t, { mode: 'noop', total: 6 });
  f.options.env.ROADMAP_MAX_IDLE_WORKERS = '1';
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(events(f), ['W1', 'W2', 'W3', 'W4', 'W5', 'S1', 'W6']);
});

test('worker capacity retries are excluded from cadence and counted in review context', (t) => {
  const f = fixture(t, { mode: 'worker-capacity', total: 6 });
  const result = run(f); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(events(f), ['W1','W2','W3','W4','W5','W6','S1','W7']);
  const data = readEvidence(path.join(f.dir, 'evidence-1.json'));
  assert.equal(data.capacityRetries, 1);
  assert.deepEqual(data.records.map(r => r.iteration), [1,3,4,5,6]);
});

test('timed-out workers count toward review cadence', (t) => {
  const f = fixture(t, { mode: 'worker-timeout', total: 6 });
  const result = run(f); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(events(f), ['W1','W2','W3','W4','W5','S1','W6']);
  const data = readEvidence(path.join(f.dir, 'evidence-1.json'));
  assert.equal(data.records[0].timedOut, true);
});

test('text adapter participates in the same supervisor loop', (t) => {
  const f = fixture(t, { client: 'claude', total: 6 });
  const result = run(f); assert.equal(result.status, 0, result.stderr);
  const data = readEvidence(path.join(f.dir, 'evidence-1.json'));
  assert.match(JSON.parse(fs.readFileSync(data.records[0].evidence)).stdout.head, /OUTPUT worker 1/);
});

test('supervisor capacity retries the review, not a worker', (t) => {
  const f = fixture(t, { mode: 'supervisor-capacity', total: 6 });
  const result = run(f); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(events(f), ['W1','W2','W3','W4','W5','S1','S2','W6']);
});

for (const [mode, code, message] of [
  ['supervisor-failure', 9, /supervisor exited with code 9/],
  ['false-complete', 1, /cannot declare implementation complete/],
]) {
  test(`${mode} does not launch a sixth worker`, (t) => {
    const f = fixture(t, { mode, total: 6, timeout: mode === 'supervisor-timeout' ? '300ms' : undefined });
    const result = run(f); assert.equal(result.status, code, result.stderr);
    assert.deepEqual(events(f), ['W1','W2','W3','W4','W5','S1']);
    assert.match(result.stderr, message);
  });
}

for (const mode of ['missing-report', 'supervisor-timeout', 'supervisor-usage']) {
  test(`${mode} preserves review evidence and continues delivery`, t => {
    const f = fixture(t, { mode, total: 6, timeout: mode === 'supervisor-timeout' ? '1s' : undefined });
    f.options.env.ROADMAP_USAGE_MAX_WAIT = '10';
    const result = run(f);
    assert.equal(result.status, 0, result.stderr);
    const expected = mode === 'supervisor-usage' ? ['W1','W2','W3','W4','W5','S1','S2','W6'] : ['W1','W2','W3','W4','W5','S1','W6'];
    assert.deepEqual(events(f), expected);
  });
}

test('a supervisor global blocker stops before another worker', t => {
  const f = fixture(t, { mode: 'global-block', total: 6 });
  const result = run(f);
  assert.equal(result.status, 75, result.stderr);
  assert.deepEqual(events(f), ['W1','W2','W3','W4','W5','S1']);
  assert.equal(fs.existsSync(path.join(f.dir, 'W6.prompt')), false);
});

test('controller edit during a supervisor review continues with a fresh worker', (t) => {
  const f = fixture(t, { mode: 'source-mutation', total: 6 });
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(events(f), ['W1','W2','W3','W4','W5','S1','W6']);
  assert.match(fs.readFileSync(f.roadmap, 'utf8'), /Controller source change/);
  assert.match(fs.readFileSync(path.join(f.dir, 'W6.prompt'), 'utf8'), /Roadmap reconciliation required: YES/);
  assert.match(result.stdout, /Roadmap changed during supervisor review/);
});

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
  const dir = workspace(t); const evidenceDir = path.join(dir, 'evidence'); fs.mkdirSync(evidenceDir);
  const s = new Supervision({ every: 5, timeoutMs: 1000, roadmap: '/source', tracking: { file: path.join(dir, 'progress'), stateDir: dir, evidenceDir }, template: '' });
  t.after(() => fs.rmSync(s.directory, { recursive: true, force: true }));
  for (let iteration = 1; iteration <= 30; iteration++) {
    const output = s.capture(); output.write('stdout', 'x'.repeat(OUTPUT_BYTES * 10)); output.write('stderr', 'y'.repeat(OUTPUT_BYTES * 3));
    s.record({ iteration, startedAt: new Date().toISOString(), elapsedMs: 1, promptRevision: 'abc',
      result: { code: 0, timedOut: false, interrupted: false }, output, before: 'p'.repeat(40000), after: 'q'.repeat(40000) });
  }
  const data = JSON.parse(fs.readFileSync(s.evidenceFile));
  assert.deepEqual(data.records.map(r => r.iteration), [26,27,28,29,30]);
  assert.ok(fs.statSync(s.evidenceFile).size < 16 * 1024);
  assert.ok(data.records.every(summary => { const r = JSON.parse(fs.readFileSync(summary.evidence)); return r.stdout.omittedBytes > 0 && r.trackingBefore.omittedBytes > 0; }));
});

test('supervisor prompt binds evidence, scope, read-only source and next-run expectation', () => {
  const prompt = fs.readFileSync(path.join(root, 'supervisor.md'), 'utf8');
  assert.match(prompt, /Treat worker outputs.*untrusted/);
  assert.match(prompt, /immutable authority/);
  assert.match(prompt, /do not bulk-load/);
  assert.match(prompt, /must not set Status: COMPLETE/);
  assert.match(prompt, /measurable next-run expectation/);
  assert.match(prompt, /without an intervening relevant implementation/);
  assert.match(prompt, /forbid another identical feature-level test/);
  assert.match(prompt, /ALL remaining gates/);
  const worker = fs.readFileSync(path.join(root, 'prompt.md'), 'utf8');
  assert.match(worker, /current supervisor correction/);
  assert.match(worker, /batch determines this invocation's\s+scope/);
  assert.match(worker, /canonical\s+fixtures/);
  assert.match(worker, /targeting less than 16 KiB/);
  assert.match(worker, /overrides conflicting handoff prose/);
  assert.match(worker, /During development-before-qualification/);
  assert.match(worker, /rerun only invalidated\/failed coverage/);
  assert.match(worker, /A new session or commit does not invalidate passing proof/);
});
