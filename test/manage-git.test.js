import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/runner.js';
import { startSchema } from '../dist/run-manager.js';

test('Git management is opt-in and explicit flags override the environment', () => {
  assert.equal(parseArgs([], {}).manageGit, false);
  for (const value of ['1', 'true']) assert.equal(parseArgs([], { ROADMAP_MANAGE_GIT: value }).manageGit, true);
  for (const value of ['', '0', 'false']) assert.equal(parseArgs([], { ROADMAP_MANAGE_GIT: value }).manageGit, false);
  assert.equal(parseArgs(['--manage-git'], {}).manageGit, true);
  assert.equal(parseArgs(['--no-manage-git'], { ROADMAP_MANAGE_GIT: 'true' }).manageGit, false);
  assert.equal(parseArgs(['--no-manage-git', '--manage-git'], {}).manageGit, true);
});

test('managed and MCP starts accept a boolean and inherit the launch environment', t => {
  const previous = process.env.ROADMAP_MANAGE_GIT;
  t.after(() => { if (previous === undefined) delete process.env.ROADMAP_MANAGE_GIT; else process.env.ROADMAP_MANAGE_GIT = previous; });
  const request = { workspace: '/prepared', roadmap: 'roadmap.md' };
  delete process.env.ROADMAP_MANAGE_GIT;
  assert.equal(startSchema.parse(request).manageGit, false);
  assert.equal(startSchema.parse({ ...request, manageGit: true }).manageGit, true);
  process.env.ROADMAP_MANAGE_GIT = '1';
  assert.equal(startSchema.parse(request).manageGit, true);
  assert.equal(startSchema.parse({ ...request, manageGit: false }).manageGit, false);
  assert.throws(() => startSchema.parse({ ...request, manageGit: 'true' }));
});

const cli = fileURLToPath(new URL('../bin/roadmap-runner.js', import.meta.url));
for (const scenario of [
  { name: 'default', args: [], env: '', enabled: false },
  { name: 'flag', args: ['--manage-git'], env: '', enabled: true },
  { name: 'environment', args: [], env: 'true', enabled: true },
  { name: 'override', args: ['--no-manage-git'], env: '1', enabled: false },
]) {
  test(`CLI ${scenario.name} delivers Git instructions through managed state without gating completion`, t => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-manage-git-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.writeFileSync(path.join(workspace, 'roadmap.md'), '# Prepared roadmap\n\n### Task API-01.1\n- [ ] API-01.1 Deliver fixture\nAcceptance: prepared change.\n');
    const executable = path.join(workspace, 'prepared-client.cjs');
    // Prepared responses only: this client records instructions and simulates
    // an advisory Git failure; it never runs Git or contacts a provider.
    fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const prompt = process.argv.at(-1);
fs.writeFileSync('prompt.txt', prompt);
if (!prompt.includes('Runner role: WORKER')) process.exit(97);
const binding = JSON.parse(prompt.match(/^Result binding: (.+)$/m)[1]);
const resultFile = JSON.parse(prompt.match(/^Optional structured result file: (.+)$/m)[1]);
fs.writeFileSync('source.txt', 'Prepared change.\\n');
fs.writeFileSync(resultFile, JSON.stringify({ ...binding, operation: 'prepared-change', outcome: 'verified',
  completed: ['Prepared criterion delivered'], remaining: [], nextAction: 'None',
  changedFiles: ['source.txt'], receiptIds: [], findings: [] }));
fs.writeFileSync('roadmap.md', fs.readFileSync('roadmap.md', 'utf8').replace('- [ ]', '- [x]'));
fs.writeFileSync('progress.md', 'Status: COMPLETE\\n\\n## Current handoff\\nPending Git action: push rejected (prepared advisory).\\n');
console.error('Prepared Git advisory: remote unavailable; continuing.');
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 32, output_tokens: 8 } }));
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [cli, 'roadmap.md', '--progress-file', 'progress.md', '--client-bin', executable,
      '--timeout', '5s', '--notify', 'off', ...scenario.args], {
      cwd: workspace, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, ROADMAP_STATE_DIR: path.join(workspace, 'registry'), ROADMAP_MANAGE_GIT: scenario.env,
        ROADMAP_MONITOR: 'off', ROADMAP_NOTIFY_BIN: '', ROADMAP_PREVENT_SLEEP: '0' },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, (result.stderr + result.stdout).slice(-1500));
    const prompt = fs.readFileSync(path.join(workspace, 'prompt.txt'), 'utf8');
    assert.equal(prompt.includes('Git management (enabled by --manage-git):'), scenario.enabled);
    if (scenario.enabled) {
      assert.match(prompt, /Before implementation in each worker session/);
      assert.match(prompt, /fetch the configured remote and compare/);
      assert.match(prompt, /At session end, after saving the roadmap and handoff/);
      assert.match(prompt, /push any unpushed task commits/);
      assert.match(prompt, /at most 30 seconds/);
      assert.match(prompt, /GIT_TERMINAL_PROMPT=0/);
      assert.match(prompt, /never mark roadmap work BLOCKED, STOPPED or NEEDS_INFO solely because of Git/);
    }
    assert.match(fs.readFileSync(path.join(workspace, 'progress.md'), 'utf8'), /Status: COMPLETE/);
    const runs = path.join(workspace, 'registry', 'runs');
    const [runId] = fs.readdirSync(runs);
    const state = JSON.parse(fs.readFileSync(path.join(runs, runId, 'state.json'), 'utf8'));
    assert.equal(state.options.manageGit, scenario.enabled);
    assert.equal(state.reason, 'complete');
  });
}
