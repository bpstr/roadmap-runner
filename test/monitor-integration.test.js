import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RunManager } from "../dist/run-manager.js";
import { monitorCommand } from "../dist/monitor-cli.js";
import { monitorConfig, monitorRoot } from "../dist/monitor-config.js";
function prepared() {
  const fs = require("node:fs");
  const prompt = process.argv.at(-1);
  const source = JSON.parse(prompt.match(/^Live roadmap[^:]*: (.+)$/m)[1]);
  const progress = prompt
    .match(
      /Tracking file \(progress \/ delivery evidence\):\s*\n\s*([^\n]+)/,
    )[1]
    .trim();
  const calls = fs.existsSync("calls.json")
    ? JSON.parse(fs.readFileSync("calls.json", "utf8"))
    : [];
  calls.push({
    role: prompt.match(/^Runner role: (.+)$/m)[1],
    monitorKeyPresent: "ROADMAP_MONITOR_API_KEY" in process.env,
  });
  fs.writeFileSync("calls.json", JSON.stringify(calls));
  if (calls.length > 3) throw new Error("Fixture must not repeat work");
  const binding = JSON.parse(prompt.match(/^Result binding: (.+)$/m)[1]);
  fs.writeFileSync(
    JSON.parse(prompt.match(/^Optional structured result file: (.+)$/m)[1]),
    JSON.stringify({
      version: 1,
      ...binding,
      operation: "Added expiry checks",
      outcome: "implemented",
      completed: ["Prepared acceptance"],
      remaining: [],
      nextAction: "Review acceptance",
      changedFiles: [],
      receiptIds: [],
      findings: [],
    }),
  );
  fs.writeFileSync(
    source,
    fs.readFileSync(source, "utf8").replaceAll("- [ ]", "- [x]"),
  );
  fs.writeFileSync(
    progress,
    "Status: COMPLETE\n## Current handoff\nPrepared fixture complete.\n",
  );
}
async function until(read) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Fixture timed out");
}
test("foreground, detached and queues register automatically with unchanged prepared-provider call counts", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "runner-monitor-integration-"),
  );
  const reports = [];
  const saved = Object.fromEntries(
    [
      "ROADMAP_STATE_DIR",
      "ROADMAP_MONITOR",
      "ROADMAP_MONITOR_URL",
      "ROADMAP_MONITOR_API_KEY",
    ].map((k) => [k, process.env[k]]),
  );
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const report = JSON.parse(body);
    reports.push(report);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        installation_id: "00000000-0000-4000-8000-000000000001",
        protocol_versions: [1],
        accepted_sequence: report.report_sequence ?? 0,
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.ROADMAP_STATE_DIR = path.join(root, "registry");
  process.env.ROADMAP_MONITOR_URL = `http://127.0.0.1:${server.address().port}/ingest`;
  process.env.ROADMAP_MONITOR_API_KEY =
    "rm_" + "a".repeat(16) + "_" + "b".repeat(64);
  t.after(async () => {
    if (process.env.MONITOR_REPORT_FIXTURE)
      fs.writeFileSync(
        process.env.MONITOR_REPORT_FIXTURE,
        JSON.stringify(reports, null, 2),
      );
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function run(name, enabled, foreground = true, queued = false) {
    process.env.ROADMAP_MONITOR = enabled ? "on" : "off";
    const workspace = path.join(root, name);
    fs.mkdirSync(workspace);
    const source = path.join(workspace, "auth.md");
    const next = path.join(workspace, "second.md");
    fs.writeFileSync(
      source,
      "# Authentication\n\n### Task API-8: Validate session expiry\n- [ ] API-8 Validate expiry\nDependencies: none\nAcceptance: Prepared fixture behavior.\n",
    );
    fs.writeFileSync(
      next,
      "# Next\n\n### Task API-9: Verify logout\n- [ ] API-9 Verify logout\nDependencies: none\nAcceptance: Prepared fixture behavior.\n",
    );
    const executable = path.join(workspace, "prepared.cjs");
    fs.writeFileSync(
      executable,
      "#!/usr/bin/env node\n(" + prepared.toString() + ")();\n",
      { mode: 0o755 },
    );
    const manager = new RunManager(workspace, process.env.ROADMAP_STATE_DIR);
    const started = await manager.start(
      {
        workspace,
        roadmap: source,
        timeout: "5s",
        notify: "off",
        sessionContinuation: false,
        ...(queued ? { queue: [{ roadmap: next }] } : {}),
      },
      { executable },
      foreground,
    );
    const result = foreground
      ? started
      : await until(async () => {
          const r = await manager.status(started.id);
          return r.endedAt && r;
        });
    assert.equal(result.reason, "complete");
    assert.equal(result.exitCode, 0);
    if (enabled) {
      await until(() =>
        reports.find((r) => r.source_run_id === result.id && r.run?.terminal),
      );
      const config = monitorConfig();
      const lock = path.join(
        monitorRoot(),
        "outbox",
        config.connectionId,
        result.id + ".json.publisher",
      );
      await until(() => !fs.existsSync(lock));
    }
    const calls = JSON.parse(
      fs.readFileSync(path.join(workspace, "calls.json"), "utf8"),
    );
    assert.ok(calls.every((c) => c.role === "WORKER" && !c.monitorKeyPresent));
    return { result, calls };
  }
  const baseline = await run("baseline", false);
  const live = await run("foreground", true);
  assert.equal(live.calls.length, baseline.calls.length);
  assert.equal(live.calls.length, 1);
  const detached = await run("detached", true, false);
  assert.equal(detached.calls.length, 1);
  const queue = await run("queue", true, true, true);
  assert.equal(queue.calls.length, 2);
  assert.equal(queue.result.queue.length, 2);
  const streamIds = new Set(
    reports.filter((r) => r.kind !== "probe").map((r) => r.source_run_id),
  );
  assert.equal(streamIds.size, 3);
  assert.ok(
    reports.some(
      (r) => r.activity?.text === "Working on API-8 · Validate session expiry",
    ),
    JSON.stringify(
      reports
        .filter((r) => r.activity)
        .map((r) => ({
          activity: r.activity,
          role: r.run.role,
          task: r.run.task_id,
        })),
    ).slice(0, 3000),
  );
  assert.ok(
    reports.some(
      (r) =>
        r.last_update?.text === "Added expiry checks" ||
        r.events?.some(
          (e) =>
            e.type === "runner.task_result" && e.text === "Added expiry checks",
        ),
    ),
  );
  assert.ok(
    reports
      .filter((r) => r.run?.terminal)
      .every((r) => r.kind === "replay" && !r.run.heartbeat_expected),
  );
  const before = new Set(
    reports.filter((r) => r.source_run_id).map((r) => r.source_run_id),
  );
  await monitorCommand(["test", "--json"]);
  assert.equal(
    new Set(reports.filter((r) => r.source_run_id).map((r) => r.source_run_id))
      .size,
    before.size,
  );
  const configured = await new Promise((resolve, reject) => {
    const cli = spawn(process.execPath, [
      fileURLToPath(new URL("../bin/roadmap-runner.js", import.meta.url)),
      "monitor", "configure", "--url", process.env.ROADMAP_MONITOR_URL,
      "--api-key-stdin", "--label", "Prepared laptop", "--json",
    ], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    cli.stdout.on("data", chunk => { stdout += chunk; });
    cli.stderr.on("data", chunk => { stderr += chunk; });
    cli.on("error", reject);
    cli.on("close", code => {
      if (code !== 0) reject(new Error(`configure exited ${code}: ${stderr}`));
      else resolve(stdout);
    });
    cli.stdin.end(process.env.ROADMAP_MONITOR_API_KEY + "\n");
  });
  const status = JSON.parse(configured);
  assert.equal(status.enabled, true);
  assert.equal(status.verified, true);
  assert.equal(status.installation_id, "00000000-0000-4000-8000-000000000001");
  assert.ok(!configured.includes(process.env.ROADMAP_MONITOR_API_KEY));
  assert.equal(monitorConfig().label, "Prepared laptop");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(monitorRoot(), "config.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(monitorRoot()).mode & 0o777, 0o700);
  }
  assert.equal(new Set(reports.filter(r => r.source_run_id).map(r => r.source_run_id)).size, before.size);
});
