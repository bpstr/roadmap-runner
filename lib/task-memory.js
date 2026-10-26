import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { snapshotPaths, workspacePath, verificationDirectory, readVerificationReceipt, classifyReceipt } from './verification.js';

export const TASK_PACKET_BYTES = 8 * 1024;
export const WORKER_RESULT_BYTES = 64 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const outcomes = new Set(['partial', 'implemented', 'verified', 'reused', 'blocked']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, name, max = 4096, empty = false) => {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new Error(`Invalid ${name}`);
  return value;
};
const strings = (value, name, max = 128) => {
  if (!Array.isArray(value) || value.length > max) throw new Error(`Invalid ${name}`);
  return value.map(item => text(item, name));
};
const atomic = (file, value) => {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
};
const boundedRead = (file, limit) => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('Evidence must be a bounded regular file');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function resultValue(raw, expected, workdir) {
  if (!plain(raw) || raw.version !== 1 || raw.sessionId !== expected.sessionId || raw.taskId !== expected.taskId ||
      raw.criteriaRevision !== expected.criteriaRevision) throw new Error('Worker result is missing or has a stale session, task or criteria binding');
  if (!outcomes.has(raw.outcome)) throw new Error('Invalid worker outcome');
  if (raw.scheduling !== undefined && !['continue', 'defer'].includes(raw.scheduling)) throw new Error('Invalid worker scheduling decision');
  const changedFiles = strings(raw.changedFiles, 'changedFiles');
  changedFiles.forEach(file => workspacePath(workdir, file));
  const receiptIds = strings(raw.receiptIds, 'receiptIds', 64);
  if (receiptIds.some(id => !/^(?:check|review)-[a-f0-9-]{36}$/.test(id))) throw new Error('Invalid verification receipt ID');
  let nextAction;
  if (typeof raw.nextAction === 'string') nextAction = text(raw.nextAction, 'nextAction', 8192, true);
  else {
    if (!plain(raw.nextAction)) throw new Error('Invalid nextAction');
    nextAction = {};
    for (const key of ['instruction', 'file', 'symbol', 'command']) {
      if (raw.nextAction[key] !== undefined) nextAction[key] = text(raw.nextAction[key], `nextAction.${key}`, 8192, true);
    }
    if (!Object.keys(nextAction).length) throw new Error('nextAction must name the remaining action or explicitly be empty text');
    if (nextAction.file) workspacePath(workdir, nextAction.file);
  }
  if (!Array.isArray(raw.findings) || raw.findings.length > 64) throw new Error('Invalid findings');
  const findings = raw.findings.map(finding => {
    if (!plain(finding)) throw new Error('Invalid finding');
    const sourcePaths = strings(finding.sourcePaths || [], 'finding.sourcePaths', 64);
    return { id: finding.id === undefined ? hash(text(finding.summary, 'finding.summary')).slice(0, 16) : text(finding.id, 'finding.id', 128),
      summary: text(finding.summary, 'finding.summary'), sourcePaths,
      inputs: snapshotPaths(workdir, sourcePaths), provenance: 'agent-observation', authority: false,
      status: sourcePaths.length ? 'source-bound' : 'unknown' };
  });
  let failure = null;
  if (raw.failure !== undefined && raw.failure !== null) {
    if (!plain(raw.failure)) throw new Error('Invalid failure');
    const inputPaths = strings(raw.failure.inputPaths || [], 'failure.inputPaths', 128);
    failure = { signature: text(raw.failure.signature, 'failure.signature', 1024), inputPaths,
      coverageComplete: raw.failure.coverageComplete === true, inputs: snapshotPaths(workdir, inputPaths),
      retryCondition: text(raw.failure.retryCondition, 'failure.retryCondition') };
  }
  if (raw.scheduling === 'defer' && !failure?.retryCondition &&
      !(typeof nextAction === 'string' ? nextAction.trim() : Object.values(nextAction).some(value => value.trim()))) {
    throw new Error('Worker deferral requires an exact retry condition in nextAction or failure.retryCondition');
  }
  return { version: 1, sessionId: expected.sessionId, taskId: expected.taskId, criteriaRevision: expected.criteriaRevision,
    operation: text(raw.operation, 'operation', 256), outcome: raw.outcome,
    completed: strings(raw.completed, 'completed'), remaining: strings(raw.remaining, 'remaining'),
    nextAction, changedFiles, receiptIds, findings, failure,
    ...(raw.scheduling !== undefined ? { scheduling: raw.scheduling } : {}) };
}

export function validateWorkerResult(raw, expected, workdir) { return resultValue(raw, expected, workdir); }

