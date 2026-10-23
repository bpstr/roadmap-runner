import fs from "node:fs";
import { Notifications } from "./notifications.js";
import { SleepInhibitor } from "./sleep-inhibitor.js";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Recovery, recoverySettings, checklistProgress } from "../lib/recovery.js";
import { Supervision, supervisorSettings } from "../lib/supervision.js";
import { prepareTracking, renderPrompt } from "../lib/tracking.js";
import { CLIENT_NAMES, buildClientInvocation } from "../lib/clients.js";
import {
  capacityRetrySettings,
  waitForRetry,
  commandExists,
  parseArgs,
  parseDuration,
  roadmapStatus,
  runClient,
} from "../lib/runner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const PROMPT_TEMPLATE = fs.readFileSync(path.join(ROOT, "prompt.md"), "utf8");
const PROMPT_REVISION = createHash("sha256").update(PROMPT_TEMPLATE).digest("hex").slice(0, 12);


const fail = (message, code = 1) => { throw Object.assign(new Error(message), { exitCode: code }); };

export const runLifecycle = async (options, { workdir = process.cwd(), signal: suppliedSignal = undefined, onEvent = undefined, onReady = undefined, managedSleep = false }: any = {}) => {
  const controller = new AbortController();
  const signal = suppliedSignal || controller.signal;
  const interrupt = () => controller.abort();
  if (!suppliedSignal) { process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt); }
  let recovery;
  let notifications;
  let sleep;
  try {
    options = { ...options, capacity: options.capacity || capacityRetrySettings(), recovery: options.recovery || recoverySettings() };
    options.supervision = supervisorSettings(options);

  const roadmap = path.isAbsolute(options.roadmap)
    ? path.normalize(options.roadmap)
    : path.resolve(workdir, options.roadmap);

  if (!fs.existsSync(roadmap) || !fs.statSync(roadmap).isFile()) {
    fail(`roadmap not found: ${roadmap}`);
  }

  let timeoutMs;
  try {
    timeoutMs = parseDuration(options.timeout);
  } catch (error) {
    fail(error.message, 64);
  }

  const probe = buildClientInvocation({
    client: options.client,
    executable: options.executable,
    prompt: "",
    workdir,
    model: options.model,
    effort: options.effort,
  });

  if (!commandExists(probe.command)) {
    fail(`${options.client} executable not found: ${probe.command}`);
  }

  if (!probe.approvalFree) {
    console.warn(`Warning: ${options.client} has no explicit approval-bypass flag in the current adapter; local client configuration may still prompt.`);
  }

  const tracking = prepareTracking(roadmap, options.progressFile, workdir);
  const prompt = renderPrompt(PROMPT_TEMPLATE, roadmap, tracking.file, tracking.historyDir);
  if (!onEvent) {
    notifications = new Notifications(options, `${tracking.file}.notifications.json`);
    onEvent = event => notifications.enqueue(event);
  }
  recovery = new Recovery({ tracking, roadmap, settings: options.recovery, wait: ms => waitForRetry(ms, signal), signal, onEvent, runId: options.runId });
  await recovery.event("runner.started");
  if (!managedSleep) { sleep = new SleepInhibitor(options.preventSleep); await sleep.start(); }
  await onReady?.(tracking);
  const supervisor = options.supervision.every ? new Supervision({
    ...options.supervision, roadmap, tracking,
    template: fs.readFileSync(path.join(ROOT, "supervisor.md"), "utf8"),
  }) : null;

  console.log(`Roadmap Runner ${PACKAGE.version}`);
  console.log(`Client:    ${options.client}`);
  console.log(`Workspace: ${workdir}`);
  console.log(`Roadmap:   ${roadmap}`);
  console.log(`Progress:  ${tracking.file} (bounded handoff/evidence; task states in roadmap)`);
  console.log("Roadmap edits: adopted between sessions; stale terminal state is re-evaluated.");
  console.log(`History:   ${tracking.historyDir} (archived snapshots; not loaded by default)`);
  console.log(`Timeout:   ${options.timeout} per run`);
  console.log(`Prompt:    ${PROMPT_REVISION} (60-minute implementation batches)`);
  console.log(`Supervisor: ${supervisor ? `every ${options.supervision.every} workers; timeout ${options.supervisorTimeout}` : "disabled"}`);
  console.log("Press Ctrl-C to stop.");
  console.log();

  console.log(`Events:    ${recovery.eventsFile}`);
  await recovery.restore({ startup: true });

  let iteration = 0;
  let capacityFailures = 0;
  let retryDelay = options.capacity.delayMs;
  let recoveryRequested = options.recoverBlocked === true;

  while (true) {
    if (signal.aborted) throw Object.assign(new Error("runner interrupted"), { exitCode: 130 });
    tracking.refreshSource(iteration);
    tracking.assertBounded();
    const contents = fs.readFileSync(tracking.file, "utf8");
    const status = tracking.deliveryStatus(roadmapStatus(contents));

    if (recovery.state.loopBlockedRevision === tracking.requirementsRevision) {
      if (!recoveryRequested) {
        await recovery.event("runner.blocked", { terminal: true, reason: "loop_detected", iteration });
        return { code: 75, reason: "blocked" };
      }
      delete recovery.state.loopBlockedRevision;
      recovery.save();
    }

    if (status === "complete" && !tracking.needsReconciliation && !recovery.state.quota && !recovery.state.requiresWorker) {
      recovery.success();
      await recovery.event("runner.completed", { iteration });
      console.log(`Roadmap complete after ${iteration} iteration(s).`);
      return { code: 0, reason: "complete" };
    }

    const blockedRecovery = status === "blocked" && !tracking.needsReconciliation;
    const terminalBlocked = blockedRecovery && !recovery.state.requiresWorker && !recovery.state.quota && !recoveryRequested;
    await recovery.attention(contents, status, iteration, terminalBlocked);
    if (terminalBlocked) {
      console.warn("Roadmap is BLOCKED; stopping without another worker or supervisor. Resolve the recorded unblock condition, then use --recover-blocked for one explicit recovery attempt.");
      return { code: 75, reason: "blocked" };
    }

    if (supervisor && recovery.state.idle < 2) supervisor.loopChecked = false;
    const loopCheck = supervisor && !supervisor.loopChecked && supervisor.records.length >= 2 &&
      recovery.state.idle >= 2 && recovery.state.progressRevision === tracking.requirementsRevision;
    // A small early review inspects repeated reconciliation before the hard stop.
    if (supervisor && (loopCheck || (supervisor.due && !tracking.needsReconciliation))) {
      console.log(`===== supervisor after iteration ${iteration} =====`);
      console.log(`Run evidence: ${supervisor.evidenceFile}`);
      if (loopCheck) supervisor.loopChecked = true;
      const review = await supervisor.review({ options: { ...options, signal }, workdir, afterIteration: iteration, recovery, loopCheck });
      if (review?.loop) {
        recovery.state.loopBlockedRevision = tracking.requirementsRevision;
        recovery.save();
        await recovery.event("runner.blocked", { terminal: true, reason: "loop_detected", role: "supervisor",
          iteration, loopIterations: review.loop.iterations, loopEvidence: review.loop.evidence });
        return { code: 75, reason: "blocked" };
      }
      continue; // Re-read the supervisor's handoff/status before another worker.
    }

    iteration += 1;
    console.log(`===== iteration ${iteration} | ${new Date().toISOString()} =====`);

    const startedAt = new Date().toISOString();
    const started = performance.now();
    const output = supervisor?.capture();
    const sourceRevision = tracking.sourceRevision;
    const sourceContents = fs.readFileSync(tracking.sourceSnapshot, "utf8");
    const revisionChanged = recovery.state.progressRevision != null &&
      recovery.state.progressRevision !== tracking.requirementsRevision;
    recoveryRequested = false; // Explicit recovery authorizes one worker, not a retry loop.
    const iterationPrompt = `${prompt}\n\nRunner context:\nRunner role: WORKER\n${tracking.sourceContext()}\n${tracking.compactionContext()}\nRecovery verification required: ${recovery.state.requiresWorker ? "YES: re-evaluate any terminal status or completion evidence left by the interrupted/failed session before selecting work" : "NO"}\nBlocked recovery mode: ${blockedRecovery ? "YES" : "NO"}\nLoaded prompt revision: ${PROMPT_REVISION}\nIteration: ${iteration}\nSession started (UTC): ${new Date().toISOString()}\n`;
    await recovery.event("runner.turn_starting", { role: "worker", iteration, sourceRevision });
    const result = await runClient({
      signal,
      onProcess: options.onProcess,
      client: options.client,
      executable: options.executable,
      prompt: iterationPrompt,
      workdir,
      model: options.model,
      effort: options.effort,
      timeoutMs,
      onOutput: output?.write,
    });

    await recovery.event("runner.turn_finished", { role: "worker", iteration, code: result.code, timedOut: result.timedOut, interrupted: result.interrupted });
    tracking.refreshSource(iteration);
    const elapsedMs = Math.round(performance.now() - started);
    const after = fs.readFileSync(tracking.file, "utf8");
    const afterSource = fs.readFileSync(tracking.sourceSnapshot, "utf8");
    const sourceHasTasks = checklistProgress(sourceContents).total || checklistProgress(afterSource).total;
    const beforeProgress = sourceHasTasks ? sourceContents : contents;
    const afterProgress = sourceHasTasks ? afterSource : after;
    tracking.archive({ kind: "worker", iteration, metadata: {
      startedAt, elapsedMs, promptRevision: PROMPT_REVISION, sourceRevision, code: result.code,
      signal: result.signal || null, timedOut: result.timedOut, interrupted: result.interrupted, usageLimit: result.usageLimit || null,
    } });
    tracking.assertBounded();
    supervisor?.record({
      iteration, startedAt, elapsedMs, promptRevision: PROMPT_REVISION, sourceRevision, result, output,
      before: contents, after,
      sourceBefore: sourceContents, sourceAfter: afterSource,
    });
    if (result.interrupted || result.error || result.timedOut || result.retryableCapacity || result.usageLimit || result.code !== 0) recovery.requireWorker();
    if (result.interrupted) throw Object.assign(new Error("runner interrupted"), { exitCode: 130 });
    if (result.error) fail(`failed to start ${options.client}: ${result.error.message}`);

    if (result.timedOut) {
      await recovery.event("runner.turn_limit_reached", { role: "worker", iteration });
      await recovery.attention(after, tracking.deliveryStatus(roadmapStatus(after)), iteration);
      await recovery.idle(beforeProgress, afterProgress, revisionChanged);
      console.log(`Iteration ${iteration} hit the ${options.timeout} limit; starting a fresh session.`);
      console.log();
      continue;
    }

    if (result.usageLimit) {
      await recovery.pause(result.usageLimit, "worker");
      continue;
    }

    if (result.retryableCapacity) {
      if (capacityFailures >= options.capacity.retries) {
        await recovery.event("runner.capacity_exhausted", { role: "worker", iteration });
        fail("model capacity retry limit reached; partial work preserved.", 75);
      }
      capacityFailures += 1;
      await recovery.event("runner.capacity_wait", { role: "worker", iteration, delayMs: retryDelay });
      const waiting = waitForRetry(retryDelay, signal);
      console.log(`Model at capacity; retry ${capacityFailures}/${options.capacity.retries} in ${retryDelay / 1000}s (same model).`);
      if (await waiting) throw Object.assign(new Error("runner interrupted"), { exitCode: 130 });
      retryDelay = Math.min(retryDelay * 2, options.capacity.maxDelayMs);
      continue;
    }
    capacityFailures = 0;
    retryDelay = options.capacity.delayMs;

    if (result.code !== 0) {
      fail(`${options.client} exited with code ${result.code}; stopping.`, result.code || 1);
    }

    recovery.success({ worker: true });
    tracking.finishWorker(sourceRevision, result);
    const afterStatus = tracking.deliveryStatus(roadmapStatus(after));
    if (afterStatus !== "blocked" || tracking.needsReconciliation) await recovery.attention(after, afterStatus, iteration);
    if ((afterStatus !== "blocked" || tracking.needsReconciliation) && (afterStatus !== "complete" || tracking.needsReconciliation)) {
      await recovery.idle(beforeProgress, afterProgress, revisionChanged);
    }
    console.log(`Iteration ${iteration} completed.`);
    console.log();
  }
  } catch (error) {
    const stopped = signal.aborted || error.exitCode === 130;
    const type = stopped ? "runner.stopped" : "runner.failed";
    const fields = { code: stopped ? 130 : error.exitCode || 1, reason: stopped ? "requested_stop" : error.reason || "terminal_failure" };
    if (recovery) await recovery.event(type, fields);
    else onEvent?.({ version: 1, id: randomUUID(), runId: options.runId || randomUUID(), sequence: 1, at: new Date().toISOString(), type,
      roadmap: options.roadmap, progressFile: options.progressFile, severity: stopped ? "info" : "warning", attention: !stopped, reasonCode: fields.reason, ...fields });
    if (!stopped) console.error(`roadmap-runner: ${error.message}`);
    return { code: stopped ? 130 : error.exitCode || 1, reason: stopped ? "stopped" : error.reason || "failed" };
  } finally {
    await sleep?.close();
    if (notifications) { if (!signal.aborted) await notifications.flush(); await notifications.close(); }
    if (!suppliedSignal) { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
  }
};
