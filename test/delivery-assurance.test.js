import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runVerification, classifyReceipt, recordReview } from '../lib/verification.js';

const prepared = fileURLToPath(new URL('./fixtures/delivery-assurance.cjs', import.meta.url));
function fixture(t) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-delivery-assurance-'));
  t.after(() => fs.rmSync(workdir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workdir, 'source'));
  fs.mkdirSync(path.join(workdir, 'nested'));
  const put = (file, value) => fs.writeFileSync(path.join(workdir, file), JSON.stringify(value));
  put('fixture.json', { itemId: 'example', enabled: true, roles: ['reader'], timeoutMs: 1000 });
  put('service.json', { maxTimeoutMs: 2000 });
  put('source/control.json', { enforceAuthorization: true });
  put('build.json', { hang: false });
  put('mapping.json', { public: './source/control.json' });
  fs.copyFileSync(prepared, path.join(workdir, 'stage.cjs'));
  const inputs = {
    configuration: ['fixture.json', 'service.json'], compile: ['source', 'build.json'],
    module: ['mapping.json', 'source'], mount: ['fixture.json'], behavior: ['source', 'fixture.json'], cleanup: ['service.json'],
  };
  const spec = (stage, extra = {}) => ({ taskId: 'ASSURE-01', criteriaRevision: 'exact-criteria-v1', operation: 'delivery-check', stage,
    command: [process.execPath, 'stage.cjs', stage], cwd: '.', inputs: [...inputs[stage], 'stage.cjs'],
    config: [], environment: [], runtime: { node: process.version }, coverageComplete: true, timeoutMs: 3000, ...extra });
  // Deliberately pass only a local deterministic environment to fixture commands.
  const options = { workdir, env: {} };
  const run = (stage, extra) => runVerification(spec(stage, extra), options);
  const calls = stage => fs.existsSync(path.join(workdir, 'dispatches.jsonl')) ? fs.readFileSync(path.join(workdir, 'dispatches.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(row => !stage || row.stage === stage).length : 0;
  const edit = (file, value, extra = {}) => runVerification({ ...spec('compile'), stage: 'repair', operation: 'repair-input',
    command: [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], process.argv[2]);', file, JSON.stringify(value)],
    inputs: [file.startsWith('source/') ? 'source' : file], ...extra }, options);
  return { workdir, put, spec, options, run, calls, edit };
}

for (const [name, value] of [
  ['incorrect field', { id: 'example', enabled: true, roles: ['reader'], timeoutMs: 1000 }],
  ['incorrect type', { itemId: 7, enabled: true, roles: ['reader'], timeoutMs: 1000 }],
  ['incorrect authorization', { itemId: 'example', enabled: true, roles: [], timeoutMs: 1000 }],
  ['timeout exceeding service limit', { itemId: 'example', enabled: true, roles: ['reader'], timeoutMs: 3000 }],
]) test(`fixture preflight rejects ${name} before compile or mount`, async t => {
  const f = fixture(t); f.put('fixture.json', value);
  const first = await f.run('configuration'); assert.equal(first.receipt.exitCode, 1);
  await assert.rejects(f.run('mount', { prerequisites: [first.receipt.id] }), /Prerequisite/);
  assert.equal((await f.run('configuration')).reused, true);
  assert.equal(f.calls('configuration'), 1); assert.equal(f.calls('compile'), 0); assert.equal(f.calls('mount'), 0);
});

test('wrong cwd and a failed edit preserve failed evidence without another probe', async t => {
  const f = fixture(t); f.put('source/control.json', { enforceAuthorization: false });
  const first = await f.run('behavior');
  const edit = await f.edit('source/control.json', { enforceAuthorization: true }, { cwd: 'nested' });
  assert.notEqual(edit.receipt.exitCode, 0);
  const next = await f.run('behavior', { repair: { failedReceiptId: first.receipt.id, editReceiptId: edit.receipt.id } });
  assert.equal(next.reused, true); assert.equal(next.receipt.exitCode, 1); assert.equal(f.calls('behavior'), 1);
  assert.ok(fs.existsSync(first.receiptFile));
});