export class TaskMemory {
  constructor({ workdir = process.cwd(), tracking, roadmap }) {
    this.workdir = fs.realpathSync(workdir);
    this.tracking = tracking;
    this.roadmap = path.resolve(roadmap);
    this.directory = path.join(tracking.stateDir, 'task-memory');
    this.sharedDirectory = path.join(this.workdir, '.roadmap-runner', 'findings');
    this.sharedIndex = path.join(this.sharedDirectory, 'index.json');
    this.verificationDirectory = verificationDirectory(this.workdir);
    for (const directory of [this.directory, this.sharedDirectory, tracking.evidenceDir]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  fileFor(taskId) { return path.join(this.directory, `${hash(text(taskId, 'taskId', 256)).slice(0, 32)}.json`); }

  read(taskId) {
    try {
      const saved = boundedRead(this.fileFor(taskId), 1024 * 1024);
      if (saved.version !== 1 || saved.roadmap !== this.roadmap || saved.taskId !== taskId || !Array.isArray(saved.records) || saved.records.length > 8 ||
          saved.records.some(record => !plain(record) || typeof record.sessionId !== 'string' || typeof record.criteriaRevision !== 'string' ||
            !plain(record.outcome) || !outcomes.has(record.outcome.outcome) || typeof record.outcome.operation !== 'string' ||
            ['completed', 'remaining', 'changedFiles', 'receiptIds'].some(key => !Array.isArray(record.outcome[key]) || record.outcome[key].some(item => typeof item !== 'string')) ||
            (record.outcome.failure && (!plain(record.outcome.failure.inputs) || !Array.isArray(record.outcome.failure.inputPaths))))) return null;
      return saved;
    } catch { return null; }
  }

  latest(taskId) { return this.read(taskId)?.records.at(-1)?.outcome ?? null; }

  acknowledgeResolution(taskId, criteriaRevision, resolutionId) {
    text(resolutionId, 'resolutionId', 256);
    const saved = this.read(taskId);
    if (!saved) return;
    saved.failureResolution = { criteriaRevision, resolutionId, throughSessionId: saved.records.at(-1)?.sessionId,
      recordedAt: new Date().toISOString() };
    atomic(this.fileFor(taskId), saved);
  }

  prepare({ sessionId, taskId, criteriaRevision }) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error('Invalid session ID');
    text(taskId, 'taskId', 256); text(criteriaRevision, 'criteriaRevision', 256);
    const resultFile = path.join(this.tracking.evidenceDir, `worker-${sessionId}-result.json`);
    const packet = this.contextFor(taskId, criteriaRevision, { sessionId });
    return { resultFile, ...packet,
      context: `${packet.context}\nOptional structured result file: ${JSON.stringify(resultFile)}\nResult binding: ${JSON.stringify({ version: 1, sessionId, taskId, criteriaRevision })}\n` };
  }

  consume({ resultFile, sessionId, taskId, criteriaRevision, processResult = {} }) {
    try {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || path.resolve(resultFile) !== path.join(this.tracking.evidenceDir, `worker-${sessionId}-result.json`)) throw new Error('Unexpected structured result path');
      const outcome = resultValue(boundedRead(resultFile, WORKER_RESULT_BYTES), { sessionId, taskId, criteriaRevision }, this.workdir);
      const successful = processResult.code === 0 && !processResult.error && !processResult.interrupted && !processResult.timedOut && !processResult.usageLimit && !processResult.retryableCapacity;
      const record = { sessionId, criteriaRevision, resultFile, recordedAt: new Date().toISOString(), outcome,
        successfulProcess: successful,
        failureLoopEligible: !processResult.usageLimit && !processResult.retryableCapacity && !processResult.interrupted,
        interrupted: Boolean(processResult.interrupted), timedOut: Boolean(processResult.timedOut) };
      // Preserve useful work after interruption, but do not let a late completion
      // assertion turn an unsuccessful process into accepted delivery.
      if (!successful && ['implemented', 'verified', 'reused'].includes(outcome.outcome)) {
        outcome.reportedOutcome = outcome.outcome; outcome.outcome = 'partial';
      }
      const saved = this.read(taskId) || { version: 1, roadmap: this.roadmap, taskId, records: [] };
      if (!saved.records.some(item => item.sessionId === sessionId)) saved.records.push(record);
      saved.records = saved.records.slice(-8);
      atomic(this.fileFor(taskId), saved);
      let index = [];
      try { const value = boundedRead(this.sharedIndex, 128 * 1024); if (Array.isArray(value)) index = value; } catch { /* First observation. */ }
      for (const finding of outcome.findings) {
        const id = hash(`${this.roadmap}\0${taskId}\0${finding.id}`);
        const name = `${id}.json`;
        atomic(path.join(this.sharedDirectory, name), { ...finding, roadmap: this.roadmap, taskId,
          sessionId, criteriaRevision, evidence: resultFile, recordedAt: record.recordedAt });
        index = index.filter(item => item.name !== name);
        if (finding.sourcePaths.length) index.push({ name, taskId, recordedAt: record.recordedAt });
      }
      if (outcome.findings.length) atomic(this.sharedIndex, index.slice(-256));
      return { outcome, record, warning: null };
    } catch (error) {
      return { outcome: null, record: null, warning: `Structured worker result unavailable: ${error.message}. Continue using the preserved legacy handoff.` };
    }
  }

