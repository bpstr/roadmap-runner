import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/roadmap-runner.js', import.meta.url));

function fixture(t, mode, { limit = 3, supervisor = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-source-loop-'));
  t.after(() => {
    const marker = path.join(dir, 'review-directory');
    if (fs.existsSync(marker)) fs.rmSync(fs.readFileSync(marker, 'utf8'), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const source = path.join(dir, 'roadmap.md');
  const progress = path.join(dir, 'progress.md');
  const tasks = Array.from({ length: mode === 'productive' ? 5 : 2 }, (_, i) =>
    `- [${mode === 'complete-churn' ? 'x' : ' '}] LOOP-${i + 1} Acceptance ${i + 1}.`).join('\n');
  fs.writeFileSync(source, `# Roadmap\nStatus: IN_PROGRESS\n\n## Acceptance\n${tasks}\n`);
  fs.writeFileSync(progress, '# Delivery\nStatus: IN_PROGRESS\n');
  const client = path.join(dir, 'prepared.cjs');
  fs.writeFileSync(client, `#!/usr/bin/env node
const fs = require('node:fs');
const crypto = require('node:crypto');
const prompt = process.argv.at(-1);
const mode = ${JSON.stringify(mode)};
const source = ${JSON.stringify(source)};
const progress = ${JSON.stringify(progress)};
const supervisor = prompt.includes('Runner role: SUPERVISOR');
if (supervisor) {
  const evidence = JSON.parse(prompt.match(/^Run evidence JSON: (.+)$/m)[1]);
  fs.writeFileSync('review-directory', require('node:path').dirname(evidence));
}
const counter = supervisor ? 'supervisors' : 'workers';
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter)) + 1 : 1;
fs.writeFileSync(counter, String(n));
if (n > 8) process.exit(99); // A failing regression must remain bounded too.
let text = fs.readFileSync(source, 'utf8');
const snapshot = JSON.parse(prompt.match(/^Source roadmap snapshot: (.+)$/m)[1]);
const sha = crypto.createHash('sha256').update(fs.readFileSync(snapshot)).digest('hex');
if (mode === 'productive') {
  text = text.replace('- [ ]', '- [x]');
  fs.writeFileSync(source, text);
  fs.writeFileSync(progress, '# Delivery\\nStatus: ' + (n === 5 ? 'COMPLETE' : 'IN_PROGRESS') + '\\n');
} else if (mode === 'toggle') {
  text = text.replace(/- \\[[ x]\\] LOOP-1/, '- [' + (n % 2 ? 'x' : ' ') + '] LOOP-1');
  fs.writeFileSync(source, text);
} else if (mode === 'controller') {
  // The test controller alone amends acceptance between sessions.
} else if (mode === 'supervisor-churn' && !supervisor) {
  // A supervisor rewrites source after each unchanged worker.
} else {
  text = text.replace(/^Current delivery:.*\\n/gm, '');
  text = text.replace('# Roadmap\\n', '# Roadmap\\nCurrent delivery: reconciled source ' + sha + '.\\n');
  fs.writeFileSync(source, text);
  fs.writeFileSync(progress, '# Delivery\\nStatus: ' + (mode === 'complete-churn' ? 'COMPLETE' : mode === 'blocked-churn' ? 'BLOCKED' : 'IN_PROGRESS') + '\\n- [x] FAKE-' + n + ' mirrored handoff.\\n');
  if (mode === 'timeout-churn') {
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  }
}
`);
  fs.chmodSync(client, 0o755);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ROADMAP_')));
  Object.assign(env, { ROADMAP_STATE_DIR: path.join(dir, 'registry'), ROADMAP_NOTIFY: 'off',
    ROADMAP_RECOVERY_DELAY: '1', ROADMAP_RECOVERY_MAX_DELAY: '1', ROADMAP_MAX_IDLE_WORKERS: String(limit) });
  const args = [cli, source, '--progress-file', progress, '--client-bin', client,
    '--supervisor-every', supervisor ? '1' : '0', '--timeout', mode === 'timeout-churn' ? '2s' : '5s'];
  const options = { cwd: dir, env, encoding: 'utf8', timeout: 20_000 };
  const count = () => Number(fs.readFileSync(path.join(dir, 'workers'), 'utf8'));
  const events = () => fs.readFileSync(progress + '.events.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
  return { dir, source, progress, args, options, count, events };
}

for (const mode of ['complete-churn', 'open-churn', 'blocked-churn', 'timeout-churn', 'supervisor-churn']) {
  test(`${mode} cannot renew the no-progress budget with source hashes`, t => {
    const f = fixture(t, mode, { supervisor: mode === 'supervisor-churn' });
    const result = spawnSync(process.execPath, f.args, f.options);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 75, result.stderr);
    assert.equal(f.count(), 3);
    assert.equal(f.events().at(-1).reason, 'no_progress_limit');
    assert.ok(fs.existsSync(f.source));
    assert.ok(fs.existsSync(f.progress));
    if (mode === 'complete-churn') {
      const again = spawnSync(process.execPath, f.args, f.options);
      assert.equal(again.status, 75, again.stderr);
      assert.equal(f.count(), 3, 'restart must preserve the exhausted budget without another worker');
      const third = spawnSync(process.execPath, f.args, f.options);
      assert.equal(third.status, 75, third.stderr);
      assert.equal(f.count(), 3, 'repeated restarts cannot bypass the limit');
    }
  });
}

test('only task completion in the live roadmap renews the budget', t => {
  const f = fixture(t, 'productive', { limit: 1 });
  const result = spawnSync(process.execPath, f.args, f.options);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.count(), 5);
  assert.equal(f.events().at(-1).type, 'runner.completed');
});

test('an exhausted budget permits one explicit recovery worker and then stays stopped', t => {
  const f = fixture(t, 'open-churn', { limit: 1 });
  assert.equal(spawnSync(process.execPath, f.args, f.options).status, 75);
  assert.equal(f.count(), 1);
  const recovered = spawnSync(process.execPath, [...f.args, '--recover-blocked'], f.options);
  assert.equal(recovered.status, 75, recovered.stderr);
  assert.equal(f.count(), 2);
  const again = spawnSync(process.execPath, f.args, f.options);
  assert.equal(again.status, 75, again.stderr);
  assert.equal(f.count(), 2, 'the explicit attempt must not reopen the exhausted budget');
});

test('reopening and rechecking the same task cannot repeat progress forever', t => {
  const f = fixture(t, 'toggle');
  const result = spawnSync(process.execPath, f.args, f.options);
  assert.equal(result.status, 75, result.stderr);
  assert.equal(f.count(), 4);
});

test('a controller acceptance amendment between sessions grants one fresh budget', async t => {
  const f = fixture(t, 'controller');
  const child = spawn(process.execPath, f.args, { ...f.options, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let amended = false, stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => {
    stderr += chunk;
    if (!amended && stderr.includes('recovery recheck')) {
      fs.writeFileSync(f.source + '.next', fs.readFileSync(f.source, 'utf8') + '\nRequire an additional controller-owned invariant.\n');
      fs.renameSync(f.source + '.next', f.source);
      amended = true;
    }
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 75, stderr + stdout);
  assert.equal(amended, true);
  assert.equal(f.count(), 6);
});
