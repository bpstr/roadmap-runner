import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";
import { Recovery, recoverySettings, resetFromText, usageObserver, usageLimitFromMessage } from "../lib/recovery.js";

const cli = fileURLToPath(new URL("../bin/roadmap-runner.js", import.meta.url));
const DAY = 86400000;
const initial = Date.parse("2026-10-07T08:00:00Z");
function fixture(t, settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roadmap-recovery-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tracking = { file: path.join(dir, "progress.md") };
  let now = initial;
  const waits = [];
  const config = { tracking, roadmap: path.join(dir, "roadmap.md"), settings: { ...recoverySettings({}), ...settings }, now: () => now, wait: async ms => { waits.push(ms); now += ms; return false; } };
  const recovery = new Recovery(config);
  return { dir, recovery, config, waits, setNow: value => { now = value; }, events: () => fs.readFileSync(recovery.eventsFile, "utf8").trim().split("\n").map(JSON.parse) };
}

test("reset clocks honor IANA timezone, next-day and dated weekly resets", () => {
  assert.equal(resetFromText("You've hit your limit · resets 2pm (Europe/Budapest)", initial), Date.parse("2026-10-07T12:00:00Z"));
  assert.equal(resetFromText("resets 9am (Europe/Budapest)", initial), Date.parse("2026-10-08T07:00:00Z"));
  assert.equal(resetFromText("resets Oct 12, 9:30am (Europe/Budapest)", initial), Date.parse("2026-10-12T07:30:00Z"));
  assert.equal(resetFromText("resets 14:15 (UTC)", initial), Date.parse("2026-10-07T14:15:00Z"));
  assert.equal(resetFromText("resets 14pm (UTC)", initial), null);
  assert.equal(resetFromText("resets 2pm (Imaginary/Zone)", initial), null);
  assert.equal(resetFromText("resets at 2026-10-07T09:00:00Z", initial), initial + 3600000);
});

test("quota observation distinguishes error events from model prose and advisory limits", () => {
  const observer = usageObserver(() => initial);
  observer.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "You've hit your limit" } }) + "\n");
  observer.write(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: initial / 1000 + 10 } }) + "\n");
  assert.equal(observer.result().limit, null);
  const text = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: initial / 1000 + 20 } });
  observer.write(text.slice(0, 20)); observer.write(text.slice(20) + "\n");
  observer.write(JSON.stringify({ type: "result", is_error: true, result: "You've hit your limit" }));
  assert.deepEqual(observer.result(), { limit: { kind: "weekly", resetAt: initial + 20000 }, failed: true });
  assert.equal(usageLimitFromMessage("Authentication failed", initial), null);
});

test("short quota pauses restore and use one persistent incident budget", async t => {
  const f = fixture(t);
  await f.recovery.pause({ kind: "session", resetAt: initial + 5 * 3600000 }, "worker");
  assert.deepEqual(f.waits, [5 * 3600000]);
  const resumed = new Recovery(f.config);
  assert.equal(resumed.state.quota.deadline, initial + DAY);
  await assert.rejects(resumed.pause({ kind: "weekly", resetAt: initial + 7 * DAY }, "supervisor"), error => error.exitCode === 75);
  assert.deepEqual(f.waits, [5 * 3600000, 19 * 3600000]);
  assert.equal(f.events().at(-1).type, "runner.usage_wait_expired");
  assert.equal(resumed.state.quota.deadline, initial + DAY);
  f.setNow(initial + 7 * DAY);
  const afterReset = new Recovery(f.config);
  await afterReset.restore({ startup: true });
  assert.equal(afterReset.state.quota, null);
  assert.equal(afterReset.state.requiresWorker, true);
  afterReset.success({ worker: true });
  assert.equal(afterReset.state.requiresWorker, false);
});

test("lowering the wait ceiling persists the shortened deadline across another restart", async t => {
  const f = fixture(t);
  f.config.wait = async () => true;
  const paused = new Recovery(f.config);
  await assert.rejects(paused.pause({ kind: "session", resetAt: initial + 3600000 }, "worker"));
  f.config.settings.quotaWaitMs = 1000;
  const lowered = new Recovery(f.config);
  await assert.rejects(lowered.restore(), error => error.exitCode === 130);
  f.setNow(initial + 500);
  assert.equal(new Recovery(f.config).state.quota.deadline, initial + 1000);
});

