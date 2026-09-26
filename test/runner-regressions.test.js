import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { roadmapStatus, runClient } from "../lib/runner.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin/roadmap-runner.js");
const runnerUrl = pathToFileURL(path.join(root, "lib/runner.js")).href;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-regression-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const statusCases = [
  ["fenced completion example", "# Roadmap\nStatus: IN_PROGRESS\n\n```md\nStatus: COMPLETE\n```", "in-progress"],
  ["historical blocker", "# Roadmap\nStatus: COMPLETE\n\n## History\nStatus: BLOCKED", "complete"],
  ["historical completion", "Status: BLOCKED\n### History\nStatus: COMPLETE", "blocked"],
  ["long backtick fence", "````md\n```\n## Not a section\nStatus: BLOCKED\n````\nStatus: COMPLETE", "complete"],
  ["tilde fence", "~~~md\nStatus: BLOCKED\n~~~\nStatus: COMPLETE", "complete"],
  ["BOM and CRLF", "\uFEFF# Roadmap\r\nStatus:\tcomplete \r\n## Tasks\r\n", "complete"],
  ["indented example", "    Status: COMPLETE\n", "in-progress"],
  ["status only in a section", "# Roadmap\n## History\nStatus: COMPLETE", "in-progress"],
  ["uninitialized roadmap", "# Roadmap\n\n- [ ] Work to do", "in-progress"],
];
for (const [name, contents, expected] of statusCases) {
  test(`header status: ${name}`, () => assert.equal(roadmapStatus(contents), expected));
}

for (const contents of [
  "Status: IN_PROGRESS\nStatus: COMPLETE",
  "Status: COMPLETE\nStatus: COMPLETE",
]) {
  test(`reject duplicate header: ${contents.replaceAll("\n", " / ")}`, () => {
    assert.throws(() => roadmapStatus(contents), /multiple roadmap header status/);
  });
}
for (const contents of ["Status: DONE", "Status:\nCOMPLETE"]) {
  test(`reject invalid header: ${contents.replaceAll("\n", " / ")}`, () => {
    assert.throws(() => roadmapStatus(contents), /invalid roadmap header status/);
  });
}

test("a documentation example cannot skip the three real worker iterations", (t) => {
  const dir = workspace(t);
  const roadmap = path.join(dir, "roadmap.md");
  fs.copyFileSync(path.join(root, "examples/three-iteration-roadmap.md"), roadmap);
  fs.appendFileSync(roadmap, "\n## Status example\n\n```md\nStatus: COMPLETE\n```\n");
  const result = spawnSync(process.execPath, [cli, roadmap, "--client", "codex", "--client-bin",
    path.join(root, "test/fixtures/mock-codex.js")], {
    cwd: dir, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout.match(/^===== iteration /gm) || []).length, 3, result.stdout);
  assert.equal((fs.readFileSync(roadmap, "utf8").match(/- \[x\] EX-/g) || []).length, 3);
});