test('an unrelated edit cannot renew a fully scoped failure; a verified repair can', async t => {
  const f = fixture(t); f.put('source/control.json', { enforceAuthorization: false });
  const first = await f.run('behavior');
  const unrelated = await f.edit('notes.json', { prose: 'repair attempted' });
  const repair = { failedReceiptId: first.receipt.id, editReceiptId: unrelated.receipt.id };
  assert.equal((await f.run('behavior', { repair })).receipt.id, first.receipt.id);
  await assert.rejects(f.run('behavior', { repair, force: true, forceReason: 'Try unchanged input' }), /relevant failing input/);
  assert.equal(f.calls('behavior'), 1);
  const fixed = await f.edit('source/control.json', { enforceAuthorization: true });
  const result = await f.run('behavior', { repair: { failedReceiptId: first.receipt.id, editReceiptId: fixed.receipt.id } });
  assert.equal(result.receipt.exitCode, 0); assert.equal(f.calls('behavior'), 2);
  assert.ok(fs.existsSync(first.receipt.stderr));
});

test('a changed input without a successful matching edit receipt cannot authorize a probe', async t => {
  const f = fixture(t); f.put('source/control.json', { enforceAuthorization: false });
  const first = await f.run('behavior');
  const wrong = await f.edit('source/control.json', { enforceAuthorization: true }, { cwd: 'nested' });
  f.put('source/control.json', { enforceAuthorization: true });
  await assert.rejects(f.run('behavior', { repair: { failedReceiptId: first.receipt.id, editReceiptId: wrong.receipt.id } }), /did not complete successfully/);
  assert.equal(f.calls('behavior'), 1);
});

test('module errors fail immediately; repairing the mapping exposes the distinct content assertion', async t => {
  const f = fixture(t); f.put('mapping.json', { public: './missing' }); f.put('fixture.json', { itemId: 'wrong', enabled: true, roles: ['reader'], timeoutMs: 1000 });
  const compiled = await f.run('compile'); const broken = await f.run('module');
  assert.match(fs.readFileSync(broken.receipt.stderr, 'utf8'), /ERR_MODULE_NOT_FOUND/);
  await assert.rejects(f.run('mount', { prerequisites: [broken.receipt.id] }), /Prerequisite/);
  assert.equal(f.calls('mount'), 0);
  const edit = await f.edit('mapping.json', { public: './source/control.json' });
  const module = await f.run('module', { repair: { failedReceiptId: broken.receipt.id, editReceiptId: edit.receipt.id } });
  assert.equal(module.receipt.exitCode, 0);
  const content = await f.run('behavior', { prerequisites: [compiled.receipt.id, module.receipt.id] });
  assert.equal(content.receipt.exitCode, 1); assert.match(fs.readFileSync(content.receipt.stderr, 'utf8'), /exact content assertion/);
  assert.notEqual(content.receipt.failureSignature, broken.receipt.failureSignature);
  assert.equal((await f.run('compile')).reused, true); assert.equal(f.calls('compile'), 1);
});

test('fixture-only repairs retain compiler evidence; source inventory drift invalidates it', async t => {
  const f = fixture(t); const compiled = await f.run('compile');
  f.put('fixture.json', { itemId: 'fixed-fixture', enabled: true, roles: ['reader'], timeoutMs: 1000 });
  assert.equal((await f.run('compile')).receipt.id, compiled.receipt.id);
  f.put('source/new-module.json', { new: true });
  assert.equal(classifyReceipt(compiled.receipt, f.spec('compile'), f.options).status, 'invalidated');
  assert.equal((await f.run('compile')).reused, false); assert.equal(f.calls('compile'), 2);
});

test('compilation timeout stays failed and is reused until its consumed input is repaired', async t => {
  const f = fixture(t); f.put('build.json', { hang: true });
  const first = await f.run('compile', { timeoutMs: 200 });
  assert.equal(first.receipt.timedOut, true); assert.equal(first.receipt.acceptanceAuthority, false);
  assert.equal((await f.run('compile', { timeoutMs: 200 })).receipt.id, first.receipt.id);
  await assert.rejects(f.run('behavior', { prerequisites: [first.receipt.id] }), /Prerequisite/);
  assert.equal(f.calls('compile'), 1); assert.equal(f.calls('behavior'), 0);
  const edit = await f.edit('build.json', { hang: false });
  const fixed = await f.run('compile', { repair: { failedReceiptId: first.receipt.id, editReceiptId: edit.receipt.id } });
  assert.equal(fixed.receipt.exitCode, 0); assert.equal(f.calls('compile'), 2);
});

