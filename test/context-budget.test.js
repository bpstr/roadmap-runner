import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { prepareTracking, TARGET_TRACKING_BYTES } from "../lib/tracking.js";

const cli = fileURLToPath(new URL("../bin/roadmap-runner.js", import.meta.url));
const notes = text => `<!-- roadmap-runner:delivery:start -->\n${text}\n<!-- roadmap-runner:delivery:end -->`;
const jsonLines = file => fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);

function fixture(t, mode = "compact", reconcile = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-context-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const roadmap = path.join(dir, "roadmap.md");
  fs.writeFileSync(roadmap, `# Requirements\n- [ ] GATE-1: first criterion\n- [ ] GATE-2: second criterion\n\n${notes("No delivery yet.")}\n`);
  const tracking = prepareTracking(roadmap, path.join(dir, "progress.md"), dir);
  const initial = "# Handoff\nStatus: IN_PROGRESS\n\n## Deferred gates\nGATE-2: preserve the release receipt.\n".padEnd(97 * 1024, "e");
  if (mode !== "grow" && !mode.startsWith("loop")) fs.writeFileSync(tracking.file, initial);
  if (reconcile) fs.appendFileSync(roadmap, "\nController criterion added.\n");
  const worker = path.join(dir, "prepared.cjs");
  fs.copyFileSync(new URL("./fixtures/context-client.cjs", import.meta.url), worker);
  fs.chmodSync(worker, 0o755);
  const result = spawnSync(process.execPath, [cli, roadmap, "--client", "codex", "--client-bin", worker,
    "--progress-file", tracking.file, "--supervisor-every", mode.startsWith("loop") ? "5" : "1", ...(mode === "timeout" ? ["--timeout", "1s"] : [])], {
    cwd: dir, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, ROADMAP_NOTIFY: "off", ROADMAP_PREVENT_SLEEP: "off",
      ROADMAP_RECOVERY_DELAY: "1", ROADMAP_RECOVERY_MAX_DELAY: "1", ROADMAP_MAX_IDLE_WORKERS: "3",
      CONTEXT_TEST_MODE: mode, CONTEXT_TEST_PROGRESS: tracking.file, CONTEXT_TEST_ROADMAP: roadmap,
      CONTEXT_TEST_RECONCILE: reconcile ? "yes" : "no" },
  });
  assert.equal(result.error, undefined);
  return { dir, roadmap, tracking, initial, result, calls: JSON.parse(fs.readFileSync(path.join(dir, "calls.json"))) };
}

test("legacy large handoffs compact separately while detailed evidence remains available", t => {
  const f = fixture(t);
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.deepEqual(f.calls, ["COMPACTOR", "WORKER"]);
  const before = jsonLines(f.tracking.historyFile).find(e => e.kind === "before-compaction");
  assert.equal(gunzipSync(fs.readFileSync(path.join(f.tracking.stateDir, before.snapshot))).toString(), f.initial);
  assert.equal(fs.readFileSync(path.join(f.tracking.evidenceDir, "GATE-2.md"), "utf8"), f.initial);
  const sessions = jsonLines(f.tracking.sessionsFile);
  assert.deepEqual(sessions.map(s => [s.role, s.iteration]), [["compactor", 0], ["worker", 1]]);
  assert.ok(sessions[0].contextBytes.after.progress < TARGET_TRACKING_BYTES);
  assert.equal(sessions[0].contextBytes.before.progress, Buffer.byteLength(f.initial));
  assert.equal(sessions[1].usage.inputTokens, 1000);
  assert.equal(sessions[1].usage.cachedInputTokens, 800);
  assert.equal(sessions[1].model, "prepared-model");
  assert.equal(sessions[1].usageComplete, true);
  const event = jsonLines(`${f.tracking.file}.events.jsonl`).find(e => e.type === "runner.turn_finished");
  assert.equal(event.sessionId, sessions[0].sessionId);
  assert.deepEqual(event.usage, sessions[0].usage);
});

