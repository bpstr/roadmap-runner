import { usageObserver, usageLimitFromMessage } from "./recovery.js";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { buildClientInvocation, CLIENT_NAMES } from "./clients.js";

export function parseDuration(value) {
  const match = /^([1-9][0-9]*)(ms|s|m|h)?$/i.exec(value);
  if (!match) throw new Error(`invalid timeout: ${value}`);
  const amount = Number(match[1]);
  const unit = (match[2] || "s").toLowerCase();
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
  const result = amount * scale;
  if (!Number.isSafeInteger(result)) throw new Error(`timeout is too large: ${value}`);
  return result;
}

export function roadmapStatus(contents) {
  // Only the opening header is control state; sections and fenced examples are not.
  let status = null;
  let fence = null;
  for (const line of contents.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[\\t ]*$`).test(line)) fence = null;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) {
      fence = opening[1];
      continue;
    }
    if (/^ {0,3}#{2,6}(?:[\t ]|$)/.test(line)) break;
    if (!/^ {0,3}Status:/i.test(line)) continue;
    const match = /^ {0,3}Status:[\t ]*(IN_PROGRESS|COMPLETE|BLOCKED)[\t ]*$/i.exec(line);
    if (!match) throw new Error("invalid roadmap header status: use IN_PROGRESS, COMPLETE, or BLOCKED");
    if (status !== null) throw new Error("multiple roadmap header status lines: keep exactly one");
    status = match[1].toLowerCase().replace("_", "-");
  }
  // Existing roadmaps without a status can still be initialized by the worker.
  return status || "in-progress";
}

export function commandExists(command) {
  if (path.isAbsolute(command) || command.includes(path.sep)) return fs.existsSync(command);

  const probe = process.platform === "win32"
    ? spawnSync("where", [command], { stdio: "ignore" })
    : spawnSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", command], { stdio: "ignore" });

  return probe.status === 0;
}

function terminateTree(child, signal = "SIGTERM") {
  if (!child?.pid) return;

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
      // Already exited.
    }
  }
}

function processGroupExists(child) {
  if (!child?.pid) return false;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function streamClientJson(stdout, onError, format) {
  let buffer = "";

  const consume = (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      const kind = event?.type;

      if (kind === "item.completed" && event?.item?.type === "agent_message") {
        const text = event.item.text || "";
        if (text) process.stdout.write(text.endsWith("\n") ? text : text + "\n");
      } else if (format === "claude-json" && kind === "assistant") {
        for (const block of event.message?.content || []) {
          if (block.type === "text" && block.text) process.stdout.write(block.text + "\n");
        }
      } else if (format === "claude-json" && kind === "result" && event.is_error) {
        process.stderr.write(`Claude error: ${event.result || (event.errors || []).join("; ")}\n`);
      } else if (kind === "error" || kind === "turn.failed") {
        const error = event?.error ?? event;
        const message = typeof error === "object" && error !== null
          ? error.message || JSON.stringify(error)
          : String(error);
        onError(message, event);
        process.stderr.write(`Codex error: ${message}\n`);
      }
    } catch {
      process.stdout.write(line + "\n");
    }
  };

  stdout.setEncoding("utf8");
  stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      consume(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  });
  stdout.on("end", () => {
    if (buffer) consume(buffer);
  });
}

export async function runClient({
  client,
  executable,
  prompt,
  workdir,
  model,
  effort,
  timeoutMs,
  terminationGraceMs = 120_000,
  interruptGraceMs = 3000,
  onOutput,
}) {
  const invocation = buildClientInvocation({
    client,
    executable,
    prompt,
    workdir,
    model,
    effort,
  });

  return await new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: workdir,
      detached: process.platform !== "win32",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const usage = usageObserver();
    let failureTail = "";
    child.stdout.on("data", chunk => usage.write(chunk));
    child.stderr.on("data", chunk => { failureTail = (failureTail + chunk.toString()).slice(-65536); });
    if (invocation.output === "text") {
      child.stdout.pipe(process.stdout, { end: false });
      child.stderr.pipe(process.stderr, { end: false });
    }
    if (onOutput) {
      child.stdout.on("data", (chunk) => onOutput("stdout", chunk));
      child.stderr.on("data", (chunk) => onOutput("stderr", chunk));
    }

    const stderrTail = [];
    let capacityError = false;
    let otherError = false;
    if (invocation.output !== "text") {
      streamClientJson(child.stdout, (message, event) => {
        if (message.toLowerCase().includes("selected model is at capacity")) capacityError = true;
        else if (!usageLimitFromMessage([message, event.error?.code, event.error?.type, event.code].filter(Boolean).join(" "))) otherError = true;
      }, invocation.output);
      child.stderr.setEncoding("utf8");
      let stderrBuffer = "";
      child.stderr.on("data", (chunk) => {
        stderrBuffer = (stderrBuffer + chunk).slice(-65536);
        const lines = stderrBuffer.split("\n");
        stderrBuffer = lines.pop() || "";
        for (const line of lines) {
          stderrTail.push(line.slice(-4096));
          if (stderrTail.length > 40) stderrTail.shift();
        }
      });
      child.stderr.on("end", () => {
        if (stderrBuffer) {
          stderrTail.push(stderrBuffer.slice(-4096));
          if (stderrTail.length > 40) stderrTail.shift();
        }
      });
    }

    let timedOut = false;
    let interrupted = false;
    let hardKillTimer = null;
    let closedResult = null;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onInterrupt);
    };

    const finish = () => {
      if (settled || !closedResult) return;
      // close drains stdio, but does not prove that descendants with ignored or
      // inherited terminal stdio have stopped. Keep the escalation alive.
      if (hardKillTimer && processGroupExists(child)) return;
      settled = true;
      cleanup();
      const { code, signal } = closedResult;
      if ((code ?? 1) !== 0 && stderrTail.length) {
        process.stderr.write(stderrTail.join("\n") + "\n");
      }
      const observed = usage.result();
      const usageLimit = otherError ? null : observed.limit || (code !== 0 ? usageLimitFromMessage(failureTail) : null);
      resolve({
        code: observed.failed && !code ? 1 : code ?? (signal ? 1 : 0),
        usageLimit,
        retryableCapacity: code === 1 && capacityError && !otherError,
        signal,
        timedOut,
        interrupted,
        invocation,
      });
    };

    const forceKill = () => {
      if (hardKillTimer) clearTimeout(hardKillTimer);
      hardKillTimer = null;
      // The process group can outlive its leader. Signal it even after close.
      terminateTree(child, "SIGKILL");
      finish();
    };

    const stop = (graceMs) => {
      clearTimeout(timeoutTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      terminateTree(child, "SIGTERM");
      // Deliberately referenced: a closed leader must not let the runner exit
      // before the remaining group receives SIGKILL.
      hardKillTimer = setTimeout(forceKill, graceMs);
      finish();
    };

    const onInterrupt = () => {
      if (interrupted) {
        forceKill();
        return;
      }
      interrupted = true;
      process.stderr.write("\nStopping Roadmap Runner...\n");
      stop(interruptGraceMs);
    };

    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onInterrupt);

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      stop(terminationGraceMs);
    }, timeoutMs);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code: 1, error, timedOut: false, interrupted, invocation });
    });

    child.once("close", (code, signal) => {
      closedResult = { code, signal };
      finish();
    });
  });
}

export function parseArgs(argv, env = process.env) {
  const options = {
    roadmap: "",
    progressFile: env.ROADMAP_PROGRESS_FILE || "",
    supervisorEvery: env.ROADMAP_SUPERVISOR_EVERY ?? "5",
    supervisorTimeout: env.ROADMAP_SUPERVISOR_TIMEOUT || "10m",
    client: env.ROADMAP_CLIENT || "codex",
    timeout: env.ROADMAP_TIMEOUT || "2h",
    model: env.ROADMAP_MODEL || "",
    effort: env.ROADMAP_EFFORT || "",
    executable: env.ROADMAP_CLIENT_BIN || env.ROADMAP_CODEX || "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    const take = (name) => {
      i += 1;
      if (i >= argv.length) throw Object.assign(new Error(`${name} requires a value`), { exitCode: 64 });
      return argv[i];
    };

    if (arg === "--client") options.client = take("--client");
    else if (arg === "--progress-file") {
      options.progressFile = take(arg);
      if (!options.progressFile.trim() || options.progressFile.startsWith("--")) {
        throw Object.assign(new Error("--progress-file requires a path"), { exitCode: 64 });
      }
    } else if (arg === "--timeout") options.timeout = take("--timeout");
    else if (arg === "--supervisor-every") options.supervisorEvery = take(arg);
    else if (arg === "--supervisor-timeout") options.supervisorTimeout = take(arg);
    else if (arg === "--model") options.model = take("--model");
    else if (arg === "--effort") options.effort = take("--effort");
    else if (arg === "--client-bin" || arg === "--codex") options.executable = take(arg);
    else if (arg.startsWith("-")) throw Object.assign(new Error(`unknown option: ${arg}`), { exitCode: 64 });
    else if (!options.roadmap) options.roadmap = arg;
    else throw Object.assign(new Error("only one roadmap file may be supplied"), { exitCode: 64 });
  }

  if (!CLIENT_NAMES.includes(options.client)) {
    throw Object.assign(
      new Error(`unsupported client "${options.client}". Choose: ${CLIENT_NAMES.join(", ")}`),
      { exitCode: 64 },
    );
  }

  return options;
}

export function capacityRetrySettings(env = process.env) {
  const number = (key, fallback) => {
    const text = env[key] ?? String(fallback);
    if (!/^(0|[1-9][0-9]{0,3})$/.test(text)) throw new Error(`${key} must be an integer from 0 to 9999`);
    return Number(text);
  };
  const retries = number("ROADMAP_CAPACITY_RETRIES", 10);
  const delay = number("ROADMAP_CAPACITY_DELAY", 300);
  const maxDelay = number("ROADMAP_CAPACITY_MAX_DELAY", 300);
  if (delay < 1 || maxDelay < delay) throw new Error("capacity delays must satisfy 1 <= delay <= maximum delay");
  return { retries, delayMs: delay * 1000, maxDelayMs: maxDelay * 1000 };
}

export { waitForRetry } from "./wait.js";
