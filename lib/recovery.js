import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { waitForRetry } from "./wait.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

// Convert an explicitly zoned provider reset clock without relying on the host zone.
export function resetFromText(text, now = Date.now()) {
  const iso = text.match(/(?:resets? (?:at )?|try again (?:at |after ))(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))/i);
  if (iso) return Date.parse(iso[1]) || null;
  const match = text.match(/resets?\s+(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([^)]+)\)/i);
  if (!match) return null;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: match[6], year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
    });
    const parts = (time) => Object.fromEntries(formatter.formatToParts(time).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
    const local = parts(now);
    let hour = Number(match[3]);
    const minute = Number(match[4] || 0);
    if (minute > 59 || hour > (match[5] ? 12 : 23) || (match[5] && hour < 1)) return null;
    if (match[5]) hour = hour % 12 + (match[5].toLowerCase() === "pm" ? 12 : 0);
    const month = match[1] ? "jan feb mar apr may jun jul aug sep oct nov dec".split(" ").indexOf(match[1].toLowerCase()) + 1 : local.month;
    const day = match[2] ? Number(match[2]) : local.day;
    if (day < 1 || day > 31) return null;
    let wall = Date.UTC(local.year, month - 1, day, hour, minute);
    const convert = (value) => {
      let guess = value;
      for (let i = 0; i < 4; i += 1) {
        const p = parts(guess);
        const correction = value - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
        if (!correction) return guess;
        guess += correction;
      }
      return null; // Ambiguous/nonexistent local clock: use the bounded fallback.
    };
    let target = convert(wall);
    if (target !== null && target <= now) {
      wall = match[1] ? Date.UTC(local.year + 1, month - 1, day, hour, minute) : wall + DAY;
      target = convert(wall);
    }
    return target;
  } catch { return null; }
}

