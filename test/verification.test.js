import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { runVerification, classifyReceipt, recordReview, snapshotPaths, verificationDirectory } from '../lib/verification.js';

function fixture(t, code = "require('node:fs').appendFileSync('invocations', '1'); console.log('checked');") {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-verification-'));
  t.after(() => fs.rmSync(workdir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workdir, 'source.js'), 'const value = 1;');
  fs.writeFileSync(path.join(workdir, 'config.json'), '{}');
  const spec = { criteriaRevision: 'criteria-v1', taskId: 'API-32', command: [process.execPath, '-e', code], cwd: '.',
    inputs: ['source.js'], config: ['config.json'], environment: ['RUNNER_TEST_CONTEXT'], runtime: { node: process.version }, coverageComplete: true };
  const env = { ...process.env, RUNNER_TEST_CONTEXT: 'private-value-for-hash-only' };
  return { workdir, spec, env, options: { workdir, env }, count: () => fs.readFileSync(path.join(workdir, 'invocations'), 'utf8').length };
}

test('unchanged declared scope reuses verification while unrelated edits preserve it', async t => {
  const f = fixture(t);
  const first = await runVerification(f.spec, f.options);
  assert.equal(first.receipt.exitCode, 0); assert.equal(first.reused, false);
  assert.equal(first.receipt.counts.tests, null);
  assert.equal((await runVerification(f.spec, f.options)).reused, true);
  fs.writeFileSync(path.join(f.workdir, 'unrelated.md'), 'unrelated');
  assert.equal((await runVerification(f.spec, f.options)).reused, true); assert.equal(f.count(), 1);
  assert.equal(JSON.stringify(first.receipt).includes(f.env.RUNNER_TEST_CONTEXT), false);
  fs.writeFileSync(path.join(f.workdir, 'source.js'), 'const value = 2;');
  assert.equal(classifyReceipt(first.receipt, f.spec, f.options).reason, 'inputs changed');
  assert.equal((await runVerification(f.spec, f.options)).reused, false); assert.equal(f.count(), 2);
});

test('criteria, configuration, environment, runtime and command changes invalidate separately', async t => {
  const f = fixture(t); const { receipt } = await runVerification(f.spec, f.options);
  for (const [change, reason] of [
    [{ criteriaRevision: 'criteria-v2' }, 'criteriaRevision changed'],
    [{ command: [...f.spec.command, 'different'] }, 'command changed'],
    [{ runtime: { node: 'different-runtime' } }, 'runtime changed'],
  ]) assert.equal(classifyReceipt(receipt, { ...f.spec, ...change }, f.options).reason, reason);
  assert.equal(classifyReceipt(receipt, f.spec, { ...f.options, env: { ...f.env, RUNNER_TEST_CONTEXT: 'changed' } }).reason, 'environment changed');
  fs.writeFileSync(path.join(f.workdir, 'config.json'), '{"changed":true}');
  assert.equal(classifyReceipt(receipt, f.spec, f.options).reason, 'config changed');
});

test('undeclared dependency coverage is unknown and never becomes a cached pass', async t => {
  const f = fixture(t); const spec = { ...f.spec, coverageComplete: false };
  const first = await runVerification(spec, f.options);
  assert.equal(classifyReceipt(first.receipt, spec, f.options).status, 'unknown');
  assert.equal((await runVerification(spec, f.options)).reused, false); assert.equal(f.count(), 2);
  const missing = { ...f.spec }; delete missing.environment;
  assert.equal(classifyReceipt(first.receipt, missing, f.options).status, 'unknown');
});

test('concurrent identical checks share the first completed scoped result', async t => {
  const f = fixture(t, "require('node:fs').appendFileSync('invocations', '1'); setTimeout(() => console.log('checked'), 128);");
  const results = await Promise.all([runVerification(f.spec, f.options), runVerification(f.spec, f.options)]);
  assert.deepEqual(results.map(result => result.reused).sort(), [false, true]); assert.equal(f.count(), 1);
});

test('changed inputs during execution cannot produce reusable verification', async t => {
  const f = fixture(t, "require('node:fs').writeFileSync('source.js', 'mutated by check'); console.log('done');");
  const { receipt } = await runVerification(f.spec, f.options);
  assert.equal(receipt.inputsChanged, true);
  assert.equal(classifyReceipt(receipt, f.spec, f.options).status, 'unknown');
});

