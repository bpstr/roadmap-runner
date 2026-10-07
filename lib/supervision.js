import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseDuration, roadmapStatus, runClient, waitForRetry } from "./runner.js";
import { renderPrompt } from "./tracking.js";

export const OUTPUT_BYTES = 16 * 1024;
const SNAPSHOT_BYTES = 8 * 1024;
const failure = (message, exitCode = 1) => Object.assign(new Error(message), { exitCode });

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
    this.revision = createHash("sha256").update(template).digest("hex").slice(0, 12);
    this.records = [];
    this.workers = 0;
    this.capacityRetries = 0;
    this.usagePauses = 0;
    this.directory = null; // No files when a completed roadmap starts no workers.
  }

  get due() { return this.workers >= this.every; }
  get evidenceFile() { return path.join(this.directory, "recent-runs.json"); }

  capture() {
    const stdout = boundedText();
    const stderr = boundedText();
    return {
      write(stream, chunk) { (stream === "stdout" ? stdout : stderr).write(chunk); },
      value() { return { stdout: stdout.value(), stderr: stderr.value() }; },
    };
  }

  save(name, data) {
    if (!this.directory) this.directory = fs.mkdtempSync(path.join(os.tmpdir(), "roadmap-runner-review-"));
    const file = path.join(this.directory, name);
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  record({ iteration, startedAt, elapsedMs, promptRevision, sourceRevision, result, output, before, after }) {
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
    this.records.push({
      iteration, startedAt, elapsedMs, promptRevision, sourceRevision,
      code: result.code, signal: result.signal || null,
      timedOut: result.timedOut, interrupted: result.interrupted,
      error: result.error?.message || null,
      trackingChanged: before !== after,
      trackingBefore: snapshot(before), trackingAfter: snapshot(after),
      ...output.value(),
    });
    if (this.records.length > this.every) this.records.shift();
    this.save("recent-runs.json", {
      roadmap: this.roadmap, trackingFile: this.tracking.file,
      capacityRetries: this.capacityRetries, usagePauses: this.usagePauses, records: this.records,
    });
  }

  async review({ options, workdir, afterIteration, recovery }) {
    const reviewId = `${path.basename(this.directory)}:${afterIteration}`;

    let retries = 0;
    let delay = options.capacity.delayMs;
    while (true) {
      this.tracking.refreshSource(afterIteration);
      if (this.tracking.needsReconciliation) return; // Let a worker adopt the revision first.
      const sourceRevision = this.tracking.sourceRevision;
      const prompt = `${this.template}\n\nRunner context:\nRunner role: SUPERVISOR\n${this.tracking.sourceContext()}\nReview ID: ${reviewId}\nLoaded prompt revision: ${this.revision}\nAfter worker iteration: ${afterIteration}\nRun evidence JSON: ${JSON.stringify(this.evidenceFile)}\nSession started (UTC): ${new Date().toISOString()}\n`;
      const output = this.capture();
      await recovery?.event("runner.turn_starting", { role: "supervisor", iteration: afterIteration, sourceRevision });
      const result = await runClient({
        signal: options.signal,
        onProcess: options.onProcess,
        client: options.client, executable: options.executable,
        model: options.model, effort: options.effort, workdir, prompt,
        timeoutMs: this.timeoutMs, terminationGraceMs: 3000, onOutput: output.write,
      });
      await recovery?.event("runner.turn_finished", { role: "supervisor", iteration: afterIteration, code: result.code, timedOut: result.timedOut, interrupted: result.interrupted });
      this.save("supervisor-output.json", {
        reviewId, sourceRevision, code: result.code, usageLimit: result.usageLimit || null, timedOut: result.timedOut,
        interrupted: result.interrupted, ...output.value(),
      });
      this.tracking.refreshSource(afterIteration);
      this.tracking.archive({ kind: "supervisor", iteration: afterIteration, metadata: {
        reviewId, sourceRevision, code: result.code, usageLimit: result.usageLimit || null, timedOut: result.timedOut, interrupted: result.interrupted,
      } });
      this.tracking.assertBounded();
      if (result.interrupted || result.error || result.timedOut || result.retryableCapacity || result.usageLimit || result.code !== 0) recovery?.requireWorker();
      if (result.interrupted) throw failure("supervisor interrupted", 130);
      if (result.error) throw failure(`supervisor failed to start: ${result.error.message}`);
      if (result.timedOut) {
        await recovery?.event("runner.turn_limit_reached", { role: "supervisor", iteration: afterIteration });
        this.workers = 0;
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
      if (this.tracking.sourceRevision !== sourceRevision) {
        this.workers = 0;
        this.capacityRetries = 0;
        console.log("Roadmap changed during supervisor review; the next worker will reconcile its handoff.");
        return;
      }
      // A review must survive context rollover, not exist only in terminal output.
      const reviewed = fs.readFileSync(this.tracking.file, "utf8");
      if (roadmapStatus(reviewed) === "complete") {
        throw failure("supervisor cannot declare implementation complete; inspect the tracking file before restarting");
      }
      if (!reviewed.includes(`Review ID: ${reviewId}`)) {
        this.workers = 0;
        console.warn("Supervisor did not record its Review ID; review flagged, continuing with a fresh worker.");
        await recovery?.event("runner.supervisor_deferred", { reason: "missing_report", afterIteration });
        return;
      }
      this.workers = 0;
      recovery?.success();
      this.capacityRetries = 0;
      console.log(`Supervisor review recorded: ${reviewId}`);
      return;
    }
  }
}
