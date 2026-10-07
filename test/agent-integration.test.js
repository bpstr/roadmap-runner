import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { RunManager, startSchema, control } from '../dist/run-manager.js';
import { readRun, saveRun, runDir, appendOutput, outputTail } from '../dist/run-state.js';
import { appendEvent, readEvents } from '../dist/events.js';
import { Notifications } from '../dist/notifications.js';
import { setup } from '../dist/setup.js';
import { parse as parseToml } from 'smol-toml';

const cli = fileURLToPath(new URL('../bin/roadmap-runner.js', import.meta.url));
const wait = async (check, timeout = 8000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('Fixture deadline exceeded');
};
const fixture = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-integration-')); const registry = path.join(dir, 'registry'); const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace); const roadmap = path.join(workspace, 'roadmap.md'); fs.writeFileSync(roadmap, '# Test\nStatus: IN_PROGRESS\n- [ ] A Implement fixture\n');
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin); fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const worker = path.join(bin, 'codex');
  fs.writeFileSync(worker, `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst prompt=process.argv.at(-1);\nconst progress=prompt.match(/Tracking file \\(progress \\/ delivery evidence\\):\\s*\\n\\s*([^\\n]+)/)[1].trim();\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'fixture output sk-abcdefghijk123456'}}));\nif(process.env.RR_MODE==='quota') { console.log(JSON.stringify({type:'turn.failed',error:{message:'usage_limit_reached. Try again at 2099-01-01T00:00:00Z'}}));process.exit(1); }\nif(process.env.RR_MODE==='complete') { fs.writeFileSync(progress, fs.readFileSync(progress,'utf8').replace('IN_PROGRESS','COMPLETE')); } else { setInterval(()=>{},1000); }\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  const manager = new RunManager(workspace, registry); const runs = [];
  t.after(async () => { for (const id of runs) { try { await manager.stop(id); await wait(async () => ['stopped','exited','unknown'].includes((await manager.status(id)).processState)); } catch {} } fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, registry, workspace, roadmap, bin, worker, manager, runs, request: { workspace, roadmap, notify: 'off', supervisorEvery: 0 } };
};
const start = async (f, changes = {}) => { const r = await f.manager.start({ ...f.request, ...changes }, { executable: f.worker }); f.runs.push(r.id); return r; };

test('managed start is ready, exclusive by canonical workspace, idempotent and survives caller disconnection', async t => {
  const f = fixture(t); const r = await start(f, { idempotencyKey: 'same' }); assert.equal(r.processState, 'running'); assert.ok(r.pid);
  const again = await start(f, { idempotencyKey: 'same' }); assert.equal(again.id, r.id);
  await assert.rejects(start(f, { idempotencyKey: 'same', timeout: '1h' }), /different options/);
  await assert.rejects(start(f), error => error.runId === r.id);
  const alias = path.join(f.dir, 'alias'); fs.symlinkSync(f.workspace, alias);
  await assert.rejects(new RunManager(alias, f.registry).start({ ...f.request, workspace: alias }, { executable: f.worker }), /reserved/);
  const reconnect = new RunManager(f.workspace, f.registry); const status = await wait(async () => { const s = await reconnect.status(r.id); return s.output.includes('fixture output') && s; });
  assert.ok(!status.output.includes('sk-')); assert.ok(!JSON.stringify(status).includes(readRun(f.registry, r.id).token));
  assert.deepEqual(status.events.slice(0, 2).map(e => e.type), ['runner.started', 'runner.turn_starting']);
  const stopped = await reconnect.stop(r.id); assert.equal(stopped.changed, true); assert.equal(stopped.processState, 'stopping');
  const final = await wait(async () => { const s = await reconnect.status(r.id); return s.processState === 'stopped' && s; });
  assert.equal(final.events.at(-1).type, 'runner.stopped'); assert.equal((await reconnect.stop(r.id)).changed, false);
});

test('simultaneous requests cannot create competing managed workers', async t => {
  const f = fixture(t); const results = await Promise.allSettled([start(f), start(f)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.match(results.find(r => r.status === 'rejected').reason.message, /reserved/);
});

test('progress aliases and symlink escapes cannot bypass managed path boundaries', async t => {
  const f = fixture(t); const outside = path.join(f.dir, 'outside.md'); fs.writeFileSync(outside, 'outside');
  fs.symlinkSync(outside, path.join(f.workspace, 'escape.md'));
  await assert.rejects(start(f, { roadmap: 'escape.md' }), /inside/);
  await assert.rejects(start(f, { progressFile: '../outside.md' }), /inside/);
  assert.throws(() => startSchema.parse({ ...f.request, executable: 'dangerous' }));
});

test('stale reused PID becomes unknown without signaling or releasing a live identity reservation', async t => {
  const f = fixture(t); const r = await start(f); await f.manager.stop(r.id); await wait(async () => (await f.manager.status(r.id)).processState === 'stopped');
  const record = readRun(f.registry, r.id); record.processState = 'running'; record.pid = process.pid; record.heartbeat = new Date(0).toISOString();
  for (const lock of record.locks) { fs.writeFileSync(lock, r.id); } saveRun(f.registry, record);
  const result = await f.manager.status(r.id); assert.equal(result.processState, 'unknown'); assert.ok(fs.existsSync(record.locks[0]));
  record.pid = 2147483647; saveRun(f.registry, record); await f.manager.status(r.id); assert.ok(!fs.existsSync(record.locks[0]));
});

test('control rejects unauthenticated ownership and nested worker management', async t => {
  const f = fixture(t); const r = await start(f); const record = readRun(f.registry, r.id);
  await assert.rejects(control({ ...record, token: 'wrong' }, 'stop'), /disconnected/); assert.equal((await f.manager.status(r.id)).processState, 'running');
  const previous = process.env.ROADMAP_WORKER_CONTEXT; process.env.ROADMAP_WORKER_CONTEXT = r.id;
  try { await assert.rejects(f.manager.stop(r.id), /cannot/); await assert.rejects(start(f), /cannot/); } finally { if (previous === undefined) delete process.env.ROADMAP_WORKER_CONTEXT; else process.env.ROADMAP_WORKER_CONTEXT = previous; }
});

test('managed quota wait can stop promptly and preserves its recovery checkpoint', async t => {
  const f = fixture(t); const prior = process.env.RR_MODE; process.env.RR_MODE = 'quota';
  let r; try { r = await start(f); } finally { if (prior === undefined) delete process.env.RR_MODE; else process.env.RR_MODE = prior; }
  await wait(async () => (await f.manager.status(r.id)).waitReason === 'quota');
  await f.manager.stop(r.id); const final = await wait(async () => { const s = await f.manager.status(r.id); return s.processState === 'stopped' && s; });
  assert.ok(fs.existsSync(`${final.progressFile}.recovery.json`)); assert.ok(final.events.some(e => e.type === 'runner.usage_paused'));
});

test('bounded output and journal retention report truncation, expiry and malformed/partial records', t => {
  const f = fixture(t); const log = path.join(f.dir, 'output'); appendOutput(log, '\x1b[31msecret token=abc\x1b[0m\n');
  assert.equal(outputTail(log).output, 'secret token=[REDACTED]\n'); appendOutput(log, ('x'.repeat(1024) + '\n').repeat(1200)); assert.ok(fs.statSync(log).size <= 1024 * 1024); assert.ok(outputTail(log, 100).outputTruncated);
  const journal = path.join(f.dir, 'journal');
  for (let sequence = 1; sequence < 1500; sequence++) appendEvent(journal, { sequence, id: String(sequence), type: 'runner.turn_finished', body: 'x'.repeat(1000) });
  fs.appendFileSync(journal, 'malformed\n{"sequence":2000'); const result = readEvents(journal, 1);
  assert.ok(result.cursorExpired); assert.ok(result.eventsTruncated); assert.equal(result.malformedRecords, 1); assert.ok(result.events.every(e => e.sequence < 2000)); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16000);
});

const fakeTransport = ({ platform = 'darwin', mode = 'success' } = {}) => {
  const calls = []; const children = [];
  return { calls, children, platform, timeoutMs: 20, env: { DISPLAY: ':1', DBUS_SESSION_BUS_ADDRESS: 'stub' }, spawn(command, args) {
    calls.push({ command, args }); const child = new EventEmitter(); child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; }; children.push(child);
    if (mode === 'success') queueMicrotask(() => child.emit('close', 0));
    if (mode === 'failure') queueMicrotask(() => child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })));
    return child;
  } };
};
test('notification filters and persistent deduplication omit model content and macOS click actions', async t => {
  const f = fixture(t); const file = path.join(f.dir, 'notifications'); const transport = fakeTransport();
  const n = new Notifications({ notify: 'attention', notifyOn: ['runner.usage_paused'] }, file, transport);
  const event = { id: 'a', type: 'runner.blocked', attention: true, attentionFingerprint: 'blocker', roadmap: f.roadmap, items: [{ task: 'A' }], output: 'SECRET' };
  n.enqueue({ ...event, attention: false, type: 'runner.completed' }); n.enqueue(event); n.enqueue(event); await n.flush();
  assert.equal(transport.calls.length, 1); assert.equal(transport.calls[0].command, 'terminal-notifier'); assert.ok(!transport.calls[0].args.some(a => /SECRET|osascript|execute|activate|open/.test(a)));
  const restarted = new Notifications(n.options, file, transport); restarted.enqueue(event); await restarted.flush(); assert.equal(transport.calls.length, 1);
  restarted.enqueue({ ...event, id: 'q', type: 'runner.usage_paused', attention: false, resetAt: 'later' }); await restarted.flush(); assert.equal(transport.calls.length, 2);
});
test('notification timeout, missing backend and headless Linux are best effort and recorded', async t => {
  const f = fixture(t); const event = { id: 'a', type: 'runner.failed', attention: true, roadmap: f.roadmap };
  for (const mode of ['timeout', 'failure']) { const transport = fakeTransport({ mode }); const file = path.join(f.dir, mode); const n = new Notifications({ notify: 'attention' }, file, transport); n.enqueue(event); await n.flush(); assert.equal(n.state.deliveries[0].result, mode === 'timeout' ? 'delivery_timeout' : 'backend_unavailable'); }
  const transport = fakeTransport({ platform: 'linux' }); transport.env = {}; const n = new Notifications({ notify: 'attention' }, path.join(f.dir, 'headless'), transport); n.enqueue(event); await n.flush(); assert.equal(transport.calls.length, 0); assert.equal(n.state.deliveries[0].result, 'backend_unavailable');
});

test('setup dry-run, both scopes, TOML comments, idempotency, conflicts and edited skill preservation', t => {
  const f = fixture(t); const home = path.join(f.dir, 'home'); fs.mkdirSync(home);
  const dependencies = { home, spawnSync: (command, args) => command === 'grok' ? { status: 0, stdout: 'grok mcp add --scope' } : { status: 1 } };
  for (const scope of ['project', 'user']) {
    const base = scope === 'project' ? f.workspace : home; const config = path.join(base, '.codex/config.toml'); fs.mkdirSync(path.dirname(config), { recursive: true }); fs.writeFileSync(config, '# Keep this comment\nmodel = "fixture"\n');
    const opts = { apps: ['codex', 'claude', 'grok'], workspace: f.workspace, scope };
    const dry = setup({ ...opts, dryRun: true }, dependencies); assert.ok(dry.every(r => r.mcp === 'planned')); assert.equal(fs.readFileSync(config, 'utf8'), '# Keep this comment\nmodel = "fixture"\n');
    const first = setup(opts, dependencies); assert.ok(first.every(r => r.mcp === 'installed' && r.skill === 'installed'));
    const content = fs.readFileSync(config, 'utf8'); assert.ok(content.startsWith('# Keep this comment\nmodel = "fixture"')); assert.ok(parseToml(content).mcp_servers['roadmap-runner'].args.includes(fs.realpathSync(f.workspace)));
    const second = setup(opts, dependencies); assert.ok(second.every(r => r.mcp === 'unchanged' && r.skill === 'unchanged')); assert.equal(fs.readFileSync(config, 'utf8'), content);
    fs.appendFileSync(path.join(first[0].skillPath, 'SKILL.md'), '\nUser edit'); fs.writeFileSync(config, content.replace(process.execPath, '/different/node'));
    const conflict = setup({ ...opts, apps: ['codex'] }, dependencies)[0]; assert.equal(conflict.mcp, 'failed'); assert.equal(conflict.skill, 'failed'); assert.match(fs.readFileSync(path.join(first[0].skillPath, 'SKILL.md'), 'utf8'), /User edit/);
  }
});

const mcpFixture = async (t, modern = false) => {
  const f = fixture(t); const child = spawn(process.execPath, [cli, 'mcp', '--workspace', f.workspace], { cwd: f.workspace, env: { ...process.env, PATH: `${f.bin}:/usr/bin:/bin`, ROADMAP_STATE_DIR: f.registry, ROADMAP_NOTIFY: 'off' }, stdio: ['pipe','pipe','pipe'] });
  const messages = []; let buffer = ''; let stderr = ''; child.stdout.on('data', chunk => { buffer += chunk; while (buffer.includes('\n')) { const index = buffer.indexOf('\n'); messages.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); } }); child.stderr.on('data', chunk => stderr += chunk);
  t.after(async () => { child.stdin.end(); await new Promise(resolve => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000).unref(); } }); assert.equal(stderr, ''); });
  let id = 0; const request = async (method, params = {}) => { const current = ++id; const p = modern ? { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'prepared-client', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } : params; child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: current, method, params: p }) + '\n'); return wait(() => messages.find(m => m.id === current || (method === 'subscriptions/listen' && m.params?._meta?.['io.modelcontextprotocol/subscriptionId'] === current))); };
  if (!modern) { const init = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'prepared-client', version: '1' } }); assert.equal(init.result.protocolVersion, '2025-11-25'); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); }
  return { ...f, child, messages, request };
};
for (const modern of [false, true]) test(`prepared ${modern ? 'modern' : 'legacy'} MCP tools, restrictions, resources and subscriptions`, async t => {
  const f = await mcpFixture(t, modern); const listing = await f.request('tools/list'); assert.deepEqual(listing.result.tools.map(t => t.name), ['roadmap_start','roadmap_stop','roadmap_status']);
  const invalid = await f.request('tools/call', { name: 'roadmap_start', arguments: { ...f.request, workspace: f.workspace, roadmap: f.roadmap, executable: f.worker } }); assert.ok(invalid.error || invalid.result.isError);
  const started = await f.request('tools/call', { name: 'roadmap_start', arguments: { workspace: f.workspace, roadmap: 'roadmap.md', notify: 'off', supervisorEvery: 0 } }); assert.ok(!started.error && !started.result.isError, JSON.stringify(started)); const r = JSON.parse(started.result.content[0].text); f.runs.push(r.id); assert.equal(r.processState, 'running');
  const uri = `roadmap://${r.id}/state`;
  if (modern) {
    const sub = await f.request('subscriptions/listen', { notifications: { resourceSubscriptions: [uri] } }); assert.ok(sub.result || sub.method === 'notifications/subscriptions/acknowledged', JSON.stringify(sub));
  } else { assert.ok((await f.request('resources/subscribe', { uri })).result); }
  const resource = await f.request('resources/read', { uri }); assert.ok(!resource.error, JSON.stringify(resource)); assert.equal(JSON.parse(resource.result.contents[0].text).id, r.id);
  const tail = await f.request('tools/call', { name: 'roadmap_status', arguments: { runId: r.id, outputBytes: 8192 } }); assert.ok(Buffer.byteLength(JSON.stringify(tail)) < 32768);
  const update = await wait(() => f.messages.find(m => m.method === 'notifications/resources/updated')).catch(() => assert.fail(JSON.stringify(f.messages).slice(-8000))); assert.equal(update.params.uri, uri);
  const stopped = await f.request('tools/call', { name: 'roadmap_stop', arguments: { runId: r.id } }); assert.ok(!stopped.result.isError);
  await wait(async () => (await f.manager.status(r.id)).processState === 'stopped');
});

