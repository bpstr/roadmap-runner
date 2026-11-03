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
  const state = path.join(temporary, 'state');
  const monitor = path.join(state, 'monitor');
  fs.mkdirSync(path.join(monitor, 'outbox'), { recursive: true });
  const savedConfig = { version: 1, endpoint: 'https://monitor.example/ingest', apiKey: 'rm_' + 'a'.repeat(16) + '_' + 'b'.repeat(64), connectionId: 'packaged-check', installationId: '00000000-0000-4000-8000-000000000001', enabled: false, verified: true };
  fs.writeFileSync(path.join(monitor, 'config.json'), JSON.stringify(savedConfig));
  const outbox = path.join(monitor, 'outbox', 'retained.json');
  fs.writeFileSync(outbox, '{"fixture":"retained terminal report"}');
  // The normal prepack hook builds the published files; no provider is invoked.
  const output = execFileSync('npm', ['pack', '--json', '--pack-destination', temporary], { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  const [packed] = JSON.parse(output);
  assert.equal(packed.name, manifest.name);
  assert.equal(packed.version, manifest.version);
  const files = packed.files.map(file => file.path);
  for (const required of ['bin/roadmap-runner.js', 'dist/doctor.js', 'dist/setup.js', 'dist/mcp.js', 'dist/worker.js', 'dist/sleep-inhibitor.js', 'dist/notification-permission.js', 'lib/runner.js', 'lib/telemetry.js', 'lib/execution.js', 'prompt.md', 'compact.md', 'resolver.md', 'RECOVERY.md', 'lib/run-evidence.js', 'lib/recovery-runs.js', 'README.md', 'LICENSE', 'docs/agent-integration.md', 'skills/write-runner-roadmap/SKILL.md', 'skills/write-runner-roadmap/references/task-contract.md', 'skills/write-runner-roadmap/references/roadmap-splitting.md', 'skills/write-runner-roadmap/templates/roadmap.md']) {
    assert.ok(files.includes(required), `Missing packaged file: ${required}`);
  }
  for (const retired of ['supervisor.md', 'SUPERVISION.md', 'lib/supervision.js']) assert.ok(!files.includes(retired), `Retired supervisor shipped: ${retired}`);
  for (const required of ['lib/task-index.js', 'lib/task-plan.js', 'lib/task-memory.js', 'lib/task-deferral.js', 'lib/verification.js', 'lib/handoff.js', 'lib/checkpoint.js', 'lib/continuation.js', 'lib/progress-ledger.js', 'docs/task-continuity.md']) assert.ok(files.includes(required), `Missing continuity artifact: ${required}`);
  for (const required of ['dist/monitor.js', 'dist/monitor-cli.js', 'dist/monitor-config.js', 'dist/monitor-lock.js', 'dist/monitor-replay.js', 'lib/monitor-environment.js']) assert.ok(files.includes(required), `Missing monitoring artifact: ${required}`);
  assert.deepEqual(files.filter(file => /^(?:node_modules|test|\.git|\.codanna|\.github|docs\/assets)(?:\/|$)|(?:^|\/)\.secrets(?:\/|$)|\.tgz$/.test(file)), [], 'Development or private files must not be published');
  execFileSync('tar', ['-xzf', path.join(temporary, packed.filename), '-C', temporary], { timeout: 10000, maxBuffer: 65536 });
  const extracted = path.join(temporary, 'package');
  assert.equal(JSON.parse(fs.readFileSync(path.join(extracted, 'package.json'), 'utf8')).version, manifest.version);
  // Use the already installed locked dependencies; no installation/network probe.
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(extracted, 'node_modules'), 'dir');
  const cli = path.join(extracted, 'bin', 'roadmap-runner.js');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ROADMAP_MONITOR')));
  env.ROADMAP_STATE_DIR = state;
  const run = (args, overrides = {}) => execFileSync(process.execPath, [cli, ...args], { cwd: extracted, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000, maxBuffer: 65536, stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(run(['--version']).trim(), manifest.version);
  assert.match(run(['--help']), /roadmap-runner doctor/);
  assert.match(run(['--help']), /--resolver-timeout/);
  assert.match(run(['--help']), /--timeout <duration>\s+Per-session timeout\. Default: 120m/);
  assert.match(run(['--help']), /--review-turns/);
  assert.match(run(['--help']), /--progress-review/);
  assert.match(run(['--help']), /roadmap-runner notifications request-permission/);
  assert.match(run(['--help']), /ROADMAP_MONITOR_API_KEY/);
  assert.match(run(['--help']), /monitor test\|status\|flush\|enable\|disable/);
  assert.match(run(['--help']), /--manage-git[\s\S]*--no-manage-git[\s\S]*ROADMAP_MANAGE_GIT/);
  assert.equal(JSON.parse(run(['monitor', 'status', '--json'])).enabled, false);
  const enabled = JSON.parse(run(['monitor', 'enable', '--json']));
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.verified, true);
  assert.equal(enabled.installation_id, savedConfig.installationId);
  assert.ok(!JSON.stringify(enabled).includes(savedConfig.apiKey));
  assert.equal(JSON.parse(run(['monitor', 'status', '--json'], { ROADMAP_MONITOR: 'off' })).enabled, false);
  assert.equal(JSON.parse(run(['monitor', 'disable', '--json'])).enabled, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(monitor, 'config.json'), 'utf8')), savedConfig);
  assert.equal(fs.readFileSync(outbox, 'utf8'), '{"fixture":"retained terminal report"}');
  assert.throws(() => run(['monitor', 'enable', '--json'], { ROADMAP_STATE_DIR: path.join(temporary, 'unconfigured') }), error => error.status === 1 && /monitor configure first/.test(error.stderr));
  console.log(`Package verified: ${packed.name}@${packed.version}; ${files.length} files; ${packed.size} packed bytes; packaged version/help and monitor enable/status/disable passed; saved configuration/outbox preserved; no inference.`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
