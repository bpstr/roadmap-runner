import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requestNotificationPermission } from '../dist/notification-permission.js';

const prepared = (errors = [], extra = {}) => {
  const calls = [];
  return { calls, platform: 'darwin', env: { PATH: '/usr/bin:/bin' },
    resolveCommand: () => '/opt/homebrew/bin/terminal-notifier',
    execFile(command, args, options, callback) { calls.push({ command, args, options }); queueMicrotask(() => callback(errors.shift() || null)); },
    ...extra,
  };
};

test('permission command requests through the alert backend and allows a human response', async () => {
  const dependencies = prepared(); const result = await requestNotificationPermission(dependencies);
  assert.equal(result.ok, true); assert.equal(result.result, 'submitted'); assert.equal(dependencies.calls.length, 1);
  const call = dependencies.calls[0]; assert.equal(call.command, '/opt/homebrew/bin/terminal-notifier');
  assert.ok(call.args.includes('-message')); assert.ok(call.args.includes('roadmap-runner-permission'));
  assert.equal(call.options.timeout, 120000); assert.equal(call.options.shell, undefined);
  assert.ok(!call.args.some(arg => ['-execute', '-activate', '-open'].includes(arg)));
});

test('denied permission opens Notifications settings without resetting the saved decision', async () => {
  const dependencies = prepared([{ code: 3 }]); const result = await requestNotificationPermission(dependencies);
  assert.equal(result.ok, false); assert.equal(result.result, 'permission_denied'); assert.equal(result.settingsOpened, true);
  assert.equal(dependencies.calls[1].command, '/usr/bin/open');
  assert.deepEqual(dependencies.calls[1].args, ['x-apple.systempreferences:com.apple.Notifications-Settings.extension']);
  assert.ok(dependencies.calls.every(call => !/tccutil|reset/.test(call.command + call.args.join(' '))));
});

test('failed settings launch retains permission denial and gives manual guidance', async () => {
  const dependencies = prepared([{ code: 3 }, { code: 1 }]);
  const result = await requestNotificationPermission(dependencies);
  assert.equal(result.settingsOpened, false); assert.equal(result.result, 'permission_denied');
  assert.match(result.message, /Open System Settings > Notifications/);
});

test('missing backend, timeout and cancellation remain distinct from permission denial', async () => {
  for (const [error, expected] of [[{ code: 'ENOENT' }, 'backend_unavailable'], [{ killed: true }, 'request_timeout'], [{ name: 'AbortError' }, 'cancelled'], [{ code: 4 }, 'delivery_failed']]) {
    const dependencies = prepared([error]); const result = await requestNotificationPermission(dependencies);
    assert.equal(result.ok, false); assert.equal(result.result, expected); assert.equal(dependencies.calls.length, 1);
  }
});

test('permission requests propagate cancellation and contain thrown launch errors', async () => {
  const signal = new AbortController().signal; const dependencies = prepared([], { signal });
  await requestNotificationPermission(dependencies); assert.equal(dependencies.calls[0].options.signal, signal);
  const failure = await requestNotificationPermission(prepared([], { execFile() { throw Object.assign(new Error('prepared launch error'), { code: 'ENOENT' }); } }));
  assert.equal(failure.result, 'backend_unavailable');
});

test('non-macOS permission requests start no process', async () => {
  for (const platform of ['linux', 'win32']) {
    const dependencies = prepared([], { platform }); const result = await requestNotificationPermission(dependencies);
    assert.equal(result.result, 'unsupported_platform'); assert.equal(dependencies.calls.length, 0);
  }
});

test('cancellation while opening settings is reported as cancelled', async () => {
  const dependencies = prepared([{ code: 3 }, { name: 'AbortError' }]);
  const result = await requestNotificationPermission(dependencies); assert.equal(result.result, 'cancelled');
});

test('permission timeout and cancellation reap the prepared sender process', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-permission-stop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const backend = path.join(dir, 'sender'); fs.writeFileSync(backend, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  for (const mode of ['timeout', 'cancel']) {
    const controller = new AbortController(); let child;
    const resultPromise = requestNotificationPermission({ platform: 'darwin', resolveCommand: () => backend,
      timeoutMs: mode === 'timeout' ? 100 : 2000, signal: controller.signal,
      execFile(...args) { child = execFile(...args); return child; },
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM'); await closed;
      }
    });
    if (mode === 'cancel') { await new Promise(resolve => child.once('spawn', resolve)); controller.abort(); }
    const result = await resultPromise; assert.equal(result.result, mode === 'timeout' ? 'request_timeout' : 'cancelled');
    assert.equal(child.signalCode, 'SIGTERM');
    assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH');
  }
});

test('cancellation reaps a prepared sender that ignores SIGTERM', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-permission-stubborn-')); const ready = path.join(dir, 'ready');
  const backend = path.join(dir, 'sender');
  fs.writeFileSync(backend, `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.env.RR_PERMISSION_READY, 'ready'); setInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const controller = new AbortController(); let child;
  const pending = requestNotificationPermission({ platform: 'darwin', resolveCommand: () => backend,
    env: { ...process.env, RR_PERMISSION_READY: ready }, signal: controller.signal, timeoutMs: 10000,
    execFile(...args) { child = execFile(...args); return child; },
  });
  t.after(async () => { controller.abort(); await pending; fs.rmSync(dir, { recursive: true, force: true }); });
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(ready), true); controller.abort();
  assert.equal((await pending).result, 'cancelled'); assert.equal(child.signalCode, 'SIGKILL');
  assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH');
});

test('dedicated CLI command submits via a prepared sender, supports JSON and rejects unknown arguments', { skip: process.platform !== 'darwin' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-permission-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const backend = path.join(dir, 'terminal-notifier'); const argvFile = path.join(dir, 'submitted.json');
  fs.writeFileSync(backend, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.RR_PERMISSION_ARGS, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  const cli = fileURLToPath(new URL('../bin/roadmap-runner.js', import.meta.url));
  const run = async args => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, PATH: dir, RR_PERMISSION_ARGS: argvFile }, cwd: dir });
    let output = '', error = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => error += chunk);
    const code = await new Promise(resolve => child.once('close', resolve)); return { code, output, error };
  };
  const json = await run(['notifications', 'request-permission', '--json']); assert.equal(json.code, 0, json.error);
  assert.equal(JSON.parse(json.output).result, 'submitted'); assert.ok(JSON.parse(fs.readFileSync(argvFile)).includes('-message'));
  const plain = await run(['notifications', 'request-permission']); assert.equal(plain.code, 0, plain.error); assert.match(plain.output, /confirmation notification was submitted/);
  const invalid = await run(['notifications', 'request-permission', '--unexpected']); assert.equal(invalid.code, 64); assert.match(invalid.error, /notifications requires/);
  assert.equal(fs.existsSync(path.join(dir, '.roadmap-runner')), false);
});
