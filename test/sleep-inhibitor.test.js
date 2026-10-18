import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SleepInhibitor } from '../dist/sleep-inhibitor.js';
import { startSchema } from '../dist/run-manager.js';

const fixture = (platform = 'darwin', mode = 'active') => {
  const calls = [], signals = []; const child = new EventEmitter();
  child.stdin = { end() { child.inputEnded = true; } };
  child.kill = signal => {
    signals.push(signal);
    if (mode !== 'stubborn' || signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null));
    return true;
  };
  const transport = { platform, pid: 12345, closeTimeoutMs: 10, spawn(command, args, options) {
    calls.push({ command, args, options });
    queueMicrotask(() => {
      if (mode === 'missing') child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
      else { child.emit('spawn'); if (mode === 'exited') child.emit('close', 1); }
    }); return child;
  } };
  return { calls, signals, child, transport };
};

test('MCP sleep prevention defaults off and requires a boolean', () => {
  const request = { workspace: '/prepared', roadmap: 'roadmap.md' };
  assert.equal(startSchema.parse(request).preventSleep, false);
  assert.equal(startSchema.parse({ ...request, preventSleep: true }).preventSleep, true);
  assert.throws(() => startSchema.parse({ ...request, preventSleep: 'true' }));
});

test('disabled sleep prevention starts no process', async () => {
  const f = fixture(); const sleep = new SleepInhibitor(false, undefined, f.transport);
  await sleep.start(); await sleep.close(); assert.deepEqual(f.calls, []); assert.equal(sleep.status.state, 'off');
});

test('macOS inhibition follows the runner PID and releases exactly once', async () => {
  const f = fixture(); const states = []; const sleep = new SleepInhibitor(true, status => states.push(status.state), f.transport);
  await sleep.start();
  assert.equal(sleep.status.state, 'active'); assert.equal(f.calls[0].command, '/usr/bin/caffeinate');
  assert.deepEqual(f.calls[0].args, ['-i', '-w', '12345']);
  await sleep.close(); await sleep.close();
  assert.deepEqual(states, ['active', 'released']); assert.deepEqual(f.signals, ['SIGTERM']);
});

test('Linux inhibitor monitors parent pipe EOF without a shell', async () => {
  const f = fixture('linux'); const sleep = new SleepInhibitor(true, undefined, f.transport);
  await sleep.start(); const { command, args, options } = f.calls[0];
  assert.equal(command, 'systemd-inhibit'); assert.ok(args.includes('--what=idle:sleep'));
  assert.ok(args.includes(process.execPath)); assert.match(args.at(-1), /stdin\.on\('end'/);
  assert.equal(options.stdio[0], 'pipe'); assert.equal(options.shell, undefined);
  await sleep.close(); assert.equal(f.child.inputEnded, true); assert.equal(sleep.status.state, 'released');
});

test('missing, refused and unsupported inhibitors are visible and leave runner work available', async () => {
  for (const [platform, mode, reason] of [['darwin', 'missing', 'backend_unavailable'], ['linux', 'exited', 'backend_exited'], ['win32', 'active', 'unsupported_platform']]) {
    const f = fixture(platform, mode); const sleep = new SleepInhibitor(true, undefined, f.transport);
    await sleep.start(); await sleep.close();
    assert.equal(sleep.status.state, 'unavailable'); assert.equal(sleep.status.reason, reason);
  }
});

test('unexpected inhibitor exit clears active status', async () => {
  const f = fixture(); const sleep = new SleepInhibitor(true, undefined, f.transport);
  await sleep.start(); f.child.emit('close', 1); await sleep.close();
  assert.equal(sleep.status.state, 'unavailable'); assert.equal(sleep.status.reason, 'backend_exited');
  assert.deepEqual(f.signals, []);
});

test('thrown inhibitor launch failure does not interrupt roadmap work', async () => {
  const sleep = new SleepInhibitor(true, undefined, { platform: 'darwin', spawn() { throw new Error('prepared launch failure'); } });
  await sleep.start(); await sleep.close();
  assert.equal(sleep.status.state, 'unavailable'); assert.equal(sleep.status.reason, 'launch_failed');
});

test('a post-launch inhibitor error still cleans up the owned process', async () => {
  const f = fixture(); const sleep = new SleepInhibitor(true, undefined, f.transport);
  await sleep.start(); f.child.emit('error', Object.assign(new Error('prepared error'), { code: 'EIO' }));
  assert.equal(sleep.status.reason, 'backend_failed');
  await sleep.close(); assert.deepEqual(f.signals, ['SIGTERM']); assert.equal(sleep.status.state, 'released');
});

test('inhibitor that ignores SIGTERM is reaped during cleanup', async () => {
  const f = fixture('darwin', 'stubborn'); const sleep = new SleepInhibitor(true, undefined, f.transport);
  await sleep.start(); await sleep.close();
  assert.deepEqual(f.signals, ['SIGTERM', 'SIGKILL']); assert.equal(sleep.status.state, 'released');
});
