#!/usr/bin/env node
// Prepared local client only. No provider transport or credentials.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { gunzipSync } = require('node:zlib');
const mode = process.env.CONTEXT_TEST_MODE;
const progress = process.env.CONTEXT_TEST_PROGRESS;
const roadmap = process.env.CONTEXT_TEST_ROADMAP;
const prompt = process.argv.at(-1);
const role = prompt.match(/^Runner role: (.+)$/m)[1];
const calls = fs.existsSync('calls.json') ? JSON.parse(fs.readFileSync('calls.json')) : [];
calls.push(role);
fs.writeFileSync('calls.json', JSON.stringify(calls));
if (calls.length > 6) process.exit(99);
fs.writeFileSync('prompt-' + calls.length, prompt);
console.log(JSON.stringify({ type: 'turn.started', model: 'prepared-model' }));
if (role === 'COMPACTOR') {
  const snapshot = JSON.parse(prompt.match(/^Pre-compaction snapshot: (.+)$/m)[1]);
  const old = fs.readFileSync(progress, 'utf8');
  assert.equal(gunzipSync(fs.readFileSync(snapshot)).toString(), old);
  if (mode === 'failure') process.exit(9);
  if (mode === 'timeout') { setInterval(() => {}, 1000); return; }
  if (mode !== 'noop') {
    const evidence = JSON.parse(prompt.match(/^Detailed evidence directory: (.+)$/m)[1]);
    fs.writeFileSync(path.join(evidence, 'GATE-2.md'), old);
    fs.writeFileSync(progress, '# Handoff\nStatus: ' + (mode === 'status' ? 'COMPLETE' : 'IN_PROGRESS') +
      '\n\n## Current handoff\nGATE-2: preserve the release receipt; details: ' + path.join(evidence, 'GATE-2.md') + '\n');
  }
} else if (role === 'SUPERVISOR') {
  const review = prompt.match(/^Review ID: (.+)$/m)[1];
  fs.appendFileSync(progress, '\n## Latest supervisor review\nReview ID: ' + review + '\nHealth: HEALTHY\nNext: GATE-2.\n');
} else {
  assert.ok(fs.statSync(progress).size < 24 * 1024);
  if (process.env.CONTEXT_TEST_RECONCILE === 'yes') assert.match(prompt, /Roadmap reconciliation required: YES/);
  const n = calls.filter(r => r === 'WORKER').length;
  let source = fs.readFileSync(roadmap, 'utf8');
  source = source.replace('- [ ] GATE-' + n, '- [x] GATE-' + n);
  source = source.replace(/<!-- roadmap-runner:delivery:start -->[\s\S]*?<!-- roadmap-runner:delivery:end -->/,
    '<!-- roadmap-runner:delivery:start -->\nReceipt ' + n + '\n<!-- roadmap-runner:delivery:end -->');
  if (mode !== 'grow') source = source.replaceAll('- [ ]', '- [x]');
  fs.writeFileSync(roadmap, source);
  const complete = mode !== 'grow' || n === 2;
  let handoff = '# Handoff\nStatus: ' + (complete ? 'COMPLETE' : 'IN_PROGRESS') + '\n\n## Current handoff\nGATE-2: release receipt required.\n';
  if (!complete) handoff = handoff.padEnd(24 * 1024 + 100, 'e');
  fs.writeFileSync(progress, handoff);
}
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 12 } }));
