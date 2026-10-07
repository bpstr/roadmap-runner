import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { atomicJson, sanitize } from './run-state.js';
import { eventTypes } from './events.js';

export class Notifications {
  options: any; file: string; state: any; queue: any[] = []; active: any; draining = false; diagnosed = false; closed = false;
  canPersist = true;
  constructor(options: any, file: string, private transport: any = {}) {
    if ((options.notifyOn || []).some(type => !eventTypes.includes(type))) throw new Error('Unknown notification event');
    this.options = options; this.file = file; this.state = { fingerprints: [], deliveries: [] };
    try {
      if (fs.statSync(file).size > 32768) throw new Error('State exceeds budget');
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(state.fingerprints) || !Array.isArray(state.deliveries)) throw new Error('Invalid state');
      this.state = { fingerprints: state.fingerprints.filter(key => typeof key === 'string').slice(-128), deliveries: state.deliveries.slice(-32) };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.diagnostic('notification_state_unavailable');
        try {
          if (fs.statSync(file).size > 32768) throw new Error('State exceeds budget');
          fs.copyFileSync(file, `${file}.invalid`, fs.constants.COPYFILE_EXCL);
        } catch { this.canPersist = false; }
      }
    }
  }
  diagnostic(result: string) { this.state.lastError = result; if (!this.diagnosed) { this.diagnosed = true; console.warn(`Desktop notifications: ${result}; inspect status/progress for attention.`); } }
  save() { if (this.canPersist) { try { atomicJson(this.file, this.state); } catch { this.diagnostic('notification_state_write_failed'); } } }
  enqueue(event: any) {
    if (this.closed || this.options.notify === 'off') return;
    if (event.type === 'runner.unblocked') {
      this.state.fingerprints = this.state.fingerprints.filter(key => !/^runner\.(blocked|needs_attention):/.test(key));
      this.save();
      this.queue = this.queue.filter(pending => !['runner.blocked', 'runner.needs_attention'].includes(pending.type));
    }
    if (!(event.attention && this.options.notify === 'attention') && !this.options.notifyOn?.includes(event.type)) return;
    const key = `${event.type}:` + createHash('sha256').update(JSON.stringify([event.type, event.attentionFingerprint || event.items || null, event.resetAt || null, event.deadline || null, event.type === 'runner.turn_limit_reached' ? event.iteration : null])).digest('hex');
    if (this.state.fingerprints.includes(key)) return;
    if (this.queue.length >= 16) { this.record(event.id, 'queue_full'); return; }
    this.state.fingerprints = [...this.state.fingerprints, key].slice(-128); this.save();
    const pending = this.queue.findIndex(item => ['runner.blocked', 'runner.needs_attention'].includes(event.type) && item.type === event.type);
    if (pending >= 0) { this.queue[pending] = event; return; }
    this.queue.push(event); void this.drain();
  }
  record(id: string, result: string) {
    this.state.deliveries = [...this.state.deliveries, { id, result, at: new Date().toISOString() }].slice(-32);
    this.save();
    if (result !== 'submitted') this.diagnostic(result);
  }
  async drain() {
    if (this.draining) return; this.draining = true;
    try { while (this.queue.length && !this.closed) {
      const event = this.queue.shift(); let result;
      try { result = await this.deliver(event); } catch { result = 'delivery_failed'; }
      this.record(event.id, result);
    } }
    finally { this.draining = false; }
  }
  async deliver(event: any): Promise<string> {
    const platform = this.transport.platform || process.platform; const env = this.transport.env || process.env;
    const title = 'Roadmap Runner needs attention';
    const tasks = (event.items || []).filter(item => item.requiresAttention !== false).map(item => item.task).slice(0, 5).join(', ');
    const message = sanitize(`${path.basename(event.roadmap).slice(0, 80)}${tasks ? `: ${tasks.slice(0, 200)}` : ''}. Inspect status or progress.`);
    let command: string, args: string[];
    if (platform === 'darwin') {
      // AppleScript notifications launch Script Editor when clicked. Use the
      // dedicated sender without any activate/open/execute action instead.
      command = 'terminal-notifier'; args = ['-title', title, '-message', message, '-group', 'roadmap-runner'];
    }
    else if (platform === 'linux' && (env.DISPLAY || env.WAYLAND_DISPLAY) && env.DBUS_SESSION_BUS_ADDRESS) { command = 'notify-send'; args = [title, message]; }
    else return 'backend_unavailable';
    return new Promise(resolve => {
      const child = (this.transport.spawn || spawn)(command, args, { stdio: 'ignore', env }); this.active = child;
      let result = 'submitted'; let settled = false;
      const timer = setTimeout(() => { result = 'delivery_timeout'; child.kill('SIGKILL'); }, this.transport.timeoutMs || 3000);
      const finish = (outcome: string) => { if (settled) return; settled = true; clearTimeout(timer); this.active = null; resolve(outcome); };
      child.once('error', error => finish(error.code === 'ENOENT' ? 'backend_unavailable' : 'delivery_failed'));
      child.once('close', code => finish(result !== 'submitted' ? result : code === 0 ? 'submitted' : 'delivery_failed'));
    });
  }
  async flush() {
    const deadline = Date.now() + 6000;
    while ((this.draining || this.queue.length) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  }
  async close() {
    this.closed = true; this.queue = [];
    if (!this.active) return;
    const child = this.active;
    await new Promise<void>(resolve => { child.once('close', resolve); child.kill('SIGKILL'); });
  }
}
