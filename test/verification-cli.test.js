import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/roadmap-runner.js', import.meta.url));

for (const exitCode of [0, 4]) test(`check CLI preserves exit ${exitCode} for fresh and reused prepared verification`, t => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-verification-cli-'));
  t.after(() => fs.rmSync(workdir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workdir, 'source.js'), 'export const value = 1;\n');
  const spec = { criteriaRevision: 'prepared-v1', taskId: 'API-01.1',
    command: [process.execPath, '-e', `require('node:fs').appendFileSync('invocations', 'x'); console.log('prepared result'); process.exitCode = ${exitCode};`],
    cwd: '.', inputs: ['source.js'], config: [], environment: [], runtime: { node: process.version }, coverageComplete: true };
  fs.writeFileSync(path.join(workdir, 'check.json'), JSON.stringify(spec));
  const run = () => spawnSync(process.execPath, [cli, 'check', '--spec', 'check.json', '--workspace', workdir], {
    cwd: workdir, encoding: 'utf8', timeout: 10000, env: { ...process.env, ROADMAP_WORKER_CONTEXT: 'prepared-worker', ROADMAP_NOTIFY: 'off' },
  });
  const first = run();
  assert.equal(first.status, exitCode, first.stderr);
  const initial = JSON.parse(first.stdout);
  assert.equal(initial.exitCode, exitCode); assert.equal(initial.reused, false);
  assert.equal(initial.acceptanceAuthority, false);
  const second = run();
  assert.equal(second.status, exitCode, second.stderr);
  const reused = JSON.parse(second.stdout);
  assert.equal(reused.reused, true); assert.equal(reused.receiptId, initial.receiptId);
  assert.equal(fs.readFileSync(path.join(workdir, 'invocations'), 'utf8'), 'x');
  assert.ok(fs.existsSync(initial.receiptFile));
});

test('check CLI surfaces invalid specification errors without invoking a command', t => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-verification-cli-invalid-'));
  t.after(() => fs.rmSync(workdir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workdir, 'check.json'), JSON.stringify({ command: 'shell command is not allowed' }));
  const result = spawnSync(process.execPath, [cli, 'check', '--spec', 'check.json'], { cwd: workdir, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /argv array/);
  assert.equal(result.stdout.trim(), '');
});
