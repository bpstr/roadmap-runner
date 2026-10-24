import fs from "node:fs";
import { Notifications } from "./notifications.js";
import { SleepInhibitor } from "./sleep-inhibitor.js";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Recovery, recoverySettings, checklistProgress } from "../lib/recovery.js";
import { Supervision, supervisorSettings } from "../lib/supervision.js";
import { prepareTracking, renderPrompt, TARGET_TRACKING_BYTES } from "../lib/tracking.js";
import { sessionMetrics } from "../lib/telemetry.js";
import { ExecutionPlan } from "../lib/execution.js";
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
const COMPACT_TEMPLATE = fs.readFileSync(path.join(ROOT, "compact.md"), "utf8");
const COMPACT_REVISION = createHash("sha256").update(COMPACT_TEMPLATE).digest("hex").slice(0, 12);


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

  let roadmap = path.isAbsolute(options.roadmap)
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

  let tracking = prepareTracking(roadmap, options.progressFile, workdir);
  const execution = options.executionPlan ? new ExecutionPlan(options.executionPlan, workdir, tracking) : null;
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
  console.log(`Prompt:    ${PROMPT_REVISION} (30–45-minute implementation batches)`);
  console.log(`Supervisor: ${supervisor ? `every ${options.supervision.every} workers; timeout ${options.supervisorTimeout}` : "disabled"}`);
  console.log("Press Ctrl-C to stop.");
  console.log();

  console.log(`Events:    ${recovery.eventsFile}`);
  await recovery.restore({ startup: true });
  if (options.recoverBlocked) {
    delete recovery.state.replanRequired;
    recovery.state.consecutiveTimeouts = 0;
    recovery.save();
  }

  let iteration = 0;
  let capacityFailures = 0;
  let retryDelay = options.capacity.delayMs;
  let recoveryRequested = options.recoverBlocked === true;

  while (true) {
    if (signal.aborted) throw Object.assign(new Error("runner interrupted"), { exitCode: 130 });
    const batch = execution?.select();
    if (batch && path.resolve(workdir, batch.roadmap) !== roadmap) {
      roadmap = path.resolve(workdir, batch.roadmap);
      tracking = prepareTracking(roadmap, tracking.file, workdir);
      recovery.tracking = tracking; recovery.roadmap = roadmap;
      if (supervisor) supervisor.selectSource(roadmap, tracking);
    }
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

    if (!execution && status === "complete" && !tracking.needsReconciliation && !recovery.state.quota && !recovery.state.requiresWorker) {
      recovery.success();
      await recovery.event("runner.completed", { iteration });
      console.log(`Roadmap complete after ${iteration} iteration(s).`);
      return { code: 0, reason: "complete" };
    }

    const blockedRecovery = !execution && status === "blocked" && !tracking.needsReconciliation;
    const terminalBlocked = blockedRecovery && !recovery.state.requiresWorker && !recovery.state.quota && !recoveryRequested;
    await recovery.attention(contents, status, iteration, terminalBlocked);
    if (terminalBlocked) {
      console.warn("Roadmap is BLOCKED; stopping without another worker or supervisor. Resolve the recorded unblock condition, then use --recover-blocked for one explicit recovery attempt.");
      return { code: 75, reason: "blocked" };
    }

    if (!recoveryRequested && recovery.state.idle >= options.recovery.maxIdleWorkers &&
        recovery.state.progressRevision === tracking.requirementsRevision) {
      await recovery.stopNoProgress();
    }

    const compacting = tracking.needsCompaction;
    if (supervisor && recovery.state.idle < 2) supervisor.loopChecked = false;
    const loopCheck = supervisor && !supervisor.loopChecked && supervisor.records.length >= 2 &&
      recovery.state.idle >= 2 && recovery.state.progressRevision === tracking.requirementsRevision;
    // A small early review inspects repeated reconciliation before the hard stop.
    const corrective = recovery.state.replanRequired === true;
    if (!compacting && supervisor && (corrective || loopCheck || supervisor.due)) {
      console.log(`===== supervisor after iteration ${iteration} =====`);
      console.log(`Run evidence: ${supervisor.evidenceFile}`);
      if (loopCheck) supervisor.loopChecked = true;
      const review = await supervisor.review({ options: { ...options, signal }, workdir, afterIteration: iteration, recovery, loopCheck: corrective || loopCheck });
      if (corrective) {
        await recovery.event('runner.blocked', { terminal: true, reason: 'replan_required', iteration });
        return { code: 75, reason: 'blocked' };
      }
      if (review?.loop) {
        recovery.state.loopBlockedRevision = tracking.requirementsRevision;
        recovery.save();
        await recovery.event("runner.blocked", { terminal: true, reason: "loop_detected", role: "supervisor",
          iteration, loopIterations: review.loop.iterations, loopEvidence: review.loop.evidence });
        return { code: 75, reason: "blocked" };
      }
      continue; // Re-read the supervisor's handoff/status before another worker.
    }
    if (corrective && !compacting) {
      await recovery.event('runner.blocked', { terminal: true, reason: 'replan_required', iteration });
      return { code: 75, reason: 'blocked' };
    }
    if (execution && !batch) {
      await recovery.event('runner.blocked', { terminal: true, reason: 'finite_plan_exhausted', iteration });
      console.log('No ready batch remains in the finite plan. Implementation acceptance is unchanged; controller replanning is required.');
      return { code: 75, reason: 'blocked' };
    }

    if (!compacting) iteration += 1;
    const role = compacting ? "compactor" : "worker";
    const sessionId = randomUUID();
    const promptRevision = compacting ? COMPACT_REVISION : PROMPT_REVISION;
    console.log(`===== ${compacting ? "compaction before next worker; after iteration" : "iteration"} ${iteration} | ${new Date().toISOString()} =====`);

    const startedAt = new Date().toISOString();
    const started = performance.now();
    const output = compacting ? undefined : supervisor?.capture();
    const sourceRevision = tracking.sourceRevision;
    const sourceContents = fs.readFileSync(tracking.sourceSnapshot, "utf8");
    const revisionChanged = recovery.state.progressRevision != null &&
      recovery.state.progressRevision !== tracking.requirementsRevision;
    if (!compacting) recoveryRequested = false; // One explicit recovery worker.
    const snapshot = compacting ? tracking.archive({ kind: "before-compaction", iteration }) : null;
    const sessionTimeoutMs = compacting ? Math.min(timeoutMs, parseDuration(options.supervisorTimeout)) : timeoutMs;
    const checkpointAtMs = Math.max(1, Math.min((batch?.budgetMinutes ?? 40) * 60_000,
      sessionTimeoutMs - Math.min(300_000, sessionTimeoutMs * 0.15)));
    const checkpointFile = path.join(tracking.evidenceDir, `${sessionId}-checkpoint.json`);
    const deadlineContext = `Soft checkpoint deadline (UTC): ${new Date(Date.now() + checkpointAtMs).toISOString()}\nHard termination deadline (UTC): ${new Date(Date.now() + sessionTimeoutMs).toISOString()}\n` +
      `Checkpoint request file: ${JSON.stringify(checkpointFile)}\nAt the soft deadline stop implementation, save exact remaining functionality, edited paths, failed/passing evidence and the next command in the current handoff, then exit. Check the clock after commands; do not start work that cannot finish before the checkpoint. Do not repeat broad discovery or unchanged checks on recovery.\n`;
    const prompt = renderPrompt(PROMPT_TEMPLATE, roadmap, tracking.file, tracking.historyDir);
    const iterationPrompt = compacting
      ? `${renderPrompt(COMPACT_TEMPLATE, roadmap, tracking.file, tracking.historyDir)}\n\nRunner context:\nRunner role: COMPACTOR\n${tracking.compactionContext()}\n${tracking.evidenceContext()}\nPre-compaction snapshot: ${JSON.stringify(snapshot)}\nLoaded prompt revision: ${promptRevision}\nAfter worker iteration: ${iteration}\n`
      : `${prompt}\n\nRunner context:\nRunner role: WORKER\n${execution ? execution.context(batch) : tracking.sourceContext()}\n${tracking.evidenceContext()}\n${deadlineContext}Recovery verification required: ${recovery.state.requiresWorker ? "YES: resume the recorded unfinished files and exact next action; inspect only changed acceptance or failed evidence" : "NO"}\nPrevious checkpoint: ${recovery.state.checkpointFile ? JSON.stringify(recovery.state.checkpointFile) : "none"}\nBlocked recovery mode: ${blockedRecovery ? "YES" : "NO"}\nLoaded prompt revision: ${promptRevision}\nIteration: ${iteration}\nSession started (UTC): ${startedAt}\n`;
    const before = tracking.contextBytes(iterationPrompt);
    await recovery.event("runner.turn_starting", { role, iteration, sessionId, sourceRevision, task: batch?.task, batch: batch?.id, contextBytes: before });
    const result = await runClient({
      signal,
      onProcess: options.onProcess,
      client: options.client,
      executable: options.executable,
      prompt: iterationPrompt,
      workdir,
      model: options.model,
      effort: options.effort,
      timeoutMs: sessionTimeoutMs,
      checkpointAtMs,
      onCheckpoint: compacting ? undefined : async request => {
        const handoff = tracking.archive({ kind: 'soft-checkpoint', iteration });
        fs.writeFileSync(checkpointFile, JSON.stringify({ ...request, sessionId, task: batch?.task, batch: batch?.id,
          sourceRevision, handoff, progressFile: tracking.file,
          instruction: 'Resume recorded unfinished work; source files are preserved in place. This controller snapshot is not an agent completion claim.' }) + '\n', { mode: 0o600 });
        recovery.state.checkpointFile = checkpointFile; recovery.save();
        await recovery.event('runner.checkpoint_requested', { role, iteration, sessionId, checkpointFile, handoff });
        return checkpointFile;
      },
      onOutput: output?.write,
    });

    const elapsedMs = Math.round(performance.now() - started);
    const metrics = sessionMetrics(result, { client: options.client, effort: options.effort, startedAt, elapsedMs,
      before, after: tracking.contextBytes(iterationPrompt) });
    const receipt = { sessionId, role, iteration, sourceRevision, promptRevision, task: batch?.task, batch: batch?.id, code: result.code,
      timedOut: result.timedOut, interrupted: result.interrupted, ...metrics };
    tracking.recordSession({ runId: recovery.runId, ...receipt });
    await recovery.event("runner.turn_finished", receipt);
    tracking.refreshSource(iteration);
    const after = fs.readFileSync(tracking.file, "utf8");
    const afterSource = fs.readFileSync(tracking.sourceSnapshot, "utf8");
    const sourceHasTasks = checklistProgress(sourceContents).total || checklistProgress(afterSource).total;
    const beforeProgress = sourceHasTasks ? sourceContents : contents;
    const afterProgress = sourceHasTasks ? afterSource : after;
    const completedHandoff = tracking.archive({ kind: role, iteration, metadata: {
      ...receipt,
      signal: result.signal || null, timedOut: result.timedOut, interrupted: result.interrupted, usageLimit: result.usageLimit || null,
    } });
    if (!compacting && execution) execution.remember(batch, completedHandoff, receipt);
    tracking.assertBounded();
    if (compacting && afterSource !== sourceContents) {
      recovery.requireWorker();
      fail(`source roadmap changed during handoff compaction; source and handoff preserved, original handoff at ${snapshot}. Inspect the change before restarting.`);
    }
    if (!compacting) supervisor?.record({
      iteration, task: batch?.task, batch: batch?.id, startedAt, elapsedMs, promptRevision, sourceRevision, result, output, metrics,
      before: contents, after,
      sourceBefore: sourceContents, sourceAfter: afterSource,
    });
    if (result.interrupted || result.error || result.timedOut || result.retryableCapacity || result.usageLimit || result.code !== 0) recovery.requireWorker();
    if (result.interrupted) throw Object.assign(new Error("runner interrupted"), { exitCode: 130 });
    if (result.error) fail(`failed to start ${options.client}: ${result.error.message}`);
    if (result.cleanupIncomplete) fail('Client process cleanup could not be confirmed; unfinished files preserved.', 75);
    const delivery = !compacting && execution ? execution.finish(batch, result) : null;
    if (!compacting) {
      recovery.state.consecutiveTimeouts = result.timedOut ? (recovery.state.consecutiveTimeouts || 0) + 1 : 0;
      if (delivery?.replan || recovery.state.consecutiveTimeouts >= 2) recovery.state.replanRequired = true;
      recovery.save();
    }

    if (result.timedOut) {
      await recovery.event("runner.turn_limit_reached", { role, iteration });
      if (compacting) fail(`handoff compaction timed out; original state preserved at ${snapshot}`);
      await recovery.attention(after, tracking.deliveryStatus(roadmapStatus(after)), iteration);
      if (!execution && !recovery.state.replanRequired) await recovery.idle(beforeProgress, afterProgress, revisionChanged);
      console.log(`Iteration ${iteration} hit the ${options.timeout} limit; preserve checkpoint and apply bounded recovery.`);
      console.log();
      continue;
    }

    if (result.usageLimit) {
      await recovery.pause(result.usageLimit, role);
      continue;
    }

    if (result.retryableCapacity) {
      if (capacityFailures >= options.capacity.retries) {
        await recovery.event("runner.capacity_exhausted", { role: "worker", iteration });
        fail("model capacity retry limit reached; partial work preserved.", 75);
      }
      capacityFailures += 1;
      await recovery.event("runner.capacity_wait", { role, iteration, delayMs: retryDelay });
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

    if (compacting) {
      if (Buffer.byteLength(after) >= TARGET_TRACKING_BYTES || roadmapStatus(after) !== roadmapStatus(contents)) {
        recovery.requireWorker();
        const reason = Buffer.byteLength(after) >= TARGET_TRACKING_BYTES
          ? `did not reach the ${TARGET_TRACKING_BYTES}-byte target` : "changed the opening status";
        fail(`handoff compaction ${reason}; original state preserved at ${snapshot}`);
      }
      recovery.success();
      console.log(`Handoff compacted from ${Buffer.byteLength(contents)} to ${Buffer.byteLength(after)} bytes; evidence remains available on demand.`);
      continue;
    }
    recovery.success({ worker: true });
    tracking.finishWorker(sourceRevision, result);
    const afterStatus = tracking.deliveryStatus(roadmapStatus(after));
    if (afterStatus !== "blocked" || tracking.needsReconciliation) await recovery.attention(after, afterStatus, iteration);
    if (!execution && (afterStatus !== "blocked" || tracking.needsReconciliation) && (afterStatus !== "complete" || tracking.needsReconciliation)) {
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
