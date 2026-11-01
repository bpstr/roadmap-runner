import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseRoadmapTasks } from './task-index.js';
import { parseDuration } from './runner.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const atomic = (file, value) => {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
};
const read = file => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Progress state must be a regular file below 2 MiB');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const validState = s => s?.version === 1 && typeof s.id === 'string' && typeof s.roadmap === 'string' && Number.isFinite(Date.parse(s.createdAt)) &&
  ['activeMs', 'workerTurns', 'originalClosureActiveMs', 'reductionActiveMs', 'reductionTurn', 'handoffEpoch'].every(key => nonnegative(s[key])) &&
  s.originalClosureActiveMs <= s.activeMs && s.reductionActiveMs <= s.activeMs && s.reductionTurn <= s.workerTurns &&
  s.limits && s.limits.turn <= 100 && ['turn', 'reviewMs', 'activeMs'].every(key => nonnegative(s.limits[key]) && s.limits[key] > 0) &&
  s.contributions && typeof s.contributions === 'object' && !Array.isArray(s.contributions) && Object.values(s.contributions).every(nonnegative) &&
  Array.isArray(s.reviews) && Array.isArray(s.criteria) && new Set(s.criteria.map(item => item?.key)).size === s.criteria.length &&
  s.criteria.every(item => item && typeof item.key === 'string' && typeof item.requirement === 'string' &&
    ['original', 'addition'].includes(item.kind) && typeof item.checked === 'boolean' && typeof item.everClosed === 'boolean' && typeof item.approved === 'boolean') &&
  (!s.session || (nonnegative(s.session.started) && nonnegative(s.session.timeoutMs) && s.session.timeoutMs > 0)) &&
  (!s.pending || (typeof s.pending.id === 'string' && typeof s.pending.sourceRevision === 'string' && typeof s.pending.requestFile === 'string' &&
    s.pending.policy === 'park' && s.pending.acknowledged === false && ['active_time_budget', 'acceptance_plateau_turns', 'acceptance_plateau_time'].includes(s.pending.reason)));

export function progressSettings(options = {}) {
  if (!['park', 'continue'].includes(options.progressReviewPolicy ?? 'park')) throw new Error('progressReviewPolicy must be park or continue');
  const turns = Number(options.reviewTurns ?? 4);
  if (!Number.isSafeInteger(turns) || turns < 1 || turns > 100) throw new Error('reviewTurns must be an integer from 1 to 100');
  return { turns, reviewMs: parseDuration(options.reviewAfter ?? '3h'), activeMs: parseDuration(options.maxActiveTime ?? '12h') };
}

// Identity excludes checkbox state, surrounding prose, operation names and run IDs.
// Requirement edits/removals remain visible as scope changes, never as closures.
export function criterionSnapshot(text) {
  const counts = new Map();
  return parseRoadmapTasks(text).checkboxes.map(box => {
    const requirement = box.text.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '').trim().replace(/\s+/g, ' ');
    const base = hash(requirement);
    const ordinal = counts.get(base) || 0; counts.set(base, ordinal + 1);
    return { key: `${base}-${ordinal}`, id: box.id, requirement, checked: box.checked };
  });
}

