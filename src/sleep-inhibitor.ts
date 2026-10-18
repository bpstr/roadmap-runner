import { spawn } from 'node:child_process';
import type { RunRecord } from './run-state.js';

type Status = NonNullable<RunRecord['sleepInhibition']>;

export class SleepInhibitor {
  status: Status = { state: 'off' };
  child: any;
  closed = false;
  closing = false;
  constructor(private enabled: boolean, private onStatus: (status: Status) => void = () => {}, private transport: any = {}) {}

  private update(status: Status) { this.status = status; this.onStatus(status); }
  private unavailable(reason: string, backend?: string) {
    this.update({ state: 'unavailable', backend, reason });
    console.warn(`Sleep prevention unavailable: ${reason}. Inspect sleepInhibition in run status.`);
  }

  async start() {
    if (!this.enabled) { this.update({ state: 'off' }); return; }
    const platform = this.transport.platform || process.platform;
    const pid = this.transport.pid || process.pid;
    let command: string, args: string[];
    if (platform === 'darwin') {
      command = '/usr/bin/caffeinate'; args = ['-i', '-w', String(pid)];
    } else if (platform === 'linux') {
      command = 'systemd-inhibit';
      // EOF releases the lock even when the runner crashes or is killed.
      args = ['--what=idle:sleep', '--mode=block', '--who=Roadmap Runner', '--why=Roadmap run in progress',
        process.execPath, '-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"];
    } else { this.unavailable('unsupported_platform'); return; }
    await new Promise<void>(resolve => {
      let spawned = false;
      try {
        const child = (this.transport.spawn || spawn)(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
        this.child = child;
        child.once('spawn', () => { spawned = true; this.update({ state: 'active', backend: command }); resolve(); });
        child.once('error', error => {
          if (!spawned) this.closed = true;
          this.unavailable(error.code === 'ENOENT' ? 'backend_unavailable' : spawned ? 'backend_failed' : 'launch_failed', command); resolve();
        });
        child.once('close', () => {
          this.closed = true;
          if (this.closing) this.update({ state: 'released', backend: command });
          else if (this.status.state !== 'unavailable') this.unavailable('backend_exited', command);
          resolve();
        });
      } catch { this.unavailable('launch_failed', command); resolve(); }
    });
  }

  async close() {
    if (!this.child || this.closed) return;
    this.closing = true;
    const child = this.child;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), this.transport.closeTimeoutMs || 1500);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.stdin?.end(); child.kill('SIGTERM');
    });
  }
}