test("conflicting header statuses fail before starting a worker", (t) => {
  const dir = workspace(t);
  const roadmap = path.join(dir, "roadmap.md");
  fs.writeFileSync(roadmap, "Status: IN_PROGRESS\nStatus: COMPLETE\n");
  const result = spawnSync(process.execPath, [cli, roadmap, "--client", "codex", "--client-bin",
    path.join(root, "test/fixtures/mock-codex.js")], {
    cwd: dir, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /multiple roadmap header status/);
  assert.doesNotMatch(result.stdout, /===== iteration /);
});

// Run cancellation in a separate runner process, never signal the test runner.
// Each leaf has an emergency lifetime limit; after hooks also kill its group.
async function shutdownFixture(t, { stdio, signal, repeat = false, client = "codex" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-shutdown-"));
  const leaf = path.join(dir, "leaf.cjs");
  const worker = path.join(dir, "worker.cjs");
  const driver = path.join(dir, "driver.mjs");
  fs.writeFileSync(leaf, `const fs = require('node:fs');
process.on('SIGTERM', () => {});
let count = 0;
const beat = () => fs.writeFileSync('heartbeat', String(++count));
beat();
setInterval(beat, 10);
setTimeout(() => process.exit(0), 10000);
fs.writeFileSync('ready', 'yes');
`);
  fs.writeFileSync(worker, `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
fs.writeFileSync('group.pid', String(process.pid));
process.on('SIGTERM', () => {
  fs.writeFileSync('leader-exited', 'yes');
  process.exit(0);
});
spawn(process.execPath, [${JSON.stringify(leaf)}], { stdio: ${JSON.stringify(stdio)} });
setInterval(() => {}, 1000);
`);
  fs.chmodSync(worker, 0o755);
  fs.writeFileSync(driver, `import fs from 'node:fs';
import { runClient } from ${JSON.stringify(runnerUrl)};
const result = await runClient({ client: ${JSON.stringify(client)}, executable: ${JSON.stringify(worker)},
  prompt: '', workdir: ${JSON.stringify(dir)}, timeoutMs: ${signal ? 10000 : 1000},
  terminationGraceMs: 150, interruptGraceMs: 150 });
fs.writeFileSync('settled-heartbeat', fs.readFileSync('heartbeat'));
console.log('RESULT ' + JSON.stringify({ code: result.code, timedOut: result.timedOut, interrupted: result.interrupted }));
`);
  const child = spawn(process.execPath, [driver], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  const killGroup = () => {
    try { process.kill(-Number(fs.readFileSync(path.join(dir, "group.pid"), "utf8")), "SIGKILL"); } catch {}
  };
  t.after(() => {
    killGroup();
    child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const completion = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killGroup();
      child.kill("SIGKILL");
      reject(new Error(`shutdown did not finish: ${stdout}\n${stderr}`));
    }, 6000);
    child.once("close", (code) => { clearTimeout(timer); resolve(code); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  if (signal) {
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(path.join(dir, "ready")) && Date.now() < deadline) await pause(10);
    assert.ok(fs.existsSync(path.join(dir, "ready")), "leaf must be ready before cancellation");
    child.kill(signal);
    if (repeat) {
      await pause(30);
      child.kill(signal);
    }
  }
  assert.equal(await completion, 0, stderr);
  assert.ok(fs.existsSync(path.join(dir, "leader-exited")), "leader exited on SIGTERM");
  const result = JSON.parse(stdout.match(/^RESULT (.+)$/m)?.[1] || "null");
  assert.ok(result, stdout);
  assert.equal(result.timedOut, !signal);
  assert.equal(result.interrupted, Boolean(signal));
  // Check the exact resolution boundary, then a new worker invocation.
  const settled = fs.readFileSync(path.join(dir, "settled-heartbeat"), "utf8");
  const observer = path.join(dir, "observer.cjs");
  fs.writeFileSync(observer, `#!/usr/bin/env node
const fs = require('node:fs');
setTimeout(() => {
  if (fs.readFileSync('heartbeat', 'utf8') !== ${JSON.stringify(settled)}) process.exitCode = 9;
}, 150);
`);
  fs.chmodSync(observer, 0o755);
  if (!signal) {
    const next = await runClient({ client: "codex", executable: observer, prompt: "", workdir: dir, timeoutMs: 2000 });
    assert.equal(next.code, 0, "previous leaf must not write during the next invocation");
  } else {
    await pause(150);
  }
  assert.equal(fs.readFileSync(path.join(dir, "heartbeat"), "utf8"), settled,
    "no descendant writes after runClient resolves");
}

for (const config of [
  { name: "timeout with ignored descendant stdio", stdio: "ignore" },
  { name: "timeout with inherited descendant pipes", stdio: "inherit" },
  { name: "SIGINT after the leader closes", stdio: "ignore", signal: "SIGINT" },
  { name: "SIGTERM with inherited pipes", stdio: "inherit", signal: "SIGTERM" },
  { name: "repeated SIGINT", stdio: "ignore", signal: "SIGINT", repeat: true },
  { name: "text adapter cancellation", stdio: "ignore", signal: "SIGINT", client: "claude" },
]) {
  test(config.name, { skip: process.platform === "win32" }, (t) => shutdownFixture(t, config));
}

test("spawn failure removes its signal listeners", async (t) => {
  const dir = workspace(t);
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const result = await runClient({ client: "codex", executable: path.join(dir, "missing"),
    prompt: "", workdir: dir, timeoutMs: 1000 });
  assert.equal(result.error?.code, "ENOENT");
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
});

test("final capacity JSON without a newline is drained before resolving", { skip: process.platform === "win32" }, async (t) => {
  const dir = workspace(t);
  const mock = path.join(dir, "capacity.cjs");
  fs.writeFileSync(mock, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:'error',message:'Selected model is at capacity'}));
process.exitCode = 1;
`);
  fs.chmodSync(mock, 0o755);
  const result = await runClient({ client: "codex", executable: mock, prompt: "", workdir: dir, timeoutMs: 1000 });
  assert.equal(result.retryableCapacity, true);
});
