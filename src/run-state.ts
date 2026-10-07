import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export type RunRecord = {
  id: string; token: string; workspace: string; roadmap: string; progressFile: string;
  processState: 'starting' | 'running' | 'stopping' | 'stopped' | 'exited' | 'unknown';
  roadmapState: 'in_progress' | 'blocked' | 'complete'; waitReason: string | null;
  createdAt: string; heartbeat: string; pid?: number; options: any; sequence: number;
  readyAt?: string;
  socket: string; locks: string[]; idempotencyKey?: string; exitCode?: number; reason?: string;
  endedAt?: string; role?: string; iteration?: number; sourceRevision?: string;
  resetAt?: string; deadline?: string; attentionTasks?: string[]; artifacts?: any;
  childGroups?: number[];
};
export const registryRoot = () => process.env.ROADMAP_STATE_DIR || (process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'roadmap-runner')
  : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'roadmap-runner'));
export const privateDir = (dir: string) => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700); return dir; };
export const atomicJson = (file: string, value: unknown) => {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
};
export const runDir = (root: string, id: string) => {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid run ID');
  return path.join(root, 'runs', id);
};
export const readRun = (root: string, id: string): RunRecord => JSON.parse(fs.readFileSync(path.join(runDir(root, id), 'state.json'), 'utf8'));
export const saveRun = (root: string, record: RunRecord) => atomicJson(path.join(runDir(root, record.id), 'state.json'), record);
export const sanitize = (text: string) => text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '')
  .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{10,})\b/g, '[REDACTED]')
  .replace(/((?:api[_-]?key|authorization|password|token)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;"']+/gi, '$1[REDACTED]');
export const appendOutput = (file: string, chunk: string | Buffer) => {
  const data = sanitize(chunk.toString());
  fs.appendFileSync(file, data, { mode: 0o600 });
  if (fs.statSync(file).size > 1024 * 1024) {
    const fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size; const tail = Buffer.alloc(512 * 1024);
    fs.readSync(fd, tail, 0, tail.length, size - tail.length); fs.closeSync(fd);
    fs.writeFileSync(file, tail.subarray(tail.indexOf(10) + 1), { mode: 0o600 });
  }
};
export const outputTail = (file: string, bytes = 8192) => {
  bytes = Math.min(8192, Math.max(0, bytes));
  if (!fs.existsSync(file)) return { output: '', outputTruncated: false };
  const fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size; const buffer = Buffer.alloc(Math.min(size, bytes));
  fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - bytes)); fs.closeSync(fd);
  return { output: sanitize(buffer.toString()), outputTruncated: size > bytes };
};
export const publicRun = ({ token, socket, locks, ...record }: RunRecord) => record;
