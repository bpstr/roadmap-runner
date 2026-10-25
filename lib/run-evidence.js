import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const OUTPUT_BYTES = 16 * 1024;
export const RUN_SUMMARY_BYTES = 16 * 1024;
const SNAPSHOT_BYTES = 8 * 1024;
const failure = (message, exitCode = 1) => Object.assign(new Error(message), { exitCode });

// Head + tail avoids retaining unbounded logs and makes missing evidence explicit.
export function boundedText(limit = OUTPUT_BYTES) {
  const half = Math.floor(limit / 2);
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let bytes = 0;
  return {
    write(chunk) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      if (head.length < half) head = Buffer.concat([head, data.subarray(0, half - head.length)]);
      // Copy retained bytes: do not pin a much larger chunk's backing buffer.
      tail = Buffer.from(Buffer.concat([tail, data]).subarray(-half));
    },
    value() {
      const tailBytes = Math.min(half, Math.max(0, bytes - half));
      return {
        head: head.toString("utf8"),
        tail: tailBytes ? tail.subarray(-tailBytes).toString("utf8") : "",
        bytes, omittedBytes: Math.max(0, bytes - limit),
      };
    },
  };
}

function snapshot(contents) {
  const text = boundedText(SNAPSHOT_BYTES);
  text.write(contents);
  return { sha256: createHash("sha256").update(contents).digest("hex"), ...text.value() };
}

export class RunEvidence {
  constructor({ roadmap, tracking }) {
    this.roadmap = roadmap;
    this.tracking = tracking;
    this.records = [];
    this.capacityRetries = 0;
    this.usagePauses = 0;
    this.workers = 0;
    this.directory = null;
    this.checkpointRoadmap = roadmap;
    this.checkpointFile = path.join(tracking.stateDir, 'runs.json');
    const legacy = path.join(tracking.stateDir, 'supervision.json');
    const file = fs.existsSync(this.checkpointFile) ? this.checkpointFile : legacy;
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size > 8 * 1024 * 1024) throw failure('run checkpoint too large');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if ((saved.version !== undefined && saved.version !== 1) ||
          (saved.roadmap !== undefined && saved.roadmap !== roadmap) ||
          !Array.isArray(saved.records) || saved.records.length > 20 ||
          saved.records.some((record, i) => !Number.isSafeInteger(record.iteration) || record.iteration < 1 ||
            (i > 0 && record.iteration <= saved.records[i - 1].iteration))) throw failure('invalid run checkpoint');
      if (saved.directory && path.dirname(saved.directory) === tracking.evidenceDir) this.directory = saved.directory;
      this.records = saved.records.map(record => record.evidence ? record : this.summarize(record));
      this.workers = saved.workers || 0;
      this.capacityRetries = saved.capacityRetries || 0;
      this.usagePauses = saved.usagePauses || 0;
    }
  }
  selectSource(roadmap, tracking) { this.roadmap = roadmap; this.tracking = tracking; }
  get evidenceFile() {
    this.saveSummary();
    return path.join(this.directory, 'recent-runs.json');
  }
  checkpoint() {
    const temporary = `${this.checkpointFile}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, roadmap: this.checkpointRoadmap,
        directory: this.directory, workers: this.workers, capacityRetries: this.capacityRetries,
        usagePauses: this.usagePauses, records: this.records }) + '\n', { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.checkpointFile);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  capture() {
    const stdout = boundedText();
    const stderr = boundedText();
    return {
      write(stream, chunk) { (stream === "stdout" ? stdout : stderr).write(chunk); },
      value() { return { stdout: stdout.value(), stderr: stderr.value() }; },
    };
  }

  save(name, data) {
    if (!this.directory) this.directory = fs.mkdtempSync(path.join(this.tracking.evidenceDir, "runs-"));
    const file = path.join(this.directory, name);
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  record({ iteration, task, batch, startedAt, elapsedMs, promptRevision, sourceRevision, result, output, before, after, sourceBefore, sourceAfter, implementationBefore, implementationAfter, metrics, outcome = null, usefulWork = false }) {
    // Rejected launches are not progress attempts. A quota-interrupted session
    // can still contain valuable work, so retain its continuation separately
    // from eligibility for repeated-failure detection.
    const hasContinuation = usefulWork || Boolean(outcome);
    if (result.usageLimit && !result.timedOut && !result.interrupted) {
      this.usagePauses += 1;
      if (!hasContinuation) { this.checkpoint(); return; }
    }
    if (result.retryableCapacity && !result.timedOut && !result.interrupted) {
      this.capacityRetries += 1;
      if (!hasContinuation) { this.checkpoint(); return; }
    }
    if (!result.interrupted && !result.error && (result.code === 0 || result.timedOut)) this.workers += 1;
    const record = {
      iteration, task: task || outcome?.taskId, batch, roadmap: this.roadmap, startedAt, elapsedMs, promptRevision, sourceRevision,
      code: result.code, signal: result.signal || null,
      timedOut: result.timedOut, interrupted: result.interrupted,
      error: result.error?.message || null,
      trackingChanged: before !== after, implementationBefore, implementationAfter, outcome,
      failureLoopEligible: !result.usageLimit && !result.retryableCapacity && !result.interrupted,
      trackingBefore: snapshot(before), trackingAfter: snapshot(after),
      metrics,
      activityEvidence: result.activityEvidence ?? null,
      checkpoint: result.checkpoint ?? null,
      sourceBefore: sourceBefore === undefined ? null : snapshot(sourceBefore),
      sourceAfter: sourceAfter === undefined ? null : snapshot(sourceAfter),
      ...output.value(),
    };
    this.records.push(this.summarize(record));
    if (this.records.length > 20) this.records.shift();
    this.saveSummary();
    this.checkpoint();
  }

  summarize(record) {
    const detail = `worker-${record.iteration}-${randomUUID()}.json`;
    this.save(detail, record);
    return { iteration: record.iteration, task: record.task, batch: record.batch,
      roadmap: record.roadmap ?? this.roadmap, startedAt: record.startedAt, elapsedMs: record.elapsedMs,
      code: record.code, timedOut: record.timedOut, interrupted: record.interrupted, error: record.error,
      sourceRevision: record.sourceRevision, trackingChanged: record.trackingChanged,
      evidence: path.join(this.directory, detail), timing: record.metrics?.timing ?? null,
      failureLoopEligible: record.failureLoopEligible ?? true,
      ...(record.outcome ? { outcome: {
        operation: record.outcome.operation, outcome: record.outcome.outcome,
        completed: (record.outcome.completed || []).slice(0, 4).map(item => item.slice(0, 256)),
        remaining: (record.outcome.remaining || []).slice(0, 4).map(item => item.slice(0, 256)),
        nextAction: typeof record.outcome.nextAction === 'string' ? record.outcome.nextAction.slice(0, 1024)
          : record.outcome.nextAction?.instruction?.slice(0, 1024) || null,
        receiptIds: (record.outcome.receiptIds || []).slice(0, 8),
        failureSignature: record.outcome.failure?.signature ?? null,
      } } : {}) };
  }

  saveSummary() {
    const summary = { roadmap: this.roadmap, trackingFile: this.tracking.file,
      capacityRetries: this.capacityRetries, usagePauses: this.usagePauses, records: this.records };
    while (Buffer.byteLength(JSON.stringify(summary, null, 2)) > RUN_SUMMARY_BYTES && this.records.length > 2) this.records.shift();
    if (Buffer.byteLength(JSON.stringify(summary, null, 2)) > RUN_SUMMARY_BYTES) throw failure('Run summary exceeds its context budget');
    this.save('recent-runs.json', summary);
  }

}
