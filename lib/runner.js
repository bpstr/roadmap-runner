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
  if (/^Status:\s*BLOCKED\s*$/mi.test(contents)) return "blocked";
  if (/^Status:\s*COMPLETE\s*$/mi.test(contents)) return "complete";
  return "in-progress";
}

export function commandExists(command) {
  if (path.isAbsolute(command) || command.includes(path.sep)) return fs.existsSync(command);

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
      // Already exited.
    }
  }
}

function streamCodexJson(stdout) {
  let buffer = "";

  const consume = (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      const kind = event?.type;

      if (kind === "item.completed" && event?.item?.type === "agent_message") {
        const text = event.item.text || "";
        if (text) process.stdout.write(text.endsWith("\n") ? text : text + "\n");
      } else if (kind === "error" || kind === "turn.failed") {
        const error = event?.error ?? event;
        const message = typeof error === "object" && error !== null
          ? error.message || JSON.stringify(error)
          : String(error);
        process.stderr.write(`Codex error: ${message}\n`);
      }
    } catch {
      process.stderr.write(line + "\n");
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
      stdio: invocation.output === "codex-json"
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "inherit", "inherit"],
    });

    const stderrTail = [];
    if (invocation.output === "codex-json") {
      streamCodexJson(child.stdout);
      child.stderr.setEncoding("utf8");
      let stderrBuffer = "";
      child.stderr.on("data", (chunk) => {
        stderrBuffer += chunk;
        const lines = stderrBuffer.split("\n");
        stderrBuffer = lines.pop() || "";
        for (const line of lines) {
          stderrTail.push(line);
          if (stderrTail.length > 40) stderrTail.shift();
        }
      });
      child.stderr.on("end", () => {
        if (stderrBuffer) {
          stderrTail.push(stderrBuffer);
          if (stderrTail.length > 40) stderrTail.shift();
        }
      });
    }

    let timedOut = false;
    let interrupted = false;
    let hardKillTimer = null;

    const scheduleHardKill = (delayMs) => {
      if (hardKillTimer) clearTimeout(hardKillTimer);
      hardKillTimer = setTimeout(() => terminateTree(child, "SIGKILL"), delayMs);
      hardKillTimer.unref();
    };

    const onInterrupt = () => {
      interrupted = true;
      process.stderr.write("\nStopping Roadmap Runner...\n");
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
      if (hardKillTimer) clearTimeout(hardKillTimer);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onInterrupt);
    };

    child.once("error", (error) => {
      cleanup();
      resolve({ code: 1, error, timedOut: false, interrupted, invocation });
    });

    child.once("exit", (code, signal) => {
      cleanup();
      if ((code ?? 1) !== 0 && stderrTail.length) {
        process.stderr.write(stderrTail.join("\n") + "\n");
      }
      resolve({
        code: code ?? (signal ? 1 : 0),
        signal,
        timedOut,
        interrupted,
        invocation,
      });
    });
  });
}

export function parseArgs(argv, env = process.env) {
  const options = {
    roadmap: "",
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
    else if (arg === "--timeout") options.timeout = take("--timeout");
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
