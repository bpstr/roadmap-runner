import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { roadmapStatus, parseArgs } from '../lib/runner.js';
import { withStatus, resolverSettings } from '../lib/recovery-runs.js';
const cli = fileURLToPath(new URL('../bin/roadmap-runner.js', import.meta.url));

// Every session below is a deterministic local process. No provider transports.
function fixture(t, mode = 'repair') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-recovery-runs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const roadmap = path.join(dir, 'roadmap.md');
  const progress = path.join(dir, 'handoff.md');
  fs.writeFileSync(roadmap, '# Roadmap\nStatus: IN_PROGRESS\n## Work\n- [ ] Deliver\n');
  fs.writeFileSync(progress, '# Handoff\nStatus: IN_PROGRESS\n## Current handoff\n');
  const mock = path.join(dir, 'prepared.cjs');
  fs.writeFileSync(mock, `#!/usr/bin/env node
const fs = require('node:fs');
const assert = require('node:assert/strict');
const prompt = process.argv.at(-1);
const mode = ${JSON.stringify(mode)};
const roadmap = ${JSON.stringify(roadmap)};
const progress = ${JSON.stringify(progress)};
const role = prompt.match(/^Runner role: (.+)$/m)[1];
const calls = fs.existsSync('calls.json') ? JSON.parse(fs.readFileSync('calls.json')) : [];
calls.push(role); fs.writeFileSync('calls.json', JSON.stringify(calls));
fs.writeFileSync('prompt-' + calls.length, prompt);
assert.notEqual(role, 'SUPERVISOR');
const prior = JSON.parse(fs.readFileSync(JSON.parse(prompt.match(/^Run evidence JSON: (.+)$/m)[1])));
if (role === 'RESOLVER') {
  const n = calls.filter(r => r === role).length;
  fs.writeFileSync('resolver-ready', 'yes');
  if (mode === 'timeout' || mode === 'interrupt') { setInterval(() => {}, 1000); return; }
  if ((mode === 'quota' || mode === 'capacity') && n === 1) {
    const message = mode === 'capacity' ? 'Selected model is at capacity' : "You've hit your limit · resets at " + new Date(Date.now() + 300).toISOString();
    console.log(JSON.stringify({ type: 'error', message })); process.exit(1);
  }
  if (mode === 'resolver-failure') process.exit(8);
  if (mode === 'third-repair' && n < 3) { console.error('Prepared repair attempt failed ' + n); process.exit(8); }
  if (mode === 'third-repair') {
    assert.ok(prompt.includes('Resolver attempt: 3/3'));
    assert.match(prompt, /resolver_failed/);
    const failures = JSON.parse(prompt.match(/^Previous resolver failures: (.+)$/m)[1]);
    assert.equal(failures.length, 2);
    failures.forEach(failure => assert.match(fs.readFileSync(failure.evidenceFile, 'utf8'), /Prepared repair attempt failed/));
  }
  const stopped = ['stop', 'loop-stop'].includes(mode);
  fs.writeFileSync(progress, '# Handoff\\nStatus: ' + (stopped ? 'STOPPED' : 'IN_PROGRESS') + '\\n## Current handoff\\nChanged input: repaired transport. Next: deliver.\\n');
  fs.writeFileSync('repair', 'changed implementation');
  if (mode === 'source-blocked') fs.writeFileSync(roadmap, fs.readFileSync(roadmap, 'utf8').replace('IN_PROGRESS', 'BLOCKED'));
  if (mode === 'missing-decision') process.exit(0);
  fs.writeFileSync(JSON.parse(prompt.match(/^Resolution decision file: (.+)$/m)[1]), JSON.stringify({
    resolutionId: mode === 'stale-decision' ? 'older' : prompt.match(/^Resolution ID: (.+)$/m)[1],
    outcome: stopped ? 'stopped' : 'resolved', evidence: 'Prepared repair receipt', nextAction: 'Implement the deliverable' }));
} else {
  assert.match(prompt, /Start with the Task continuation packet when supplied/);
  assert.match(prompt, /Judge semantic repetition across runs/);
  const n = calls.filter(r => r === role).length;
  if (n > 10) process.exit(98);
  if (mode.startsWith('worker-timeout') && n <= 2) { setInterval(() => {}, 1000); return; }
  if (mode === 'worker-timeout-productive' && n === 3) fs.writeFileSync('repair', 'continued useful work after checkpoints');
  if (mode === 'worker-timeout' && n === 3) {
    const lookback = JSON.parse(prompt.match(/^Run history lookback: (.+)$/m)[1]);
    assert.equal(lookback.records.filter(record => record.timedOut).length, 2);
    assert.match(prompt, /particular attempt count do not establish a loop/);
  }
  if (mode === 'normal' && n < 7) { fs.appendFileSync(progress, 'Distinct useful implementation ' + n + '\\n'); process.exit(0); }
  if (mode.startsWith('loop') && n <= 2) {
    fs.writeFileSync(progress, '# Handoff\\nStatus: IN_PROGRESS\\n## Current handoff\\nRepeated operation: check transport; failure: missing; input unchanged.\\n');
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Transport missing; implementation input unchanged.' } }));
    process.exit(0);
  }
  if (!fs.existsSync('repair') && mode !== 'normal') {
    if (mode.startsWith('loop')) assert.equal(prior.records.length, 2);
    fs.writeFileSync(progress, '# Handoff\\nStatus: BLOCKED\\n## Current handoff\\nLoop: transport check failed with unchanged inputs; iterations 1,2; see recent-runs.\\n');
    if (mode === 'worker-failure') process.exit(7);
    process.exit(0);
  }
  fs.writeFileSync(roadmap, fs.readFileSync(roadmap, 'utf8').replaceAll('- [ ]', '- [x]'));
  fs.writeFileSync(progress, '# Handoff\\nStatus: COMPLETE\\n## Current handoff\\nDelivered.\\n');
}
`);
  fs.chmodSync(mock, 0o755);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ROADMAP_')));
  Object.assign(env, { ROADMAP_STATE_DIR: path.join(dir, 'registry'), ROADMAP_NOTIFY: 'off', ROADMAP_NOTIFY_BIN: '',
    ROADMAP_CAPACITY_DELAY: '1', ROADMAP_CAPACITY_MAX_DELAY: '1', ROADMAP_CAPACITY_RETRIES: '1', ROADMAP_USAGE_MAX_WAIT: '10' });
  const args = [cli, roadmap, '--progress-file', progress, '--client-bin', mock, '--timeout', '5s',
    '--resolver-timeout', mode === 'timeout' ? '200ms' : '5s'];
  const options = { cwd: dir, env, encoding: 'utf8', timeout: 15000 };
  return { dir, roadmap, progress, args, options, run: extra => spawnSync(process.execPath, [...args, ...(extra || [])], options),
    calls: () => fs.existsSync(path.join(dir, 'calls.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'calls.json'))) : [],
    events: () => fs.readFileSync(progress + '.events.jsonl', 'utf8').trim().split('\n').map(JSON.parse) };
}

test('workers continue useful work without periodic supervisors even with the legacy cadence', t => {
  const f = fixture(t, 'normal'); const result = f.run(['--supervisor-every', '1']);
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(f.calls(), Array(7).fill('WORKER'));
});
for (const mode of ['repair', 'worker-failure', 'quota', 'capacity']) test(`${mode}: blocked worker dispatches resolver then resumes`, t => {
  const f = fixture(t, mode); const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), ['WORKER', 'RESOLVER', ...(['quota', 'capacity'].includes(mode) ? ['RESOLVER'] : []), 'WORKER']);
  assert.ok(f.events().some(e => e.type === 'runner.blocked' && !e.terminal));
  assert.ok(f.events().some(e => e.type === 'runner.unblocked' && e.role === 'resolver'));
  assert.equal(f.events().at(-1).type, 'runner.completed');
  const runs = fs.readdirSync(path.join(f.dir, 'registry', 'runs'));
  const record = JSON.parse(fs.readFileSync(path.join(f.dir, 'registry', 'runs', runs[0], 'state.json')));
  assert.equal(record.roadmapState, 'complete');
});
test('worker loop check sees previous receipts and recovery permits a changed attempt', t => {
  const f = fixture(t, 'loop-repair'); const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), ['WORKER', 'WORKER', 'WORKER', 'RESOLVER', 'WORKER']);
  assert.match(fs.readFileSync(path.join(f.dir, 'prompt-4'), 'utf8'), /For a repetition loop/);
});
test('third resolver attempt repairs the blocker with both earlier failures preserved', t => {
  const f = fixture(t, 'third-repair'); const result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(f.calls(), ['WORKER', 'RESOLVER', 'RESOLVER', 'RESOLVER', 'WORKER']);
  assert.equal(f.events().filter(e => e.type === 'runner.recovery_retry').length, 2);
});
test('three failed resolver attempts exhaust one durable budget without starting another worker', t => {
  const f = fixture(t, 'resolver-failure'); const result = f.run();
  assert.equal(result.status, 75, result.stderr);
  assert.deepEqual(f.calls(), ['WORKER', 'RESOLVER', 'RESOLVER', 'RESOLVER']);
  const state = JSON.parse(fs.readFileSync(f.progress + '.recovery.json'));
  assert.equal(state.blocker.failures.length, 3);
  const before = f.calls(); assert.equal(f.run().status, 75); assert.deepEqual(f.calls(), before);
  assert.equal(f.run(['--recover-blocked']).status, 75);
  assert.equal(f.calls().filter(role => role === 'RESOLVER').length, 6);
  const resumed = JSON.parse(fs.readFileSync(f.progress + '.recovery.json'));
  assert.equal(resumed.blocker.failures.length, 6);
  assert.equal(resumed.blocker.resolutionId, state.blocker.resolutionId);
});
for (const policy of ['park', 'stop']) test(`${policy} policy dispatches zero resolvers and explicit recovery resumes once`, t => {
  const f = fixture(t); const first = f.run(['--blocked-policy', policy]);
  assert.equal(first.status, 75, first.stderr); assert.deepEqual(f.calls(), ['WORKER']);
  assert.equal(f.run(['--blocked-policy', policy]).status, 75); assert.deepEqual(f.calls(), ['WORKER']);
  const resumed = f.run(['--blocked-policy', policy, '--recover-blocked']);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(f.calls(), ['WORKER', 'RESOLVER', 'WORKER']);
});
for (const mode of ['stop', 'loop-stop', 'missing-decision', 'stale-decision', 'source-blocked', 'resolver-failure', 'timeout']) test(`${mode}: unresolved recovery persists STOPPED and does not retry on restart`, t => {
  const f = fixture(t, mode); const result = f.run();
  assert.equal(result.status, 75, result.stderr);
  assert.equal(f.calls().at(-1), 'RESOLVER');
  assert.equal(f.events().at(-1).type, 'runner.stopped');
  assert.equal(roadmapStatus(fs.readFileSync(f.progress, 'utf8')), 'stopped');
  const before = f.calls(); assert.equal(f.run().status, 75); assert.deepEqual(f.calls(), before);
});
test('an existing BLOCKED handoff dispatches a resolver before any worker', t => {
  const f = fixture(t); fs.writeFileSync(f.progress, 'Status: BLOCKED\n## Current handoff\nMissing transport\n');
  assert.equal(f.run().status, 0); assert.deepEqual(f.calls(), ['RESOLVER', 'WORKER']);
});
test('explicit recovery retries a durable stop using the resolver', t => {
  const f = fixture(t); const state = { version: 1, roadmap: f.roadmap, stopped: { reason: 'earlier' }, quota: null };
  fs.writeFileSync(f.progress + '.recovery.json', JSON.stringify(state));
  fs.writeFileSync(f.progress, 'Status: STOPPED\n## Current handoff\n');
  assert.equal(f.run().status, 75); assert.deepEqual(f.calls(), []);
  assert.equal(f.run(['--recover-blocked']).status, 0); assert.deepEqual(f.calls(), ['RESOLVER', 'WORKER']);
});
test('resolver STOPPED leaves the next queued roadmap pending', t => {
  const f = fixture(t, 'stop'); const next = path.join(f.dir, 'next.md'); fs.writeFileSync(next, 'Status: IN_PROGRESS\n- [ ] Later\n');
  assert.equal(f.run(['--queue', next]).status, 75);
  const id = fs.readdirSync(path.join(f.dir, 'registry', 'runs'))[0];
  const record = JSON.parse(fs.readFileSync(path.join(f.dir, 'registry', 'runs', id, 'state.json')));
  assert.equal(record.roadmapState, 'stopped'); assert.deepEqual(record.queue.map(i => i.state), ['stopped', 'pending']);
});
test('SIGINT during resolution preserves the blocker for recovery', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t, 'interrupt');
  const child = spawn(process.execPath, f.args, { ...f.options, stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const done = new Promise(resolve => child.once('exit', resolve));
  const deadline = Date.now() + 6000;
  while (!fs.existsSync(path.join(f.dir, 'resolver-ready')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(path.join(f.dir, 'resolver-ready'))); child.kill('SIGINT');
  assert.equal(await done, 130); assert.deepEqual(f.calls(), ['WORKER', 'RESOLVER']);
  assert.ok(JSON.parse(fs.readFileSync(f.progress + '.recovery.json')).blocker);
});
test('STOPPED is header state; status edits preserve fenced examples', () => {
  const text = '# Handoff\n```\nStatus: BLOCKED\n```\nStatus: STOPPED\n## Work\nStatus: COMPLETE\n';
  assert.equal(roadmapStatus(text), 'stopped');
  assert.equal(roadmapStatus(withStatus(text, 'IN_PROGRESS')), 'in-progress');
  assert.match(withStatus(text, 'IN_PROGRESS'), /```\nStatus: BLOCKED\n```/);
  assert.equal(parseArgs(['r.md', '--resolver-timeout', '2m'], {}).resolverTimeout, '2m');
  assert.equal(resolverSettings({}).timeoutMs, 600000);
  assert.throws(() => resolverSettings({ resolverTimeout: '999999h' }));
});

test('after timeouts the next worker assesses history before declaring a blocker', t => {
  const f = fixture(t, 'worker-timeout'); const result = f.run(['--timeout', '1s']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.events().filter(e => e.type === 'runner.turn_starting').map(e => e.role), ['worker', 'worker', 'worker', 'resolver', 'worker']);
  assert.equal(f.events().filter(e => e.type === 'runner.turn_finished' && e.timedOut).length, 2);
  assert.ok(f.events().some(e => e.type === 'runner.blocked' && e.reason === 'roadmap_blocked'));
  assert.equal(f.events().some(e => e.reason === 'repeated_timeout'), false);
});
test('repeated timeouts do not abort a worker that can continue productive work', t => {
  const f = fixture(t, 'worker-timeout-productive'); const result = f.run(['--timeout', '1s']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), ['WORKER', 'WORKER', 'WORKER']);
  assert.equal(f.events().some(event => event.type === 'runner.blocked'), false);
});
test('legacy count-based recovery flags request worker review without forcing resolver dispatch', t => {
  const f = fixture(t, 'normal');
  fs.writeFileSync(f.progress + '.recovery.json', JSON.stringify({ version: 1, roadmap: f.roadmap,
    quota: null, reviewRequested: true, loopBlockedRevision: 'historical-counter' }));
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), Array(7).fill('WORKER'));
  assert.match(fs.readFileSync(path.join(f.dir, 'prompt-1'), 'utf8'), /Legacy recovery flags request a review/);
  assert.equal(f.events().some(event => event.type === 'runner.blocked'), false);
});
test('STOPPED skips saved quota waits and compaction without dispatching a session', t => {
  const f = fixture(t);
  fs.writeFileSync(f.progress, 'Status: STOPPED\n## Current handoff\n'.padEnd(32769, 'e'));
  fs.writeFileSync(f.progress + '.recovery.json', JSON.stringify({ version: 1, roadmap: f.roadmap,
    quota: { deadline: Date.now() + 86400000, resumeAt: Date.now() + 3600000 } }));
  const result = f.run(); assert.equal(result.status, 75); assert.deepEqual(f.calls(), []);
});
