#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
const VERSION = PACKAGE.version;
const PROMPT_TEMPLATE = fs.readFileSync(path.join(PACKAGE_ROOT, "prompt.md"), "utf8");

function printHelp() {
  console.log(`Roadmap Runner ${VERSION}

Usage:
  roadmap-runner <roadmap-file> [options]

Run from the workspace Codex should operate in. The current directory is always
the Codex working directory. The roadmap may be relative to it or absolute.

Options:
  --timeout <duration>   Per-Codex-run limit. Default: 2h
  --model <model>        Override the configured Codex model
  --effort <level>       Override model reasoning effort
  --codex <path>         Codex executable. Default: codex
  --help                 Show help
  --version              Show version

Environment:
  ROADMAP_TIMEOUT
  ROADMAP_MODEL
  ROADMAP_EFFORT
  ROADMAP_CODEX
`);
}

function fail(message, code = 1) {
  console.error(`roadmap-runner: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const options = {
    timeout: process.env.ROADMAP_TIMEOUT || "2h",
    model: process.env.ROADMAP_MODEL || "",
    effort: process.env.ROADMAP_EFFORT || "",
    codex: process.env.ROADMAP_CODEX || "codex",
    roadmap: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--version" || arg === "-v") {
      console.log(VERSION);
      process.exit(0);
    }

    const takeValue = (name) => {
      i += 1;
      if (i >= argv.length) fail(`${name} requires a value`, 64);
      return argv[i];
    };

    if (arg === "--timeout") {
      options.timeout = takeValue("--timeout");
    } else if (arg === "--model") {
      options.model = takeValue("--model");
    } else if (arg === "--effort") {
      options.effort = takeValue("--effort");
    } else if (arg === "--codex") {
      options.codex = takeValue("--codex");
    } else if (arg.startsWith("-")) {
      fail(`unknown option: ${arg}`, 64);
    } else if (!options.roadmap) {
      options.roadmap = arg;
    } else {
      fail("only one roadmap file may be supplied", 64);
    }
  }

  if (!options.roadmap) {
    printHelp();
    process.exit(64);
  }

  return options;
}

function parseDuration(value) {
  const match = /^([1-9][0-9]*)(ms|s|m|h)?$/i.exec(value);
  if (!match) fail(`invalid timeout: ${value}`);
  const amount = Number(match[1]);
  const unit = (match[2] || "s").toLowerCase();
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
  const result = amount * scale;
  if (!Number.isSafeInteger(result)) fail(`timeout is too large: ${value}`);
  return result;
}

function roadmapStatus(file) {
  let contents;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch (error) {
    fail(`cannot read roadmap: ${error.message}`);
  }

  if (/^Status:\s*BLOCKED\s*$/mi.test(contents)) return "blocked";
  if (/^Status:\s*COMPLETE\s*$/mi.test(contents)) return "complete";
  return "in-progress";
}

function workerPrompt(roadmap) {
  return PROMPT_TEMPLATE.replaceAll("{{ROADMAP}}", roadmap);
}

function codexArgs(options, workdir) {
  const args = [
    "exec",
    "--approve-for-me",
    "--skip-git-repo-check",
    "--ephemeral",
    "--cd",
    workdir,
  ];

  if (options.model) args.push("--model", options.model);
  if (options.effort) {
    args.push("-c", `model_reasoning_effort="${options.effort}"`);
  }

  args.push(workerPrompt(options.roadmap));
  return args;
}

function commandExists(command) {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    return fs.existsSync(command);
  }

  const probe = process.platform === "win32"
    ? spawnSync("where", [command], { stdio: "ignore" })
    : spawnSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", command], { stdio: "ignore" });
  return probe.status === 0;
}

function terminateTree(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32") {
    const args = ["/PID", String(child.pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    spawnSync("taskkill", args, { stdio: "ignore" });
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process already exited.
    }
  }
}

async function runCodex(options, workdir, timeoutMs) {
  return await new Promise((resolve) => {
    const child = spawn(options.codex, codexArgs(options, workdir), {
      cwd: workdir,
      stdio: "inherit",
      detached: process.platform !== "win32",
      env: process.env,
    });

    let timedOut = false;
    let interrupted = false;
    let hardKillTimer = null;

    const clearHardKill = () => {
      if (hardKillTimer) clearTimeout(hardKillTimer);
    };

    const scheduleHardKill = (delayMs) => {
      clearHardKill();
      hardKillTimer = setTimeout(() => terminateTree(child, "SIGKILL"), delayMs);
      hardKillTimer.unref();
    };

    const onInterrupt = () => {
      interrupted = true;
      console.log("\nStopping Roadmap Runner...");
      terminateTree(child, "SIGTERM");
      scheduleHardKill(3000);
    };

    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateTree(child, "SIGTERM");
      scheduleHardKill(120_000);
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearHardKill();
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onInterrupt);
    };

    child.once("error", (error) => {
      cleanup();
      resolve({ code: 1, error, timedOut: false, interrupted });
    });

    child.once("exit", (code, signal) => {
      cleanup();
      resolve({
        code: code ?? (signal ? 1 : 0),
        signal,
        timedOut,
        interrupted,
      });
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workdir = process.cwd();

  options.roadmap = path.isAbsolute(options.roadmap)
    ? path.normalize(options.roadmap)
    : path.resolve(workdir, options.roadmap);

  if (!fs.existsSync(options.roadmap) || !fs.statSync(options.roadmap).isFile()) {
    fail(`roadmap not found: ${options.roadmap}`);
  }

  if (!commandExists(options.codex)) {
    fail(`Codex executable not found: ${options.codex}`);
  }

  const timeoutMs = parseDuration(options.timeout);

  console.log(`Roadmap Runner ${VERSION}`);
  console.log(`Workspace: ${workdir}`);
  console.log(`Roadmap:   ${options.roadmap}`);
  console.log(`Timeout:   ${options.timeout} per Codex run`);
  console.log("Approvals: automatic review (--approve-for-me)");
  console.log("Press Ctrl-C to stop.");
  console.log();

  let iteration = 0;

  while (true) {
    const status = roadmapStatus(options.roadmap);

    if (status === "complete") {
      console.log(`Roadmap complete after ${iteration} iteration(s).`);
      process.exit(0);
    }

    if (status === "blocked") {
      console.error("Roadmap globally blocked; resolve the recorded external blockers before restarting.");
      process.exit(3);
    }

    iteration += 1;
    console.log(`===== iteration ${iteration} | ${new Date().toISOString()} =====`);

    const result = await runCodex(options, workdir, timeoutMs);

    if (result.interrupted) process.exit(130);

    if (result.error) {
      fail(`failed to start Codex: ${result.error.message}`);
    }

    if (result.timedOut) {
      console.log(`Iteration ${iteration} hit the ${options.timeout} limit; starting a fresh session.`);
      console.log();
      continue;
    }

    if (result.code !== 0) {
      fail(`Codex exited with code ${result.code}; stopping.`, result.code || 1);
    }

    console.log(`Iteration ${iteration} completed.`);
    console.log();
  }
}

main().catch((error) => {
  console.error("roadmap-runner:", error);
  process.exit(1);
});
