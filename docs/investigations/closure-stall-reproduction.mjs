// Prepared local client only. No coding agent, provider transport or credentials.
// Run: node docs/investigations/closure-stall-reproduction.mjs OUTPUT_DIRECTORY [CLI_PATH]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const output = path.resolve(process.argv[2] || 'closure-stall-evidence');
fs.mkdirSync(output, { recursive: true });
const work = fs.mkdtempSync(path.join(output, 'prepared-'));
const roadmap = path.join(work, 'roadmap.md');
const progress = path.join(work, 'progress.md');
const client = path.join(work, 'prepared-client.cjs');
fs.writeFileSync(roadmap, '# Roadmap\n\nStatus: IN_PROGRESS\n\n- [ ] DEMO-01 Deliver and validate the required outcome.\n');
fs.writeFileSync(progress, '# Handoff\n\nStatus: IN_PROGRESS\n\nContinue DEMO-01.\n');

function preparedClient() {
  const fs = require('node:fs');
  const prompt = process.argv.at(-1);
  const binding = JSON.parse(prompt.match(/^Result binding: (.+)$/m)[1]);
  const resultFile = JSON.parse(prompt.match(/^Optional structured result file: (.+)$/m)[1]);
  const calls = fs.existsSync('calls.json') ? JSON.parse(fs.readFileSync('calls.json')) : [];
  calls.push({ task: binding.taskId, criteriaRevision: binding.criteriaRevision });
  fs.writeFileSync('calls.json', JSON.stringify(calls));
  fs.appendFileSync('supporting-work.txt', `Supporting slice ${calls.length}\n`);
  fs.writeFileSync(resultFile, JSON.stringify({ ...binding,
    operation: 'add-supporting-slice', outcome: 'partial', scheduling: 'continue',
    completed: [`Supporting slice ${calls.length}`], remaining: ['DEMO-01 remains incomplete.'],
    nextAction: 'Add another supporting slice.', changedFiles: ['supporting-work.txt'],
    receiptIds: [], findings: [] }));
  // Fixture containment, deliberately outside the runner's progress assessment.
  fs.writeFileSync('progress.md', '# Handoff\n\nStatus: ' + (calls.length === 4 ? 'STOPPED' : 'IN_PROGRESS') +
    '\n\nContinue the same supporting work.\n');
}
fs.writeFileSync(client, '#!/usr/bin/env node\n(' + preparedClient.toString() + ')();\n', { mode: 0o700 });
const cli = process.argv[3] ? path.resolve(process.argv[3]) :
  fileURLToPath(new URL('../../bin/roadmap-runner.js', import.meta.url));
const result = spawnSync(process.execPath, [cli, roadmap, '--progress-file', progress,
  '--client', 'codex', '--client-bin', client, '--notify', 'off', '--timeout', '3s'], {
  cwd: work, env: { PATH: process.env.PATH || '/usr/bin:/bin' }, encoding: 'utf8', timeout: 15000,
});
fs.writeFileSync(path.join(output, 'stdout.log'), result.stdout || '');
fs.writeFileSync(path.join(output, 'stderr.log'), result.stderr || '');
assert.ifError(result.error);
const calls = JSON.parse(fs.readFileSync(path.join(work, 'calls.json')));
assert.equal(calls.length, 4);
assert.equal(new Set(calls.map(c => c.task)).size, 1);
assert.match(calls[0].task, /^roadmap-/);
assert.equal(new Set(calls.map(c => c.criteriaRevision)).size, 1);
assert.match(fs.readFileSync(roadmap, 'utf8'), /- \[ \] DEMO-01/);
const events = fs.readFileSync(progress + '.events.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
const starts = events.filter(e => e.type === 'runner.turn_starting');
assert.equal(starts.length, 4);
assert.ok(starts.every(e => e.role === 'worker'));
assert.equal(result.status, 75);
assert.equal(events.filter(e => e.type === 'runner.progress_observed').length, 0);
const summary = { preparedOnly: true, paidCalls: 0, credentialEnvironmentForwarded: false,
  calls: calls.length, uniqueControllerTasks: 1, criteriaRevisions: 1, closedCriteria: 0,
  controllerRejectedContinuation: false, termination: 'fixture explicitly wrote STOPPED after four calls',
  exitCode: result.status, cli, eventTypes: events.map(e => e.type), work };
fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