test('full raw output and TAP failures remain distinct from passing evidence', async t => {
  const f = fixture(t, "process.stdout.write('x'.repeat(65536) + '\\n# tests 8\\n# pass 6\\n# fail 1\\n# skipped 1\\n'); process.stderr.write('original failure'); process.exitCode = 1;");
  const { receipt } = await runVerification({ ...f.spec, format: 'tap' }, f.options);
  assert.equal(receipt.exitCode, 1); assert.equal(receipt.acceptanceAuthority, false);
  assert.deepEqual(receipt.counts, { tests: 8, passed: 6, failed: 1, skipped: 1, cancelled: null });
  assert.ok(fs.statSync(receipt.stdout).size > 65536);
  assert.equal(fs.readFileSync(receipt.stderr, 'utf8'), 'original failure');
  if (process.platform !== 'win32') assert.equal(fs.statSync(receipt.stdout).mode & 0o777, 0o600);
});

test('expired external evidence and agent reviews cannot authorize reuse', async t => {
  const f = fixture(t); const external = { freshUntil: new Date(Date.now() + 60_000).toISOString() };
  const spec = { ...f.spec, external }; const { receipt } = await runVerification(spec, f.options);
  assert.equal(classifyReceipt(receipt, spec, { ...f.options, now: Date.parse(external.freshUntil) + 1 }).status, 'invalidated');
  const review = recordReview({ taskId: 'API-32', criteriaRevision: 'criteria-v1', verdict: 'looks correct', inputPaths: ['source.js'] }, f.options);
  assert.equal(review.receipt.provenance, 'agent-assertion');
  assert.equal(classifyReceipt(review.receipt, f.spec, f.options).status, 'unknown');
});

test('argv stays literal and escaping dependency paths are rejected before execution', async t => {
  const f = fixture(t, 'console.log(process.argv[1]);');
  const literal = '$(touch should-not-exist)';
  const { receipt } = await runVerification({ ...f.spec, command: [...f.spec.command, literal] }, f.options);
  assert.equal(fs.readFileSync(receipt.stdout, 'utf8').trim(), literal);
  assert.equal(fs.existsSync(path.join(f.workdir, 'should-not-exist')), false);
  fs.symlinkSync(os.tmpdir(), path.join(f.workdir, 'escape'));
  await assert.rejects(runVerification({ ...f.spec, inputs: ['escape/missing-file'] }, f.options), /outside the workspace/);
  assert.throws(() => snapshotPaths(f.workdir, ['../missing-file']), /outside the workspace/);
});

test('explicit force reruns a matching check without overwriting its old evidence', async t => {
  const f = fixture(t); const first = await runVerification(f.spec, f.options);
  const second = await runVerification({ ...f.spec, force: true }, f.options);
  assert.equal(second.reused, false); assert.notEqual(first.receipt.id, second.receipt.id);
  assert.ok(fs.existsSync(first.receiptFile)); assert.equal(f.count(), 2);
  assert.equal(fs.readdirSync(path.join(verificationDirectory(f.workdir), 'locks')).length, 0);
});

test('a scope changed while waiting joins the new input lock instead of duplicating its command', async t => {
  const f = fixture(t, "require('node:fs').appendFileSync('invocations', '1'); setTimeout(() => console.log('checked'), 1024);");
  const first = runVerification(f.spec, f.options);
  const deadline = Date.now() + 8000;
  while (!fs.existsSync(path.join(f.workdir, 'invocations')) && Date.now() < deadline) await delay(16);
  assert.ok(fs.existsSync(path.join(f.workdir, 'invocations')));
  const waiting = runVerification(f.spec, f.options);
  fs.writeFileSync(path.join(f.workdir, 'source.js'), 'changed while first command was running');
  const current = runVerification(f.spec, f.options);
  const results = await Promise.all([first, waiting, current]);
  assert.equal(results[0].receipt.inputsChanged, true);
  assert.equal(results.filter(result => result.reused).length, 1);
  assert.equal(f.count(), 2);
});

