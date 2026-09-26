import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { capacityRetrySettings } from '../lib/runner.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin/roadmap-runner.js');
function fixture(t, mode) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-check-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const roadmap = path.join(temp, 'roadmap.md');
  fs.writeFileSync(roadmap, 'Status: IN_PROGRESS\n');
  const mock = path.join(temp, 'mock.js');
  fs.writeFileSync(mock, `#!/usr/bin/env node
import fs from 'node:fs';
const count = fs.existsSync('count') ? Number(fs.readFileSync('count')) + 1 : 1;
fs.writeFileSync('count', String(count));
fs.appendFileSync('models', JSON.stringify(process.argv) + '\\n');
const mode = process.env.TEST_MODE;
if (mode === 'recover' && count > 1) {
 fs.writeFileSync('roadmap.md', 'Status: COMPLETE\\n');
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RECOVERED'}}));
} else {
 console.log(JSON.stringify({type:'error',message: mode === 'ordinary' ? 'Authentication failed' : 'Selected model is at capacity. Please try a different model.'}));
 if (mode === 'mixed') console.log(JSON.stringify({type:'turn.failed',error:{message:'Authentication failed'}}));
 process.stderr.write('OAuth refresh warning\\n');
 process.exitCode = 1;
}
`);
  fs.chmodSync(mock, 0o755);
  return {
    temp,
    args: [cli, roadmap, '--client-bin', mock, '--model', 'unchanged-model'],
    options: { cwd: temp, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, TEST_MODE: mode, ROADMAP_CAPACITY_RETRIES: '2', ROADMAP_CAPACITY_DELAY: '1', ROADMAP_CAPACITY_MAX_DELAY: '2' } },
  };
}

test('capacity configuration rejects invalid bounds', () => {
  assert.deepEqual(capacityRetrySettings({}), { retries: 10, delayMs: 300000, maxDelayMs: 300000 });
  assert.throws(() => capacityRetrySettings({ ROADMAP_CAPACITY_RETRIES: '-1' }));
  assert.throws(() => capacityRetrySettings({ ROADMAP_CAPACITY_DELAY: '0' }));
  assert.throws(() => capacityRetrySettings({ ROADMAP_CAPACITY_DELAY: '301' }));
});

test('capacity retry recovers with same model and existing files', (t) => {
  const f = fixture(t, 'recover');
  const result = spawnSync(process.execPath, f.args, f.options);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /retry 1\/2 in 1s \(same model\)/);
  assert.match(result.stdout, /RECOVERED/);
  assert.equal(fs.readFileSync(path.join(f.temp, 'count'), 'utf8'), '2');
  for (const line of fs.readFileSync(path.join(f.temp, 'models'), 'utf8').trim().split('\n')) {
    assert.ok(JSON.parse(line).includes('unchanged-model'));
  }
});

test('persistent capacity errors exhaust finite exponential retries', (t) => {
  const f = fixture(t, 'always');
  const result = spawnSync(process.execPath, f.args, f.options);
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stdout, /retry 2\/2 in 2s/);
  assert.equal(fs.readFileSync(path.join(f.temp, 'count'), 'utf8'), '3');
  assert.match(fs.readFileSync(path.join(f.temp, 'roadmap.md'), 'utf8'), /IN_PROGRESS/);
});

for (const mode of ['ordinary', 'mixed']) {
  test(`${mode} failure does not retry`, (t) => {
    const f = fixture(t, mode);
    const result = spawnSync(process.execPath, f.args, f.options);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(fs.readFileSync(path.join(f.temp, 'count'), 'utf8'), '1');
    assert.doesNotMatch(result.stdout, /retry/);
  });
}

test('Ctrl-C interrupts capacity backoff without another invocation', async (t) => {
  const f = fixture(t, 'always');
  f.options.env.ROADMAP_CAPACITY_DELAY = '30';
  f.options.env.ROADMAP_CAPACITY_MAX_DELAY = '30';
  const child = spawn(process.execPath, f.args, { ...f.options, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  const result = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('retry cancellation timed out')), 5000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('retry 1/2')) child.kill('SIGINT');
    });
    child.once('close', code => { clearTimeout(timer); resolve(code); });
    child.once('error', reject);
  });
  assert.equal(result, 130);
  assert.equal(fs.readFileSync(path.join(f.temp, 'count'), 'utf8'), '1');
});
