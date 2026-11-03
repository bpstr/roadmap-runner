import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLifecycle } from '../dist/lifecycle.js';
import { parseArgs } from '../lib/runner.js';

// Prepared executable only: no provider transport, credentials or inference.
function prepared() {
  const fs = require('node:fs');
  const prompt = process.argv.at(-1);
  const binding = JSON.parse(prompt.match(/^Result binding: (.+)$/m)[1]);
  fs.writeFileSync(JSON.parse(prompt.match(/^Optional structured result file: (.+)$/m)[1]), JSON.stringify({
    ...binding, operation: 'prepared-shared-source', outcome: 'verified', completed: ['Prepared change'],
    remaining: [], nextAction: '', changedFiles: ['source.txt'], receiptIds: [], findings: [],
  }));
  fs.writeFileSync('roadmap.md', fs.readFileSync('roadmap.md', 'utf8').replace('- [ ]', '- [x]'));
  fs.writeFileSync('progress.md', 'Status: COMPLETE\n');
}

for (const configured of [false, true]) test(`shared source ${configured ? 'uses an explicit containing evidence root' : 'keeps the default escape fence'}`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-evidence-root-'));
  const launcher = path.join(root, 'launcher'); fs.mkdirSync(launcher);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = process.env.ROADMAP_EVIDENCE_WORKSPACE;
  t.after(() => { if (previous === undefined) delete process.env.ROADMAP_EVIDENCE_WORKSPACE; else process.env.ROADMAP_EVIDENCE_WORKSPACE = previous; });
  if (configured) process.env.ROADMAP_EVIDENCE_WORKSPACE = root;
  else delete process.env.ROADMAP_EVIDENCE_WORKSPACE;
  fs.writeFileSync(path.join(root, 'source.txt'), 'prepared');
  fs.writeFileSync(path.join(root, 'roadmap.md'), '# Prepared\nStatus: IN_PROGRESS\n\n### Task A-01\nDependencies: none\nAcceptance: prepared source works.\n- [ ] A-01 Prepared change\n');
  for (const name of ['source.txt', 'roadmap.md']) fs.symlinkSync(path.join(root, name), path.join(launcher, name));
  fs.writeFileSync(path.join(launcher, 'progress.md'), 'Status: IN_PROGRESS\n');
  const executable = path.join(launcher, 'prepared.cjs');
  fs.writeFileSync(executable, '#!/usr/bin/env node\n(' + prepared.toString() + ')();\n', { mode: 0o755 });
  const events = [];
  const result = await runLifecycle({ ...parseArgs([], {}), roadmap: path.join(root, 'roadmap.md'),
    progressFile: path.join(launcher, 'progress.md'), executable, timeout: '5s', notify: 'off', preventSleep: false },
  { workdir: launcher, managedSleep: true, onEvent: event => events.push(event) });
  assert.equal(result.code, configured ? 0 : 75);
  assert.equal(events.some(event => event.type === 'runner.task_result_invalid'), !configured);
});
