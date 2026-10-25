import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const digest = value => createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(stable(value[key]))]))
  : Array.isArray(value) ? value.map(item => JSON.parse(stable(item))) : value);
const same = (a, b) => stable(a) === stable(b);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const within = (root, target) => target === root || (!path.isAbsolute(path.relative(root, target)) && !path.relative(root, target).split(path.sep).includes('..'));

export const verificationDirectory = workdir => path.join(path.resolve(workdir), '.roadmap-runner', 'verification');

function atomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

// Resolve existing ancestors too: a missing file below an escaping symlink is
// not an authorized workspace input. Missing inputs are versioned as absence.
export function workspacePath(workdir, name, { allowMissing = true } = {}) {
  if (typeof name !== 'string' || !name || name.includes('\0')) throw new Error('Invalid workspace input path');
  const root = fs.realpathSync(workdir);
  const resolved = path.resolve(root, name);
  if (!within(root, resolved)) throw new Error(`Input is outside the workspace: ${name}`);
  let ancestor = resolved;
  while (!fs.existsSync(ancestor)) {
    if (!allowMissing || ancestor === root) throw new Error(`Input does not exist: ${name}`);
    // existsSync follows links, whereas lstat also detects dangling symlinks.
    try { if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error(`Input is a dangling symlink: ${name}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    ancestor = path.dirname(ancestor);
  }
  if (!within(root, fs.realpathSync(ancestor))) throw new Error(`Input resolves outside the workspace: ${name}`);
  return resolved;
}

function fileHash(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

export function snapshotPaths(workdir, names) {
  if (!Array.isArray(names) || names.length > 256 || names.some(name => typeof name !== 'string')) throw new Error('Input paths must be a bounded array');
  const root = fs.realpathSync(workdir);
  let visited = 0;
  const inspect = name => {
    if (++visited > 8192) throw new Error('Declared input scope exceeds 8192 entries; use a narrower scope');
    const file = workspacePath(root, name);
    if (!fs.existsSync(file)) return { kind: 'missing' };
    const stat = fs.statSync(file);
    if (stat.isFile()) return { kind: 'file', sha256: fileHash(file) };
    if (!stat.isDirectory()) throw new Error(`Input must be a regular file or directory: ${name}`);
    // Directory membership and file contents both matter. Never follow a
    // directory symlink recursively: the caller can declare its target instead.
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Declare the directory target instead of its symlink: ${name}`);
    const entries = fs.readdirSync(file).sort().map(entry => [entry, inspect(path.join(name, entry))]);
    return { kind: 'directory', sha256: digest(stable(entries)) };
  };
  return Object.fromEntries([...new Set(names.map(name => path.relative(root, workspacePath(root, name))))].sort()
    .map(name => [name || '.', inspect(name || '.') ]));
}

function validateSpec(spec, workdir) {
  if (Buffer.byteLength(JSON.stringify(spec) || '') > 64 * 1024) throw new Error('Verification specification exceeds 64 KiB');
  if (!plain(spec) || !Array.isArray(spec.command) || spec.command.length < 1 || spec.command.length > 256 ||
      spec.command.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !spec.command[0]) throw new Error('Verification command must be an argv array');
  if (spec.criteriaRevision !== undefined && typeof spec.criteriaRevision !== 'string') throw new Error('criteriaRevision must be a string');
  const cwd = workspacePath(workdir, spec.cwd ?? '.', { allowMissing: false });
  if (!fs.statSync(cwd).isDirectory()) throw new Error('Verification cwd must be a directory');
  for (const key of ['inputs', 'config', 'environment']) {
    if (spec[key] !== undefined && (!Array.isArray(spec[key]) || spec[key].length > 256 || spec[key].some(value => typeof value !== 'string'))) throw new Error(`${key} must be a bounded string array`);
  }
  if (spec.environment?.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error('Invalid environment variable name');
  if (spec.runtime !== undefined && (!plain(spec.runtime) || Object.keys(spec.runtime).length > 32 || Object.values(spec.runtime).some(value => typeof value !== 'string'))) throw new Error('runtime must map names to version strings');
  if (spec.external !== undefined && spec.external !== null && (!plain(spec.external) || !Number.isFinite(Date.parse(spec.external.freshUntil)))) throw new Error('External evidence requires a freshUntil timestamp');
  if (spec.timeoutMs !== undefined && (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > 2_147_483_647)) throw new Error('Invalid verification timeout');
  return { ...spec, cwd: path.relative(fs.realpathSync(workdir), cwd) || '.' };
}

function executableFor(command, cwd, env) {
  if (command.includes('/') || command.includes('\\')) {
    const file = path.resolve(cwd, command);
    try { if (fs.statSync(file).isFile()) { fs.accessSync(file, fs.constants.X_OK); return file; } } catch { /* Unknown executable identity cannot be cached. */ }
    return null;
  }
  const extensions = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    for (const extension of ['', ...extensions]) {
      const file = path.join(path.resolve(cwd, dir || '.'), command + extension);
      try { if (fs.statSync(file).isFile()) { fs.accessSync(file, fs.constants.X_OK); return file; } } catch { /* Try the next PATH entry. */ }
    }
  }
  return null;
}

function scopeFor(spec, workdir, env = process.env) {
  const cwd = workspacePath(workdir, spec.cwd, { allowMissing: false });
  const executable = executableFor(spec.command[0], cwd, env);
  return {
    criteriaRevision: spec.criteriaRevision ?? null,
    command: spec.command, cwd: fs.realpathSync(cwd),
    inputs: snapshotPaths(workdir, spec.inputs || []),
    config: snapshotPaths(workdir, spec.config || []),
    environment: Object.fromEntries([...(new Set(spec.environment || []))].sort().map(name => [name,
      Object.hasOwn(env, name) ? digest(String(env[name])) : null])),
    runtime: { declared: spec.runtime || null, platform: process.platform, arch: process.arch,
      executable: executable ? { path: fs.realpathSync(executable), sha256: fileHash(executable) } : null },
  };
}

function coverageReason(spec) {
  if (spec.coverageComplete !== true) return 'Relevant dependency coverage is not declared complete';
  if (!spec.criteriaRevision) return 'Acceptance criteria version is missing';
  if (!Array.isArray(spec.inputs) || !spec.inputs.length || !Array.isArray(spec.config) ||
      !Array.isArray(spec.environment) || !plain(spec.runtime)) return 'Dependency, configuration, environment or runtime scope is missing';
  return null;
}

export function classifyReceipt(receipt, rawSpec, { workdir = process.cwd(), now = Date.now(), env = process.env } = {}) {
  try {
    if (receipt?.kind === 'review') return { status: 'unknown', reason: 'Review verdict is an agent assertion, not runner-observed verification' };
    const spec = validateSpec(rawSpec, workdir);
    if (receipt?.version !== 1 || receipt.kind !== 'verification' || receipt.provenance !== 'runner' || !receipt.scope) return { status: 'unknown', reason: 'Missing runner verification provenance' };
    const missing = coverageReason(spec) || coverageReason(receipt.spec || {});
    if (missing) return { status: 'unknown', reason: missing };
    if (!receipt.scope.runtime?.executable) return { status: 'unknown', reason: 'Executed runtime identity could not be resolved' };
    if (!receipt.completed || receipt.inputsChanged || receipt.signal || receipt.error || !Number.isInteger(receipt.exitCode)) return { status: 'unknown', reason: 'Check did not finish against stable declared inputs' };
    const expiry = receipt.spec.external?.freshUntil;
    if (expiry && now >= Date.parse(expiry)) return { status: 'invalidated', reason: 'External evidence freshness expired' };
    if (!same(receipt.spec.external ?? null, spec.external ?? null)) return { status: 'invalidated', reason: 'External freshness scope changed' };
    const current = scopeFor(spec, workdir, env);
    if (!current.runtime.executable) return { status: 'unknown', reason: 'Current runtime identity could not be resolved' };
    for (const key of ['criteriaRevision', 'command', 'cwd', 'inputs', 'config', 'environment', 'runtime']) {
      if (!same(receipt.scope[key], current[key])) return { status: 'invalidated', reason: `${key} changed` };
    }
    return { status: 'reusable', reason: 'Recorded command and all declared relevant inputs match', scope: 'declared-check-only' };
  } catch (error) { return { status: 'unknown', reason: error.message }; }
}

export function readVerificationReceipt(id, { workdir = process.cwd(), evidenceDir = verificationDirectory(workdir) } = {}) {
  if (typeof id !== 'string' || !/^(?:check|review)-[a-f0-9-]{36}$/.test(id)) return null;
  const file = path.join(evidenceDir, 'receipts', `${id}.json`);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 256 * 1024) return null;
    return { receipt: JSON.parse(fs.readFileSync(file, 'utf8')), file };
  } catch { return null; }
}

