import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/roadmap-runner.js', import.meta.url));

// Prepared reviews verify orchestration contracts, not live model judgment.
function fixture(t, mode, every = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-attempt-loop-'));
  const roadmap = path.join(dir, 'roadmap.md');
  const progress = path.join(dir, 'delivery.md');
  fs.writeFileSync(roadmap, '# Roadmap\nStatus: IN_PROGRESS\n- [ ] Finish the long acceptance unit\n');
  const worker = path.join(dir, 'prepared.cjs');
  fs.writeFileSync(worker, `#!/usr/bin/env node
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const prompt = process.argv.at(-1);
const roadmap = ${JSON.stringify(roadmap)};
const progress = ${JSON.stringify(progress)};
const mode = ${JSON.stringify(mode)};
const count = name => { const n = fs.existsSync(name) ? Number(fs.readFileSync(name)) + 1 : 1; fs.writeFileSync(name, String(n)); return n; };
if (prompt.includes('Runner role: SUPERVISOR')) {
  const n = count('reviews');
  if (n > 8) process.exit(99);
  const file = JSON.parse(prompt.match(/^Run evidence JSON: (.+)$/m)[1]);
  fs.writeFileSync('review-directory', path.dirname(file));
  fs.copyFileSync(file, 'review-' + n + '.json');
  const records = JSON.parse(fs.readFileSync(file)).records;
  const id = prompt.match(/^Review ID: (.+)$/m)[1];
  const detected = mode === 'hash-failure' || mode === 'restart-failure';
  fs.writeFileSync(progress, '# Delivery\\nStatus: ' + (detected ? 'BLOCKED' : 'IN_PROGRESS') + '\\n## Latest supervisor review\\nReview ID: ' + id + '\\nHealth: ' + (detected ? 'STUCK' : 'HEALTHY') + '\\nLoop: ' + (detected ? 'DETECTED' : 'CLEAR') + '\\n' + (detected
    ? 'Loop iterations: ' + records.slice(-2).map(r => r.iteration).join(', ') + '\\nLoop attempt: Retry the same transport acceptance check.\\nLoop failure: The check still fails because the transport is missing.\\nLoop unchanged inputs: Transport implementation and dependency receipt are unchanged; only the source delivery hash changed.\\nLoop evidence: Both cited worker outputs report transport-missing with the same prerequisite.\\n'
    : 'Assessment: Prepared evidence shows another distinct investigation or repaired input.\\n'));
  process.exit(0);
}
const n = count('workers');
if (n > 9) process.exit(99);
const failed = mode === 'hash-failure' || mode === 'restart-failure';
if (failed) {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(roadmap)).digest('hex');
  fs.appendFileSync(roadmap, '\\nCurrent delivery: reconciled source hash ' + sha + '\\n');
} else if (mode === 'repaired-input') fs.writeFileSync('transport.js', 'export const repair = ' + n + ';\\n');
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: failed
  ? 'Attempt: transport acceptance check; failure: transport-missing; dependency receipt: missing-v1; implementation unchanged.'
  : 'Distinct investigation/verification step ' + n + ' completed; remaining acceptance work is still open.' }}));
if (mode === 'restart-failure' && n === 2) process.exit(7);
if (!failed && n === 7) {
  fs.writeFileSync(roadmap, fs.readFileSync(roadmap, 'utf8').replace('- [ ]', '- [x]'));
  fs.writeFileSync(progress, '# Delivery\\nStatus: COMPLETE\\n');
}
`);
  fs.chmodSync(worker, 0o755);
  t.after(() => {
    const file = path.join(dir, 'review-directory');
    if (fs.existsSync(file)) fs.rmSync(fs.readFileSync(file, 'utf8'), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const args = [cli, roadmap, '--progress-file', progress, '--client-bin', worker,
    '--supervisor-every', String(every), '--timeout', '5s'];
  const options = { cwd: dir, env: { ...process.env, ROADMAP_NOTIFY: 'off', ROADMAP_NOTIFY_BIN: '',
    ROADMAP_MAX_IDLE_WORKERS: '1' }, encoding: 'utf8', timeout: 20_000 };
  const count = name => fs.existsSync(path.join(dir, name)) ? Number(fs.readFileSync(path.join(dir, name))) : 0;
  return { dir, roadmap, progress, args, options, count,
    run: extra => spawnSync(process.execPath, [...args, ...(extra || [])], options),
    events: () => fs.readFileSync(progress + '.events.jsonl', 'utf8').trim().split('\n').map(JSON.parse) };
}

for (const mode of ['investigation', 'repaired-input']) {
  test(`${mode} continues seven sessions with an open acceptance item`, t => {
    const f = fixture(t, mode);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.count('workers'), 7);
    assert.equal(f.count('reviews'), 3);
    assert.equal(f.events().at(-1).type, 'runner.completed');
    assert.equal(f.events().some(e => e.reason === 'no_progress_limit'), false);
    const evidence = JSON.parse(fs.readFileSync(path.join(f.dir, 'review-3.json')));
    assert.ok(evidence.records.every(r => !r.sourceBefore.head.includes('- [x]')));
    if (mode === 'investigation') assert.ok(evidence.records.every(r => !r.trackingChanged));
  });
}

test('hash-only retries cannot postpone review and a confirmed repeated failure stays blocked on restart', t => {
  const f = fixture(t, 'hash-failure');
  const result = f.run();
  assert.equal(result.status, 75, result.stderr);
  assert.equal(f.count('workers'), 3);
  assert.equal(f.count('reviews'), 1);
  const evidence = JSON.parse(fs.readFileSync(path.join(f.dir, 'review-1.json')));
  assert.ok(evidence.records.every(r => r.sourceBefore.sha256 !== r.sourceAfter.sha256));
  const event = f.events().at(-1);
  assert.equal(event.reason, 'loop_detected');
  assert.match(event.loopFailure, /transport is missing/);
  assert.match(event.loopUnchangedInputs, /only the source delivery hash changed/);
  assert.equal(f.run().status, 75);
  assert.equal(f.count('workers'), 3);
  assert.equal(f.count('reviews'), 1);
  assert.equal(f.run(['--recover-blocked']).status, 75);
  assert.equal(f.count('workers'), 4, 'explicit recovery grants exactly one worker before another failed-attempt review');
});

test('attempt evidence and review cadence survive a failed invocation', t => {
  const f = fixture(t, 'restart-failure', 3);
  const first = f.run();
  assert.equal(first.status, 7, first.stderr);
  assert.equal(f.count('workers'), 2);
  assert.equal(f.count('reviews'), 0);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(f.dir, '.roadmap-runner', fs.readdirSync(path.join(f.dir, '.roadmap-runner'))[0], 'supervision.json')));
  assert.equal(checkpoint.records.at(-1).code, 7, 'the failed attempt receipt survives the invocation');
  const restarted = f.run();
  assert.equal(restarted.status, 75, restarted.stderr);
  assert.equal(f.count('workers'), 5, 'the first successful attempt still counts toward the review interval');
  const evidence = JSON.parse(fs.readFileSync(path.join(f.dir, 'review-1.json')));
  assert.deepEqual(evidence.records.map(r => r.iteration), [3, 4, 5]);
});

test('disabling supervision does not leave a checkbox or file-based stopping condition', t => {
  const f = fixture(t, 'investigation', 0);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.count('workers'), 7);
  assert.equal(f.count('reviews'), 0);
});