export class ProgressLedger {
  constructor({ roadmap, tracking, options = {}, now = () => Date.now() }) {
    this.roadmap = path.resolve(roadmap); this.tracking = tracking; this.now = now;
    this.file = path.join(tracking.stateDir, 'progress-ledger.json');
    fs.mkdirSync(tracking.stateDir, { recursive: true });
    const settings = progressSettings(options);
    this.reviewSettings = settings;
    try {
      this.state = read(this.file);
      const s = this.state;
      if (!validState(s) || s.roadmap !== this.roadmap) throw new Error('Invalid progress ledger or source binding');
      if (s.pending && path.dirname(path.resolve(s.pending.requestFile)) !== path.resolve(tracking.evidenceDir)) throw new Error('Invalid progress review evidence binding');
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot safely resume progress accounting: ${error.message}. Preserve and inspect ${this.file}`);
      this.state = { version: 1, id: randomUUID(), roadmap: this.roadmap, createdAt: this.at(), activeMs: 0, workerTurns: 0,
        originalClosureActiveMs: 0, lastOriginalClosureAt: null, reductionActiveMs: 0, reductionTurn: 0,
        limits: { turn: settings.turns, reviewMs: settings.reviewMs, activeMs: settings.activeMs },
        criteria: [], reviews: [], contributions: {}, handoffEpoch: options.sessionContinuation === false ? 1 : 0 };
    }
    // Settings are established once. New sessions/options cannot replenish a budget.
    if (this.state.session) {
      this.state.activeMs += Math.max(0, Math.min(this.now() - this.state.session.started, this.state.session.timeoutMs));
      this.state.interruptedAccounting = 'Unfinished session charged conservatively up to its recorded timeout.';
      delete this.state.session;
    }
    this.state.reviewPolicy = options.progressReviewPolicy ?? 'park';
    this.initialObservation = this.observe(); this.save();
  }
  at() { return new Date(this.now()).toISOString(); }
  save() {
    if (Buffer.byteLength(JSON.stringify(this.state)) > 2 * 1024 * 1024) throw new Error('Progress ledger reached 2 MiB; review required before further work');
    atomic(this.file, this.state);
  }
  observe() {
    const text = fs.readFileSync(this.roadmap, 'utf8');
    const first = !this.state.sourceRevision;
    this.state.sourceRevision = hash(text);
    const current = criterionSnapshot(text);
    const byKey = new Map(this.state.criteria.map(item => [item.key, item]));
    const present = new Set(current.map(item => item.key));
    let closures = 0, additions = 0, originalClosures = 0;
    for (const box of current) {
      let entry = byKey.get(box.key);
      if (!entry) {
        entry = { ...box, kind: first ? 'original' : 'addition', firstSeenAt: this.at(), everClosed: box.checked, approved: false };
        this.state.criteria.push(entry);
        if (!first) additions++;
      } else if (!entry.everClosed && box.checked) {
        entry.everClosed = true; entry.closedAt = this.at();
        if (entry.kind === 'original' || entry.approved) closures++;
        if (entry.kind === 'original') originalClosures++;
      }
      entry.checked = box.checked; entry.missing = false;
    }
    for (const entry of this.state.criteria) if (!present.has(entry.key)) { entry.missing = true; entry.checked = false; }
    if (closures) { this.state.reductionActiveMs = this.state.activeMs; this.state.reductionTurn = this.state.workerTurns; }
    if (originalClosures) { this.state.originalClosureActiveMs = this.state.activeMs; this.state.lastOriginalClosureAt = this.at(); }
    this.save();
    return { closures, originalClosures, additions };
  }
  syncHandoff() {
    const revision = this.handoffRevision();
    const changed = Boolean(this.state.handoffRevision && revision !== this.state.handoffRevision);
    if (changed) this.state.handoffEpoch++;
    this.state.handoffRevision = revision; this.save();
    return changed;
  }
  handoffRevision() { return hash(fs.readFileSync(this.tracking.file, 'utf8').replace(/^Status:[^\r\n]*$/gim, 'Status: <controller-state>')); }
  rememberHandoff() { this.state.handoffRevision = this.handoffRevision(); this.save(); }
  beginSession(role, timeoutMs) {
    if (role === 'worker') this.state.workerTurns++;
    this.state.session = { role, started: this.now(), timeoutMs }; this.save();
  }
  finishSession(elapsedMs, outcome) {
    this.state.activeMs += Math.max(0, elapsedMs); delete this.state.session;
    if (outcome) this.state.contributions[outcome] = (this.state.contributions[outcome] || 0) + 1;
    this.save();
  }
  reason() {
    const s = this.state;
    if (s.pending) return s.pending.reason;
    if (s.activeMs >= s.limits.activeMs) return 'active_time_budget';
    if (s.workerTurns - s.reductionTurn >= s.limits.turn) return 'acceptance_plateau_turns';
    if (s.activeMs - s.reductionActiveMs >= s.limits.reviewMs) return 'acceptance_plateau_time';
    return null;
  }
  remainingMs() {
    return Math.max(1, Math.min(this.state.limits.activeMs - this.state.activeMs,
      this.state.limits.reviewMs - (this.state.activeMs - this.state.reductionActiveMs)));
  }
  summary() {
    const s = this.state;
    const count = kind => {
      const entries = s.criteria.filter(item => item.kind === kind);
      return { total: entries.length, remaining: entries.filter(item => !item.checked).length,
        missing: entries.filter(item => item.missing).length, closed: entries.filter(item => item.checked).length };
    };
    return { ledgerFile: this.file, ledgerId: s.id, sourceRevision: s.sourceRevision, scheduling: s.scheduling,
      original: count('original'), additions: count('addition'), approvedSubgaps: s.criteria.filter(item => item.approved && !item.checked).length,
      contributions: s.contributions, activeMs: s.activeMs, workerTurns: s.workerTurns,
      turnsSinceReduction: s.workerTurns - s.reductionTurn, activeMsSinceReduction: s.activeMs - s.reductionActiveMs,
      activeMsSinceOriginalClosure: s.activeMs - s.originalClosureActiveMs, lastOriginalClosureAt: s.lastOriginalClosureAt,
      closureAgeMs: this.now() - Date.parse(s.lastOriginalClosureAt || s.createdAt), limits: s.limits,
      reviewPolicy: s.reviewPolicy ?? 'park',
      pendingReview: s.pending || null, supervision: { scheduledReviews: false, delivery: 'durable journal and status; desktop submission is not acknowledgment',
        acknowledgment: s.pending ? 'required' : 'no pending review' }, authority: 'source checkbox observations; contributions and receipts do not prove acceptance correctness' };
  }
  requestReview(reason) {
    fs.mkdirSync(this.tracking.evidenceDir, { recursive: true });
    if (!this.state.pending || this.state.pending.sourceRevision !== this.state.sourceRevision) {
      this.state.pending = { id: randomUUID(), reason, at: this.at(), sourceRevision: this.state.sourceRevision,
        acknowledged: false, policy: 'park', requestFile: path.join(this.tracking.evidenceDir, `progress-review-${randomUUID()}.json`) };
    }
    this.save();
    atomic(this.state.pending.requestFile, { ...this.summary(), criteria: this.state.criteria });
    return this.state.pending;
  }
  applyReview(file) {
    const decision = read(file), pending = this.state.pending;
    if (this.state.reviews.some(item => item.id === decision.reviewId)) return false;
    if (!pending || pending.sourceRevision !== this.state.sourceRevision || decision.version !== 1 || decision.reviewId !== pending.id || decision.sourceRevision !== this.state.sourceRevision ||
        typeof decision.reason !== 'string' || !decision.reason.trim() || decision.reason.length > 4096 ||
        decision.decision !== 'extend' || !Array.isArray(decision.gapKeys) || decision.gapKeys.length > 1000) throw new Error('Progress review must acknowledge the current request and source revision with a reason and finite gapKeys');
    const turns = Number(decision.additionalTurns), ms = parseDuration(decision.additionalActiveTime);
    if (!Number.isSafeInteger(turns) || turns < 1 || turns > 100 || ms > 12 * 60 * 60 * 1000) throw new Error('Review extension must be 1–100 turns and at most 12h');
    const keys = new Set(decision.gapKeys);
    if (keys.size !== decision.gapKeys.length || [...keys].some(key => !this.state.criteria.some(item => item.key === key && !item.missing && !item.checked))) throw new Error('Review gapKeys must identify current unresolved criteria/subgaps');
    for (const entry of this.state.criteria) if (entry.kind === 'addition') entry.approved = keys.has(entry.key);
    this.state.reviews.push({ ...decision, id: pending.id, acknowledgedAt: this.at(), activeMs: this.state.activeMs, workerTurns: this.state.workerTurns });
    this.state.limits = { turn: turns, reviewMs: ms, activeMs: this.state.activeMs + ms };
    this.state.reductionActiveMs = this.state.activeMs; this.state.reductionTurn = this.state.workerTurns;
    delete this.state.pending; this.save();
    return true;
  }
  continueReview() {
    if (this.state.reviewPolicy !== 'continue') throw new Error('Continuing progress reviews requires the explicit continue policy');
    const reason = this.reason();
    if (!reason) return null;
    const request = this.requestReview(reason);
    const file = path.join(this.tracking.evidenceDir, `progress-continue-${request.id}.json`);
    atomic(file, { version: 1, reviewId: request.id, sourceRevision: this.state.sourceRevision, decision: 'extend',
      reason: 'Operator selected continue policy: renew the execution window without asserting acceptance or approving new subgaps.',
      gapKeys: this.state.criteria.filter(item => item.kind === 'original' && !item.checked && !item.missing).map(item => item.key),
      additionalTurns: this.reviewSettings.turns,
      additionalActiveTime: `${Math.min(this.reviewSettings.reviewMs, 12 * 60 * 60 * 1000)}ms` });
    this.applyReview(file);
    return { request, decisionFile: file };
  }
}

// Status must not instantiate a controller or modify accounting. During a live
// session its elapsed time is a bounded observation, not a final process receipt.
export function readProgressStatus(file, now = Date.now()) {
  const ledger = Object.create(ProgressLedger.prototype);
  ledger.file = file; ledger.state = read(file); ledger.now = () => now;
  if (!validState(ledger.state)) throw new Error('Invalid progress ledger');
  if (ledger.state.session) ledger.state.activeMs += Math.max(0, Math.min(now - ledger.state.session.started, ledger.state.session.timeoutMs));
  return ledger.summary();
}

export function runtimeIdentity(root) {
  const files = ['package.json', 'bin/roadmap-runner.js', 'prompt.md', 'resolver.md', 'compact.md',
    ...['dist', 'lib'].flatMap(dir => fs.readdirSync(path.join(root, dir)).filter(file => file.endsWith('.js')).sort().map(file => `${dir}/${file}`))];
  const manifest = files.map(file => ({ file, sha256: hash(fs.readFileSync(path.join(root, file))) }));
  return { root, bundleHash: hash(JSON.stringify(manifest)), manifest };
}