test("unknown reset fallbacks are five hours/session and at most one day/weekly", async t => {
  const f = fixture(t);
  await f.recovery.pause({ kind: "session", resetAt: null }, "worker");
  assert.equal(f.waits[0], 5 * 3600000);
  f.recovery.success();
  await assert.rejects(f.recovery.pause({ kind: "weekly", resetAt: null }, "worker"), error => error.exitCode === 75);
  assert.equal(f.waits[1], DAY);
});

test("interrupts preserve the quota checkpoint and never renew its deadline", async t => {
  const f = fixture(t);
  f.config.wait = async () => true;
  const interrupted = new Recovery(f.config);
  await assert.rejects(interrupted.pause({ kind: "session", resetAt: initial + 1000 }, "worker"), error => error.exitCode === 130);
  const restored = new Recovery(f.config);
  assert.equal(restored.state.quota.deadline, initial + DAY);
  await assert.rejects(restored.restore(), error => error.exitCode === 130);
});

test("changed attention flags notify once, remain unfinished, and clear on recovery", async t => {
  const f = fixture(t);
  const flags = "Status: IN_PROGRESS\n- [ ] A build\n- BLOCKED A: database | Unblock: credentials | Retry: supplied\n- SKIPPED B: depends A | Unblock: A done | Retry: complete\n";
  await f.recovery.attention(flags, "in-progress", 1);
  await new Recovery(f.config).attention(flags, "in-progress", 2);
  assert.equal(f.events().length, 1);
  assert.deepEqual(f.events()[0].items, [{ status: "BLOCKED", task: "A" }, { status: "SKIPPED", task: "B" }]);
  assert.ok(!JSON.stringify(f.events()).includes("credentials"));
  await f.recovery.attention(flags.replace("database", "new blocker"), "in-progress", 3);
  await f.recovery.attention("Status: IN_PROGRESS", "in-progress", 4);
  assert.equal(f.events().at(-1).type, "runner.unblocked");
});

test("unchanged workers back off with a bounded delay and reset after changed evidence", async t => {
  const f = fixture(t, { delayMs: 10, maxDelayMs: 20 });
  for (let i = 0; i < 5; i++) await f.recovery.idle("unchanged", "unchanged");
  assert.deepEqual(f.waits, [10, 20, 20, 20]);
  await f.recovery.idle("before", "after");
  assert.equal(f.recovery.state.idle, 0);
  await f.recovery.idle("same", "same", true);
  assert.equal(f.recovery.state.idle, 0);
});

test("wait settings reject zero, invalid input and values above one day", () => {
  for (const value of ["0", "86401", "NaN", "Infinity", "-1"]) assert.throws(() => recoverySettings({ ROADMAP_USAGE_MAX_WAIT: value }));
  assert.throws(() => recoverySettings({ ROADMAP_RECOVERY_DELAY: "20", ROADMAP_RECOVERY_MAX_DELAY: "10" }));
});