test('a source-review finding cannot promote passing checks or survive a relevant source change', async t => {
  const f = fixture(t); const first = await f.run('behavior'); const compiled = await f.run('compile');
  const review = recordReview({ taskId: 'ASSURE-01', criteriaRevision: 'exact-criteria-v1', verdict: 'Missing write authorization control', inputPaths: ['source'], findings: ['Add the missing control'] }, f.options);
  assert.equal(classifyReceipt(review.receipt, f.spec('behavior'), f.options).status, 'unknown');
  f.put('source/control.json', { enforceAuthorization: false });
  assert.equal(classifyReceipt(first.receipt, f.spec('behavior'), f.options).status, 'invalidated');
  assert.equal(classifyReceipt(compiled.receipt, f.spec('compile'), f.options).status, 'invalidated');
  assert.equal((await f.run('behavior')).receipt.exitCode, 1);
  assert.ok(fs.existsSync(first.receiptFile)); assert.equal(f.calls('behavior'), 2);
});

test('task/stage bindings and incomplete coverage cannot silently create cache hits', async t => {
  const f = fixture(t); const first = await f.run('compile');
  assert.equal((await f.run('compile', { taskId: 'ASSURE-02' })).reused, false);
  assert.equal((await f.run('compile', { coverageComplete: false })).reused, false);
  assert.equal((await f.run('compile', { coverageComplete: false })).reused, false);
  assert.equal(classifyReceipt(first.receipt, f.spec('compile', { stage: 'behavior' }), f.options).status, 'invalidated');
  await assert.rejects(f.run('compile', { force: true }), /forceReason/);
});

test('a complete staged recipe passes exact behavior and cleanup while keeping prior stages reusable', async t => {
  const f = fixture(t); const configuration = await f.run('configuration'), compile = await f.run('compile'), module = await f.run('module');
  const mount = await f.run('mount', { prerequisites: [configuration.receipt.id, compile.receipt.id, module.receipt.id] });
  const behavior = await f.run('behavior', { prerequisites: [mount.receipt.id], format: 'tap' });
  assert.equal(behavior.receipt.exitCode, 0); assert.equal(behavior.receipt.counts.failed, 0);
  assert.equal((await f.run('cleanup', { prerequisites: [behavior.receipt.id] })).receipt.exitCode, 0);
  assert.equal((await f.run('compile')).reused, true); assert.equal(f.calls('compile'), 1); assert.equal(f.calls('cleanup'), 1);
});

test('expired external state cannot reuse a timed-out local result', async t => {
  const f = fixture(t); f.put('build.json', { hang: true });
  const scope = { timeoutMs: 200, external: { freshUntil: '2020-01-01T00:00:00.000Z' } };
  assert.equal((await f.run('compile', scope)).receipt.timedOut, true);
  assert.equal((await f.run('compile', scope)).reused, false);
  assert.equal(f.calls('compile'), 2);
});

test('a verified prerequisite can repair a consumed generated input without a separate edit receipt', async t => {
  const f = fixture(t);
  const spec = f.spec('module', { command: [process.execPath, '-e', 'process.exit(require("node:fs").existsSync("dependency.ready") ? 0 : 1)'], inputs: ['dependency.ready'] });
  const failed = await runVerification(spec, f.options); assert.equal(failed.receipt.exitCode, 1);
  const prerequisite = await runVerification(f.spec('configuration', { command: [process.execPath, '-e', 'require("node:fs").writeFileSync("dependency.ready", "prepared");'], inputs: ['service.json'] }), f.options);
  const fixed = await runVerification({ ...spec, prerequisites: [prerequisite.receipt.id], repair: { failedReceiptId: failed.receipt.id } }, f.options);
  assert.equal(fixed.receipt.exitCode, 0); assert.equal(fixed.reused, false);
  f.put('service.json', { maxTimeoutMs: 500 });
  await assert.rejects(runVerification({ ...spec, prerequisites: [prerequisite.receipt.id] }, f.options), /Prerequisite/);
});