function directories(directory) {
  for (const name of ['', 'receipts', 'outputs', 'index', 'locks']) fs.mkdirSync(path.join(directory, name), { recursive: true, mode: 0o700 });
}

function groupExists(pid) {
  if (!pid) return false;
  try { process.kill(process.platform === 'win32' ? pid : -pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function terminateGroup(child, signal) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 3000 });
    return;
  }
  try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
}

function updateLock(file, token, update) {
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (current.token !== token) throw new Error('Verification lock ownership changed');
  atomic(file, { ...current, ...update });
}

function releaseLock(file, token) {
  try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function lock(file, signal, maxWaitMs) {
  const started = Date.now();
  while (true) {
    if (signal?.aborted) throw new Error('Verification cancelled while awaiting an identical check');
    const token = randomUUID();
    try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token, phase: 'acquired', at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); return token; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (owner.cleanupIncomplete) {
          if (groupExists(owner.processGroupId)) throw Object.assign(new Error('Previous verification process cleanup is unconfirmed; no duplicate check was started'), { cleanupIncomplete: true });
          releaseLock(file, owner.token); continue;
        }
        if (Number.isInteger(owner.pid)) {
          try { process.kill(owner.pid, 0); }
          catch (cause) {
            if (cause.code === 'ESRCH') {
              // The helper may die while its detached command is still alive.
              // Its process group, rather than the helper PID, owns the work.
              if (owner.phase === 'spawning' && !owner.processGroupId) throw Object.assign(
                new Error('Previous verification launch state is unknown; no duplicate check was started'), { launchStateUnknown: true });
              if (!groupExists(owner.processGroupId)) { releaseLock(file, owner.token); continue; }
            }
          }
        }
      } catch (cause) { if (cause.cleanupIncomplete || cause.launchStateUnknown) throw cause; if (cause.code === 'ENOENT') continue; }
      if (Date.now() - started >= maxWaitMs) throw new Error('An identical verification is still running; no duplicate command was started');
      await delay(64);
    }
  }
}