for (const [mode, error] of [["noop", /did not reach/], ["status", /changed the opening status/], ["source", /source roadmap changed/], ["source-capacity", /source roadmap changed/], ["failure", /exited with code 9/], ["timeout", /compaction timed out/]]) {
  test(`compaction ${mode} stops before implementation and retains the original archive`, t => {
    const f = fixture(t, mode);
    assert.notEqual(f.result.status, 0);
    assert.match(f.result.stderr, error);
    assert.deepEqual(f.calls, ["COMPACTOR"]);
    const snapshot = jsonLines(f.tracking.historyFile).find(e => e.kind === "before-compaction").snapshot;
    assert.equal(gunzipSync(fs.readFileSync(path.join(f.tracking.stateDir, snapshot))).toString(), f.initial);
    assert.match(fs.readFileSync(f.roadmap, "utf8"), /- \[ \] GATE-1/);
    if (mode.startsWith("source")) assert.match(fs.readFileSync(f.roadmap, "utf8"), /Unexpected compactor requirement rewrite/);
    assert.equal(JSON.parse(fs.readFileSync(`${f.tracking.file}.recovery.json`)).requiresWorker, true);
  });
}

test("worker growth compacts before a due supervisor; delivery notes do not starve review", t => {
  const f = fixture(t, "grow");
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.deepEqual(f.calls, ["WORKER", "COMPACTOR", "SUPERVISOR", "WORKER"]);
  const sessions = jsonLines(f.tracking.sessionsFile);
  assert.deepEqual(sessions.map(s => [s.role, s.iteration]), [["worker", 1], ["compactor", 1], ["supervisor", 1], ["worker", 2]]);
  assert.equal(new Set(sessions.map(s => s.sessionId)).size, 4);
  assert.ok(sessions[2].contextBytes.before.progress < TARGET_TRACKING_BYTES);
  assert.equal(sessions[2].usage.outputTokens, 12);
});

test("compaction cannot acknowledge pending requirements before the worker sees them", t => {
  const f = fixture(t, "compact", true);
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.match(fs.readFileSync(path.join(f.dir, "prompt-2"), "utf8"), /Roadmap reconciliation required: YES/);
});

for (const mode of ["loop-detected", "loop-clear"]) {
  test(`compaction preserves ${mode === "loop-detected" ? "the early loop verdict" : "the deterministic worker limit"}`, t => {
    const f = fixture(t, mode);
    assert.equal(f.result.status, 75, f.result.stderr);
    assert.deepEqual(f.calls, ["WORKER", "COMPACTOR", "WORKER", "COMPACTOR", "SUPERVISOR",
      ...(mode === "loop-clear" ? ["WORKER"] : [])]);
    const events = jsonLines(`${f.tracking.file}.events.jsonl`);
    assert.equal(events.at(-1).reason, mode === "loop-detected" ? "loop_detected" : "no_progress_limit");
    assert.equal(jsonLines(f.tracking.sessionsFile).filter(s => s.role === "worker").length,
      mode === "loop-detected" ? 2 : 3);
    assert.equal(JSON.parse(fs.readFileSync(`${f.tracking.file}.recovery.json`)).idle,
      mode === "loop-detected" ? 2 : 3);
    assert.match(fs.readFileSync(f.roadmap, "utf8"), /- \[ \] GATE-1/);
  });
}

test("only valid delivery notes are excluded from scope reconciliation", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-notes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, initial, update, pending] of [
    ["note", notes("old receipt"), notes("new receipt"), false],
    ["checkbox", notes("- [ ] actual task"), notes("- [ ] changed task"), true],
    ["malformed", "<!-- roadmap-runner:delivery:start -->\nold", "<!-- roadmap-runner:delivery:start -->\nnew", true],
    ["nested", notes(notes("old")), notes(notes("new")), true],
    ["fenced", "```md\n" + notes("old") + "\n```", "```md\n" + notes("new") + "\n```", true],
    ["criteria", "Must retain criterion A.\n" + notes("old"), "Must retain criterion B.\n" + notes("new"), true],
  ]) {
    const roadmap = path.join(dir, `${name}.md`);
    fs.writeFileSync(roadmap, `# Requirements\n- [ ] GATE: acceptance\n${initial}\n`);
    const tracking = prepareTracking(roadmap, "", dir);
    const revision = tracking.sourceRevision;
    fs.writeFileSync(roadmap, `# Requirements\n- [x] GATE: acceptance\n${update}\n`);
    tracking.refreshSource(1);
    tracking.finishWorker(revision, { code: 0 });
    assert.equal(tracking.needsReconciliation, pending, name);
  }
});