test('roadmap skill template passes the structure contract and rejects missing fields, cycles and release dependencies', async () => {
  const { validateRoadmap } = await import('../dist/roadmap-contract.js');
  const template = fs.readFileSync(fileURLToPath(new URL('../skills/write-runner-roadmap/templates/roadmap.md', import.meta.url)), 'utf8');
  assert.deepEqual(validateRoadmap(template), []);
  assert.ok(validateRoadmap(template.replace('Dependencies: none.', 'Dependencies: EXP-1.2.')).some(error => /cycle/.test(error)));
  assert.ok(validateRoadmap(template.replace('Dependencies: none.', 'Dependencies: MISSING-99.')).some(error => /missing dependency/.test(error)));
  assert.ok(validateRoadmap(template.replace('Acceptance:', 'Missing:')).some(error => /missing Acceptance/.test(error)));
  assert.ok(validateRoadmap(template + '\n- [ ] EXP-1.1 duplicate').some(error => /Duplicate checkbox/.test(error)));
  const releaseTask = template.slice(template.indexOf('### Task EXP-1.1'), template.indexOf('### Task EXP-1.2')).replaceAll('EXP-1.1', 'REL-1');
  assert.ok(validateRoadmap(template.replace('Dependencies: none.', 'Dependencies: REL-1.') + '\n## Epic REL — Deployment\n' + releaseTask).some(error => /development depends on release-only/.test(error)));
});