test('timed-out leader cannot release a live descendant into the next check', { skip: process.platform === 'win32' }, async t => {
  const childCode = "process.on('SIGTERM', () => {}); setInterval(() => require('node:fs').appendFileSync('heartbeat', '1'), 16);";
  const code = `const fs = require('node:fs'); const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {stdio: 'ignore'}); fs.writeFileSync('descendant.pid', String(child.pid)); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`;
  const f = fixture(t, code);
  const { receipt } = await runVerification({ ...f.spec, timeoutMs: 512 }, f.options);
  const pid = Number(fs.readFileSync(path.join(f.workdir, 'descendant.pid'), 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* Already stopped. */ } });
  assert.equal(receipt.timedOut, true); assert.equal(receipt.completed, false);
  const count = fs.statSync(path.join(f.workdir, 'heartbeat')).size;
  await delay(128);
  assert.equal(fs.statSync(path.join(f.workdir, 'heartbeat')).size, count);
  assert.equal(classifyReceipt(receipt, f.spec, f.options).status, 'unknown');
  if (receipt.cleanupIncomplete) await assert.rejects(runVerification({ ...f.spec, timeoutMs: 512 }, f.options), /cleanup is unconfirmed/);
});

test('relative PATH entries resolve against the command cwd and changed executables invalidate receipts', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.workdir, 'bin'));
  const executable = path.join(f.workdir, 'bin', 'runner-checker');
  fs.writeFileSync(executable, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
  const spec = { ...f.spec, command: ['runner-checker'] };
  const options = { ...f.options, env: { ...f.env, PATH: `bin${path.delimiter}${f.env.PATH || ''}` } };
  const first = await runVerification(spec, options);
  assert.equal(first.receipt.scope.runtime.executable.path, executable);
  assert.equal(first.receipt.exitCode, 0);
  fs.writeFileSync(executable, `#!${process.execPath}\nprocess.exit(7);\n`);
  const second = await runVerification(spec, options);
  assert.equal(second.reused, false); assert.equal(second.receipt.exitCode, 7);
  const unknown = { ...first.receipt, scope: { ...first.receipt.scope, runtime: { ...first.receipt.scope.runtime, executable: null } } };
  assert.equal(classifyReceipt(unknown, spec, options).status, 'unknown');
});

test('a killed verification helper does not release its still-running detached command', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t, "const fs=require('node:fs'); fs.appendFileSync('starts', process.pid+'\\n'); setTimeout(()=>fs.appendFileSync('ends',process.pid+'\\n'),4096);");
  const helper = path.join(f.workdir, 'helper.mjs');
  fs.writeFileSync(helper, `import {runVerification} from ${JSON.stringify(new URL('../lib/verification.js', import.meta.url).href)};\nawait runVerification(${JSON.stringify(f.spec)},{workdir:${JSON.stringify(f.workdir)}});\n`);
  const processHelper = spawn(process.execPath, [helper], { cwd: f.workdir, env: f.env, stdio: 'ignore' });
  const ended = new Promise(resolve => processHelper.once('exit', resolve));
  let group = null;
  try {
    const deadline = Date.now() + 8000;
    while (!fs.existsSync(path.join(f.workdir, 'starts')) && Date.now() < deadline) await delay(16);
    assert.ok(fs.existsSync(path.join(f.workdir, 'starts')));
    const locks = path.join(verificationDirectory(f.workdir), 'locks');
    const owner = JSON.parse(fs.readFileSync(path.join(locks, fs.readdirSync(locks)[0]), 'utf8'));
    group = owner.processGroupId;
    assert.ok(Number.isInteger(group)); assert.equal(owner.phase, 'running');
    processHelper.kill('SIGKILL'); await ended;
    await assert.rejects(runVerification(f.spec, { ...f.options, lockWaitMs: 128 }), /still running/);
    assert.equal(fs.readFileSync(path.join(f.workdir, 'starts'), 'utf8').trim().split('\n').length, 1);
  } finally {
    if (processHelper.exitCode === null && processHelper.signalCode === null) processHelper.kill('SIGKILL');
    if (group) { try { process.kill(-group, 'SIGKILL'); } catch { /* Already ended. */ } }
    await ended;
  }
});
