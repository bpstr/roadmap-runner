#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const VERSION = "0.3.0";

function printHelp() {
  console.log(`Roadmap Runner ${VERSION}

Usage:
  roadmap-runner <roadmap-file> [options]

Run from the workspace Codex should operate in. process.cwd() is always the
Codex working directory. The roadmap may be relative to it or absolute.

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

function durationMs(value) {
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

const PROMPT = (roadmap) => `Work on this implementation roadmap:

${roadmap}

This is one fresh-context iteration. The roadmap and current filesystem are the
handoff to the next session. The working directory may contain multiple repositories.
Read repository instructions and preserve unrelated changes.

Select the acceptance gate:

1. Read the maintained Markdown checkbox checklist and compact current handoff
   near the top of the roadmap. Consult historical entries for evidence, not as
   a competing task list. If no checklist exists, create one from the original roadmap
   existing acceptance gates without changing their scope or deleting history.
2. Resume the current handoff active unchecked gate. If none is named, choose the first
   dependency-ready unchecked gate in roadmap order. Before editing, state its
   exact checkbox ID/text, acceptance criteria and necessary prerequisites.
3. Compare the last two iteration records. Resolve the missing active-gate
   dependency when it is authorized and feasible; size or difficulty alone is
   not a blocker. If it needs unavailable access, an external service, user
   judgment or another unmet dependency, leave its checkbox open and record the
   evidence, unblock condition and next ready checkbox. Continue other useful
   authorized work in this invocation if coding has not started, or hand it off
   for the next iteration after finishing the current coherent batch.
4. Revisit a deferred gate only when its unblock condition changes or a planned
   bounded retry is due. Keep a compact deferred-gates list in the handoff so
   fresh contexts do not repeat discovery or silently forget the original gate.
   Resume it when ready; do not replace its criteria with smaller adjacent tests.

Implement and verify:

- Complete one coherent acceptance gate or an explicit child task toward it,
  including necessary cross-repository changes and integration checks. If a gate
  is too large for one invocation, break it into ordered, independently verifiable
  child checkboxes with stable IDs under the same parent. Select the next ready
  child and finish it. Size and difficulty require decomposition, not deferral.
  Stop after the selected coherent gate or child batch is complete.
- A local prerequisite or prepared component test does not close an end-to-end
  gate. Keep the parent unchecked until its full stated criteria pass; record
  prerequisite progress with child checkboxes under that parent. Child completion
  is measurable progress, not a replacement for the full parent acceptance gate.
- Add follow-up checkboxes for discoveries, repairs and missing verification only
  when necessary to satisfy an original requirement. Each must identify its
  original parent ID, the exact acceptance criterion it serves, a concrete result
  and verification. Keep scope, permissions and completion standards unchanged.
  Record unrelated opportunities separately as out of scope; do not add them to
  the actionable checklist or treat them as completion dependencies.
- Finish the coding batch before validation. Reuse passing evidence for unchanged
  code and environments; rerun only failed or invalidated checks after repairs.
- Inspect executed, passed, failed and skipped counts. A skipped check is not a
  pass. Distinguish prepared tests, actual integration and deployed behavior.
- Use existing authorization for tests and side effects. An unchecked deployment
  or live-provider gate does not itself authorize publication or spending.
- Do not use subagents. Use Git only inside the applicable repositories.

Update the roadmap and stop this invocation:

- The roadmap is the durable progress-tracking and handoff artifact. You may edit
  it as needed to accurately preserve progress, decomposition, evidence, blockers
  and the next action for a completely fresh session.
- Maintain - [ ] for incomplete gates and - [x] only for gates whose stated
  acceptance criteria passed. Preserve IDs, unresolved criteria and dated failures.
- Maintain a compact Checked-item status log in the roadmap for every existing
  checked item: ID, current implemented/verified/deployed status, evidence link,
  and last status change or review date. Carry forward valid prior evidence without
  rerunning unchanged checks. Log newly checked children and each status transition
  in the dated iteration record. If new evidence invalidates a checked item,
  reopen it with the reason and retain its previous completion/failure history.
  A checked local prerequisite does not imply its parent or deployment is complete.
- Replace a compact Current handoff near the top with: active checkbox, criteria
  closed this iteration, remaining criteria, blocker/dependency, verification
  results (including skips), deferred gates with unblock conditions, and the
  exact next ready checkbox. Preserve historical records below it. Continue the
  unfinished active gate unless its documented blocker makes another gate ready.
- Summarize concrete changes and checks; explain any scope change. If no gate
  closed, identify the material prerequisite advanced and how it reduces the
  remaining work. Repeated rediscovery, extra notes or adjacent tests alone
  are not progress toward the active gate.
- Before declaring the entire roadmap blocked, inspect ALL remaining unchecked
  gates and their dependencies for useful authorized implementation, repair or
  verification work. One blocked gate, a failed check, a hard task or one
  no-progress attempt is not enough: diagnose and repair, or move to a genuinely
  ready gate with the deferral recorded. Avoid repeatedly running unchanged checks.
- Treat Status: BLOCKED as a last-resort global dead-end, not a normal per-task
  outcome. Do not set it while ANY other remaining gate or prerequisite can make
  material progress with current authorization and resources.
- Set Status: BLOCKED only when no remaining gate or prerequisite can materially
  advance within existing authorization and available resources. Record every
  remaining gate blocking dependency and the exact external unblock action.
  Otherwise keep Status: IN_PROGRESS and hand off the next actionable checkbox.
- Set Status: COMPLETE only when every original gate and its required in-scope
  follow-up/child checkboxes are implemented and verified. New children must neither
  broaden original scope nor hide unfinished original acceptance criteria.
  Otherwise use Status: IN_PROGRESS when material progress permits continuation.
  Maintain exactly one of these status lines near the top of the roadmap.
`;

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

  args.push(PROMPT(options.roadmap));
  return args;
}

function commandExists(command) {
  const probe = process.platform === "win32"
    ? spawnSync("where", [command], { stdio: "ignore" })
    : spawnSync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", command], { stdio: "ignore" });
  return probe.status === 0;
}

function terminateTree(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", signal === "SIGKILL" ? "/F" : ""].filter(Boolean), {
      stdio: "ignore",
    });
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

async function runCodex(options, workdir, timeout) {
  return await new Promise((resolve) => {
    const child = spawn(options.codex, codexArgs(options, workdir), {
      cwd: workdir,
      stdio: "inherit",
      detached: process.platform !== "win32",
      env: process.env,
    });

    let timedOut = false;
    let interrupted = false;

    const hardKill = () => {
      terminateTree(child, "SIGKILL");
    };

    const onInterrupt = () => {
      interrupted = true;
      console.log("\nStopping Roadmap Runner...");
      terminateTree(child, "SIGTERM");
      setTimeout(hardKill, 3000).unref();
    };

    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);

    const timer = setTimeout(() => {
      timedOut = true;
      terminateTree(child, "SIGTERM");
      setTimeout(hardKill, 120_000).unref();
    }, timeout);

    child.once("error", (error) => {
      clearTimeout(timer);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onInterrupt);
      resolve({ code: 1, error, timedOut: false, interrupted });
    });

    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onInterrupt);
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

  const timeout = durationMs(options.timeout);

  console.log(`Roadmap Runner ${VERSION}`);
  console.log(`Workspace: ${workdir}`);
  console.log(`Roadmap:   ${options.roadmap}`);
  console.log(`Timeout:   ${options.timeout} per run`);
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

    const result = await runCodex(options, workdir, timeout);

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