async function execute(spec, { workdir, directory, id, signal, env, onOutput, beforeSpawn, onSpawn }) {
  const stdout = path.join(directory, 'outputs', `${id}.stdout.log`);
  const stderr = path.join(directory, 'outputs', `${id}.stderr.log`);
  const out = fs.openSync(stdout, 'wx', 0o600), err = fs.openSync(stderr, 'wx', 0o600);
  const counts = { tests: null, passed: null, failed: null, skipped: null, cancelled: null };
  let lines = '', failure = null, aborted = Boolean(signal?.aborted), timedOut = false, cleanupIncomplete = false, descendantCleanupRequired = false, childPid = null;
  const startedAt = new Date().toISOString();
  try {
    const result = await new Promise(resolve => {
      if (aborted) { resolve({ code: null, signal: null }); return; }
      beforeSpawn?.();
      const child = spawn(spec.command[0], spec.command.slice(1), { cwd: workspacePath(workdir, spec.cwd), env, shell: false,
        stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      childPid = child.pid ?? null;
      try { onSpawn?.(childPid); } catch (error) { failure = error.message; terminateGroup(child, 'SIGKILL'); }
      let timeout, force, cleanupWork = null, closed = null, finished = false;
      const cleanupGroup = () => {
        if (cleanupWork) return cleanupWork;
        cleanupWork = (async () => {
          // An exit/close of the leader does not establish that descendants
          // with ignored or inherited stdio have stopped editing the workspace.
          await delay(32);
          if (!groupExists(child.pid)) return;
          descendantCleanupRequired = true;
          terminateGroup(child, 'SIGTERM');
          let deadline = Date.now() + 2048;
          while (groupExists(child.pid) && Date.now() < deadline) await delay(32);
          if (groupExists(child.pid)) terminateGroup(child, 'SIGKILL');
          deadline = Date.now() + 1024;
          while (groupExists(child.pid) && Date.now() < deadline) await delay(32);
          cleanupIncomplete = groupExists(child.pid);
        })();
        return cleanupWork;
      };
      const finish = async () => {
        if (finished || !closed) return;
        finished = true;
        await cleanupGroup();
        clearTimeout(timeout); clearTimeout(force); signal?.removeEventListener('abort', abort);
        resolve(closed);
      };
      const stop = () => {
        if (!child.pid) return;
        terminateGroup(child, 'SIGTERM');
        if (!force) { force = setTimeout(() => terminateGroup(child, 'SIGKILL'), 2048); force.unref(); }
      };
      const abort = () => { aborted = true; stop(); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      timeout = setTimeout(() => { timedOut = true; stop(); }, spec.timeoutMs ?? 30 * 60_000);
      const capture = (stream, fd, chunk) => {
        try {
          fs.writeSync(fd, chunk);
          onOutput?.(stream, chunk);
          if (spec.format === 'tap' && stream === 'stdout') {
            lines += chunk.toString();
            let end;
            while ((end = lines.indexOf('\n')) >= 0) {
              const match = /^# (tests|pass|fail|skipped|cancelled) (\d+)\s*$/.exec(lines.slice(0, end));
              if (match) counts[({ pass: 'passed', fail: 'failed' })[match[1]] || match[1]] = Number(match[2]);
              lines = lines.slice(end + 1);
            }
            if (lines.length > 65536) lines = lines.slice(-65536);
          }
        } catch (error) { failure ||= error.message; stop(); }
      };
      child.stdout.on('data', chunk => capture('stdout', out, chunk));
      child.stderr.on('data', chunk => capture('stderr', err, chunk));
      child.on('error', error => { failure = error.message; });
      child.on('exit', () => { clearTimeout(timeout); void cleanupGroup(); });
      child.on('close', (code, exitSignal) => {
        closed = { code, signal: exitSignal }; void finish();
      });
    });
    return { exitCode: result.code, signal: result.signal, error: failure, timedOut, aborted, cleanupIncomplete, descendantCleanupRequired, processGroupId: childPid,
      completed: !failure && !aborted && !timedOut && !cleanupIncomplete && !descendantCleanupRequired && Number.isInteger(result.code), counts, stdout, stderr,
      startedAt, finishedAt: new Date().toISOString() };
  } finally { fs.closeSync(out); fs.closeSync(err); }
}

export async function runVerification(rawSpec, { workdir = process.cwd(), evidenceDir = verificationDirectory(workdir), signal,
  env = process.env, onOutput, lockWaitMs = 30 * 60_000 } = {}) {
  const spec = validateSpec(rawSpec, workdir);
  directories(evidenceDir);
  const before = scopeFor(spec, workdir, env);
  const key = digest(stable({ scope: before, external: spec.external ?? null }));
  const indexFile = path.join(evidenceDir, 'index', `${key}.json`);
  const lockFile = path.join(evidenceDir, 'locks', `${key}.lock`);
  const lockToken = await lock(lockFile, signal, lockWaitMs);
  let ownsLock = true;
  try {
    const currentScope = scopeFor(spec, workdir, env);
    if (digest(stable({ scope: currentScope, external: spec.external ?? null })) !== key) {
      // Rejoin the single-flight group for the new inputs, rather than running
      // them under a stale key while another process checks the same new scope.
      releaseLock(lockFile, lockToken); ownsLock = false;
      return await runVerification(rawSpec, { workdir, evidenceDir, signal, env, onOutput, lockWaitMs });
    }
    if (!spec.force) {
      try {
        const entry = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
        const previous = readVerificationReceipt(entry.id, { evidenceDir });
        if (previous && classifyReceipt(previous.receipt, spec, { workdir, env }).status === 'reusable') {
          return { receipt: previous.receipt, receiptFile: previous.file, reused: true };
        }
      } catch { /* Missing or invalid cached evidence requires a real check. */ }
    }
    // Inputs may have changed while waiting for the identical in-flight check.
    const scope = currentScope;
    const id = `check-${randomUUID()}`;
    const observed = await execute(spec, { workdir, directory: evidenceDir, id, signal, env, onOutput,
      beforeSpawn: () => updateLock(lockFile, lockToken, { phase: 'spawning', receiptId: id }),
      onSpawn: pid => updateLock(lockFile, lockToken, { phase: 'running', processGroupId: pid }) });
    let after = null, snapshotError = null;
    try { after = scopeFor(spec, workdir, env); } catch (error) { snapshotError = error.message; }
    const receipt = { version: 1, kind: 'verification', provenance: 'runner', id, taskId: spec.taskId ?? null,
      spec, scope, ...observed, inputsChanged: !after || !same(scope, after), snapshotError,
      acceptanceAuthority: false };
    const receiptFile = path.join(evidenceDir, 'receipts', `${id}.json`);
    atomic(receiptFile, receipt);
    if (observed.cleanupIncomplete) {
      updateLock(lockFile, lockToken, { phase: 'unconfirmed-cleanup', processGroupId: observed.processGroupId, cleanupIncomplete: true, receiptFile });
      ownsLock = false;
    }
    if (classifyReceipt(receipt, spec, { workdir, env }).status === 'reusable') atomic(indexFile, { id });
    return { receipt, receiptFile, reused: false };
  } finally { if (ownsLock) releaseLock(lockFile, lockToken); }
}

// A review can supply useful scoped context, but an agent assertion is never
// promoted into a runner-observed command result or acceptance authorization.
export function recordReview(spec, { workdir = process.cwd(), evidenceDir = verificationDirectory(workdir) } = {}) {
  if (!plain(spec) || Buffer.byteLength(JSON.stringify(spec)) > 64 * 1024 || typeof spec.verdict !== 'string' ||
      spec.verdict.length > 8192 || !Array.isArray(spec.inputPaths)) throw new Error('A review needs a bounded verdict and explicit input paths');
  directories(evidenceDir);
  const id = `review-${randomUUID()}`;
  const receipt = { version: 1, kind: 'review', provenance: 'agent-assertion', id,
    taskId: spec.taskId ?? null, criteriaRevision: spec.criteriaRevision ?? null, verdict: spec.verdict,
    findings: Array.isArray(spec.findings) ? spec.findings : [], inputPaths: spec.inputPaths,
    inputs: snapshotPaths(workdir, spec.inputPaths), recordedAt: new Date().toISOString(), acceptanceAuthority: false };
  const receiptFile = path.join(evidenceDir, 'receipts', `${id}.json`);
  atomic(receiptFile, receipt);
  return { receipt, receiptFile };
}
