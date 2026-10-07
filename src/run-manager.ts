import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseArgs, parseDuration } from '../lib/runner.js';
import { trackingPaths } from '../lib/tracking.js';
import { supervisorSettings } from '../lib/supervision.js';
import { readEvents, eventTypes } from './events.js';
import { registryRoot, privateDir, runDir, readRun, saveRun, publicRun, outputTail, type RunRecord } from './run-state.js';

export const startSchema = z.object({
  workspace: z.string().min(1), roadmap: z.string().min(1), progressFile: z.string().optional(),
  client: z.enum(['codex', 'claude', 'gemini', 'grok', 'kimi', 'muse']).default('codex'),
  timeout: z.string().default('2h'), supervisorEvery: z.number().int().min(0).max(20).default(5),
  supervisorTimeout: z.string().default('10m'), model: z.string().max(200).optional(), effort: z.string().max(50).optional(),
  notify: z.enum(['attention', 'off']).default('attention'), notifyOn: z.array(z.enum(eventTypes as [string, ...string[]])).max(20).default([]),
  idempotencyKey: z.string().min(1).max(128).optional(),
}).strict();
const terminal = (r: RunRecord) => ['stopped', 'exited', 'unknown'].includes(r.processState);
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);
export const canonicalPath = (input: string): string => {
  const resolved = path.resolve(input);
  if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
  return path.join(canonicalPath(path.dirname(resolved)), path.basename(resolved));
};
export const within = (root: string, file: string) => file === root || (!path.relative(root, file).startsWith('..' + path.sep) && path.relative(root, file) !== '..' && !path.isAbsolute(path.relative(root, file)));
export const assertController = () => { if (process.env.ROADMAP_WORKER_CONTEXT) throw new Error('Roadmap workers cannot start or control managed runs'); };
export const control = (record: RunRecord, operation = 'ping'): Promise<any> => new Promise((resolve, reject) => {
  const client = net.createConnection(record.socket); let response = ''; let finished = false;
  const finish = (error?, value?) => { if (finished) return; finished = true; client.destroy(); error ? reject(error) : resolve(value); };
  client.setTimeout(1500, () => finish(new Error('Run control unavailable')));
  client.on('error', error => finish(error));
  client.on('connect', () => client.write(JSON.stringify({ token: record.token, operation }) + '\n'));
  client.on('data', chunk => { response += chunk; if (response.length > 4096) return finish(new Error('Invalid control response')); if (!response.includes('\n')) return;
    try { const result = JSON.parse(response.split('\n')[0]); if (result.id !== record.id || result.token !== record.token) throw new Error('Run ownership mismatch'); finish(null, result); } catch (error) { finish(error); }
  });
  client.on('end', () => { if (!finished) finish(new Error('Run control disconnected')); });
});
export class RunManager {
  root: string; workspace: string;
  constructor(workspace: string, root = registryRoot()) {
    this.workspace = fs.realpathSync(workspace); this.root = privateDir(root);
    if (!fs.statSync(this.workspace).isDirectory()) throw new Error('Workspace must be a directory');
    privateDir(path.join(root, 'runs')); privateDir(path.join(root, 'locks'));
  }
  get(id: string) { const record = readRun(this.root, id); if (record.workspace !== this.workspace) throw new Error('Run belongs to a different workspace'); return record; }
  async reconcile(record: RunRecord) {
    if (['stopped', 'exited'].includes(record.processState)) { this.release(record); return record; }
    try { await control(record); return this.get(record.id); }
    catch {
      let exists = false;
      if (record.pid) { try { process.kill(record.pid, 0); exists = true; } catch (error) { exists = error.code !== 'ESRCH'; } }
      const workerExists = exists;
      for (const pid of record.childGroups || []) {
        try { process.kill(process.platform === 'win32' ? pid : -pid, 0); exists = true; }
        catch (error) { if (error.code !== 'ESRCH') exists = true; }
      }
      // Never signal a PID or release a live process's locks based on a stale record.
      if ((record.pid && !workerExists) || Date.now() - Date.parse(record.heartbeat) > 15000) {
        record.processState = 'unknown'; record.reason = 'worker_unreachable'; saveRun(this.root, record);
        if (!exists) this.release(record);
      }
      return record;
    }
  }
  release(record: RunRecord) {
    for (const lock of record.locks) {
      try { if (fs.readFileSync(lock, 'utf8') === record.id) fs.rmSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  async start(input: unknown, trustedOptions: any = {}, foreground = false) {
    assertController(); const request = startSchema.parse(input);
    const workspace = fs.realpathSync(request.workspace);
    if (workspace !== this.workspace) throw new Error('Workspace is not authorized by this server');
    const roadmap = canonicalPath(path.resolve(workspace, request.roadmap));
    if ((!foreground && !within(workspace, roadmap)) || !fs.statSync(roadmap).isFile()) throw new Error('Roadmap must be a file inside the authorized workspace');
    const optionRoadmap = foreground ? path.resolve(request.workspace, request.roadmap) : roadmap;
    const optionProgress = request.progressFile ? (foreground ? path.resolve(request.workspace, request.progressFile) : canonicalPath(path.resolve(workspace, request.progressFile))) : '';
    const progressFile = canonicalPath(trackingPaths(optionRoadmap, optionProgress, workspace).file);
    if ((!foreground && !within(workspace, progressFile)) || progressFile === roadmap) throw new Error('Progress must be separate and inside the authorized workspace');
    const options = { ...parseArgs([], {}), ...request, roadmap: optionRoadmap, progressFile: optionProgress, ...trustedOptions };
    parseDuration(options.timeout); supervisorSettings(options);
    const fingerprint = hash(JSON.stringify({ ...request, workspace, roadmap, progressFile, idempotencyKey: undefined }));
    for (const id of fs.readdirSync(path.join(this.root, 'runs')).sort()) {
      const r = readRun(this.root, id);
      if (r.workspace === workspace && request.idempotencyKey && r.idempotencyKey === request.idempotencyKey) {
        if (r.options.requestFingerprint !== fingerprint) throw new Error('Idempotency key was used with different options');
        return publicRun(await this.ready(r.id));
      }
    }
    const id = randomBytes(12).toString('hex');
    const locks = [path.join(this.root, 'locks', hash(workspace)), path.join(this.root, 'locks', hash(progressFile))];
    privateDir(runDir(this.root, id));
    const socketDir = process.platform === 'win32' ? '' : privateDir(path.join('/tmp', `rr-${process.getuid?.() ?? 'user'}-${hash(this.root)}`));
    const record: RunRecord = { id, token: randomBytes(32).toString('hex'), workspace, roadmap, progressFile,
      processState: 'starting', roadmapState: 'in_progress', waitReason: null, createdAt: new Date().toISOString(), heartbeat: new Date().toISOString(), sequence: 0,
      options: { ...options, requestFingerprint: fingerprint }, socket: process.platform === 'win32' ? `\\\\.\\pipe\\rr-${id}` : path.join(socketDir, `${id}.sock`), locks, idempotencyKey: request.idempotencyKey };
    saveRun(this.root, record);
    const ownerFile = path.join(runDir(this.root, id), 'owner');
    fs.writeFileSync(ownerFile, id, { mode: 0o600 });
    const acquired: string[] = [];
    let spawned = false;
    try {
      for (const lock of locks) {
        try { fs.linkSync(ownerFile, lock); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const owner = fs.readFileSync(lock, 'utf8');
          const existing = await this.reconcile(readRun(this.root, owner));
          if (terminal(existing) && !fs.existsSync(lock)) { fs.linkSync(ownerFile, lock); }
          else {
            if (existing.idempotencyKey === request.idempotencyKey && request.idempotencyKey && existing.options.requestFingerprint === fingerprint) {
              fs.rmSync(runDir(this.root, id), { recursive: true }); return publicRun(await this.ready(owner));
            }
            throw Object.assign(new Error(`Workspace or progress is already reserved by run ${owner}`), { runId: owner });
          }
        }
        acquired.push(lock);
      }
      if (foreground) {
        const { runWorker } = await import('./worker.js');
        spawned = true;
        await runWorker(this.root, id, true); return publicRun(this.get(id));
      }
      const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.js', import.meta.url)), this.root, id], { cwd: workspace, detached: true, stdio: 'ignore', env: { ...process.env, ROADMAP_WORKER_CONTEXT: id } });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); spawned = true; child.unref();
      // Only the worker writes state after spawning. It publishes its own PID.
      return publicRun(await this.ready(id));
    } catch (error) {
      // Once spawned, a readiness failure must retain ownership until reconciliation.
      if (!spawned) {
        for (const lock of acquired) fs.rmSync(lock, { force: true });
        fs.rmSync(runDir(this.root, id), { recursive: true, force: true });
      }
      throw error;
    }
  }
  async ready(id: string) {
    const until = Date.now() + 15000;
    do {
      const r = await this.reconcile(this.get(id));
      if (terminal(r)) {
        if (!r.readyAt) throw Object.assign(new Error(`Run ${id} failed to initialize; inspect status`), { runId: id });
        return r;
      }
      try { const result = await control(r); if (result.ready) return this.get(id); } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < until);
    throw new Error(`Run ${id} did not become ready; inspect status`);
  }
  async stop(id: string) {
    assertController(); const r = await this.reconcile(this.get(id));
    if (terminal(r)) return { ...publicRun(r), changed: false };
    const result = await control(r, 'stop'); return { ...publicRun(this.get(id)), changed: result.changed };
  }
  async status(id?: string, { outputBytes = 8192, cursor = 0, offset = 0 }: any = {}) {
    if (!id) {
      const records = fs.readdirSync(path.join(this.root, 'runs')).sort().map(id => readRun(this.root, id)).filter(r => r.workspace === this.workspace);
      const runs = []; let bytes = 0;
      for (const r of records.slice(offset, offset + 20)) {
        const value = publicRun(await this.reconcile(r)); const size = Buffer.byteLength(JSON.stringify(value));
        if (runs.length && bytes + size > 24000) break;
        runs.push(value); bytes += size;
      }
      return { runs, nextOffset: offset + runs.length < records.length ? offset + runs.length : null };
    }
    const r = await this.reconcile(this.get(id)); const dir = runDir(this.root, id);
    return { ...publicRun(r), ...outputTail(path.join(dir, 'output.log'), outputBytes), ...readEvents(path.join(dir, 'events.jsonl'), cursor), resources: { state: `roadmap://${id}/state`, events: `roadmap://${id}/events` }, outputTrust: 'untrusted local content' };
  }
}
