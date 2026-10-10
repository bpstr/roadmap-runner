import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyToml } from 'smol-toml';
import { doctor } from '../dist/doctor.js';
import { setup, checkConnectivity } from '../dist/setup.js';

const cli = fileURLToPath(new URL('../bin/roadmap-runner.js', import.meta.url));
const replies = [
  { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25' } },
  { jsonrpc: '2.0', id: 2, result: { tools: ['roadmap_start', 'roadmap_stop', 'roadmap_status'].map(name => ({ name })) } },
];
const prepared = { status: 0, stdout: replies.map(value => JSON.stringify(value)).join('\n') + '\n' };
const fixture = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-doctor-'));
  const workspace = path.join(dir, 'workspace with spaces'); const home = path.join(dir, 'home');
  fs.mkdirSync(workspace); fs.mkdirSync(home);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const dependencies = { home, env: {}, spawnSync(command, args, options) {
    calls.push({ command, args, options });
    if (command === process.execPath) return prepared;
    if (command === 'grok') return { status: 0, stdout: 'mcp add' };
    return { status: 1 };
  } };
  const options = { apps: ['codex'], workspace };
  const install = setup(options, dependencies)[0]; calls.length = 0;
  const monitorFile = path.join(home, '.codex', 'automations', 'hourly-run', 'automation.toml');
  const saveMonitor = (overrides = {}) => {
    fs.mkdirSync(path.dirname(monitorFile), { recursive: true });
    fs.writeFileSync(monitorFile, stringifyToml({ version: 1, id: 'hourly-run', kind: 'heartbeat', target_thread_id: 'fixture-thread', status: 'ACTIVE', rrule: 'FREQ=HOURLY;INTERVAL=1', prompt: `Monitor run-123 hourly in ${JSON.stringify(workspace)}. Keep secret fixture content private.`, ...overrides }));
  };
  return { dir, workspace, home, calls, dependencies, options, install, monitorFile, saveMonitor };
};

test('doctor checks installed MCP/skill without modifying configuration or calling tools', t => {
  const f = fixture(t); const before = fs.readFileSync(f.install.config, 'utf8');
  const result = doctor(f.options, f.dependencies);
  assert.equal(result.ok, true); assert.equal(result.apps[0].skill, 'current');
  assert.equal(result.monitor.status, 'not_checked'); assert.equal(result.monitor.execution, 'not_verified');
  assert.equal(fs.readFileSync(f.install.config, 'utf8'), before);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].command, process.execPath);
  assert.deepEqual(f.calls[0].args, [cli, 'mcp', '--workspace', fs.realpathSync(f.workspace)]);
  assert.deepEqual(f.calls[0].options.input.trim().split('\n').map(line => JSON.parse(line).method), ['initialize', 'notifications/initialized', 'tools/list']);
});

test('doctor refuses conflicting, disabled, missing and malformed MCP entries without executing them', t => {
  const f = fixture(t);
  const cases = [
    ['conflict', stringifyToml({ mcp_servers: { 'roadmap-runner': { command: '/untrusted/provider', args: ['spend'] } } })],
    ['conflict', fs.readFileSync(f.install.config, 'utf8') + 'enabled = false\n'],
    ['missing', 'model = "fixture"\n'],
    ['invalid', 'malformed = [\n'],
  ];
  for (const [expected, contents] of cases) {
    fs.writeFileSync(f.install.config, contents); f.calls.length = 0;
    const result = doctor(f.options, f.dependencies);
    assert.equal(result.ok, false); assert.equal(result.apps[0].mcp, expected);
    assert.equal(result.apps[0].connectivity, 'not_run'); assert.equal(f.calls.length, 0);
    assert.equal(fs.readFileSync(f.install.config, 'utf8'), contents);
  }
  fs.rmSync(f.install.config); assert.equal(doctor(f.options, f.dependencies).apps[0].mcp, 'missing');
});

