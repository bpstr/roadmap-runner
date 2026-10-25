import fs from "node:fs";
import { Notifications } from "./notifications.js";
import { SleepInhibitor } from "./sleep-inhibitor.js";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Recovery, recoverySettings } from "../lib/recovery.js";
import { RunEvidence } from "../lib/run-evidence.js";
import { resolverSettings, readResolution, withStatus } from "../lib/recovery-runs.js";
import { prepareTracking, trackingPaths, renderPrompt, TARGET_TRACKING_BYTES } from "../lib/tracking.js";
import { sessionMetrics } from "../lib/telemetry.js";
import { ExecutionPlan } from "../lib/execution.js";
import { RoadmapPlan } from "../lib/task-plan.js";
import { TaskMemory, validateWorkerResult } from "../lib/task-memory.js";
import { checkpointDelay, readCheckpointAcknowledgment } from "../lib/checkpoint.js";
import { selectContinuation, rememberContinuation } from "../lib/continuation.js";
import { atomicJson } from "./run-state.js";
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
const RESOLVER_TEMPLATE = fs.readFileSync(path.join(ROOT, "resolver.md"), "utf8");
const RESOLVER_REVISION = createHash("sha256").update(RESOLVER_TEMPLATE).digest("hex").slice(0, 12);
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
    const resolverTimeoutMs = resolverSettings(options).timeoutMs;

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
  const queuedDelivery = options.deliveryPlan ? new ExecutionPlan(options.deliveryPlan, workdir, tracking) : null;
  const defaultPlan = !execution && !queuedDelivery ? new RoadmapPlan(roadmap, workdir, tracking) : null;
  const memories = new Map<string, any>();
  const legacyMemory = { latest: () => null, repeatFailure: () => false, prepare: () => null, acknowledgeResolution: () => {} };
  const disableMemory = (owner, error) => {
    owner = path.resolve(workdir, owner);
    if (memories.get(owner) !== legacyMemory) console.warn(`Optional task memory unavailable for ${owner}: ${error.message}. Continuing with the preserved legacy handoff.`);
    memories.set(owner, legacyMemory);
    return legacyMemory;
  };
  const memoryFor = (owner = roadmap) => {
    owner = path.resolve(workdir, owner);
    if (!memories.has(owner)) {
      try {
        const locations = owner === roadmap ? tracking : trackingPaths(owner, tracking.file, workdir);
        const memoryTracking = { ...locations, evidenceDir: locations.evidenceDir || path.join(locations.stateDir, 'evidence') };
        memories.set(owner, new TaskMemory({ workdir, tracking: memoryTracking, roadmap: owner }));
      } catch (error) { return disableMemory(owner, error); }
    }
    return memories.get(owner);
  };
  const continuationFile = path.join(tracking.stateDir, 'continuation.json');
  let previousConversation = null;
  let continuationAvailable = options.sessionContinuation ?? options.client === 'codex';
  let continuationPersistenceFailed = false;
  try {
    if (continuationAvailable && fs.statSync(continuationFile).size <= 8192) previousConversation = JSON.parse(fs.readFileSync(continuationFile, 'utf8'));
  } catch { /* Optional conversation state never blocks a fresh invocation. */ }
  const saveContinuation = () => {
    if (continuationPersistenceFailed) return;
    try {
      if (previousConversation && continuationAvailable) atomicJson(continuationFile, previousConversation);
      else fs.rmSync(continuationFile, { force: true });
    }
    catch (error) {
      continuationPersistenceFailed = true;
      continuationAvailable = false;
      previousConversation = null;
      console.warn(`Optional conversation state unavailable: ${error.message}. Continuing with fresh sessions.`);
    }
  };
  if (!continuationAvailable) saveContinuation();
  let deferredTasks: any[] = [];
  if (!onEvent) {
    notifications = new Notifications(options, `${tracking.file}.notifications.json`);
    onEvent = event => notifications.enqueue(event);
  }
  recovery = new Recovery({ tracking, roadmap, settings: options.recovery, wait: ms => waitForRetry(ms, signal), signal, onEvent, runId: options.runId });
  await recovery.event("runner.started");
  if (!managedSleep) { sleep = new SleepInhibitor(options.preventSleep); await sleep.start(); }
  await onReady?.(tracking);
  const runs = new RunEvidence({ roadmap, tracking });
  const block = async (reason) => {
    recovery.state.blocker ||= { reason, resolutionId: randomUUID() };
    recovery.save();
    fs.writeFileSync(tracking.file, withStatus(fs.readFileSync(tracking.file, 'utf8'), 'BLOCKED'));
    await recovery.event('runner.blocked', { reason: recovery.state.blocker.reason, terminal: false });
  };
  const stopRecovery = async (reason) => {
    recovery.state.stopped = { reason, blocker: recovery.state.blocker };
    recovery.state.quota = null;
    recovery.save();
    fs.writeFileSync(tracking.file, withStatus(fs.readFileSync(tracking.file, 'utf8'), 'STOPPED'));
    await recovery.event('runner.stopped', { reason, role: 'resolver', code: 75 });
    return { code: 75, reason: 'stopped' };
  };

  console.log(`Roadmap Runner ${PACKAGE.version}`);
  console.log(`Client:    ${options.client}`);
  console.log(`Workspace: ${workdir}`);
  console.log(`Roadmap:   ${roadmap}`);
  console.log(`Progress:  ${tracking.file} (bounded handoff/evidence; task states in roadmap)`);
  console.log("Roadmap edits: adopted between sessions; stale terminal state is re-evaluated.");
  console.log(`History:   ${tracking.historyDir} (archived snapshots; not loaded by default)`);
  console.log(`Timeout:   ${options.timeout} per run`);
  console.log(`Prompt:    ${PROMPT_REVISION} (work through meaningful checkpoints)`);
  console.log(`Recovery: resolver on blockers; timeout ${options.resolverTimeout || "10m"}`);
  console.log("Press Ctrl-C to stop.");
  console.log();

  console.log(`Events:    ${recovery.eventsFile}`);
  if (!options.recoverBlocked && (recovery.state.stopped || roadmapStatus(fs.readFileSync(tracking.file, 'utf8')) === 'stopped' || roadmapStatus(fs.readFileSync(roadmap, 'utf8')) === 'stopped')) {
    await recovery.event('runner.stopped', { reason: recovery.state.stopped?.reason || 'roadmap_stopped', code: 75 });
    return { code: 75, reason: 'stopped' };
  }
  await recovery.restore({ startup: true });
  if (options.recoverBlocked) {
    delete recovery.state.stopped;
    await block('explicit_recovery');
  }
  if (recovery.state.reviewRequested || recovery.state.loopBlockedRevision) {
    await block(recovery.state.loopBlockedRevision ? 'loop_detected' : 'corrective_recovery');
    delete recovery.state.reviewRequested;
    delete recovery.state.loopBlockedRevision;
    recovery.save();
  }
  let iteration = runs.records.at(-1)?.iteration ?? 0;
  let capacityFailures = 0;
  let retryDelay = options.capacity.delayMs;

  while (true) {
    if (signal.aborted) throw Object.assign(new Error("runner interrupted"), { exitCode: 130 });
    defaultPlan?.read();
    const plan = execution || queuedDelivery || (defaultPlan?.reliable ? defaultPlan : null);
    plan?.read();
    deferredTasks = [];
    for (const task of plan?.tasks || []) {
      const memory = memoryFor(task.roadmap || roadmap);
      const latest = memory.latest(task.task || task.id);
      if (latest) plan.setContinuation(task.task || task.id, latest);
      const repeated = memory.repeatFailure(task.task || task.id, task.criteriaRevision);
      if (repeated) deferredTasks.push({ task: task.task || task.id, roadmap: task.roadmap || roadmap, criteriaRevision: task.criteriaRevision, ...repeated });
    }
    plan?.setSkippedTaskIds(deferredTasks.map(task => task.task));
    const batch = plan?.select();
    if (execution && batch && path.resolve(workdir, batch.roadmap) !== roadmap) {
      roadmap = path.resolve(workdir, batch.roadmap);
      tracking = prepareTracking(roadmap, tracking.file, workdir);
      recovery.tracking = tracking; recovery.roadmap = roadmap;
      runs.selectSource(roadmap, tracking);
    }
    tracking.refreshSource(iteration);
    tracking.assertBounded();
    const contents = fs.readFileSync(tracking.file, "utf8");
    const status = tracking.deliveryStatus(roadmapStatus(contents));
    const compacting = tracking.needsCompaction;

    const sourceStatus = roadmapStatus(fs.readFileSync(roadmap, 'utf8'));
    if (!compacting && (recovery.state.stopped || status === 'stopped' || sourceStatus === 'stopped') && !options.recoverBlocked) {
      await recovery.event('runner.stopped', { reason: recovery.state.stopped?.reason || 'roadmap_stopped', code: 75 });
      return { code: 75, reason: 'stopped' };
    }
    if (!compacting && !recovery.state.blocker && (status === 'blocked' || sourceStatus === 'blocked')) await block('roadmap_blocked');
    if (!compacting && !recovery.state.blocker && !batch && (execution || (defaultPlan?.reliable && !queuedDelivery))) {
      const schedule = plan.schedulingOutcome();
      if (schedule.status === 'blocked') await block(deferredTasks.length ? 'unchanged_failed_operation' : 'task_prerequisite_blocked');
      else if (execution && ['needs_next_batch', 'awaiting_verification'].includes(schedule.status)) {
        if (tracking.needsReconciliation || recovery.state.requiresWorker || recovery.state.quota) await block('finite_plan_reconciliation');
        else {
          recovery.success();
          await recovery.event('runner.plan_exhausted', { reason: schedule.status, schedulingState: schedule.status, code: 0, terminal: true });
          console.log(`Finite plan: ${schedule.status}. Original acceptance remains open; no resolver is needed.`);
          return { code: 0, reason: schedule.status };
        }
      }
    }
    const fallbackTaskId = `roadmap-${createHash('sha256').update(roadmap).digest('hex').slice(0, 12)}`;
    if (!compacting && !recovery.state.blocker && !plan && memoryFor().repeatFailure(fallbackTaskId, tracking.requirementsRevision)) {
      deferredTasks.push({ task: fallbackTaskId, roadmap, criteriaRevision: tracking.requirementsRevision });
      await block('unchanged_failed_operation');
    }
    const resolving = !compacting && Boolean(recovery.state.blocker);
    if (!compacting && !resolving && status === 'complete' && (!execution || execution.schedulingOutcome().status === 'complete') && !tracking.needsReconciliation && !recovery.state.quota && !recovery.state.requiresWorker) {
      previousConversation = null;
      saveContinuation();
      recovery.success();
      await recovery.event('runner.completed', { iteration });
      console.log(`Roadmap complete after ${iteration} iteration(s).`);
      return { code: 0, reason: 'complete' };
    }
    if (!resolving) await recovery.attention(contents, status, iteration);
    if (!compacting && !resolving) iteration += 1;
    const role = compacting ? "compactor" : resolving ? "resolver" : "worker";
    const sessionId = randomUUID();
    const taskId = batch?.task || fallbackTaskId;
    const taskOwner = path.resolve(workdir, batch?.roadmap || roadmap);
    const criteriaRevision = batch?.criteriaRevision || plan?.tasks.find(task => task.task === taskId)?.criteriaRevision || tracking.requirementsRevision;
    const taskMemory = memoryFor(taskOwner);
    let taskContext = null;
    if (role === 'worker') {
      try { taskContext = taskMemory.prepare({ sessionId, taskId, criteriaRevision }); }
      catch (error) { disableMemory(taskOwner, error); }
    }
    const promptRevision = compacting ? COMPACT_REVISION : resolving ? RESOLVER_REVISION : PROMPT_REVISION;
    console.log(`===== ${compacting ? "compaction before next worker; after iteration" : "iteration"} ${iteration} | ${new Date().toISOString()} =====`);

    const startedAt = new Date().toISOString();
    const started = performance.now();
    const output = runs.capture();
    const sourceRevision = tracking.sourceRevision;
    const sourceContents = fs.readFileSync(tracking.sourceSnapshot, "utf8");
    const snapshot = compacting ? tracking.archive({ kind: "before-compaction", iteration }) : null;
    const sessionTimeoutMs = compacting || resolving ? Math.min(timeoutMs, resolverTimeoutMs) : timeoutMs;
    const checkpointAtMs = checkpointDelay(sessionTimeoutMs, batch?.budgetMinutes);
    const checkpointFile = path.join(tracking.evidenceDir, `${sessionId}-checkpoint.json`);
    const checkpointAckFile = path.join(tracking.evidenceDir, `${sessionId}-checkpoint-ack.json`);
    const deadlineContext = `Soft checkpoint deadline (UTC): ${new Date(Date.now() + checkpointAtMs).toISOString()}\nHard termination deadline (UTC): ${new Date(Date.now() + sessionTimeoutMs).toISOString()}\n` +
      `Checkpoint request file: ${JSON.stringify(checkpointFile)}\n` +
      (taskContext ? `Checkpoint acknowledgment file: ${JSON.stringify(checkpointAckFile)}\nCheckpoint request ID: ${sessionId}\nAfter a checkpoint request exists, save the current structured result, then atomically write {"version":1,"requestId":"${sessionId}","resultFile":${JSON.stringify(taskContext.resultFile)}} to the acknowledgment file. Save changedFiles and exact nextAction in the result; the runner verifies acknowledgment separately from completion.\n` : '') +
      'At the soft deadline stop implementation, save exact remaining functionality, edited paths, failed/passing evidence and the next command in the current handoff, then exit. Check the clock after commands; do not start work that cannot finish before the checkpoint. Do not repeat broad discovery or unchanged checks on recovery.\n';
    const prompt = renderPrompt(PROMPT_TEMPLATE, roadmap, tracking.file, tracking.historyDir);
    const resolutionId = recovery.state.blocker?.resolutionId;
    const resolutionFile = resolving ? path.join(tracking.evidenceDir, `${sessionId}-resolution.json`) : null;
    // A unique path keeps every failed/partial decision across retries and restart.
    const iterationPrompt = compacting
      ? `${renderPrompt(COMPACT_TEMPLATE, roadmap, tracking.file, tracking.historyDir)}\n\nRunner context:\nRunner role: COMPACTOR\n${tracking.compactionContext()}\n${tracking.evidenceContext()}\nPre-compaction snapshot: ${JSON.stringify(snapshot)}\nLoaded prompt revision: ${promptRevision}\nAfter worker iteration: ${iteration}\n`
      : resolving
      ? `${renderPrompt(RESOLVER_TEMPLATE, roadmap, tracking.file, tracking.historyDir)}\n\nRunner context:\nRunner role: RESOLVER\n${tracking.sourceContext()}\n${tracking.evidenceContext()}\n${deadlineContext}Blocker reason: ${recovery.state.blocker.reason}\nResolution ID: ${resolutionId}\nResolution decision file: ${JSON.stringify(resolutionFile)}\nRun evidence JSON: ${JSON.stringify(runs.evidenceFile)}\nDeferred task evidence: ${JSON.stringify(deferredTasks)}\nFinite execution authority: ${JSON.stringify(options.executionPlan || options.deliveryPlan || null)}\nLoaded prompt revision: ${promptRevision}\n`
      : `${prompt}\n\nRunner context:\nRunner role: WORKER\n${tracking.sourceContext()}\n${batch && plan ? plan.context(batch) : ''}\n${taskContext?.context || ''}\n${tracking.evidenceContext()}\n${deadlineContext}Recovery verification required: ${recovery.state.requiresWorker ? "YES: resume the recorded unfinished files and exact next action; inspect only changed acceptance or failed evidence" : "NO"}\nPrevious checkpoint: ${recovery.state.checkpointFile ? JSON.stringify(recovery.state.checkpointFile) : "none"}\nRun evidence JSON: ${JSON.stringify(runs.evidenceFile)}\nLoaded prompt revision: ${promptRevision}\nIteration: ${iteration}\nSession started (UTC): ${startedAt}\n`;
    const implementationBefore = !compacting && !resolving && batch ? plan.observe(batch) : undefined;
    const before = tracking.contextBytes(iterationPrompt);
    const conversationScope = createHash('sha256').update(JSON.stringify({ criteriaRevision, promptRevision,
      batch: batch ? { id: batch.id, deliverable: batch.deliverable, boundary: batch.boundary, completion: batch.completion,
        sourcePointers: batch.sourcePointers, prerequisites: batch.prerequisites, phase: batch.phase } : null })).digest('hex');
    const conversation = selectContinuation({ enabled: continuationAvailable, previous: previousConversation,
      client: options.client, task: `${taskOwner}#${taskId}`, role, scopeRevision: conversationScope,
      workdir, model: options.model, effort: options.effort, executable: options.executable });
    await recovery.event("runner.turn_starting", { role, iteration, sessionId, sourceRevision, task: taskId, batch: batch?.id, contextBytes: before,
      continuation: { resumed: Boolean(conversation.resumeSessionId), reason: conversation.reason } });
    const clientOptions = {
      signal,
      onProcess: options.onProcess,
      client: options.client,
      executable: options.executable,
      prompt: iterationPrompt,
      workdir,
      model: options.model,
      effort: options.effort,
      persistSession: conversation.persistSession,
      resumeSessionId: conversation.resumeSessionId,
      timeoutMs: sessionTimeoutMs,
      checkpointAtMs,
      checkpointRequestId: sessionId,
      readCheckpointAck: taskContext ? request => readCheckpointAcknowledgment(checkpointAckFile, {
        requestId: sessionId, resultFile: taskContext.resultFile, workdir, requestedAt: request.at, taskId, criteriaRevision,
        validateResult: raw => { validateWorkerResult(raw, { sessionId, taskId, criteriaRevision }, workdir); return true; },
      }) : undefined,
      onCheckpointAck: taskContext ? async acknowledgment => {
        recovery.state.checkpointFile = checkpointAckFile; recovery.save();
        await recovery.event('runner.checkpoint_acknowledged', { role, iteration, sessionId, requestId: sessionId,
          resultFile: acknowledgment.resultFile, checkpointFile: checkpointAckFile });
      } : undefined,
      onCheckpoint: compacting ? undefined : async request => {
        const handoff = tracking.archive({ kind: 'soft-checkpoint', iteration });
        fs.writeFileSync(checkpointFile, JSON.stringify({ ...request, sessionId, task: taskId, batch: batch?.id,
          resultFile: taskContext?.resultFile, acknowledgmentFile: taskContext ? checkpointAckFile : undefined,
          sourceRevision, handoff, progressFile: tracking.file,
          instruction: 'Resume recorded unfinished work; source files are preserved in place. This controller snapshot is not an agent completion claim.' }) + '\n', { mode: 0o600 });
        recovery.state.checkpointFile = checkpointFile; recovery.save();
        await recovery.event('runner.checkpoint_requested', { role, iteration, sessionId, checkpointFile, handoff });
        return checkpointFile;
      },
      onOutput: output?.write,
    };
    let result = await runClient(clientOptions);
    if (result.resumeUnavailable && conversation.resumeSessionId) {
      // A provider-confirmed missing thread before any agent activity is a
      // transport recovery, not a failed implementation or a reason to replan.
      const failedResumeFile = path.join(tracking.evidenceDir, `${sessionId}-resume-unavailable.json`);
      const failedResumeMetrics = sessionMetrics(result, { client: options.client, effort: options.effort, startedAt,
        elapsedMs: Math.round(performance.now() - started), before, after: tracking.contextBytes(iterationPrompt) });
      atomicJson(failedResumeFile, { sessionId, task: taskId, reason: 'provider_thread_unavailable',
        requestedThreadId: conversation.resumeSessionId, code: result.code, ...failedResumeMetrics, output: output.value() });
      tracking.recordSession({ runId: recovery.runId, sessionId: randomUUID(), continuationFor: sessionId, role,
        iteration, task: taskId, code: result.code, transportAttempt: 'resume_unavailable', evidence: failedResumeFile, ...failedResumeMetrics });
      await recovery.event('runner.continuation_fallback', { role, iteration, sessionId, task: taskId,
        reason: 'provider_thread_unavailable', evidence: failedResumeFile });
      previousConversation = null;
      saveContinuation();
      conversation.resumeSessionId = null;
      conversation.reason = 'resume_unavailable';
      const elapsed = Math.round(performance.now() - started);
      result = await runClient({ ...clientOptions, resumeSessionId: null,
        timeoutMs: Math.max(1, sessionTimeoutMs - elapsed), checkpointAtMs: Math.max(1, checkpointAtMs - elapsed) });
    }

    previousConversation = rememberContinuation(previousConversation, conversation, result);
    saveContinuation();
    const workerOutcome = taskContext ? taskMemory.consume({ resultFile: taskContext.resultFile, sessionId, taskId, criteriaRevision, processResult: result }) : null;
    if (workerOutcome?.outcome) {
      plan?.setContinuation(taskId, workerOutcome.outcome);
      await recovery.event('runner.task_result', { role, iteration, sessionId, task: taskId, outcome: workerOutcome.outcome.outcome,
        resultFile: taskContext.resultFile, receiptCount: workerOutcome.outcome.receiptIds.length });
    } else if (taskContext && fs.existsSync(taskContext.resultFile)) {
      console.warn(workerOutcome.warning);
      await recovery.event('runner.task_result_invalid', { role, iteration, sessionId, task: taskId, resultFile: taskContext.resultFile, reason: 'legacy_handoff_retained' });
    }

    const elapsedMs = Math.round(performance.now() - started);
    const metrics = sessionMetrics(result, { client: options.client, effort: options.effort, startedAt, elapsedMs,
      before, after: tracking.contextBytes(iterationPrompt) });
    const receipt = { sessionId, role, iteration, sourceRevision, promptRevision, task: taskId, batch: batch?.id, code: result.code,
      taskResultFile: workerOutcome?.outcome ? taskContext.resultFile : null,
      continuation: { resumed: Boolean(conversation.resumeSessionId), reason: conversation.reason },
      timedOut: result.timedOut, interrupted: result.interrupted, ...metrics };
    tracking.recordSession({ runId: recovery.runId, ...receipt });
    await recovery.event("runner.turn_finished", receipt);
    tracking.refreshSource(iteration);
    const after = fs.readFileSync(tracking.file, "utf8");
    const afterSource = fs.readFileSync(tracking.sourceSnapshot, "utf8");
    const completedHandoff = tracking.archive({ kind: role, iteration, metadata: {
      ...receipt,
      signal: result.signal || null, timedOut: result.timedOut, interrupted: result.interrupted, usageLimit: result.usageLimit || null,
    } });
    if (!compacting && !resolving && batch) plan.remember(batch, completedHandoff, receipt);
    tracking.assertBounded();
    if (compacting && afterSource !== sourceContents) {
      recovery.requireWorker();
      fail(`source roadmap changed during handoff compaction; source and handoff preserved, original handoff at ${snapshot}. Inspect the change before restarting.`);
    }
    if (!compacting && !resolving) runs.record({
      iteration, task: taskId, batch: batch?.id, startedAt, elapsedMs, promptRevision, sourceRevision, result, output, metrics,
      outcome: workerOutcome?.outcome, usefulWork: Boolean(workerOutcome?.outcome),
      before: contents, after, implementationBefore,
      implementationAfter: batch ? plan.observe(batch) : undefined,
      sourceBefore: sourceContents, sourceAfter: afterSource,
    });
    if (result.interrupted || result.error || result.timedOut || result.retryableCapacity || result.usageLimit || result.code !== 0) recovery.requireWorker();
    if (result.interrupted) throw Object.assign(new Error("runner interrupted"), { exitCode: 130 });
    if (result.error) { if (resolving) return await stopRecovery("resolver_start_failed"); await block("worker_start_failed"); continue; }
    if (result.cleanupIncomplete) fail('Client process cleanup could not be confirmed; unfinished files preserved.', 75);
    const delivery = !compacting && !resolving && batch ? plan.finish(batch, result) : null;
    if (delivery?.delivered) await recovery.event('runner.progress_observed', {
      kind: 'implementation', task: batch.task, batch: batch.id });
    if (!compacting && !resolving && !result.usageLimit && !result.retryableCapacity) {
      recovery.state.consecutiveTimeouts = result.timedOut ? (recovery.state.consecutiveTimeouts || 0) + 1 : 0;
      if (recovery.state.consecutiveTimeouts >= 2) await block("repeated_timeout");
      recovery.save();
    }

    if (result.timedOut) {
      await recovery.event("runner.turn_limit_reached", { role, iteration });
      if (resolving) return await stopRecovery("resolver_timed_out");
      if (compacting) fail(`handoff compaction timed out; original state preserved at ${snapshot}`);
      await recovery.attention(after, tracking.deliveryStatus(roadmapStatus(after)), iteration);
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
        await recovery.event("runner.capacity_exhausted", { role, iteration });
        if (resolving) return await stopRecovery("resolver_capacity_exhausted");
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
      if (resolving) return await stopRecovery('resolver_failed');
      if (compacting) fail(`${options.client} compactor exited with code ${result.code}`, result.code || 1);
      await block('worker_failed');
      continue;
    }
    if (resolving) {
      const decision = readResolution(resolutionFile, resolutionId);
      let cleared = false;
      try {
        const sourceAfterStatus = roadmapStatus(fs.readFileSync(roadmap, 'utf8'));
        cleared = !['blocked', 'stopped'].includes(sourceAfterStatus) && roadmapStatus(after) === 'in-progress';
      } catch { /* Invalid terminal state cannot authorize further workers. */ }
      // A fresh resolver decision can authorize one revised attempt. Historical
      // failures remain recorded, but must not immediately veto that repair.
      plan?.setSkippedTaskIds([]);
      const recoveryPlan = execution || (defaultPlan?.reliable ? defaultPlan : null);
      const ready = !recoveryPlan || Boolean(recoveryPlan.select()) || recoveryPlan.schedulingOutcome().status === 'complete';
      if (!decision || decision.outcome !== 'resolved' || !cleared || !ready) return await stopRecovery(
        decision?.outcome === 'stopped' ? 'resolver_stopped' : 'blocker_unresolved');
      delete recovery.state.blocker;
      delete recovery.state.stopped;
      for (const task of deferredTasks) {
        try { memoryFor(task.roadmap).acknowledgeResolution(task.task, task.criteriaRevision, resolutionId); }
        catch (error) { disableMemory(task.roadmap, error); }
      }
      recovery.state.consecutiveTimeouts = 0;
      recovery.state.requiresWorker = true;
      recovery.success();
      recovery.save();
      await recovery.event('runner.unblocked', { role, iteration, resolutionId, resolutionFile });
      options.recoverBlocked = false;
      continue;
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
