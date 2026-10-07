import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { runLifecycle } from './lifecycle.js';
import { Notifications } from './notifications.js';
import { appendEvent } from './events.js';
import { readRun, saveRun, runDir, appendOutput } from './run-state.js';
import { RunManager } from './run-manager.js';

export const runWorker = async (root: string, id: string, foreground = false) => {

const record = readRun(root, id); record.pid = process.pid; saveRun(root, record);
const manager = new RunManager(record.workspace, root); const dir = runDir(root, id);
const controller = new AbortController(); let ready = false;
const sockets = new Set<net.Socket>();
const previousContext = process.env.ROADMAP_WORKER_CONTEXT; process.env.ROADMAP_WORKER_CONTEXT = id;
const originalWrites = new Map();
const pendingOutput = new Map<any, string>();
const oversizedLines = new Set<any>();
const outputFile = path.join(dir, 'output.log');
// Capture normalized client output and runner messages even when supervision is disabled.
for (const stream of [process.stdout, process.stderr]) {
  const original = stream.write.bind(stream); originalWrites.set(stream, original);
  stream.write = ((chunk, ...args) => {
    let pending = (pendingOutput.get(stream) || '') + chunk.toString();
    while (pending.includes('\n')) {
      const end = pending.indexOf('\n') + 1;
      if (!oversizedLines.has(stream)) appendOutput(outputFile, Buffer.byteLength(pending.slice(0, end)) > 65536 ? '[Oversized output line omitted]\n' : pending.slice(0, end));
      oversizedLines.delete(stream); pending = pending.slice(end);
    }
    if (Buffer.byteLength(pending) > 65536) {
      appendOutput(outputFile, '[Oversized output line omitted]\n'); oversizedLines.add(stream); pending = '';
    }
    pendingOutput.set(stream, pending);
    if (foreground) return original(chunk, ...args);
    const callback = args.find(arg => typeof arg === 'function'); callback?.(); return true;
  }) as any;
}
const notifier = new Notifications(record.options, path.join(dir, 'notifications.json'));
const persist = () => { record.heartbeat = new Date().toISOString(); saveRun(root, record); };
const stop = () => { const changed = !controller.signal.aborted; if (changed) { record.processState = 'stopping'; persist(); controller.abort(); } return changed; };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
const server = net.createServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.setTimeout(2000, () => socket.destroy());
  let buffer = ''; socket.on('data', chunk => {
    buffer += chunk; if (buffer.length > 4096) { socket.destroy(); return; } if (!buffer.includes('\n')) return;
    try {
      const request = JSON.parse(buffer.split('\n')[0]); const token = Buffer.from(String(request.token)); const expected = Buffer.from(record.token);
      if (token.length !== expected.length || !timingSafeEqual(token, expected)) { socket.destroy(); return; }
      if (!['ping', 'stop'].includes(request.operation)) { socket.destroy(); return; }
      const changed = request.operation === 'stop' ? stop() : false;
      socket.end(JSON.stringify({ id, token: record.token, ready, changed, processState: record.processState }) + '\n');
    } catch { socket.destroy(); }
  });
});
let heartbeat;
try {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(record.socket, resolve); });
  if (process.platform !== 'win32') fs.chmodSync(record.socket, 0o600);
  heartbeat = setInterval(persist, 2000);
  const result = await runLifecycle({ ...record.options, runId: id, onProcess: ({ pid, active }) => {
    record.childGroups = active ? [...new Set([...(record.childGroups || []), pid])] : (record.childGroups || []).filter(value => value !== pid);
    persist();
  } }, {
    workdir: record.workspace, signal: controller.signal,
    onReady: tracking => { record.artifacts = { progress: tracking.file, history: tracking.historyDir, output: outputFile, events: path.join(dir, 'events.jsonl'), notifications: path.join(dir, 'notifications.json') }; record.processState = controller.signal.aborted ? 'stopping' : 'running'; record.readyAt = new Date().toISOString(); ready = true; persist(); },
    onEvent: event => {
      record.sequence = event.sequence; record.sourceRevision = event.sourceRevision; record.role = event.role || record.role; record.iteration = event.iteration ?? record.iteration;
      if (event.type === 'runner.blocked') record.roadmapState = 'blocked';
      if (event.type === 'runner.unblocked' || event.type === 'runner.turn_starting') record.roadmapState = 'in_progress';
      if (event.type === 'runner.completed') record.roadmapState = 'complete';
      if (event.type === 'runner.usage_paused') { record.waitReason = 'quota'; record.resetAt = event.resetAt; record.deadline = event.deadline; }
      if (event.type === 'runner.capacity_wait') record.waitReason = 'capacity';
      if (event.type === 'runner.recovery_wait') record.waitReason = 'recovery';
      if (['runner.turn_starting', 'runner.usage_resumed'].includes(event.type)) record.waitReason = null;
      if (event.items) record.attentionTasks = event.items.filter(item => item.requiresAttention).map(item => item.task);
      if (event.type === 'runner.unblocked') record.attentionTasks = [];
      appendEvent(path.join(dir, 'events.jsonl'), event); persist(); notifier.enqueue(event);
    },
  });
  if (!controller.signal.aborted) await notifier.flush();
  await notifier.close();
  record.processState = result.reason === 'stopped' ? 'stopped' : 'exited'; record.reason = result.reason; record.exitCode = result.code; record.endedAt = new Date().toISOString(); record.waitReason = null;
  persist();
} catch (error) {
  record.processState = 'unknown'; record.reason = error.message; persist();
} finally {
  for (const [stream, pending] of pendingOutput) if (pending && !oversizedLines.has(stream)) appendOutput(outputFile, pending);
  clearInterval(heartbeat); await notifier.close(); for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (process.platform !== 'win32') fs.rmSync(record.socket, { force: true });
  manager.release(record);
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  for (const [stream, write] of originalWrites) stream.write = write;
  if (previousContext === undefined) delete process.env.ROADMAP_WORKER_CONTEXT; else process.env.ROADMAP_WORKER_CONTEXT = previousContext;
}
return record;
};
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runWorker(...process.argv.slice(2) as [string, string]);