test('MCP connectivity rejects timeout, malformed replies, initialization errors and wrong tool names', () => {
  const wrongTools = structuredClone(replies); wrongTools[1].result.tools[0].name = 'unrelated_tool';
  const failedInitialize = structuredClone(replies); delete failedInitialize[0].result; failedInitialize[0].error = { code: -1, message: 'fixture' };
  for (const check of [
    { ...prepared, status: null, error: { code: 'ETIMEDOUT' } },
    { ...prepared, status: 1 },
    { ...prepared, stdout: 'broken json' },
    { ...prepared, stdout: JSON.stringify(replies[1]) },
    { ...prepared, stdout: wrongTools.map(value => JSON.stringify(value)).join('\n') },
    { ...prepared, stdout: failedInitialize.map(value => JSON.stringify(value)).join('\n') },
  ]) assert.equal(checkConnectivity('/unused', () => check), 'failed_no_inference');
  assert.equal(checkConnectivity('/unused', () => { throw new Error('fixture transport failure'); }), 'failed_no_inference');
});

test('doctor confirms saved hourly registration for the exact workspace and run without exposing prompts', t => {
  const f = fixture(t); f.saveMonitor(); const before = fs.readFileSync(f.monitorFile, 'utf8');
  const result = doctor({ ...f.options, monitorId: 'hourly-run', runId: 'run-123' }, f.dependencies);
  assert.equal(result.ok, true); assert.equal(result.monitor.status, 'registered_hourly');
  assert.equal(result.monitor.execution, 'not_verified'); assert.equal(result.monitor.basis, 'local_codex_configuration');
  assert.ok(!JSON.stringify(result).includes('secret fixture content'));
  assert.equal(fs.readFileSync(f.monitorFile, 'utf8'), before);
  f.saveMonitor({ kind: 'cron', cwds: [f.workspace], prompt: 'Monitor run-123' });
  assert.equal(doctor({ ...f.options, monitorId: 'hourly-run', runId: 'run-123' }, f.dependencies).monitor.status, 'registered_hourly');
});

test('monitor diagnostics reject paused, restricted, malformed and mismatched registrations', t => {
  const f = fixture(t); const options = { ...f.options, monitorId: 'hourly-run', runId: 'run-123' };
  assert.equal(doctor(options, f.dependencies).monitor.status, 'missing');
  for (const [overrides, expected] of [
    [{ status: 'PAUSED' }, 'inactive'],
    [{ rrule: 'FREQ=HOURLY;INTERVAL=2' }, 'cadence_unverified'],
    [{ rrule: 'FREQ=HOURLY;BYHOUR=10' }, 'cadence_unverified'],
    [{ rrule: 'FREQ=HOURLY;BYMINUTE=0,30' }, 'cadence_unverified'],
    [{ rrule: 'FREQ=HOURLY;BYMINUTE=60' }, 'cadence_unverified'],
    [{ rrule: 'FREQ=HOURLY;COUNT=1' }, 'cadence_unverified'],
    [{ rrule: 'FREQ=HOURLY;INTERVAL=1;INTERVAL=2' }, 'cadence_unverified'],
    [{ prompt: `Monitor run-123 in ${JSON.stringify(f.workspace + '-other')}` }, 'workspace_mismatch'],
    [{ prompt: `Monitor run-1234 in ${JSON.stringify(f.workspace)}` }, 'run_mismatch'],
    [{ id: 'wrong' }, 'invalid'],
    [{ version: 2 }, 'invalid'],
    [{ target_thread_id: '' }, 'invalid'],
  ]) { f.saveMonitor(overrides); const result = doctor(options, f.dependencies); assert.equal(result.monitor.status, expected, JSON.stringify(overrides)); assert.equal(result.ok, false); }
  f.saveMonitor({ rrule: 'RRULE:FREQ=HOURLY;BYMINUTE=30;BYSECOND=0' }); assert.equal(doctor(options, f.dependencies).monitor.status, 'registered_hourly');
  fs.writeFileSync(f.monitorFile, 'invalid = ['); assert.equal(doctor(options, f.dependencies).monitor.status, 'invalid');
  fs.writeFileSync(f.monitorFile, 'x'.repeat(65537)); assert.equal(doctor(options, f.dependencies).monitor.status, 'invalid');
  fs.rmSync(f.monitorFile); const outside = path.join(f.dir, 'outside.toml'); fs.writeFileSync(outside, 'version = 1'); fs.symlinkSync(outside, f.monitorFile);
  assert.equal(doctor(options, f.dependencies).monitor.status, 'invalid');
});

