#!/usr/bin/env node

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Recovery, recoverySettings } from "../lib/recovery.js";
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

function help() {
  console.log(`Roadmap Runner ${PACKAGE.version}

Usage:
  roadmap-runner <roadmap-file> [options]

Options:
  --client <name>        CLI client: ${CLIENT_NAMES.join(", ")}. Default: codex
  --progress-file <path> Override the bounded progress-state path; workers never edit source
  --timeout <duration>   Per-run timeout. Default: 2h
  --supervisor-every <n> Review after n workers (1-20); default 5, 0 disables
  --supervisor-timeout <duration> Review timeout; default 10m
  --model <model>        Optional client model override
  --effort <level>       Optional reasoning effort override (Codex)
  --client-bin <path>    Override the selected client executable
  --help                 Show help
  --version              Show version

Environment:
  ROADMAP_CLIENT
  ROADMAP_PROGRESS_FILE
  ROADMAP_SUPERVISOR_EVERY
  ROADMAP_SUPERVISOR_TIMEOUT
  ROADMAP_TIMEOUT
  ROADMAP_MODEL
  ROADMAP_EFFORT
  ROADMAP_CLIENT_BIN
  ROADMAP_NOTIFY_BIN         Notification executable; receives event JSON on stdin
  ROADMAP_USAGE_MAX_WAIT     Quota wait ceiling in seconds; default/max 86400
  ROADMAP_RECOVERY_DELAY     No-progress recheck delay in seconds; default 60
  ROADMAP_RECOVERY_MAX_DELAY Maximum no-progress delay in seconds; default 900
  ROADMAP_CAPACITY_RETRIES    Consecutive capacity retries; default 10
  ROADMAP_CAPACITY_DELAY      Initial delay in seconds; default 300
  ROADMAP_CAPACITY_MAX_DELAY  Maximum delay in seconds; default 300

The current directory is always the workspace.
`);
}