export function usageLimitFromMessage(message, now = Date.now()) {
  if (!/(?:you(?:'|’)ve hit your limit|usage[_ ]limit[_ ](?:reached|exceeded)|weekly (?:usage )?limit|(?:5|five)[ -]hour (?:usage )?limit|rate_limit_exceeded)/i.test(message)) return null;
  return { kind: /weekly|seven.day|7.day/i.test(message) ? "weekly" : "session", resetAt: resetFromText(message, now) };
}

export function usageObserver(now = () => Date.now()) {
  let limit = null;
  let failed = false;
  let buffer = "";
  const merge = (next) => {
    if (!next) return;
    limit = { kind: next.kind === "weekly" || limit?.kind === "weekly" ? "weekly" : "session", resetAt: Math.max(limit?.resetAt || 0, next.resetAt || 0) || null };
  };
  const line = (text) => {
    try {
      const event = JSON.parse(text);
      if (event.type === "rate_limit_event" && event.rate_limit_info?.status === "rejected") {
        const info = event.rate_limit_info;
        const reset = Number(info.resetsAt);
        merge({ kind: /seven|weekly|7.day/i.test(info.rateLimitType || "") ? "weekly" : "session", resetAt: Number.isFinite(reset) && reset > 0 && reset * 1000 <= 8.64e15 ? reset * 1000 : null });
      }
      if (event.type === "result" && event.is_error) failed = true;
      const isError = ["error", "turn.failed"].includes(event.type) || event.is_error || event.isApiErrorMessage || event.error === "rate_limit";
      if (!isError) return;
      const texts = [event.message, event.result, ...(Array.isArray(event.errors) ? event.errors : []), ...(event.message?.content || []).filter(b => b.type === "text").map(b => b.text), event.error?.message, event.error?.code, event.error?.type, event.code];
      const message = texts.filter(t => typeof t === "string").join("\n");
            const parsed = usageLimitFromMessage(message, now());
      const rawReset = event.error?.resetsAt ?? event.error?.reset_at ?? event.resetsAt;
      if (parsed && rawReset !== undefined) {
        const reset = typeof rawReset === "number" ? rawReset * 1000 : Date.parse(rawReset);
        if (Number.isFinite(reset) && reset > 0 && reset <= 8.64e15) parsed.resetAt = reset;
      }
      merge(parsed);
      if (event.error === "rate_limit" && !limit) merge({ kind: "session", resetAt: resetFromText(message, now()) });
    } catch { /* Plain text is considered only on a failing CLI exit. */ }
  };
  return {
    write(chunk) {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        line(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
      if (buffer.length > 65536) buffer = buffer.slice(-65536);
    },
    result() { if (buffer) line(buffer); return { limit, failed }; },
  };
}

export function recoverySettings(env = process.env) {
  const seconds = (key, fallback, maximum) => {
    const value = env[key] ?? String(fallback);
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum) throw new Error(`${key} must be between 1 and ${maximum} seconds`);
    return Number(value) * 1000;
  };
  const delayMs = seconds("ROADMAP_RECOVERY_DELAY", 60, 3600);
  const maxDelayMs = seconds("ROADMAP_RECOVERY_MAX_DELAY", 900, 3600);
  if (maxDelayMs < delayMs) throw new Error("recovery maximum delay must be >= initial delay");
  const maxIdleWorkers = env.ROADMAP_MAX_IDLE_WORKERS ?? "3";
  if (!/^\d+$/.test(String(maxIdleWorkers)) || Number(maxIdleWorkers) < 1 || Number(maxIdleWorkers) > 100) {
    throw new Error("ROADMAP_MAX_IDLE_WORKERS must be between 1 and 100 workers");
  }
  return {
    delayMs, maxDelayMs, maxIdleWorkers: Number(maxIdleWorkers),
    quotaWaitMs: seconds("ROADMAP_USAGE_MAX_WAIT", 86400, 86400),
    hook: env.ROADMAP_NOTIFY_BIN || "",
  };
}

const hash = text => createHash("sha256").update(text).digest("hex");

// Only closed acceptance units count as progress in a checklist. Handoff prose,
// new unchecked tasks and rewritten blocker reasons must not renew the budget.
export function checklistProgress(contents) {
  const checked = new Set();
  const ids = new Set();
  let total = 0;
  let fence = null;
  for (const line of contents.split(/\r?\n/)) {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[\\t ]*$`).test(line)) fence = null;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) { fence = opening[1]; continue; }
    const task = /^\s*[-*+] \[([ xX])\]\s+(.+?)\s*$/.exec(line);
    if (!task) continue;
    total += 1;
    const label = task[2].replace(/\*\*|`/g, "").trim();
    const id = /^([A-Za-z]+[\w.-]*\d[\w.-]*|[A-Za-z]+)(?=\s|[:—–]|$)/.exec(label);
    // Prefer stable IDs when present; otherwise retain the full task label.
    const key = id && (/\d/.test(id[1]) || /^[A-Z]+$/.test(id[1])) ? id[1] : label;
    ids.add(key);
    if (task[1].toLowerCase() === 'x') checked.add(key);
  }
  return { checked, total, ids };
}

export class Recovery {
  constructor({ tracking, roadmap, settings, now = () => Date.now(), wait = waitForRetry, signal, onEvent, runId = randomUUID() }) {
    this.tracking = tracking;
    this.roadmap = roadmap;
    this.settings = settings;
    this.now = now;
    this.wait = wait;
    this.signal = signal;
    this.onEvent = onEvent;
    this.runId = runId;
    this.sequence = 0;
    this.stateFile = `${tracking.file}.recovery.json`;
    this.eventsFile = `${tracking.file}.events.jsonl`;
    this.state = { version: 1, roadmap, quota: null, attention: null, idle: 0, requiresWorker: false };
    try {
      if (fs.statSync(this.stateFile).size > 8192) throw new Error("recovery state too large");
      const state = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      if (state.version !== 1 || state.roadmap !== roadmap || !Number.isInteger(state.idle) || state.idle < 0 ||
          (state.completedCount !== undefined && (!Number.isInteger(state.completedCount) || state.completedCount < 0)) ||
          (state.quota && (!Number.isFinite(state.quota.deadline) || !Number.isFinite(state.quota.resumeAt)))) throw new Error("invalid recovery state");
      this.state = state;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }

  save() {
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(this.state) + "\n", { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, this.stateFile);
    } finally { fs.rmSync(temporary, { force: true }); }
  }

  async event(type, fields = {}) {
    if (fields.items?.length > 50) fields = { ...fields, items: fields.items.slice(0, 50), itemsTruncated: true };
    const attentionTypes = ["runner.blocked", "runner.needs_attention", "runner.stuck", "runner.failed", "runner.capacity_exhausted", "runner.usage_wait_expired"];
    const attention = attentionTypes.includes(type) && (type !== "runner.needs_attention" || fields.items?.some(item => item.status !== "SKIPPED" || item.requiresAttention));
    const event = { version: 1, id: randomUUID(), runId: this.runId, sequence: ++this.sequence, sourceRevision: this.tracking.sourceRevision,
      severity: attention ? "warning" : "info", attention: Boolean(attention), reasonCode: fields.reason || type.replace("runner.", ""),
      at: new Date(this.now()).toISOString(), type, roadmap: this.roadmap, progressFile: this.tracking.file, ...fields };
    fs.appendFileSync(this.eventsFile, JSON.stringify(event) + "\n", { mode: 0o600 });
    this.onEvent?.(event);
    if (this.signal?.aborted) return;
    if (!this.settings.hook) return;
    // The hook receives metadata only, with no shell interpolation or model output.
    const interrupted = await new Promise(resolve => {
      const child = spawn(this.settings.hook, [], { stdio: ["pipe", "ignore", "ignore"], detached: process.platform !== "win32", env: process.env });
      let timer;
      let didInterrupt = false;
      const stop = () => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 3000 });
          return;
        }
        try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      };
      const onInterrupt = () => { didInterrupt = true; stop(); };
      const finish = () => {
        clearTimeout(timer);
        process.removeListener("SIGINT", onInterrupt);
        process.removeListener("SIGTERM", onInterrupt);
        this.signal?.removeEventListener("abort", onInterrupt);
        resolve(didInterrupt);
      };
      child.on("error", error => { console.warn(`Notification hook failed: ${error.message}`); finish(); });
      child.on("close", code => { stop(); if (code) console.warn(`Notification hook exited ${code}; runner continues.`); finish(); });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(event) + "\n");
      timer = setTimeout(() => { console.warn("Notification hook timed out; runner continues."); stop(); }, 10_000);
      if (this.signal) this.signal.addEventListener("abort", onInterrupt, { once: true });
      else {
        process.once("SIGINT", onInterrupt);
        process.once("SIGTERM", onInterrupt);
      }
    });
    if (interrupted) throw Object.assign(new Error("notification interrupted"), { exitCode: 130 });
  }

  async attention(contents, status, iteration, terminal = false) {
    const items = [...contents.matchAll(/^\s*- (BLOCKED|SKIPPED|NEEDS_INFO|PROBLEM) ([A-Za-z0-9_.-]+):[^\r\n]*/gm)].map(m => ({ status: m[1], task: m[2], fingerprint: hash(m[0]), requiresAttention: m[1] !== "SKIPPED" || /\bblock(?:ed|er)?\b|needs?[_ ](?:input|info)|\bawait(?:ing)?\b|unavailable|credential|decision/i.test(m[0].split("|")[0]) }));
    const fingerprint = status === "blocked" || items.length ? hash(JSON.stringify({ status, items })) : null;
    if (fingerprint !== this.state.attention || terminal) {
      this.state.attention = fingerprint;
      this.save();
      if (fingerprint) await this.event(status === "blocked" ? "runner.blocked" : "runner.needs_attention", { iteration, ...(terminal ? { terminal: true, reason: "blocked" } : {}), attentionFingerprint: fingerprint, items: items.map(({ status, task, requiresAttention }) => ({ status, task, requiresAttention })) });
      else await this.event("runner.unblocked", { iteration });
    }
  }

  async pause(limit, role) {
    const now = this.now();
    const deadline = this.state.quota?.deadline ?? now + this.settings.quotaWaitMs;
    const resetAt = limit.resetAt > now ? limit.resetAt : now + (limit.kind === "weekly" ? DAY : 5 * HOUR);
    this.state.requiresWorker = true;
    this.state.quota = { kind: limit.kind, role, deadline, resumeAt: resetAt, resetAt };
    this.save(); // Restarting cannot renew the one-day budget.
    await this.event("runner.usage_paused", { role, kind: limit.kind, resetAt: new Date(resetAt).toISOString(), deadline: new Date(deadline).toISOString() });
    return this.restore();
  }

  async restore({ startup = false } = {}) {
    const quota = this.state.quota;
    if (!quota) return;
    if (startup && quota.expired && this.now() >= quota.resumeAt) {
      this.success();
      await this.event("runner.usage_resumed", { role: quota.role });
      return;
    }
    // Lowering the configured maximum also bounds an existing checkpoint.
    const deadline = Math.min(quota.deadline, this.now() + this.settings.quotaWaitMs);
    if (deadline !== quota.deadline) { quota.deadline = deadline; this.save(); }
    console.log(`Usage limit: preserving work; resume at ${new Date(quota.resumeAt).toISOString()} (deadline ${new Date(deadline).toISOString()}).`);
    const delay = Math.max(0, Math.min(quota.resumeAt, deadline) - this.now());
    if (delay && await this.wait(delay)) throw Object.assign(new Error("usage-limit wait interrupted; checkpoint preserved"), { exitCode: 130 });
    if (this.now() >= deadline || quota.resumeAt >= deadline) {
      this.state.quota.expired = true;
      this.save();
      await this.event("runner.usage_wait_expired", { role: quota.role, kind: quota.kind });
      throw Object.assign(new Error("usage-limit wait reached its one-day/configured bound; restart after the reset, partial work preserved"), { exitCode: 75 });
    }
    await this.event("runner.usage_resumed", { role: quota.role });
    // Keep the incident deadline until a successful non-quota session.
  }

  requireWorker() {
    this.state.requiresWorker = true;
    this.save();
  }

  success({ worker = false } = {}) {
    if (this.state.quota || (worker && this.state.requiresWorker)) {
      this.state.quota = null;
      if (worker) this.state.requiresWorker = false;
      this.save();
    }
  }

  async reportStuck(fields) {
    if (this.state.stuck === true) return;
    this.state.stuck = true;
    this.save();
    await this.event("runner.stuck", fields);
  }

  async stopNoProgress() {
    const limit = this.settings.maxIdleWorkers ?? 3;
    await this.event("runner.stuck", { reason: "no_progress_limit", terminal: true,
      unchangedWorkers: this.state.idle, maxIdleWorkers: limit });
    throw Object.assign(new Error(`No completed checklist progress for ${this.state.idle} workers; stopping. Resolve the blocker or revise the roadmap, then restart. Progress and evidence are preserved.`),
      { exitCode: 75, reason: "no_progress_limit" });
  }

  async idle(before, after, revisionChanged = false) {
    const wasStuck = this.state.stuck === true;
    const previous = checklistProgress(before);
    const current = checklistProgress(after);
    // Only an incoming controller amendment grants a new budget. Record the
    // post-worker revision too, so agent rewrites cannot grant another reset on
    // the next turn or restart. Checkbox/status changes do not change scope.
    const revision = this.tracking.requirementsRevision ?? this.tracking.sourceRevision;
    const revised = revisionChanged && (!revision || this.state.progressRevision !== revision);
    const baselineFile = `${this.tracking.file}.acceptance-baseline.json`;
    let baseline;
    if (!revised && fs.existsSync(baselineFile)) {
      if (fs.statSync(baselineFile).size > 256 * 1024) throw new Error('Acceptance baseline exceeds its bound');
      baseline = new Set(JSON.parse(fs.readFileSync(baselineFile, 'utf8')));
    } else {
      baseline = previous.ids;
      fs.writeFileSync(baselineFile, JSON.stringify([...baseline]) + '\n', { mode: 0o600 });
    }
    const count = set => [...set].filter(id => baseline.has(id)).length;
    this.state.progressRevision = revision;
    const completed = Math.max(count(previous.checked), this.state.completedCount ?? 0);
    const changed = revised || count(current.checked) > completed;
    // Reopening and rechecking the same number of tasks is no net progress.
    this.state.completedCount = revised ? count(current.checked) : Math.max(completed, count(current.checked));
    this.state.idle = changed ? 0 : this.state.idle + 1;
    this.state.stuck = !changed && (wasStuck || this.state.idle >= 2);
    this.save();
    const limit = this.settings.maxIdleWorkers ?? 3;
    if (this.state.idle >= limit) {
      await this.stopNoProgress();
    }
    if (!this.state.stuck) {
      if (wasStuck) await this.event("runner.progress_resumed");
      return;
    }
    if (!wasStuck) await this.event("runner.stuck", {
      unchangedWorkers: this.state.idle,
      attentionFingerprint: hash(JSON.stringify([before, this.tracking.sourceRevision || null])),
    });
    if (this.state.idle < 2) return;
    const delay = Math.min(this.settings.delayMs * 2 ** Math.min(this.state.idle - 2, 10), this.settings.maxDelayMs);
    console.warn(`No progress change for ${this.state.idle} workers; recovery recheck in ${delay / 1000}s.`);
    await this.event("runner.recovery_wait", { unchangedWorkers: this.state.idle, delayMs: delay });
    if (await this.wait(delay)) throw Object.assign(new Error("recovery wait interrupted"), { exitCode: 130 });
  }
}
