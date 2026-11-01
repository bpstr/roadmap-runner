import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseRoadmapTasks, taskSnapshot, isProductivePartial, continuationSummary, onlyDeferredTasks } from './task-index.js';
import { hasOpenRoadmapTasks } from './tracking.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const MAX_STATE_BYTES = 1024 * 1024;

// The Markdown remains the acceptance authority. This sidecar contains only
// dispatch/checkpoint memory; it neither invents tasks nor checks acceptance.
export class RoadmapPlan {
  constructor(file, workdir, tracking, { taskState = {}, skipTaskIds = [] } = {}) {
    this.root = fs.realpathSync(workdir);
    this.file = fs.realpathSync(path.resolve(this.root, file));
    this.stateFile = path.join(tracking.stateDir, 'task-plan.json');
    this.evidenceDir = tracking.evidenceDir;
    this.state = { version: 1, source: this.file, attempts: {}, checkpoints: {}, continuations: {} };
    this.savedState = null;
    this.selectedContexts = new WeakMap();
    try {
      if (fs.statSync(this.stateFile).size > MAX_STATE_BYTES) throw new Error('task cache exceeds 1 MiB');
      const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (saved.version !== 1 || saved.source !== this.file || !record(saved.attempts) ||
          !record(saved.checkpoints) || !record(saved.continuations)) throw new Error('invalid task cache or source binding');
      this.state = saved;
      this.savedState = JSON.stringify(saved) + '\n';
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const archive = `${this.stateFile}.invalid-${randomUUID()}`;
        try { fs.renameSync(this.stateFile, archive); }
        catch { this.persistenceDisabled = true; }
        console.warn(`Ignoring optional task continuation cache (${error.message}); previous data preserved at ${this.persistenceDisabled ? this.stateFile : archive}.`);
      }
    }
    for (const key of ['attempts', 'checkpoints', 'continuations']) this.state[key] = Object.assign(Object.create(null), this.state[key]);
    this.skippedTaskIds = new Set(skipTaskIds);
    this.read();
    for (const [taskId, outcome] of taskState instanceof Map ? taskState : Object.entries(taskState)) this.setContinuation(taskId, outcome);
  }
  read() {
    this.text = fs.readFileSync(this.file, 'utf8');
    this.index = parseRoadmapTasks(this.text);
    this.reliable = this.index.reliable;
    const reasons = [];
    if (this.index.format !== 'headings') reasons.push({ code: 'flat_format' });
    if (!this.index.tasks.length) reasons.push({ code: 'no_task_headings' });
    if (new Set(this.index.tasks.map(task => task.id)).size !== this.index.tasks.length) reasons.push({ code: 'duplicate_task_ids' });
    if (this.index.orphanCheckboxes.length) reasons.push({ code: 'orphan_checkboxes', count: this.index.orphanCheckboxes.length });
    if (this.index.cycle) reasons.push({ code: 'dependency_cycle' });
    if (this.index.unknownDependencies.length) reasons.push({ code: 'unknown_dependencies', count: this.index.unknownDependencies.length });
    for (const task of this.index.tasks) {
      if (task.checkboxes.filter(item => item.id === task.id).length !== 1) reasons.push({ code: 'ambiguous_parent_checkbox', task: task.id });
      if (!task.dependenciesExplicit) reasons.push({ code: 'ambiguous_dependencies', task: task.id });
      if (!/^Acceptance:[\t ]*\S/m.test(task.visibleSection)) reasons.push({ code: 'missing_acceptance', task: task.id });
      const bytes = Buffer.byteLength(taskSnapshot(this.index, task));
      if (bytes > 24 * 1024) reasons.push({ code: 'oversized_contract', task: task.id, bytes, limitBytes: 24 * 1024 });
    }
    this.tasks = this.index.tasks.map(task => ({ id: task.id, task: task.id, roadmap: this.file,
      criteriaRevision: task.criteriaRevision, sourcePointers: [], dependencies: task.dependencies,
      complete: task.complete }));
    // An unusually large selected/global contract should take the existing broad
    // prompt path rather than adding a new controller failure for old roadmaps.
    if (reasons.some(reason => reason.code === 'oversized_contract')) this.reliable = false;
    this.scheduling = { mode: this.reliable ? 'focused' : 'broad', reasons: reasons.slice(0, 20), reasonsTruncated: reasons.length > 20 };
    return this.tasks;
  }
  save() {
    if (this.persistenceDisabled) return;
    const serialized = JSON.stringify(this.state) + '\n';
    if (serialized === this.savedState) return;
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) {
      this.persistenceDisabled = true;
      console.warn('Optional task continuation cache reached 1 MiB; retaining prior cache and continuing with in-memory scheduling.');
      return;
    }
    const temporary = this.stateFile + '.tmp';
    try {
      fs.writeFileSync(temporary, serialized, { mode: 0o600 });
      fs.renameSync(temporary, this.stateFile);
      this.savedState = serialized;
    } catch (error) {
      this.persistenceDisabled = true;
      console.warn(`Optional task continuation cache could not be saved (${error.message}); continuing with in-memory scheduling.`);
    }
  }
  setContinuation(taskId, outcome) {
    if (!this.tasks.some(task => task.id === taskId)) return;
    const summary = continuationSummary(outcome);
    if (JSON.stringify(this.state.continuations[taskId] ?? null) === JSON.stringify(summary)) return;
    if (summary) this.state.continuations[taskId] = summary;
    else delete this.state.continuations[taskId];
    this.save();
  }
  setSkippedTaskIds(ids) { this.skippedTaskIds = new Set(ids); }
  continuation(task) {
    const outcome = this.state.continuations[task.task];
    return outcome && (!outcome.criteriaRevision || outcome.criteriaRevision === task.criteriaRevision) ? outcome : null;
  }
  select() {
    this.read();
    if (!this.reliable) return null;
    const byId = new Map(this.tasks.map(task => [task.id, task]));
    const ready = this.tasks.filter(task => !task.complete && !this.skippedTaskIds.has(task.id) &&
      task.dependencies.every(id => byId.get(id)?.complete)).map(task => ({ ...task,
        phase: ['implemented', 'verified', 'reused'].includes(this.continuation(task)?.outcome) ? 'verification' : 'implementation' }));
    const previous = ready.find(task => task.id === this.state.lastTask);
    const selected = previous && this.state.checkpoints[previous.task]?.hasStructuredOutcome !== false &&
      isProductivePartial(this.continuation(previous)) ? previous :
      ready.find(task => task.id !== this.state.lastTask) || ready[0] || null;
    if (selected) this.selectedContexts.set(selected, { index: this.index,
      task: this.index.tasks.find(task => task.id === selected.id) });
    return selected;
  }
  schedulingOutcome({ deferredTaskIds = [] } = {}) {
    const task = this.select();
    if (!this.reliable) return { status: 'needs_next_batch', fallback: true, reason: 'Roadmap structure requires legacy worker selection.' };
    if (task) return { status: 'ready', task };
    if (this.tasks.length && this.tasks.every(task => task.complete) && !hasOpenRoadmapTasks(this.text)) return { status: 'complete' };
    if (onlyDeferredTasks(this.tasks.filter(task => !task.complete), deferredTaskIds,
      this.tasks.filter(task => task.complete).map(task => task.id))) return { status: 'deferred' };
    return { status: 'blocked', reason: 'Open tasks have unmet prerequisites or unchanged blocked retries.' };
  }
  context(task) {
    // select/read captured this invocation's source. Do not replace its criteria
    // with a later edit while rendering the selected task packet.
    const captured = this.selectedContexts.get(task);
    const indexed = captured?.task || this.index.tasks.find(item => item.id === task.task && item.criteriaRevision === task.criteriaRevision);
    if (!indexed) throw new Error(`Selected task ${task.task} changed; select it again before dispatch`);
    const criteria = taskSnapshot(captured?.index || this.index, indexed);
    const snapshot = path.join(this.evidenceDir, `task-${task.task}-${hash(criteria).slice(0, 12)}.md`);
    if (!fs.existsSync(snapshot)) fs.writeFileSync(snapshot, criteria, { mode: 0o600, flag: 'wx' });
    const contract = { ...task, previousAttempt: this.state.checkpoints[task.task] ?? null };
    return `Selected roadmap task: ${task.task}\nOwning roadmap: ${JSON.stringify(this.file)}\n` +
      `Selected original task snapshot: ${JSON.stringify(snapshot)}\nTask criteria revision: ${task.criteriaRevision}\n` +
      `Selected task contract: ${JSON.stringify(contract)}\n` +
      'Read this task snapshot and its shared constraints, then only its named prerequisite evidence. ' +
      'The controller selected this task; do not rediscover or select unrelated roadmap work. ' +
      (task.phase === 'verification' ? 'Implementation is recorded; reconcile only its outstanding acceptance and compatible evidence. ' : '') +
      'Keep the live original acceptance unchecked until its requirements pass; record exact continuation and reusable evidence.\n';
  }
  observe() { return {}; }
  remember(task, handoff, receipt) {
    this.state.checkpoints[task.task] = { handoff, sessionId: receipt.sessionId,
      timedOut: receipt.timedOut, interrupted: receipt.interrupted, criteriaRevision: task.criteriaRevision,
      ...(Object.hasOwn(receipt, 'taskResultFile') ? { hasStructuredOutcome: Boolean(receipt.taskResultFile) } : {}) };
    this.save();
  }
  finish(task, result) {
    if (result.usageLimit || result.retryableCapacity) {
      this.read();
      const current = this.tasks.find(item => item.id === task.task);
      const checkpoint = this.state.checkpoints[task.task];
      const continuation = current && this.continuation(current);
      if (checkpoint?.hasStructuredOutcome && checkpoint.criteriaRevision === current?.criteriaRevision &&
          continuation?.sessionId === checkpoint.sessionId && isProductivePartial(continuation)) {
        this.state.consecutiveAttempts = this.state.lastTask === task.task ? (this.state.consecutiveAttempts || 0) : 0;
        this.state.lastTask = task.task;
        this.save();
      }
      return { delivered: false, attempts: this.state.attempts[task.task] || 0, reviewRequired: false };
    }
    this.read();
    const current = this.tasks.find(item => item.id === task.task);
    const delivered = !task.complete && current?.complete && current.criteriaRevision === task.criteriaRevision &&
      result.code === 0 && !result.timedOut && !result.interrupted;
    this.state.consecutiveAttempts = this.state.lastTask === task.task ? (this.state.consecutiveAttempts || 0) + 1 : 1;
    this.state.lastTask = task.task;
    this.state.attempts[task.task] = delivered ? 0 : (this.state.attempts[task.task] || 0) + 1;
    this.save();
    return { delivered: Boolean(delivered), attempts: this.state.attempts[task.task], reviewRequired: false };
  }
}