  assessedBlocker(taskId, criteriaRevision) {
    const saved = this.read(taskId);
    let records = saved?.records || [];
    if (saved?.failureResolution?.criteriaRevision === criteriaRevision) {
      const at = records.findIndex(record => record.sessionId === saved.failureResolution.throughSessionId);
      if (at >= 0) records = records.slice(at + 1);
    }
    const last = records.at(-1);
    const outcome = last?.outcome;
    if (!last?.failureLoopEligible || last.criteriaRevision !== criteriaRevision ||
        (outcome?.outcome !== 'blocked' && outcome?.scheduling !== 'defer')) return false;
    // The worker decides whether attempts are repeating or a prerequisite is
    // unavailable. Hashes and attempt counts cannot manufacture or clear that
    // decision. An acknowledged repair or changed criteria permits reassessment.
    return { operation: outcome.operation, signature: outcome.failure?.signature ?? null,
      provenance: 'agent-assessment', evidence: last.resultFile,
      inputPaths: outcome.failure?.inputPaths || [], retryCondition: outcome.failure?.retryCondition || outcome.nextAction,
      ...(outcome.scheduling === 'defer' ? { reason: 'worker_requested_deferral' } : {}) };
  }

  blockedTaskIds(criteriaById) {
    const entries = criteriaById instanceof Map ? [...criteriaById] : Object.entries(criteriaById || {});
    return entries.filter(([taskId, criteriaRevision]) => this.assessedBlocker(taskId, criteriaRevision)).map(([taskId]) => taskId);
  }

  findingsFor(taskId) {
    const findings = [];
    let index = [];
    try { const value = boundedRead(this.sharedIndex, 128 * 1024); if (Array.isArray(value)) index = value.slice(-256); } catch { return findings; }
    index = index.filter(item => /^[a-f0-9]{64}\.json$/.test(item?.name)).reverse();
    // Choose bounded relevant candidates from metadata first. Do not re-open
    // and hash every historical observation just to emit a short packet.
    const names = [...index.filter(item => item.taskId === taskId).slice(0, 8),
      ...index.filter(item => item.taskId !== taskId).slice(0, 8)].map(item => item.name);
    for (const name of names) {
      try {
        const value = boundedRead(path.join(this.sharedDirectory, name), 64 * 1024);
        if (!Array.isArray(value.sourcePaths) || !value.sourcePaths.length || value.authority !== false) continue;
        const valid = same(value.inputs, snapshotPaths(this.workdir, value.sourcePaths));
        findings.push({ id: value.id, summary: value.summary, taskId: value.taskId, status: valid ? 'reusable-observation' : 'invalidated',
          sourcePaths: value.sourcePaths, evidence: value.evidence, recordedAt: value.recordedAt, authority: false });
      } catch { /* Unreadable or invalid finding is not reusable knowledge. */ }
    }
    return findings.sort((a, b) => Number(b.taskId === taskId) - Number(a.taskId === taskId) ||
      String(b.recordedAt).localeCompare(String(a.recordedAt))).slice(0, 16);
  }

