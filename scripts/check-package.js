import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-package-check-'));
try {
  // The normal prepack hook builds the published files; no provider is invoked.
  const output = execFileSync('npm', ['pack', '--json', '--pack-destination', temporary], { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  const [packed] = JSON.parse(output);
  assert.equal(packed.name, manifest.name);
  assert.equal(packed.version, manifest.version);
  const files = packed.files.map(file => file.path);
  for (const required of ['bin/roadmap-runner.js', 'dist/doctor.js', 'dist/setup.js', 'dist/mcp.js', 'dist/worker.js', 'lib/runner.js', 'prompt.md', 'supervisor.md', 'README.md', 'LICENSE', 'docs/agent-integration.md', 'skills/write-runner-roadmap/SKILL.md', 'skills/write-runner-roadmap/references/task-contract.md', 'skills/write-runner-roadmap/templates/roadmap.md']) {
    assert.ok(files.includes(required), `Missing packaged file: ${required}`);
  }
  assert.deepEqual(files.filter(file => /^(?:node_modules|test|\.git|\.codanna|\.github|docs\/assets)(?:\/|$)|(?:^|\/)\.secrets(?:\/|$)|\.tgz$/.test(file)), [], 'Development or private files must not be published');
  execFileSync('tar', ['-xzf', path.join(temporary, packed.filename), '-C', temporary], { timeout: 10000, maxBuffer: 65536 });
  const extracted = path.join(temporary, 'package');
  assert.equal(JSON.parse(fs.readFileSync(path.join(extracted, 'package.json'), 'utf8')).version, manifest.version);
  // Use the already installed locked dependencies; no installation/network probe.
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(extracted, 'node_modules'), 'dir');
  const cli = path.join(extracted, 'bin', 'roadmap-runner.js');
  const run = args => execFileSync(process.execPath, [cli, ...args], { cwd: extracted, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  assert.equal(run(['--version']).trim(), manifest.version);
  assert.match(run(['--help']), /roadmap-runner doctor/);
  console.log(`Package verified: ${packed.name}@${packed.version}; ${files.length} files; ${packed.size} packed bytes; packaged version/help passed; no inference.`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
