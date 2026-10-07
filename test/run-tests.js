import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const registry = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-test-registry-'));
const files = fs.readdirSync('test').filter(file => file.endsWith('.test.js')).map(file => path.join('test', file));
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  stdio: 'inherit', env: { ...process.env, ROADMAP_NOTIFY: 'off', ROADMAP_NOTIFY_BIN: '', ROADMAP_STATE_DIR: registry },
});
const stop = () => child.kill('SIGTERM'); process.on('SIGINT', stop); process.on('SIGTERM', stop);
child.once('exit', code => {
  fs.rmSync(registry, { recursive: true, force: true });
  if (process.platform !== 'win32') {
    const socketDir = path.join('/tmp', `rr-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(registry).digest('hex').slice(0, 24)}`);
    try { fs.rmdirSync(socketDir); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; }
  }
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); process.exitCode = code ?? 1;
});