test('managed stop finishes only after an ignoring descendant is terminated', async t => {
  const f = fixture(t); const leaf = path.join(f.dir, 'leaf.js'); const pidFile = path.join(f.workspace, 'leaf.pid');
  fs.writeFileSync(leaf, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`);
  fs.writeFileSync(f.worker, `#!/usr/bin/env node\nimport {spawn} from 'node:child_process'; spawn(process.execPath,[${JSON.stringify(leaf)}],{stdio:'ignore'}); setInterval(()=>{},1000);`, { mode: 0o755 });
  const r = await start(f); await wait(() => fs.existsSync(pidFile)); const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  await f.manager.stop(r.id); await wait(async () => (await f.manager.status(r.id)).processState === 'stopped');
  await wait(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
});

test('setup connectivity checks only initialize/list MCP and never launch a provider', async t => {
  const f = fixture(t); const { spawnSync } = await import('node:child_process');
  const result = setup({ apps: ['codex'], workspace: f.workspace }, { home: path.join(f.dir, 'home'), spawnSync(command, args, options) {
    if (command === process.execPath) return spawnSync(command, args, { ...options, env: { ...process.env, ROADMAP_STATE_DIR: f.registry, ROADMAP_NOTIFY: 'off', PATH: '/usr/bin:/bin' } });
    return { status: 1 };
  } })[0];
  assert.equal(result.connectivity, 'passed_no_inference'); assert.deepEqual((await f.manager.status()).runs, []);
});

test('qualified local skills installer is staged and checked before publishing the skill', t => {
  const f = fixture(t); const calls = [];
  const result = setup({ apps: ['codex'], workspace: f.workspace }, { spawnSync(command, args, options) {
    if (command !== 'skills') return { status: 1 };
    calls.push({ args, cwd: options.cwd });
    if (args[0] === '--version') return { status: 0, stdout: '1.7.1' };
    if (args.includes('--help')) return { status: 0, stdout: '--copy' };
    const target = path.join(options.cwd, '.agents/skills/write-runner-roadmap'); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.cpSync(path.join(args[1], 'write-runner-roadmap'), target, { recursive: true }); return { status: 0 };
  } })[0];
  assert.equal(result.skill, 'installed'); assert.equal(result.skillInstaller, 'skills@1.7.1');
  assert.ok(calls.some(call => call.args.includes('--agent') && call.args.includes('codex') && call.cwd !== f.workspace));
});

test('benign SKIPPED dependency flags do not trigger desktop attention', async t => {
  const f = fixture(t); const { Recovery, recoverySettings } = await import('../lib/recovery.js'); const events = [];
  const recovery = new Recovery({ tracking: { file: path.join(f.workspace, 'progress.md') }, roadmap: f.roadmap, settings: recoverySettings({}), onEvent: event => events.push(event) });
  await recovery.attention('Status: IN_PROGRESS\n- SKIPPED A: depends B | Unblock: B validated | Retry: complete\n', 'in-progress', 1);
  assert.equal(events[0].attention, false);
  await recovery.attention('Status: IN_PROGRESS\n- SKIPPED A: needs input from owner | Unblock: answer | Retry: answer\n', 'in-progress', 2);
  assert.equal(events[1].attention, true);
});

test('Linux delivery uses notify-send, and off suppresses explicitly selected events', async t => {
  const f = fixture(t); const transport = fakeTransport({ platform: 'linux' });
  const n = new Notifications({ notify: 'attention' }, path.join(f.dir, 'linux'), transport);
  const event = { id: 'a', type: 'runner.failed', attention: true, roadmap: f.roadmap };
  n.enqueue(event); await n.flush(); assert.equal(transport.calls[0].command, 'notify-send');
  const disabled = new Notifications({ notify: 'off', notifyOn: ['runner.failed'] }, path.join(f.dir, 'off'), transport);
  disabled.enqueue(event); await disabled.flush(); assert.equal(transport.calls.length, 1);
});

test('damaged notification state and thrown transports cannot interrupt runner work', async t => {
  const f = fixture(t); const file = path.join(f.dir, 'damaged'); fs.writeFileSync(file, '{invalid');
  const n = new Notifications({ notify: 'attention' }, file, { platform: 'darwin', spawn() { throw new Error('stub transport failed'); } });
  n.enqueue({ id: 'a', type: 'runner.failed', attention: true, roadmap: f.roadmap }); await n.flush();
  assert.equal(fs.readFileSync(`${file}.invalid`, 'utf8'), '{invalid'); assert.equal(n.state.deliveries[0].result, 'delivery_failed');
});

test('managed startup failure reports its run identity without claiming readiness', async t => {
  const f = fixture(t); let failedId;
  await assert.rejects(f.manager.start(f.request, { executable: path.join(f.dir, 'missing-client') }), error => { failedId = error.runId; return /failed to initialize/.test(error.message); });
  const result = await f.manager.status(failedId); assert.equal(result.processState, 'exited'); assert.equal(result.readyAt, undefined);
  assert.equal(result.events.at(-1).type, 'runner.failed'); assert.ok(readRun(f.registry, failedId).locks.every(lock => !fs.existsSync(lock)));
});
