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
  if (mode.startsWith('source')) fs.appendFileSync(roadmap, '\nUnexpected compactor requirement rewrite.\n');
  if (mode === 'source-capacity') {
    console.log(JSON.stringify({ type: 'error', message: 'Selected model is at capacity' }));
    process.exit(1);
  }
  if (mode !== 'noop') {
    const evidence = JSON.parse(prompt.match(/^Detailed evidence directory: (.+)$/m)[1]);
    fs.writeFileSync(path.join(evidence, 'GATE-2.md'), old);
    const status = mode === 'status' ? 'COMPLETE' : old.match(/^Status: (.+)$/m)[1];
    const handoff = '# Handoff\nStatus: ' + status +
      '\n\n## Current handoff\nGATE-2: preserve the release receipt; details: ' + path.join(evidence, 'GATE-2.md') + '\n';
    fs.writeFileSync(progress, mode === 'compact-wide' ? handoff.padEnd(31 * 1024, 'e') : handoff);
  }
} else if (role === 'RESOLVER') {
  fs.writeFileSync(progress, '# Handoff\nStatus: STOPPED\n## Current handoff\nRequired release receipt remains unavailable.\n');
  fs.writeFileSync(JSON.parse(prompt.match(/^Resolution decision file: (.+)$/m)[1]), JSON.stringify({
    resolutionId: prompt.match(/^Resolution ID: (.+)$/m)[1], outcome: 'stopped',
    evidence: 'Prepared missing release receipt', nextAction: 'Supply receipt' }));
} else {
  assert.ok(fs.statSync(progress).size < 32 * 1024);
  if (process.env.CONTEXT_TEST_RECONCILE === 'yes') assert.match(prompt, /Roadmap reconciliation required: YES/);
  const n = calls.filter(r => r === 'WORKER').length;
  let source = fs.readFileSync(roadmap, 'utf8');
  if (!mode.startsWith('loop')) source = source.replace('- [ ] GATE-' + n, '- [x] GATE-' + n);
  source = source.replace(/<!-- roadmap-runner:delivery:start -->[\s\S]*?<!-- roadmap-runner:delivery:end -->/,
    '<!-- roadmap-runner:delivery:start -->\nReceipt ' + n + '\n<!-- roadmap-runner:delivery:end -->');
  if (mode !== 'grow' && !mode.startsWith('loop')) source = source.replaceAll('- [ ]', '- [x]');
  fs.writeFileSync(roadmap, source);
  const complete = (mode === 'loop-clear' && n >= 3) || (!mode.startsWith('loop') && (mode !== 'grow' || n === 2));
  if (complete) fs.writeFileSync(roadmap, source.replaceAll('- [ ]', '- [x]'));
  if (mode === 'loop-detected' && n === 3) { fs.writeFileSync(progress, '# Handoff\nStatus: BLOCKED\n## Current handoff\nLoop: attempts 1 and 2 have unchanged transport input.\n'); process.exit(0); }
  let handoff = '# Handoff\nStatus: ' + (complete ? 'COMPLETE' : 'IN_PROGRESS') + '\n\n## Current handoff\nGATE-2: release receipt required.\n';
  if (!complete) handoff = handoff.padEnd(32 * 1024 + 100, 'e');
  fs.writeFileSync(progress, handoff);
}
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 12 } }));