function fail(message, code = 1) {
  console.error(`roadmap-runner: ${message}`);
  process.exit(code);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    help();
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(PACKAGE.version);
    return;
  }

  let options;
  try {
    options = { ...parseArgs(argv), capacity: capacityRetrySettings(), recovery: recoverySettings() };
    options.supervision = supervisorSettings(options);
  } catch (error) {
    fail(error.message, error.exitCode || 1);
  }

  if (!options.roadmap) {
    help();
    process.exit(64);
  }

  const workdir = process.cwd();
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
  const recovery = new Recovery({ tracking, roadmap, settings: options.recovery });
  const supervisor = options.supervision.every ? new Supervision({
    ...options.supervision, roadmap, tracking,
    template: fs.readFileSync(path.join(ROOT, "supervisor.md"), "utf8"),
  }) : null;

  console.log(`Roadmap Runner ${PACKAGE.version}`);
  console.log(`Client:    ${options.client}`);
  console.log(`Workspace: ${workdir}`);
  console.log(`Roadmap:   ${roadmap}`);
  console.log(`Progress:  ${tracking.file} (bounded active state; source roadmap preserved)`);
  console.log("Roadmap edits: adopted between sessions; stale terminal state is re-evaluated.");
  console.log(`History:   ${tracking.historyDir} (archived snapshots; not loaded by default)`);
  console.log(`Timeout:   ${options.timeout} per run`);
  console.log(`Prompt:    ${PROMPT_REVISION} (30-minute implementation batches)`);
  console.log(`Supervisor: ${supervisor ? `every ${options.supervision.every} workers; timeout ${options.supervisorTimeout}` : "disabled"}`);
  console.log("Press Ctrl-C to stop.");
  console.log();

  console.log(`Events:    ${recovery.eventsFile}`);
  await recovery.restore({ startup: true });

  let iteration = 0;
  let capacityFailures = 0;
  let retryDelay = options.capacity.delayMs;

  while (true) {
    tracking.refreshSource(iteration);
    tracking.assertBounded();
    const contents = fs.readFileSync(tracking.file, "utf8");
    const status = roadmapStatus(contents);

    if (status === "complete" && !tracking.needsReconciliation && !recovery.state.quota && !recovery.state.requiresWorker) {
      recovery.success();
      await recovery.event("runner.completed", { iteration });
      console.log(`Roadmap complete after ${iteration} iteration(s).`);
      process.exit(0);
    }

    await recovery.attention(contents, status, iteration);

    const blockedRecovery = status === "blocked" && !tracking.needsReconciliation;
    if (blockedRecovery) {
      console.warn("Roadmap reported BLOCKED; continuing in recovery mode instead of stopping.");
      console.warn("The next worker must defer stuck gates, re-check dependencies, and advance any other useful work.");
    }

    // Reconcile a controller revision before trusting terminal state or old reviews.
    if (supervisor?.due && !tracking.needsReconciliation) {
      console.log(`===== supervisor after iteration ${iteration} =====`);
      console.log(`Run evidence: ${supervisor.evidenceFile}`);
      await supervisor.review({ options, workdir, afterIteration: iteration, recovery });
      continue; // Re-read the supervisor's handoff/status before another worker.
    }

    iteration += 1;
    console.log(`===== iteration ${iteration} | ${new Date().toISOString()} =====`);

    const startedAt = new Date().toISOString();
    const started = performance.now();
    const output = supervisor?.capture();
    const sourceRevision = tracking.sourceRevision;
    const iterationPrompt = `${prompt}\n\nRunner context:\nRunner role: WORKER\n${tracking.sourceContext()}\nRecovery verification required: ${recovery.state.requiresWorker ? "YES: re-evaluate any terminal status or completion evidence left by the interrupted/failed session before selecting work" : "NO"}\nBlocked recovery mode: ${blockedRecovery ? "YES" : "NO"}\nLoaded prompt revision: ${PROMPT_REVISION}\nIteration: ${iteration}\nSession started (UTC): ${new Date().toISOString()}\n`;
    const result = await runClient({
      client: options.client,
      executable: options.executable,
      prompt: iterationPrompt,
      workdir,
      model: options.model,
      effort: options.effort,
      timeoutMs,
      onOutput: output?.write,
    });

    tracking.refreshSource(iteration);
    const elapsedMs = Math.round(performance.now() - started);
    const after = fs.readFileSync(tracking.file, "utf8");
    tracking.archive({ kind: "worker", iteration, metadata: {
      startedAt, elapsedMs, promptRevision: PROMPT_REVISION, sourceRevision, code: result.code,
      signal: result.signal || null, timedOut: result.timedOut, interrupted: result.interrupted, usageLimit: result.usageLimit || null,
    } });
    tracking.assertBounded();
    supervisor?.record({
      iteration, startedAt, elapsedMs, promptRevision: PROMPT_REVISION, sourceRevision, result, output,
      before: contents, after,
    });
    if (result.interrupted || result.error || result.timedOut || result.retryableCapacity || result.usageLimit || result.code !== 0) recovery.requireWorker();
    if (result.interrupted) process.exit(130);
    if (result.error) fail(`failed to start ${options.client}: ${result.error.message}`);

    if (result.timedOut) {
      await recovery.attention(after, roadmapStatus(after), iteration);
      await recovery.idle(contents, after, sourceRevision !== tracking.sourceRevision);
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
        fail("model capacity retry limit reached; partial work preserved.", 75);
      }
      capacityFailures += 1;
      const waiting = waitForRetry(retryDelay);
      console.log(`Model at capacity; retry ${capacityFailures}/${options.capacity.retries} in ${retryDelay / 1000}s (same model).`);
      if (await waiting) process.exit(130);
      retryDelay = Math.min(retryDelay * 2, options.capacity.maxDelayMs);
      continue;
    }
    capacityFailures = 0;
    retryDelay = options.capacity.delayMs;

    if (result.code !== 0) {
      await recovery.event("runner.failed", { role: "worker", iteration, code: result.code });
      fail(`${options.client} exited with code ${result.code}; stopping.`, result.code || 1);
    }

    recovery.success({ worker: true });
    tracking.finishWorker(sourceRevision, result);
    await recovery.attention(after, roadmapStatus(after), iteration);
    if (roadmapStatus(after) !== "complete" || tracking.needsReconciliation) {
      await recovery.idle(contents, after, sourceRevision !== tracking.sourceRevision);
    }
    console.log(`Iteration ${iteration} completed.`);
    console.log();
  }
}

main().catch((error) => {
  console.error("roadmap-runner:", error);
  process.exit(error.exitCode || 1);
});
