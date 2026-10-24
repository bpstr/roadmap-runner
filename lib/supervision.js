import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseDuration, roadmapStatus, runClient, waitForRetry } from "./runner.js";
import { renderPrompt } from "./tracking.js";
import { sessionMetrics } from "./telemetry.js";

export const OUTPUT_BYTES = 16 * 1024;
export const REVIEW_SUMMARY_BYTES = 16 * 1024;
const SNAPSHOT_BYTES = 8 * 1024;
const failure = (message, exitCode = 1) => Object.assign(new Error(message), { exitCode });

function currentReview(contents, reviewId) {
  // Only the current review's explicit field counts, never examples or history.
  let fence = null; let section = null; const reviews = [];
  for (const line of contents.split(/\r?\n/)) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    if (/^#{1,6}\s/.test(line)) {
      if (section) reviews.push(section);
      section = /^## Latest supervisor review\s*$/i.test(line) ? [] : null;
    } else if (section) section.push(line);
  }
  if (section) reviews.push(section);
  section = reviews.at(-1) || [];
  return section.filter(line => line.trim() === `Review ID: ${reviewId}`).length === 1 ? section : [];
}

export function currentReviewIsStuck(contents, reviewId) {
  return currentReview(contents, reviewId).some(line => /^Health:\s*STUCK\s*$/i.test(line.trim()));
}

export function currentReviewLoop(contents, reviewId, records) {
  const section = currentReview(contents, reviewId).map(line => line.trim());
  const field = name => {
    const lines = section.filter(line => line.startsWith(name + ':'));
    return lines.length === 1 ? lines[0].slice(name.length + 1).trim() : '';
  };
  if (field('Loop') !== 'DETECTED' || !/^\d+(?:\s*,\s*\d+)+$/.test(field('Loop iterations'))) return null;
  const iterations = [...new Set(field('Loop iterations').split(',').map(Number))];
  const known = new Set(records.filter(r => !r.interrupted && !r.error && (r.code === 0 || r.timedOut)).map(r => r.iteration));
  const evidence = field('Loop evidence').slice(0, 512);
  return evidence && iterations.length >= 2 && iterations.every(n => known.has(n)) ? { iterations, evidence } : null;
}

export function supervisorSettings(options) {
  const value = String(options.supervisorEvery ?? "5");
  if (!/^(0|[1-9]|1[0-9]|20)$/.test(value)) {
    throw failure("--supervisor-every must be an integer from 0 to 20", 64);
  }
  let timeoutMs;
  try {
    timeoutMs = parseDuration(options.supervisorTimeout || "10m");
    if (timeoutMs > 2_147_483_647) throw new Error("supervisor timeout exceeds the timer limit");
  } catch (error) {
    throw failure(error.message, 64);
  }
  return { every: Number(value), timeoutMs };
}

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

export class Supervision {
  constructor({ every, timeoutMs, roadmap, tracking, template }) {
    this.every = every;
    this.timeoutMs = timeoutMs;
    this.roadmap = roadmap;
    this.tracking = tracking;
    this.template = renderPrompt(template, roadmap, tracking.file, tracking.historyDir);
    this.sourceTemplate = template;
    this.revision = createHash("sha256").update(template).digest("hex").slice(0, 12);
    this.records = [];
    this.workers = 0;
    this.capacityRetries = 0;
    this.usagePauses = 0;
    this.directory = null; // No files when a completed roadmap starts no workers.
    this.loopChecked = false;
    this.stateFile = path.join(tracking.stateDir, 'supervision.json');
    if (fs.existsSync(this.stateFile)) {
      if (fs.statSync(this.stateFile).size > REVIEW_SUMMARY_BYTES) throw failure('Supervisor state exceeds its context budget');
      const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      this.workers = state.workers || 0; this.records = state.records || [];
      if (state.directory && path.dirname(state.directory) === tracking.evidenceDir) this.directory = state.directory;
    }
  }