test('doctor validates arguments and reports unsupported monitoring hosts explicitly', t => {
  const f = fixture(t);
  for (const monitorId of ['../escape', '/absolute', 'x'.repeat(129), '']) assert.throws(() => doctor({ ...f.options, monitorId }, f.dependencies), /IDs/);
  assert.throws(() => doctor({ ...f.options, runId: 'run-123' }, f.dependencies), /requires --monitor-id/);
  assert.throws(() => doctor({ ...f.options, apps: ['__proto__'] }, f.dependencies), /Unsupported doctor app/);
  assert.throws(() => doctor({ ...f.options, scope: 'invalid' }, f.dependencies), /Scope/);
  assert.equal(doctor({ ...f.options, apps: ['claude'], monitorId: 'hourly-run' }, f.dependencies).monitor.status, 'unsupported_host');
});

test('setup and doctor agree on user-scoped CODEX_HOME and project-scoped paths for every app', t => {
  const f = fixture(t); const customHome = path.join(f.dir, 'custom-codex-home');
  const dependencies = { ...f.dependencies, env: { CODEX_HOME: customHome } };
  const options = { ...f.options, scope: 'user' };
  const installed = setup(options, dependencies)[0]; assert.equal(installed.config, path.join(customHome, 'config.toml'));
  assert.equal(doctor(options, dependencies).ok, true); assert.ok(!fs.existsSync(path.join(f.home, '.codex', 'config.toml')));
  const apps = ['codex', 'claude', 'grok']; setup({ ...f.options, apps }, dependencies);
  const result = doctor({ ...f.options, apps }, dependencies); assert.equal(result.ok, true); assert.equal(result.apps.length, 3);
  fs.appendFileSync(f.install.skillPath + '/SKILL.md', '\nUser customization\n');
  const customized = doctor(f.options, dependencies); assert.equal(customized.apps[0].skill, 'different'); assert.equal(customized.apps[0].ready, true);
});

test('CLI doctor uses only local MCP initialization and creates no managed runs', t => {
  const f = fixture(t); f.saveMonitor();
  const env = { PATH: '/usr/bin:/bin', HOME: f.home, CODEX_HOME: path.join(f.home, '.codex'), ROADMAP_STATE_DIR: path.join(f.dir, 'registry'), ROADMAP_NOTIFY: 'off' };
  const args = [cli, 'doctor', '--workspace', f.workspace, '--monitor-id', 'hourly-run', '--run-id', 'run-123', '--json'];
  const checked = spawnSync(process.execPath, args, { encoding: 'utf8', env, timeout: 10000 });
  assert.equal(checked.status, 0, checked.stderr); const result = JSON.parse(checked.stdout); assert.equal(result.ok, true); assert.equal(result.apps[0].connectivity, 'passed_no_inference');
  const status = spawnSync(process.execPath, [cli, 'status', '--workspace', f.workspace, '--json'], { encoding: 'utf8', env, timeout: 10000 });
  assert.equal(status.status, 0, status.stderr); assert.deepEqual(JSON.parse(status.stdout).runs, []);
  const invalid = spawnSync(process.execPath, [cli, 'doctor', '--workspace', f.workspace, '--unknown'], { encoding: 'utf8', env, timeout: 10000 });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /Unknown doctor argument/);
});