function cliFixture(t, client, mode) {
  const f = fixture(t);
  fs.writeFileSync(f.config.roadmap, "# Roadmap\nStatus: IN_PROGRESS\n## Tasks\n- [ ] A\n- [ ] B\n");
  const mock = path.join(f.dir, "worker.cjs");
  fs.writeFileSync(mock, `#!/usr/bin/env node
const fs = require('node:fs');
const prompt = process.argv.at(-1);
const progress = prompt.match(/Tracking file \\(progress \\/ delivery evidence\\):\\s*\\n\\s*([^\\n]+)/)[1].trim();
const count = fs.existsSync('count') ? Number(fs.readFileSync('count')) + 1 : 1;
fs.writeFileSync('count', String(count));
if (count === 1) {
  fs.appendFileSync(progress, '\\n- BLOCKED A: external input | Unblock: answer | Retry: answer arrives\\n');
  if (${JSON.stringify(mode)} === 'quota-complete') fs.writeFileSync(progress, fs.readFileSync(progress, 'utf8').replace('IN_PROGRESS', 'COMPLETE')); 
  if (${JSON.stringify(mode)} === 'blocked') fs.writeFileSync(progress, fs.readFileSync(progress, 'utf8').replace('IN_PROGRESS', 'BLOCKED'));
  else {
    const reset = ${JSON.stringify(mode)} === 'weekly' ? Date.now() / 1000 + 7 * 86400 : Date.now() / 1000 + 1;
    if (${JSON.stringify(client)} === 'claude') {
      console.log(JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'rejected',rateLimitType:${JSON.stringify(mode)} === 'weekly' ? 'seven_day' : 'five_hour',resetsAt:reset}}));
      console.log(JSON.stringify({type:'result',is_error:true,result:"You've hit your limit"}));
    } else { console.log(JSON.stringify({type:'error',message:"You've hit your limit · resets at " + new Date(reset * 1000).toISOString()})); process.exitCode = 1; }
  }
} else {
  fs.writeFileSync('independent-built', 'yes');
  if (${JSON.stringify(mode)} === 'blocked') {
    fs.writeFileSync(progress, fs.readFileSync(progress, 'utf8').replace('BLOCKED', 'IN_PROGRESS'));
    process.exitCode = 9; // End this prepared scenario with A still unfinished.
  } else fs.writeFileSync(progress, fs.readFileSync(progress, 'utf8').replace('IN_PROGRESS', 'COMPLETE'));
}
`);
  fs.chmodSync(mock, 0o755);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ROADMAP_")));
  return { ...f, args: [cli, f.config.roadmap, "--progress-file", f.config.tracking.file, "--client", client, "--client-bin", mock, "--supervisor-every", "0"], options: { cwd: f.dir, env: { ...env, ROADMAP_USAGE_MAX_WAIT: mode === "weekly" ? "1" : "10" }, encoding: "utf8", timeout: 10000 } };
}

for (const client of ["codex", "claude"]) test(`${client} CLI quota pauses then restores a fresh worker`, t => {
  const f = cliFixture(t, client, "short");
  const result = spawnSync(process.execPath, f.args, f.options);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.dir, "count"), "utf8"), "2");
  assert.ok(f.events().some(e => e.type === "runner.usage_paused"));
  assert.ok(f.events().some(e => e.type === "runner.completed"));
});

test("a terminal status left by a quota session must be verified by the next worker", t => {
  const f = cliFixture(t, "claude", "quota-complete");
  const result = spawnSync(process.execPath, f.args, f.options);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.dir, "count"), "utf8"), "2");
});

test("weekly CLI quota expires at the configured ceiling without another provider attempt", t => {
  const f = cliFixture(t, "claude", "weekly");
  const result = spawnSync(process.execPath, f.args, f.options);
  assert.equal(result.status, 75, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.dir, "count"), "utf8"), "1");
  assert.match(fs.readFileSync(f.config.tracking.file, "utf8"), /BLOCKED A/);
  assert.equal(f.events().at(-1).type, "runner.usage_wait_expired");
});

test("blocked CLI emits notification and executes the next worker for independent work", t => {
  const f = cliFixture(t, "codex", "blocked");
  const hook = path.join(f.dir, "notify.cjs");
  fs.writeFileSync(hook, "#!/usr/bin/env node\nlet input=''; process.stdin.on('data', c => input+=c); process.stdin.on('end', () => { require('node:fs').appendFileSync('notifications', JSON.parse(input).type + '\\n'); process.exitCode=1; });\n");
  fs.chmodSync(hook, 0o755);
  f.options.env.ROADMAP_NOTIFY_BIN = hook;
  const result = spawnSync(process.execPath, f.args, f.options);
  assert.equal(result.status, 9, result.stderr);
  assert.ok(fs.existsSync(path.join(f.dir, "independent-built")));
  assert.match(fs.readFileSync(path.join(f.dir, "notifications"), "utf8"), /runner.blocked/);
});

test("SIGINT during a real quota wait exits promptly and keeps state for restart", async t => {
  const f = cliFixture(t, "claude", "weekly");
  f.options.env.ROADMAP_USAGE_MAX_WAIT = "30";
  const child = spawn(process.execPath, f.args, { ...f.options, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let output = "";
  const exited = new Promise(resolve => child.once("exit", resolve));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("missing quota wait")), 5000);
    child.stdout.on("data", chunk => { output += chunk; if (output.includes("Usage limit:")) { clearTimeout(timer); resolve(); } });
  });
  child.kill("SIGINT");
  assert.equal(await exited, 130);
  assert.equal(fs.readFileSync(path.join(f.dir, "count"), "utf8"), "1");
  assert.ok(JSON.parse(fs.readFileSync(f.recovery.stateFile, "utf8")).quota);
});