  get due() { return this.workers >= this.every; }
  selectSource(roadmap, tracking) {
    this.roadmap = roadmap; this.tracking = tracking;
    this.template = renderPrompt(this.sourceTemplate, roadmap, tracking.file, tracking.historyDir);
  }
  get evidenceFile() { return path.join(this.directory, "recent-runs.json"); }
  persist() {
    fs.writeFileSync(this.stateFile, JSON.stringify({ workers: this.workers, records: this.records, directory: this.directory }) + '\n', { mode: 0o600 });
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
    if (!this.directory) this.directory = fs.mkdtempSync(path.join(this.tracking.evidenceDir, "review-"));
    const file = path.join(this.directory, name);
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  record({ iteration, task, batch, startedAt, elapsedMs, promptRevision, sourceRevision, result, output, before, after, sourceBefore, sourceAfter, metrics }) {
    // Capacity-only failures are not progress attempts; keep their count visible.
    if (result.usageLimit && !result.timedOut && !result.interrupted) {
      this.usagePauses += 1;
      return;
    }
    if (result.retryableCapacity && !result.timedOut && !result.interrupted) {
      this.capacityRetries += 1;
      return;
    }
    if (!result.interrupted && !result.error && (result.code === 0 || result.timedOut)) this.workers += 1;
    const record = {
      iteration, task, batch, startedAt, elapsedMs, promptRevision, sourceRevision,
      code: result.code, signal: result.signal || null,
      timedOut: result.timedOut, interrupted: result.interrupted,
      error: result.error?.message || null,
      trackingChanged: before !== after,
      trackingBefore: snapshot(before), trackingAfter: snapshot(after),
      metrics,
      sourceBefore: sourceBefore === undefined ? null : snapshot(sourceBefore),
      sourceAfter: sourceAfter === undefined ? null : snapshot(sourceAfter),
      ...output.value(),
    };
    // Full bounded captures are cold evidence. Never inject all snapshots and
    // stdout/stderr again in the automatically read recent-runs summary.
    const detail = `worker-${iteration}-${randomUUID()}.json`;
    this.save(detail, record);
    this.records.push({ iteration, task, batch, roadmap: this.roadmap, startedAt, elapsedMs, code: record.code, timedOut: record.timedOut,
      interrupted: record.interrupted, error: record.error, sourceRevision,
      trackingChanged: record.trackingChanged, evidence: path.join(this.directory, detail),
      timing: metrics?.timing ?? null });
    if (this.records.length > Math.max(2, this.every)) this.records.shift();
    const summary = {
      roadmap: this.roadmap, trackingFile: this.tracking.file,
      capacityRetries: this.capacityRetries, usagePauses: this.usagePauses, records: this.records,
    };
    while (Buffer.byteLength(JSON.stringify(summary, null, 2)) > REVIEW_SUMMARY_BYTES && summary.records.length > 2) summary.records.shift();
    if (Buffer.byteLength(JSON.stringify(summary, null, 2)) > REVIEW_SUMMARY_BYTES) throw failure('Supervisor summary exceeds its context budget');
    this.save("recent-runs.json", summary);
    this.persist();
  }

  async review({ options, workdir, afterIteration, recovery, loopCheck = false }) {
    const reviewId = `${path.basename(this.directory)}:${afterIteration}`;

    let retries = 0;
    let delay = options.capacity.delayMs;
    while (true) {
      this.tracking.refreshSource(afterIteration);
      // Reconciliation is review input, never a reason to starve supervision.
      if (this.tracking.needsCompaction) return; // Compact before either review reads the handoff.
      const sourceRevision = this.tracking.sourceRevision;
      const requirementsRevision = this.tracking.requirementsRevision;
      const prompt = `${this.template}\n\nRunner context:\nRunner role: SUPERVISOR\nReview purpose: ${loopCheck ? 'LOOP_CHECK' : 'PERIODIC'}\n${this.tracking.sourceContext()}\n${this.tracking.evidenceContext()}\nReview ID: ${reviewId}\nLoaded prompt revision: ${this.revision}\nAfter worker iteration: ${afterIteration}\nRun evidence JSON: ${JSON.stringify(this.evidenceFile)}\nSession started (UTC): ${new Date().toISOString()}\n`;
      const output = this.capture();
      const sessionId = randomUUID();
      const startedAt = new Date().toISOString();
      const started = performance.now();
      const before = this.tracking.contextBytes(prompt);
      await recovery?.event("runner.turn_starting", { role: "supervisor", iteration: afterIteration, sourceRevision, sessionId, contextBytes: before });
      const result = await runClient({
        signal: options.signal,
        onProcess: options.onProcess,
        client: options.client, executable: options.executable,
        model: options.model, effort: options.effort, workdir, prompt,
        timeoutMs: loopCheck ? Math.min(this.timeoutMs, 60_000) : this.timeoutMs, terminationGraceMs: 3000, onOutput: output.write,
      });
      const metrics = sessionMetrics(result, { client: options.client, effort: options.effort, startedAt,
        elapsedMs: Math.round(performance.now() - started), before, after: this.tracking.contextBytes(prompt) });
      const receipt = { sessionId, role: "supervisor", iteration: afterIteration, sourceRevision, promptRevision: this.revision,
        code: result.code, timedOut: result.timedOut, interrupted: result.interrupted, ...metrics };
      this.tracking.recordSession({ runId: recovery?.runId ?? null, ...receipt });
      await recovery?.event("runner.turn_finished", receipt);
      this.save("supervisor-output.json", {
        reviewId, ...receipt, usageLimit: result.usageLimit || null,
        interrupted: result.interrupted, ...output.value(),
      });
      this.tracking.refreshSource(afterIteration);
      if (recovery && this.tracking.requirementsRevision !== requirementsRevision) {
        // A supervisor rewrite is agent churn, not a fresh controller budget.
        recovery.state.progressRevision = this.tracking.requirementsRevision;
        recovery.save();
      }
      this.tracking.archive({ kind: "supervisor", iteration: afterIteration, metadata: {
        reviewId, ...receipt, usageLimit: result.usageLimit || null,
      } });
      this.tracking.assertBounded();
      if (result.interrupted || result.error || result.timedOut || result.retryableCapacity || result.usageLimit || result.code !== 0) recovery?.requireWorker();
      if (result.interrupted) throw failure("supervisor interrupted", 130);
      if (result.error) throw failure(`supervisor failed to start: ${result.error.message}`);
      if (result.timedOut) {
        await recovery?.event("runner.turn_limit_reached", { role: "supervisor", iteration: afterIteration });
        this.workers = 0;
        this.persist();
        console.warn("Supervisor timed out; partial review preserved, continuing with a fresh worker.");
        await recovery?.event("runner.supervisor_deferred", { reason: "timeout", afterIteration });
        return;
      }
      if (result.usageLimit) {
        if (!recovery) throw failure("supervisor usage limit reached", 75);
        await recovery.pause(result.usageLimit, "supervisor");
        continue;
      }
      if (result.retryableCapacity) {
        if (this.tracking.requirementsRevision !== requirementsRevision) {
          this.workers = 0;
          this.persist();
          await recovery?.event('runner.supervisor_deferred', { reason: 'requirements_changed', afterIteration });
          return;
        }
        if (retries >= options.capacity.retries) {
          await recovery?.event("runner.capacity_exhausted", { role: "supervisor", iteration: afterIteration });
          throw failure("supervisor capacity retry limit reached", 75);
        }
        retries += 1;
        await recovery?.event("runner.capacity_wait", { role: "supervisor", iteration: afterIteration, delayMs: delay });
        const waiting = waitForRetry(delay, options.signal);
        console.log(`Supervisor at capacity; retry ${retries}/${options.capacity.retries} in ${delay / 1000}s (same model).`);
        if (await waiting) throw failure("supervisor retry interrupted", 130);
        delay = Math.min(delay * 2, options.capacity.maxDelayMs);
        continue;
      }
      if (result.code !== 0) throw failure(`supervisor exited with code ${result.code}; stopping.`, result.code || 1);
      if (this.tracking.requirementsRevision !== requirementsRevision) {
        this.workers = 0;
        this.persist();
        this.capacityRetries = 0;
        console.log("Roadmap changed during supervisor review; the next worker will reconcile its handoff.");
        return;
      }
      // A review must survive context rollover, not exist only in terminal output.
      const reviewed = fs.readFileSync(this.tracking.file, "utf8");
      const loop = currentReviewLoop(reviewed, reviewId, this.records);
      if (loop) return { loop };
      if (roadmapStatus(reviewed) === "complete") {
        throw failure("supervisor cannot declare implementation complete; inspect the tracking file before restarting");
      }
      if (!reviewed.includes(`Review ID: ${reviewId}`)) {
        this.workers = 0;
        this.persist();
        console.warn("Supervisor did not record its Review ID; review flagged, continuing with a fresh worker.");
        await recovery?.event("runner.supervisor_deferred", { reason: "missing_report", afterIteration });
        return;
      }
      if (currentReviewIsStuck(reviewed, reviewId)) await recovery?.reportStuck({
        reason: "supervisor_stuck", role: "supervisor", iteration: afterIteration,
        attentionFingerprint: createHash("sha256").update(reviewId).digest("hex"),
      });
      this.workers = 0;
      this.persist();
      recovery?.success();
      this.capacityRetries = 0;
      console.log(`Supervisor review recorded: ${reviewId}`);
      return;
    }
  }
}
