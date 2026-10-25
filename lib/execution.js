import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseRoadmapTasks, taskSnapshot, isProductivePartial, continuationSummary } from './task-index.js';
import { hasOpenRoadmapTasks } from './tracking.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const states = ['not_started', 'partial', 'implemented', 'blocked'];
const inside = (root, file) => {
  const resolved = fs.realpathSync(path.resolve(root, file));
  if (path.relative(root, resolved).split(path.sep).includes('..')) throw new Error('Execution input is outside the workspace');
  return resolved;
};

// The existing progress authority owns both the fixed baseline and a small
// current batch plan. It is not another roadmap or an automatically growing queue.
export class ExecutionPlan {
  constructor(file, workdir, tracking, { taskState = {}, skipTaskIds = [] } = {}) {
    this.root = fs.realpathSync(workdir);
    this.file = inside(this.root, file);
    this.stateFile = path.join(tracking.stateDir, 'execution-state.json');
    this.evidenceDir = tracking.evidenceDir;
    this.state = fs.existsSync(this.stateFile) ? JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) : { attempts: {}, completed: [] };
    this.savedState = fs.existsSync(this.stateFile) ? JSON.stringify(this.state) + '\n' : null;
    this.selectedContexts = new WeakMap();
    this.skippedTaskIds = new Set(skipTaskIds);
    this.read();
    for (const [taskId, outcome] of taskState instanceof Map ? taskState : Object.entries(taskState)) this.setContinuation(taskId, outcome);
  }
  read() {
    if (fs.statSync(this.file).size > 2 * 1024 * 1024) throw new Error('Execution authority exceeds 2 MiB');
    const text = fs.readFileSync(this.file, 'utf8');
    const blocks = [...text.matchAll(/^```roadmap-runner-execution\n([\s\S]*?)^```\s*$/gm)];
    if (blocks.length !== 1) throw new Error('Expected one roadmap-runner-execution block in the progress authority');
    const plan = JSON.parse(blocks[0][1]);
    if (plan.version !== 1 || !Array.isArray(plan.parents) || plan.parents.length !== plan.denominator ||
        new Set(plan.parents.map(p => p.id)).size !== plan.denominator || !Array.isArray(plan.batches) || plan.batches.length > 3) {
      throw new Error('Execution baseline must have a fixed denominator, unique original parents and at most three batches');
    }
    for (const parent of plan.parents) {
      if (!states.includes(parent.implementation) || !parent.roadmap || !Array.isArray(parent.operations) ||
          !Array.isArray(parent.missing) || !Array.isArray(parent.evidence)) throw new Error(`Invalid baseline parent ${parent.id}`);
    }
    if (!Array.isArray(plan.operations) || plan.operations.length !== plan.operationDenominator ||
        new Set(plan.operations.map(o => o.id)).size !== plan.operationDenominator ||
        plan.operations.some(o => !plan.parents.some(p => p.id === o.owner && p.operations.includes(o.id)))) {
      throw new Error('Operation baseline must retain unique IDs and their original owners');
    }
    const identity = hash(JSON.stringify(plan.parents.map(p => [p.id, p.roadmap, p.operations]).sort()));
    if (this.state.identity && this.state.identity !== identity) throw new Error('Frozen original task/operation baseline changed; explicit controller migration required');
    this.state.identity = identity;
    const ids = new Set();
    for (const batch of plan.batches) {
      if (ids.has(batch.id) || !plan.parents.some(p => p.id === batch.task && p.roadmap === batch.roadmap) ||
          !states.includes(batch.implementation) || ![30, 35, 40, 45].includes(batch.budgetMinutes) ||
          !batch.id || !batch.deliverable || !batch.boundary || !batch.completion || !batch.checkpoint || !Array.isArray(batch.prerequisites) ||
          !Array.isArray(batch.sourcePointers) || !batch.sourcePointers.length) {
        throw new Error(`Invalid finite batch ${batch.id}`);
      }
      ids.add(batch.id);
    }
    this.plan = plan;
    this.save();
    return plan;
  }
  save() {
    const serialized = JSON.stringify(this.state) + '\n';
    if (serialized === this.savedState) return;
    const temporary = this.stateFile + '.tmp';
    fs.writeFileSync(temporary, serialized, { mode: 0o600 });
    fs.renameSync(temporary, this.stateFile);
    this.savedState = serialized;
  }
  setContinuation(taskId, outcome) {
    if (!this.plan.parents.some(parent => parent.id === taskId)) return;
    const summary = continuationSummary(outcome);
    this.state.continuations = Object.assign(Object.create(null), this.state.continuations || {});
    if (JSON.stringify(this.state.continuations[taskId] ?? null) === JSON.stringify(summary)) return;
    if (summary) this.state.continuations[taskId] = summary;
    else delete this.state.continuations[taskId];
    this.save();
  }
  setSkippedTaskIds(ids) { this.skippedTaskIds = new Set(ids); }
  taskIndex(batch) {
    const source = inside(this.root, batch.roadmap);
    const text = fs.readFileSync(source, 'utf8');
    const index = parseRoadmapTasks(text, { parentIds: this.plan.parents.filter(parent => parent.roadmap === batch.roadmap).map(parent => parent.id) });
    const task = index.tasks.find(task => task.id === batch.task);
    if (!task) throw new Error(`Original task ${batch.task} is missing from its owner`);
    return { source, text, index, task };
  }
  get tasks() {
    return this.plan.parents.map(parent => ({ id: parent.id, task: parent.id, roadmap: parent.roadmap,
      sourcePointers: [], criteriaRevision: this.taskIndex({ task: parent.id, roadmap: parent.roadmap }).task.criteriaRevision }));
  }
  prerequisiteEvidenceMatches(batch) {
    return (batch.prerequisiteEvidence || []).every(item => {
      try { return hash(fs.readFileSync(inside(this.root, item.path))) === item.sha256; }
      catch { return false; }
    });
  }
  recoverablePartial(batch) {
    const checkpoint = this.state.checkpoints?.[batch.id];
    const continuation = this.state.continuations?.[batch.task];
    if (!checkpoint?.hasStructuredOutcome || continuation?.outcome !== 'partial' ||
        continuation.sessionId !== checkpoint.sessionId) return false;
    const revision = this.taskIndex(batch).task.criteriaRevision;
    return checkpoint.criteriaRevision === revision && continuation.criteriaRevision === revision;
  }
  select() {
    const plan = this.read();
    const ready = plan.batches.filter(b => !this.skippedTaskIds.has(b.task) && !this.skippedTaskIds.has(b.id) && b.implementation !== 'blocked' &&
      (b.implementation !== 'implemented' || (!this.state.completed.includes(b.id) &&
        ((this.state.attempts[b.id] || 0) > 0 || this.recoverablePartial(b)))) &&
      b.prerequisites.every(id => plan.batches.some(p => p.id === id && p.implementation === 'implemented') ||
        plan.parents.some(p => p.id === id && p.implementation === 'implemented')) &&
      this.prerequisiteEvidenceMatches(b));
    const selected = batch => {
      if (!batch) return null;
      const context = this.taskIndex(batch);
      const result = { ...batch, criteriaRevision: context.task.criteriaRevision };
      this.selectedContexts.set(result, { ...context, parent: this.plan.parents.find(parent => parent.id === batch.task) });
      return result;
    };
    const previous = ready.find(batch => batch.id === this.state.lastBatch);
    const continuation = previous && this.state.continuations?.[previous.task];
    if (previous && this.state.checkpoints?.[previous.id]?.hasStructuredOutcome !== false && isProductivePartial(continuation) && this.state.parentAttempts < 8 &&
        (!continuation.criteriaRevision || continuation.criteriaRevision === this.taskIndex(previous).task.criteriaRevision)) return selected(previous);
    // Rotate after a checkpoint when another ready outcome exists. No new task
    // or checkbox is created for discovery, commands or deferred qualification.
    if (this.state.parentAttempts >= 2) {
      const other = ready.find(b => b.task !== this.state.lastParent);
      if (other) return selected(other);
    }
    return selected(ready.find(b => b.id !== this.state.lastBatch) || ready[0]);
  }
  schedulingOutcome() {
    const task = this.select();
    if (task) return { status: 'ready', task };
    const sources = this.plan.parents.map(parent => this.taskIndex({ task: parent.id, roadmap: parent.roadmap }));
    if (sources.length && sources.every(source => source.task.complete && !hasOpenRoadmapTasks(source.text))) return { status: 'complete' };
    const pending = this.plan.batches.filter(batch => batch.implementation !== 'implemented');
    if (pending.length) return { status: 'blocked', reason: 'No current batch has satisfied prerequisites and an eligible retry.' };
    if (this.plan.parents.every(parent => parent.implementation === 'implemented')) return { status: 'awaiting_verification', reason: 'Implementation is delivered; original acceptance remains open.' };
    return { status: 'needs_next_batch', reason: 'Current batches are exhausted; unfinished original work needs its next bounded batch.' };
  }
  context(batch) {
    this.state.sourceBaseline ??= {};
    // Retain the first attempt's hashes across checkpoint/restart recovery, so
    // unfinished implementation can close without being written a second time.
    if (!this.state.sourceBaseline[batch.id]) {
      this.state.sourceBaseline[batch.id] = Object.fromEntries(batch.sourcePointers.map(file =>
        [file, hash(fs.readFileSync(inside(this.root, file)))]));
      this.save();
    }
    const { source, index, task, parent } = this.selectedContexts.get(batch) || this.taskIndex(batch);
    const criteria = taskSnapshot(index, task);
    if (Buffer.byteLength(criteria) > 24 * 1024) throw new Error('Selected acceptance block exceeds 24 KiB; controller must bound its existing owner');
    const snapshot = path.join(this.evidenceDir, `task-${batch.task}-${hash(criteria).slice(0, 12)}.md`);
    if (!fs.existsSync(snapshot)) fs.writeFileSync(snapshot, criteria, { mode: 0o600, flag: 'wx' });
    const contract = JSON.stringify({ ...batch, parent: parent || this.plan.parents.find(p => p.id === batch.task),
      previousAttempt: this.state.checkpoints?.[batch.id] ?? null });
    if (Buffer.byteLength(contract) > 32 * 1024) throw new Error('Selected batch summary exceeds 32 KiB');
    return `Finite execution authority: ${JSON.stringify(this.file)}\nOwning roadmap: ${JSON.stringify(source)}\n` +
      `Selected original task snapshot: ${JSON.stringify(snapshot)}\nNamed deliverable: ${batch.id}\n${contract}\n` +
      'Read only this task snapshot and targeted prerequisites. This finite batch replaces broad roadmap selection. ' +
      'Keep original acceptance unchecked where verification is deferred. Update this batch and its original parent missing-work/state in the existing authority; do not add baseline rows, tasks or checkboxes. ' +
      'Record implementationEvidence as [{path, sha256}] for hand-authored implementation files. Generator output, tests, status notes and decomposition alone are not delivery. ' +
      'If blocked, record the precise prerequisite under its existing owner and return. Preserve unchanged passing evidence and unfinished files.\n';
  }
  observe(batch) {
    // Content observations are review evidence, never a progress/stop score.
    return Object.fromEntries(batch.sourcePointers.map(file =>
      [file, hash(fs.readFileSync(inside(this.root, file)))]));
  }
  remember(batch, handoff, receipt) {
    this.state.checkpoints ??= {};
    this.state.checkpoints[batch.id] = { handoff, sessionId: receipt.sessionId,
      timedOut: receipt.timedOut, interrupted: receipt.interrupted, criteriaRevision: batch.criteriaRevision,
      ...(Object.hasOwn(receipt, 'taskResultFile') ? { hasStructuredOutcome: Boolean(receipt.taskResultFile) } : {}) };
    this.save();
  }
  finish(batch, result) {
    if (result.usageLimit || result.retryableCapacity) {
      this.read();
      if (this.recoverablePartial(batch) && isProductivePartial(this.state.continuations[batch.task])) {
        this.state.parentAttempts = this.state.lastParent === batch.task ? (this.state.parentAttempts || 0) : 0;
        this.state.lastParent = batch.task; this.state.lastBatch = batch.id;
        this.save();
      }
      return { delivered: false, attempts: this.state.attempts[batch.id] || 0, reviewRequired: false };
    }
    this.read();
    const current = this.plan.batches.find(b => b.id === batch.id);
    let delivered = false;
    if (current?.implementation === 'implemented' && !this.state.completed.includes(batch.id) && !result.timedOut && !result.interrupted && result.code === 0) {
      const evidence = current.implementationEvidence;
      if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > 20) throw new Error('Batch delivery requires targeted implementation source evidence');
      for (const item of evidence) {
        if (/(?:^|\/)(?:generated|dist|evidence|test|tests)(?:\/|$)|(?:\.test\.|_test\.)/.test(item.path) ||
            (/\.(?:md|json|log)$/.test(item.path) && current.kind !== 'documentation' &&
              !(current.kind === 'configuration' && item.path.endsWith('.json') && current.sourcePointers.includes(item.path)))) throw new Error('Status/generator/test churn is not implementation delivery');
        if (hash(fs.readFileSync(inside(this.root, item.path))) !== item.sha256) throw new Error('Implementation source evidence does not match current files');
      }
      const baseline = this.state.sourceBaseline[batch.id];
      if (!evidence.some(item => Object.hasOwn(baseline, item.path) && baseline[item.path] !== item.sha256)) {
        throw new Error('Unchanged source references are not a new implementation delivery');
      }
      delivered = true;
      this.state.completed = [...new Set([...this.state.completed, batch.id])];
    }
    this.state.lastBatch = batch.id;
    this.state.parentAttempts = this.state.lastParent === batch.task ? (this.state.parentAttempts || 0) + 1 : 1;
    this.state.lastParent = batch.task;
    this.state.attempts[batch.id] = delivered ? 0 : (this.state.attempts[batch.id] || 0) + 1;
    this.save();
    return { delivered, attempts: this.state.attempts[batch.id], reviewRequired: !delivered && this.state.attempts[batch.id] >= 2 && this.state.attempts[batch.id] % 2 === 0 };
  }
}
