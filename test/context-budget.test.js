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

function fixture(t, mode = "compact", reconcile = false, { initialBytes = 97 * 1024, status = "IN_PROGRESS", sourceBytes = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-context-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const roadmap = path.join(dir, "roadmap.md");
  const source = `# Requirements\n- [ ] GATE-1: first criterion\n- [ ] GATE-2: second criterion\n\n${notes("No delivery yet.")}\n`
    .replaceAll("[ ]", status === "COMPLETE" ? "[x]" : "[ ]").padEnd(sourceBytes, " ");
  fs.writeFileSync(roadmap, source);
  const tracking = prepareTracking(roadmap, path.join(dir, "progress.md"), dir);
  const initial = `# Handoff\nStatus: ${status}\n\n## Deferred gates\nGATE-2: preserve the release receipt.\n`.padEnd(initialBytes, "e");
  if (mode !== "grow" && !mode.startsWith("loop")) fs.writeFileSync(tracking.file, initial);
  if (reconcile) fs.appendFileSync(roadmap, "\nController criterion added.\n");
  const worker = path.join(dir, "prepared.cjs");
  fs.copyFileSync(new URL("./fixtures/context-client.cjs", import.meta.url), worker);
  fs.chmodSync(worker, 0o755);
  const result = spawnSync(process.execPath, [cli, roadmap, "--client", "codex", "--client-bin", worker,
    "--progress-file", tracking.file, "--supervisor-every", mode.startsWith("loop") ? "2" : "1", ...(mode === "timeout" ? ["--timeout", "1s"] : [])], {
    cwd: dir, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, ROADMAP_NOTIFY: "off", ROADMAP_PREVENT_SLEEP: "off",
      ROADMAP_RECOVERY_DELAY: "1", ROADMAP_RECOVERY_MAX_DELAY: "1", ROADMAP_MAX_IDLE_WORKERS: "3",
      CONTEXT_TEST_MODE: mode, CONTEXT_TEST_PROGRESS: tracking.file, CONTEXT_TEST_ROADMAP: roadmap,
      CONTEXT_TEST_RECONCILE: reconcile ? "yes" : "no" },
  });
  assert.equal(result.error, undefined);
  return { dir, roadmap, tracking, source, initial, result, calls: JSON.parse(fs.readFileSync(path.join(dir, "calls.json"))) };
}

for (const initialBytes of [32767, 32768, 32769]) {
  test(`a ${initialBytes}-byte handoff compacts only at the 32 KiB boundary`, t => {
    const f = fixture(t, "compact-target", false, { initialBytes });
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.deepEqual(f.calls, [...(initialBytes >= 32768 ? ["COMPACTOR"] : []), "WORKER"]);
    if (initialBytes >= 32768) assert.equal(jsonLines(f.tracking.sessionsFile)[0].contextBytes.after.progress, 8 * 1024 - 1);
  });
}

test("a blocked handoff compacts before recovery stops and leaves a 256 KiB roadmap intact", t => {
  const f = fixture(t, "compact", false, { initialBytes: 32768, status: "BLOCKED", sourceBytes: 256 * 1024 });
  assert.equal(f.result.status, 75, f.result.stderr);
  assert.deepEqual(f.calls, ["COMPACTOR", "RESOLVER"]);
  assert.match(fs.readFileSync(f.tracking.file, "utf8"), /Status: STOPPED/);
  assert.ok(fs.statSync(f.tracking.file).size < 32768);
  assert.equal(fs.readFileSync(f.roadmap, "utf8"), f.source);
  const snapshot = jsonLines(f.tracking.historyFile).find(e => e.kind === "before-compaction").snapshot;
  assert.equal(gunzipSync(fs.readFileSync(path.join(f.tracking.stateDir, snapshot))).toString(), f.initial);
});

test("a complete handoff compacts before exiting without another worker", t => {
  const f = fixture(t, "compact", false, { initialBytes: 32768, status: "COMPLETE" });
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.deepEqual(f.calls, ["COMPACTOR"]);
  assert.match(fs.readFileSync(f.tracking.file, "utf8"), /Status: COMPLETE/);
  assert.ok(fs.statSync(f.tracking.file).size < 32768);
  assert.equal(fs.readFileSync(f.roadmap, "utf8"), f.source);
});

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

for (const [mode, error] of [["noop", /did not reach/], ["compact-wide", /did not reach/], ["status", /changed the opening status/], ["source", /source roadmap changed/], ["source-capacity", /source roadmap changed/], ["failure", /exited with code 9/], ["timeout", /compaction timed out/]]) {
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

test("worker growth compacts before the next worker without scheduled supervision", t => {
  const f = fixture(t, "grow");
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.deepEqual(f.calls, ["WORKER", "COMPACTOR", "WORKER"]);
  const sessions = jsonLines(f.tracking.sessionsFile);
  assert.deepEqual(sessions.map(s => [s.role, s.iteration]), [["worker", 1], ["compactor", 1], ["worker", 2]]);
  assert.equal(new Set(sessions.map(s => s.sessionId)).size, 3);
  assert.ok(sessions[2].contextBytes.before.progress < TARGET_TRACKING_BYTES);
  assert.equal(sessions[2].usage.outputTokens, 12);
  for (let i = 1; i <= f.calls.length; i++) {
    const prompt = fs.readFileSync(path.join(f.dir, `prompt-${i}`), "utf8");
    assert.match(prompt, /Handoff limit: 32768 UTF-8 bytes \(32 KiB\)/);
    assert.match(prompt, /Handoff size alone is not a reason to set BLOCKED/);
    assert.match(prompt, /Source roadmap limit: 262144 UTF-8 bytes \(256 KiB\), inclusive/);
    assert.match(prompt, /must not compress or truncate the source roadmap/);
  }
});

test("compaction cannot acknowledge pending requirements before the worker sees them", t => {
  const f = fixture(t, "compact", true);
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.match(fs.readFileSync(path.join(f.dir, "prompt-2"), "utf8"), /Roadmap reconciliation required: YES/);
});

for (const mode of ["loop-detected", "loop-clear"]) {
  test(`compaction preserves ${mode === "loop-detected" ? "the repeated-failure verdict" : "productive continuation"}`, t => {
    const f = fixture(t, mode);
    assert.equal(f.result.status, mode === "loop-detected" ? 75 : 0, f.result.stderr);
    assert.deepEqual(f.calls, ["WORKER", "COMPACTOR", "WORKER", "COMPACTOR", "WORKER",
      ...(mode === "loop-detected" ? ["RESOLVER"] : [])]);
    const events = jsonLines(`${f.tracking.file}.events.jsonl`);
    assert.equal(events.at(-1).reason, mode === "loop-detected" ? "resolver_stopped" : undefined);
    assert.equal(jsonLines(f.tracking.sessionsFile).filter(s => s.role === "worker").length,
      3);
    assert.equal(events.some(e => e.reason === "no_progress_limit"), false);
    assert.match(fs.readFileSync(f.roadmap, "utf8"), mode === "loop-detected" ? /- \[ \] GATE-1/ : /- \[x\] GATE-1/);
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