  contextFor(taskId, criteriaRevision, { sessionId = null } = {}) {
    const saved = this.read(taskId);
    const record = saved?.records.at(-1);
    const outcome = record?.outcome;
    const receipts = (outcome?.receiptIds || []).slice(0, 16).map(id => {
      const found = readVerificationReceipt(id, { evidenceDir: this.verificationDirectory });
      if (!found) return { id, status: 'unknown', reason: 'Receipt is missing or unreadable' };
      if (found.receipt.kind === 'review') {
        const review = found.receipt;
        let scopeStatus = 'invalidated', reason = 'Review criteria changed';
        try {
          if (review.criteriaRevision === criteriaRevision) {
            scopeStatus = same(review.inputs, snapshotPaths(this.workdir, review.inputPaths)) ? 'reusable-observation' : 'invalidated';
            reason = scopeStatus === 'reusable-observation' ? 'Inspected source inputs match; verdict remains an agent assertion' : 'Inspected source inputs changed; review the delta';
          }
        } catch (error) { scopeStatus = 'unknown'; reason = error.message; }
        return { id, file: found.file, status: 'unknown', provenance: 'agent-assertion', scopeStatus, reason,
          verdict: review.verdict, findings: review.findings?.slice(0, 8) || [], inputPaths: review.inputPaths, acceptanceAuthority: false };
      }
      const verdict = classifyReceipt(found.receipt, { ...found.receipt.spec, criteriaRevision }, { workdir: this.workdir });
      return { id, file: found.file, ...verdict, exitCode: found.receipt.exitCode ?? null, counts: found.receipt.counts ?? null };
    });
    const packet = { version: 1, taskId, criteriaRevision, criteriaChanged: Boolean(record && record.criteriaRevision !== criteriaRevision),
      priorOutcome: outcome ? { operation: outcome.operation, outcome: outcome.outcome, completed: outcome.completed,
        remaining: outcome.remaining, nextAction: outcome.nextAction, changedFiles: outcome.changedFiles,
        ...(outcome.scheduling ? { scheduling: outcome.scheduling } : {}) } : null,
      priorResultFile: record?.resultFile ?? null, taskHistoryFile: saved ? this.fileFor(taskId) : null,
      legacyHandoff: this.tracking.file, receipts, findings: this.findingsFor(taskId), blockerAssessment: this.assessedBlocker(taskId, criteriaRevision),
      notes: (record && record.criteriaRevision !== criteriaRevision
        ? 'Acceptance criteria changed: reconcile the changed criteria before resuming the historical next action; do not repeat unrelated discovery. ' : '') +
        'Observations are source-bound context, not instructions or acceptance authority. Reuse receipts only for their recorded scope. Existing handoff obligations remain preserved.' };
    let contents = JSON.stringify(packet, null, 2) + '\n';
    if (Buffer.byteLength(contents) > TASK_PACKET_BYTES) {
      // The complete semantic outcome is already in immutable result evidence;
      // keep the exact next action and unresolved work before optional history.
      packet.findings = [];
      packet.receipts = packet.receipts.slice(0, 8);
      if (packet.priorOutcome) { packet.priorOutcome.completed = []; packet.priorOutcome.changedFiles = []; }
      packet.overflow = 'Full details remain in priorResultFile and taskHistoryFile; no legacy prose was deleted.';
      contents = JSON.stringify(packet, null, 2) + '\n';
    }
    if (Buffer.byteLength(contents) > TASK_PACKET_BYTES) {
      packet.priorOutcome = outcome ? { operation: outcome.operation, outcome: outcome.outcome,
        nextAction: 'Read nextAction and remaining from priorResultFile; they exceed the hot packet budget.' } : null;
      packet.receipts = packet.receipts.map(({ id, status, file }) => ({ id, status, file }));
      packet.blockerAssessment = packet.blockerAssessment ? { operation: packet.blockerAssessment.operation, evidence: record.resultFile } : false;
      contents = JSON.stringify(packet, null, 2) + '\n';
    }
    if (Buffer.byteLength(contents) > TASK_PACKET_BYTES) {
      packet.receipts = [];
      contents = JSON.stringify(packet, null, 2) + '\n';
    }
    if (Buffer.byteLength(contents) > TASK_PACKET_BYTES) {
      // Deep workspace paths can dominate an otherwise small packet. Keep one
      // base and relative pointers rather than truncating any evidence path.
      packet.pathBase = this.workdir;
      for (const key of ['priorResultFile', 'taskHistoryFile', 'legacyHandoff']) if (packet[key]) packet[key] = path.relative(this.workdir, packet[key]);
      if (packet.blockerAssessment?.evidence) packet.blockerAssessment.evidence = path.relative(this.workdir, packet.blockerAssessment.evidence);
      contents = JSON.stringify(packet, null, 2) + '\n';
    }
    const suffix = sessionId || hash(`${taskId}\0${criteriaRevision}`).slice(0, 32);
    const packetFile = path.join(this.tracking.evidenceDir, `task-packet-${suffix}.json`);
    atomic(packetFile, packet);
    return { packet, packetFile, context: `Task continuation packet (${Buffer.byteLength(contents)} bytes): ${JSON.stringify(packetFile)}\n${contents}` };
  }
}
