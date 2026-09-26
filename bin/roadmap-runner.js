#!/usr/bin/env node

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
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
  --timeout <duration>   Per-run timeout. Default: 2h
  --model <model>        Optional client model override
  --effort <level>       Optional reasoning effort override (Codex)
  --client-bin <path>    Override the selected client executable
  --help                 Show help
  --version              Show version

Environment:
  ROADMAP_CLIENT
  ROADMAP_TIMEOUT
  ROADMAP_MODEL
  ROADMAP_EFFORT
  ROADMAP_CLIENT_BIN
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
    options = { ...parseArgs(argv), capacity: capacityRetrySettings() };
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

  const prompt = PROMPT_TEMPLATE.replaceAll("{{ROADMAP}}", roadmap);

  console.log(`Roadmap Runner ${PACKAGE.version}`);
  console.log(`Client:    ${options.client}`);
  console.log(`Workspace: ${workdir}`);
  console.log(`Roadmap:   ${roadmap}`);
  console.log(`Timeout:   ${options.timeout} per run`);
  console.log(`Prompt:    ${PROMPT_REVISION} (30-minute implementation batches)`);
  console.log("Press Ctrl-C to stop.");
  console.log();

  let iteration = 0;
  let capacityFailures = 0;
  let retryDelay = options.capacity.delayMs;

  while (true) {
    const contents = fs.readFileSync(roadmap, "utf8");
    const status = roadmapStatus(contents);

    if (status === "complete") {
      console.log(`Roadmap complete after ${iteration} iteration(s).`);
      process.exit(0);
    }

    if (status === "blocked") {
      console.error("Roadmap globally blocked; resolve the recorded blocker before restarting.");
      process.exit(3);
    }

    iteration += 1;
    console.log(`===== iteration ${iteration} | ${new Date().toISOString()} =====`);

    const iterationPrompt = `${prompt}\n\nRunner context:\nLoaded prompt revision: ${PROMPT_REVISION}\nIteration: ${iteration}\nSession started (UTC): ${new Date().toISOString()}\n`;
    const result = await runClient({
      client: options.client,
      executable: options.executable,
      prompt: iterationPrompt,
      workdir,
      model: options.model,
      effort: options.effort,
      timeoutMs,
    });

    if (result.interrupted) process.exit(130);
    if (result.error) fail(`failed to start ${options.client}: ${result.error.message}`);

    if (result.timedOut) {
      console.log(`Iteration ${iteration} hit the ${options.timeout} limit; starting a fresh session.`);
      console.log();
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
      fail(`${options.client} exited with code ${result.code}; stopping.`, result.code || 1);
    }

    console.log(`Iteration ${iteration} completed.`);
    console.log();
  }
}

main().catch((error) => {
  console.error("roadmap-runner:", error);
  process.exit(1);
});
