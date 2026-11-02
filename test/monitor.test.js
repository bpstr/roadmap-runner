import { appendEvent } from '../dist/events.js';
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MonitorReporter,
  flushMonitor,
  projectMonitor,
  terminalOutcome,
  monitorText,
} from "../dist/monitor.js";
import {
  configureMonitor,
  readMonitorConfig,
  diagnostics,
} from "../dist/monitor-config.js";
import { parseRoadmapTasks, taskDisplayTitle } from "../lib/task-index.js";
import { withoutMonitorCredentials } from "../lib/monitor-environment.js";
const key = "rm_" + "a".repeat(16) + "_" + "b".repeat(64);
const installation = "00000000-0000-4000-8000-000000000001";
const config = {
  version: 1,
  endpoint: "http://127.0.0.1:1/monitor-ingest",
  apiKey: key,
  installationId: installation,
  connectionId: "test-connection",
  enabled: true,
  verified: true,
};
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-monitor-test-"));
  const previous = process.env.ROADMAP_STATE_DIR;
  process.env.ROADMAP_STATE_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.ROADMAP_STATE_DIR;
    else process.env.ROADMAP_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    id: "a".repeat(24),
    token: "private-token",
    workspace: root,
    roadmap: path.join(root, "auth.md"),
    progressFile: path.join(root, "progress.md"),
    processState: "running",
    roadmapState: "in_progress",
    waitReason: null,
    createdAt: new Date().toISOString(),
    heartbeat: new Date().toISOString(),
    pid: process.pid,
    options: { secret: "no upload" },
    sequence: 0,
    role: "worker",
    iteration: 8,
    task: "API-8",
    sourceRevision: "revision-1",
    queue: [
      {
        roadmap: path.join(root, "auth.md"),
        progressFile: "private",
        state: "running",
      },
    ],
    queueIndex: 0,
  };
}
const response = (sequence = 1) =>
  new Response(
    JSON.stringify({
      installation_id: installation,
      accepted_sequence: sequence,
      protocol_versions: [1],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
test("projection allowlists fields, preserves task activity time, and omits paths and credentials", (t) => {
  const r = fixture(t);
  const state = {
    sequence: 0,
    sessionId: "session-1",
    taskId: "API-8",
    title: "Validate expiry",
    activityAt: "2026-11-02T10:00:00Z",
  };
  const report = projectMonitor(r, state);
  const next = projectMonitor(r, state);
  assert.equal(report.activity.text, "Working on API-8 · Validate expiry");
  assert.equal(report.activity.observed_at, next.activity.observed_at);
  assert.equal(next.report_sequence, 2);
  assert.ok(!JSON.stringify(report).includes(r.workspace));
  assert.ok(!JSON.stringify(report).includes("private-token"));
  assert.equal(report.run.task_id, "API-8");
  r.role = "resolver";
  assert.match(projectMonitor(r, state).activity.text, /^Resolving/);
  r.role = "worker";
  r.task = "roadmap-abcdef";
  assert.equal(projectMonitor(r, state).run.task_id, null);
  assert.ok(!monitorText(`${key} /Users/private/project`).includes(key));
  assert.equal(
    withoutMonitorCredentials({ PATH: "/bin", ROADMAP_MONITOR_API_KEY: key })
      .ROADMAP_MONITOR_API_KEY,
    undefined,
  );
});
test("terminal outcomes never infer completion from code zero", (t) => {
  const r = fixture(t);
  r.exitCode = 0;
  r.reason = "deferred";
  assert.equal(terminalOutcome(r), "deferred");
  r.reason = "complete";
  assert.equal(terminalOutcome(r), "failed");
  r.roadmapState = "complete";
  assert.equal(terminalOutcome(r), "completed");
});
test("task titles use the selected parsed section or parent checkbox without another scan", () => {
  const index = parseRoadmapTasks(
    "### Task API-8: Validate session expiry\n- [ ] API-8 Acceptance\nDependencies: none\n",
  );
  assert.equal(taskDisplayTitle(index.tasks[0]), "Validate session expiry");
  const flat = parseRoadmapTasks("- [ ] **API-8** Validate expiry\n", {
    parentIds: ["API-8"],
  });
  assert.equal(taskDisplayTitle(flat.tasks[0]), "Validate expiry");
});
test("reporter holds one request in flight and preserves terminal delivery during a pending heartbeat", async (t) => {
  const record = fixture(t);
  const sent = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let first = true;
  let active = 0,
    max = 0;
  const reporter = new MonitorReporter(record, {
    config,
    timers: false,
    transport: async (_url, options) => {
      active++;
      max = Math.max(max, active);
      const report = JSON.parse(options.body);
      sent.push(report);
      if (first) {
        first = false;
        await gate;
      }
      active--;
      return response(report.report_sequence);
    },
  });
  const pending = reporter.send();
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = reporter.send();
  record.reason = "complete";
  record.roadmapState = "complete";
  record.processState = "exited";
  const finish = reporter.finish();
  release();
  await Promise.all([pending, duplicate, finish]);
  assert.equal(max, 1);
  assert.equal(sent.at(-1).run.terminal, true);
  assert.equal(sent.at(-1).run.terminal_outcome, "completed");
  assert.equal(fs.existsSync(reporter.file + ".publisher"), false);
});
test("outage keeps terminal outcome durable and never changes runner exit code", async (t) => {
  const record = fixture(t);
  record.reason = "deferred";
  record.exitCode = 0;
  const reporter = new MonitorReporter(record, {
    config,
    timers: false,
    transport: async () => {
      throw new Error("fixture offline");
    },
  });
  await reporter.finish();
  const saved = JSON.parse(fs.readFileSync(reporter.file, "utf8"));
  assert.equal(saved.terminal.kind, "replay");
  assert.equal(saved.terminal.run.heartbeat_expected, false);
  assert.equal(record.exitCode, 0);
  assert.equal(saved.terminal.run.terminal_outcome, "deferred");
});
test("validated result is separate from current activity and cleared on session change", async (t) => {
  const record = fixture(t);
  const reporter = new MonitorReporter(record, {
    config,
    timers: false,
    transport: async () => response(),
  });
  reporter.event({
    id: "start-1",
    sequence: 1,
    type: "runner.turn_starting",
    role: "worker",
    task: "API-8",
    sessionId: "session-1",
    sourceRevision: "revision-1",
    activityTitle: "Validate expiry",
    at: record.createdAt,
  });
  await reporter.pending;
  reporter.event({
    id: "result-1",
    sequence: 2,
    type: "runner.task_result",
    role: "worker",
    task: "API-8",
    sessionId: "session-1",
    sourceRevision: "revision-1",
    operation: "Added expiry checks",
    outcome: "partial",
    at: record.createdAt,
  });
  assert.equal(
    projectMonitor(record, reporter.state).last_update.text,
    "Added expiry checks",
  );
  assert.equal(
    projectMonitor(record, reporter.state).activity.text,
    "Working on API-8 · Validate expiry",
  );
  record.role = "resolver";
  reporter.event({
    id: "resolver-1",
    sequence: 3,
    type: "runner.turn_starting",
    role: "resolver",
    sessionId: "session-2",
    sourceRevision: "revision-1",
    at: record.createdAt,
  });
  assert.equal(projectMonitor(record, reporter.state).last_update, null);
  record.reason = "stopped";
  await reporter.finish();
});
test("configuration masks keys, survives replacement failures, and saves offline setup unverified", async (t) => {
  fixture(t);
  await configureMonitor(config.endpoint, key, "Laptop", async () =>
    response(),
  );
  assert.equal(readMonitorConfig().verified, true);
  const old = readMonitorConfig();
  await assert.rejects(() =>
    configureMonitor(
      config.endpoint,
      key.replace(/b/g, "c"),
      undefined,
      async () => new Response("", { status: 401 }),
    ),
  );
  assert.equal(readMonitorConfig().apiKey, old.apiKey);
  assert.ok(!JSON.stringify(diagnostics(readMonitorConfig())).includes(key));
  await configureMonitor(
    "https://offline.example/ingest",
    key,
    undefined,
    async () => {
      throw new Error("network");
    },
  );
  assert.equal(readMonitorConfig().verified, false);
  assert.notEqual(readMonitorConfig().connectionId, old.connectionId);
});

test('automatic historical retry is limited to one verified destination and never claims liveness', async t => {
  const record = fixture(t);
  await configureMonitor(config.endpoint, key, undefined, async () => response());
  const saved = readMonitorConfig();
  for (const id of ['c'.repeat(24), 'd'.repeat(24)]) {
    const reporter = new MonitorReporter({...record, id, reason:'deferred'}, {config:saved, timers:false, transport:async()=>{throw new Error('fixture offline');}});
    await reporter.finish();
  }
  const previousFetch=globalThis.fetch;const previousDisable=process.env.ROADMAP_MONITOR;const sent=[];
  delete process.env.ROADMAP_MONITOR;globalThis.fetch=async (_url,options)=>{sent.push(JSON.parse(options.body));return response();};
  try{const result=await flushMonitor(1);assert.equal(result.attempted,1);assert.equal(sent.length,1);assert.equal(sent[0].kind,'replay');assert.equal(sent[0].run.heartbeat_expected,false);}
  finally{globalThis.fetch=previousFetch;if(previousDisable===undefined)delete process.env.ROADMAP_MONITOR;else process.env.ROADMAP_MONITOR=previousDisable;}
});

test('optional monitoring fields cannot overflow a valid managed journal event', t => {
 const record=fixture(t);const file=path.join(record.workspace,'events.jsonl');const event={id:'event-1',sequence:1,type:'runner.task_result',padding:'x'.repeat(8000),operation:'x'.repeat(256)};
 appendEvent(file,event);assert.ok(fs.statSync(file).size<=8192);assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).operation,undefined);assert.equal(event.operation.length,256);
 assert.throws(()=>appendEvent(file,{id:'too-large',sequence:2,padding:'x'.repeat(8300)}),/journal record budget/);
});
