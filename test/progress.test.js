import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, roadmapStatus } from "../lib/runner.js";
import { COMPACT_TRACKING_BYTES, MAX_SOURCE_BYTES, MAX_TRACKING_BYTES, hasOpenRoadmapTasks, prepareTracking, renderPrompt } from "../lib/tracking.js";

const withoutMarks = value => value.toString().replace(/^(\s*- \[)[ xX](\])/gm, "$1 $2");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = fs.readFileSync(path.join(root, "prompt.md"), "utf8");
const example = fs.readFileSync(path.join(root, "examples/three-iteration-roadmap.md"), "utf8");

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner progress "));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const roadmap = path.join(dir, "roadmap.md");
  const file = path.join(dir, "delivery evidence.md");
  fs.writeFileSync(roadmap, example);
  return { dir, roadmap, file };
}

test("progress-file argument and environment are opt-in, with CLI precedence", () => {
  assert.equal(parseArgs(["roadmap.md"], {}).progressFile, "");
  assert.equal(parseArgs(["roadmap.md"], { ROADMAP_PROGRESS_FILE: "evidence.md" }).progressFile, "evidence.md");
  assert.equal(parseArgs(["roadmap.md", "--progress-file", "progress.md"],
    { ROADMAP_PROGRESS_FILE: "evidence.md" }).progressFile, "progress.md");
  for (const args of [["--progress-file"], ["--progress-file", ""], ["--progress-file", "--client", "codex"]]) {
    assert.throws(() => parseArgs(args, {}), (error) => error.exitCode === 64);
  }
});

test("default mode preserves the roadmap and creates bounded internal progress state", (t) => {
  const { dir, roadmap } = workspace(t);
  const before = fs.readFileSync(roadmap);
  const tracking = prepareTracking(roadmap, "", dir);
  assert.notEqual(tracking.file, roadmap);
  assert.match(tracking.file, /[\\/].roadmap-runner[\\/].+[\\/]progress\.md$/);
  assert.equal(roadmapStatus(fs.readFileSync(tracking.file, "utf8")), "in-progress");
  assert.deepEqual(fs.readFileSync(roadmap), before);
  assert.doesNotThrow(() => tracking.refreshSource());
  assert.doesNotThrow(() => tracking.assertBounded());
  const prompt = renderPrompt(template, roadmap, tracking.file, tracking.historyDir);
  assert.match(prompt, /Tracking mode: ROADMAP_CHECKBOXES/);
  assert.match(prompt, /immutable authority/);
  assert.match(prompt, /do not bulk-load/);
});

test("new nested evidence gets an incomplete scaffold without touching the source", (t) => {
  const { dir, roadmap } = workspace(t);
  const before = fs.readFileSync(roadmap);
  const file = path.join(dir, "notes", "delivery.md");
  const tracking = prepareTracking(roadmap, file);
  assert.equal(tracking.file, file);
  assert.equal(roadmapStatus(fs.readFileSync(file, "utf8")), "in-progress");
  assert.deepEqual(fs.readFileSync(roadmap), before);
  assert.doesNotThrow(() => tracking.refreshSource());
});

test("existing evidence is never truncated or reset by initialization", (t) => {
  const { roadmap, file } = workspace(t);
  const before = Buffer.from("# Delivery\r\nStatus: COMPLETE\r\n\r\n## Evidence\r\nPrior proof.\r\n");
  fs.writeFileSync(file, before);
  prepareTracking(roadmap, file);
  prepareTracking(roadmap, file);
  assert.deepEqual(fs.readFileSync(file), before);
});

for (const kind of ["same path", "normalized path", "symlink", "hard link"]) {
  test(`reject source alias: ${kind}`, { skip: process.platform === "win32" && kind.includes("link") }, (t) => {
    const { dir, roadmap, file } = workspace(t);
    const before = fs.readFileSync(roadmap);
    let target = file;
    if (kind === "same path") target = roadmap;
    if (kind === "normalized path") target = `${dir}/unused/../roadmap.md`;
    if (kind === "symlink") fs.symlinkSync(roadmap, file);
    if (kind === "hard link") fs.linkSync(roadmap, file);
    assert.throws(() => prepareTracking(roadmap, target), /must be different/);
    assert.deepEqual(fs.readFileSync(roadmap), before);
  });
}

test("non-file progress targets are rejected without altering the source", (t) => {
  const { roadmap, file } = workspace(t);
  const before = fs.readFileSync(roadmap);
  fs.mkdirSync(file);
  assert.throws(() => prepareTracking(roadmap, file), /not a regular file/);
  assert.deepEqual(fs.readFileSync(roadmap), before);
});

test("source edits and deletion are detected without automatic restoration", (t) => {
  const { roadmap, file } = workspace(t);
  const tracking = prepareTracking(roadmap, file);
  fs.writeFileSync(roadmap, "Changed externally\n");
  assert.equal(tracking.refreshSource(), true);
  assert.equal(tracking.needsReconciliation, true);
  assert.equal(fs.readFileSync(roadmap, "utf8"), "Changed externally\n");
  fs.unlinkSync(roadmap);
  assert.throws(() => tracking.refreshSource(), /no longer readable/);
  assert.equal(fs.existsSync(roadmap), false);
});

test("progress replaced with a source alias is rejected at the next boundary", { skip: process.platform === "win32" }, (t) => {
  const { roadmap, file } = workspace(t);
  const tracking = prepareTracking(roadmap, file);
  fs.unlinkSync(file);
  fs.linkSync(roadmap, file);
  assert.throws(() => tracking.refreshSource(), /must be different/);
});

test("prompt keeps literal paths and the latest batching and evidence instructions", () => {
  const roadmap = "/workspace/source $&{{PROGRESS_FILE}}.md";
  const file = "/workspace/evidence $&{{ROADMAP}}.md";
  const prompt = renderPrompt(template, roadmap, file);
  assert.ok(prompt.includes(`Work on this implementation roadmap:\n\n${roadmap}\n`));
  assert.ok(prompt.includes(`Tracking file (progress / delivery evidence):\n\n${file}\n`));
  assert.match(prompt, /Tracking mode: ROADMAP_CHECKBOXES/);
  assert.match(prompt, /Tick verified tasks directly in the live roadmap/);
  assert.match(prompt, /Keep detailed evidence\s+and handoffs in the separate tracking file/);
  assert.match(prompt, /one concrete outcome/);
  assert.match(prompt, /canonical harness first/);
  assert.match(prompt, /roughly 60 minutes of\s+implementation/);
  assert.match(prompt, /loaded prompt\s+revision/);
  assert.match(prompt, /each run may process only one checkbox/);
  assert.match(prompt, /original gate IDs and criteria/);
  assert.doesNotMatch(prompt, /Update the roadmap and stop|status log in the roadmap|EDIT_ROADMAP/);
});

test("source/history pollution is rejected before a worker sees it", (t) => {
  const { dir, roadmap } = workspace(t);
  fs.writeFileSync(roadmap, "# Roadmap\n\n" + "history noise\n".repeat(Math.ceil(MAX_SOURCE_BYTES / 10)));
  assert.ok(fs.statSync(roadmap).size > MAX_SOURCE_BYTES);
  assert.throws(() => prepareTracking(roadmap, "", dir), /compact requirements-only roadmap/);
});

test("a 350 KB source is rejected unchanged even though older versions accepted it", t => {
  const { dir, roadmap } = workspace(t);
  const contents = "# Roadmap\n" + "x".repeat(350000);
  fs.writeFileSync(roadmap, contents);
  assert.equal(MAX_SOURCE_BYTES, 128 * 1024);
  assert.throws(() => prepareTracking(roadmap, "", dir), /source roadmap exceeded/);
  assert.equal(fs.readFileSync(roadmap, "utf8"), contents);
  assert.equal(fs.existsSync(path.join(dir, ".roadmap-runner")), false);
});

test("progress compaction is requested before the hard limit without discarding state", t => {
  const { dir, roadmap } = workspace(t);
  const tracking = prepareTracking(roadmap, "", dir);
  assert.equal(tracking.compactionContext(), "");
  const contents = "# Progress\nStatus: IN_PROGRESS\n- [ ] GATE-1: preserve criterion\n".padEnd(COMPACT_TRACKING_BYTES, "x");
  fs.writeFileSync(tracking.file, contents);
  tracking.archive({ kind: "worker", iteration: 55 });
  assert.doesNotThrow(() => tracking.assertBounded());
  assert.match(tracking.compactionContext(), /Progress compaction required/);
  assert.match(tracking.compactionContext(), /Preserve every gate ID, acceptance criterion, checkbox state/);
  assert.equal(fs.readFileSync(tracking.file, "utf8"), contents);
  fs.writeFileSync(tracking.file, "x".repeat(MAX_TRACKING_BYTES + 1));
  assert.throws(() => tracking.assertBounded(), /active progress file exceeded/);
});

test("active progress is capped while archived snapshots preserve prior state", (t) => {
  const { dir, roadmap } = workspace(t);
  const tracking = prepareTracking(roadmap, "", dir);
  fs.writeFileSync(tracking.file, "# State\nStatus: IN_PROGRESS\n\n" + "x".repeat(4096));
  const snapshot = tracking.archive({ kind: "worker", iteration: 1, metadata: { code: 0 } });
  assert.ok(fs.existsSync(snapshot));
  assert.match(fs.readFileSync(tracking.historyFile, "utf8"), /"iteration":1/);
  assert.doesNotThrow(() => tracking.assertBounded());
  fs.writeFileSync(tracking.file, "x".repeat(MAX_TRACKING_BYTES + 1));
  assert.throws(() => tracking.assertBounded(), /active progress file exceeded/);
});

// This mock models controller edits as well as missing-file faults. Ordinary edits
// must continue; missing source/progress files still stop without restoration.
function run(t, { sourceStatus = "IN_PROGRESS", evidence, mode = "normal", useEnv = false } = {}) {
  const { dir, roadmap, file } = workspace(t);
  fs.writeFileSync(roadmap, "\uFEFF" + example.replace("Status: IN_PROGRESS", `Status: ${sourceStatus}`).replaceAll("\n", "\r\n"));
  const before = fs.readFileSync(roadmap);
  if (evidence !== undefined) fs.writeFileSync(file, evidence);
  const worker = path.join(dir, "worker.cjs");
  fs.writeFileSync(worker, `#!/usr/bin/env node
const fs = require('node:fs');
const assert = require('node:assert/strict');
const prompt = process.argv.at(-1);
assert.match(prompt, /Tracking mode: ROADMAP_CHECKBOXES/);
assert.match(prompt, /Loaded prompt revision: [a-f0-9]{12}/);
const source = prompt.match(/Work on this implementation roadmap:\\s*\\n\\s*([^\\n]+)/)[1];
const file = prompt.match(/Tracking file \\(progress \\/ delivery evidence\\):\\s*\\n\\s*([^\\n]+)/)[1];
const count = fs.existsSync('calls') ? Number(fs.readFileSync('calls')) + 1 : 1;
fs.writeFileSync('calls', String(count));
if (count > 5) process.exit(9); // Bound fixture failures even if stop logic breaks.
const mode = process.env.PROGRESS_TEST_MODE;
if (mode === 'capacity' && count === 1) {
  fs.appendFileSync(file, '\\nCapacity attempt preserved.\\n');
  console.log(JSON.stringify({type:'error',message:'Selected model is at capacity'}));
  process.exit(1);
}
if (mode === 'delete-progress') { fs.unlinkSync(file); process.exit(0); }
let text = fs.readFileSync(file, 'utf8');
if (mode === 'compact' && count === 1) {
  assert.match(prompt, /Progress compaction required/);
  text = text.split('## Padding')[0];
}
if (prompt.includes('Roadmap reconciliation required: YES')) text = text.replace('Status: COMPLETE', 'Status: IN_PROGRESS');
if (prompt.includes('Blocked recovery mode: YES')) text = text.replace('Status: BLOCKED', 'Status: IN_PROGRESS');
if (!/- \\[[ x]\\] EX-/.test(text)) {
  const gates = fs.readFileSync(source, 'utf8').match(/^- \\[ \\] EX-[^\\r\\n]+/gm);
  text += '\\n## Tasks\\n\\n' + gates.join('\\n') + '\\n';
}
const task = text.match(/- \\[ \\] (EX-[123])/);
assert.ok(task, 'must resume an unfinished gate');
text = text.replace('- [ ] ' + task[1], '- [x] ' + task[1]);
let live = fs.readFileSync(source, 'utf8');
for (const match of text.matchAll(/- \\[[xX]\\] (EX-[123])/g)) live = live.replace('- [ ] ' + match[1], '- [x] ' + match[1]);
fs.writeFileSync(source, live);
fs.writeFileSync(task[1] + '.txt', 'verified\\n');
text += '- Verified ' + task[1] + '\\n';
if (!/- \\[ \\] EX-/.test(text)) text = text.replace('Status: IN_PROGRESS', 'Status: COMPLETE');
if ((mode === 'edit-source' || mode === 'edit-capacity') && count === 1) fs.appendFileSync(source, '\\nCONTROLLER EDIT\\n');
if (mode === 'delete-source') fs.unlinkSync(source);
if (mode === 'edit-source' && count === 1) text = text.replace('Status: IN_PROGRESS', 'Status: COMPLETE');
fs.writeFileSync(file, text);
if (mode === 'edit-capacity' && count === 1) {
  console.log(JSON.stringify({type:'error',message:'Selected model is at capacity'}));
  process.exitCode = 1;
}
`);
  fs.chmodSync(worker, 0o755);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ROADMAP_")));
  Object.assign(env, { ROADMAP_STATE_DIR: path.join(dir, "registry"), ROADMAP_NOTIFY: "off", ROADMAP_NOTIFY_BIN: "" });
  Object.assign(env, { PROGRESS_TEST_MODE: mode, ROADMAP_CAPACITY_RETRIES: "1", ROADMAP_CAPACITY_DELAY: "1", ROADMAP_CAPACITY_MAX_DELAY: "1" });
  if (useEnv) env.ROADMAP_PROGRESS_FILE = path.basename(file);
  const result = spawnSync(process.execPath, [path.join(root, "bin/roadmap-runner.js"), path.basename(roadmap),
    "--client-bin", worker, ...(useEnv ? [] : ["--progress-file", path.basename(file)])], {
    cwd: dir, env, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  return { dir, roadmap, file, before, result,
    calls: fs.existsSync(path.join(dir, "calls")) ? Number(fs.readFileSync(path.join(dir, "calls"))) : 0 };
}

for (const sourceStatus of ["IN_PROGRESS", "COMPLETE", "BLOCKED"]) {
  test(`three iterations update roadmap checkboxes and preserve requirements, ignoring source ${sourceStatus}`, (t) => {
    const f = run(t, { sourceStatus, useEnv: sourceStatus === "BLOCKED" });
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.equal(f.calls, 3);
    assert.equal(withoutMarks(fs.readFileSync(f.roadmap)), withoutMarks(f.before));
    const evidence = fs.readFileSync(f.file, "utf8");
    assert.equal(roadmapStatus(evidence), "complete");
    assert.equal((evidence.match(/- \[x\] EX-/g) || []).length, 3);
    for (const id of [1, 2, 3]) assert.equal(fs.readFileSync(path.join(f.dir, `EX-${id}.txt`), "utf8"), "verified\n");
  });
}

test("resume skips previously checked tasks and preserves prior delivery evidence", (t) => {
  const f = run(t, { evidence: "# Evidence\nStatus: IN_PROGRESS\n\n## Tasks\n- [x] EX-1\n- [ ] EX-2\n- [ ] EX-3\n\n## History\nPrior proof preserved.\n" });
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.equal(f.calls, 2);
  assert.equal(fs.existsSync(path.join(f.dir, "EX-1.txt")), false);
  assert.match(fs.readFileSync(f.file, "utf8"), /Prior proof preserved/);
  assert.equal(withoutMarks(fs.readFileSync(f.roadmap)), withoutMarks(f.before));
});

test("stale progress COMPLETE cannot finish with open roadmap tasks", (t) => {
  const evidence = "# Evidence\nStatus: COMPLETE\n\n## Evidence\nPrior proof.\n";
  const f = run(t, { evidence });
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.equal(f.calls, 3);
  assert.equal((fs.readFileSync(f.roadmap, "utf8").match(/- \[x\] EX-/g) || []).length, 3);
  assert.equal(withoutMarks(fs.readFileSync(f.roadmap)), withoutMarks(f.before));
});

test("progress BLOCKED stops without launching or rescanning", (t) => {
  const evidence = "# Evidence\nStatus: BLOCKED\n\n## Tasks\n- [ ] EX-1\n- [ ] EX-2\n- [ ] EX-3\n\n## Deferred gates\nEX-1 blocked externally.\n";
  const f = run(t, { evidence });
  assert.equal(f.result.status, 75, f.result.stderr);
  assert.equal(f.calls, 0);
  assert.match(f.result.stdout + f.result.stderr, /Roadmap is BLOCKED/);
  assert.equal(fs.readFileSync(f.file, "utf8"), evidence);
});

test("conflicting progress statuses fail before launching", (t) => {
  const f = run(t, { evidence: "Status: IN_PROGRESS\nStatus: COMPLETE\n" });
  assert.equal(f.result.status, 1);
  assert.equal(f.calls, 0);
  assert.match(f.result.stderr, /multiple roadmap header status/);
});

for (const mode of ["edit-source", "edit-capacity"]) {
  test(`continue after ${mode}, preserving controller edits and prior evidence`, (t) => {
    const f = run(t, { mode });
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.equal(f.calls, 3);
    assert.match(f.result.stdout, /Roadmap requirements changed/);
    assert.match(fs.readFileSync(f.roadmap, "utf8"), /CONTROLLER EDIT/);
    assert.match(fs.readFileSync(f.file, "utf8"), /Verified EX-1/);
    if (mode === "edit-capacity") assert.match(f.result.stdout, /retry 1\/1/);
  });
}

for (const mode of ["delete-source", "delete-progress"]) {
  test(`stop after ${mode}, without another worker or automatic restoration`, (t) => {
    const f = run(t, { mode });
    assert.equal(f.result.status, 1, f.result.stderr);
    assert.equal(f.calls, 1);
    assert.doesNotMatch(f.result.stdout, /Roadmap complete|retry 1\//);
    assert.equal(fs.existsSync(mode === "delete-source" ? f.roadmap : f.file), false);
  });
}

test("capacity retry retains progress and source protection", (t) => {
  const f = run(t, { mode: "capacity" });
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.equal(f.calls, 4);
  assert.match(f.result.stdout, /retry 1\/1/);
  assert.match(fs.readFileSync(f.file, "utf8"), /Capacity attempt preserved/);
  assert.equal(withoutMarks(fs.readFileSync(f.roadmap)), withoutMarks(f.before));
});

test("worker receives the compaction directive before continuing a large handoff", t => {
  const evidence = "# State\nStatus: IN_PROGRESS\n\n## Padding\n".padEnd(COMPACT_TRACKING_BYTES, "x");
  const f = run(t, { mode: "compact", evidence });
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.equal(f.calls, 3);
  assert.equal(withoutMarks(fs.readFileSync(f.roadmap)), withoutMarks(f.before));
  assert.ok(fs.statSync(f.file).size < COMPACT_TRACKING_BYTES);
});


test("roadmap completion ignores fenced examples and rejects stale handoff completion", t => {
  const { roadmap, file } = workspace(t);
  const tracking = prepareTracking(roadmap, file);
  assert.equal(tracking.deliveryStatus("complete"), "in-progress");
  fs.writeFileSync(roadmap, fs.readFileSync(roadmap, "utf8").replaceAll("- [ ] EX-", "- [x] EX-"));
  assert.equal(tracking.deliveryStatus("complete"), "complete");
  assert.equal(hasOpenRoadmapTasks("```md\n- [ ] example\n```\n- [x] real"), false);
  assert.equal(hasOpenRoadmapTasks("~~~md\n- [ ] example\n~~~\n  - [ ] real"), true);
});

test("checkbox updates retain the source snapshot without requiring scope reconciliation", t => {
  const { roadmap, file } = workspace(t);
  const tracking = prepareTracking(roadmap, file);
  const revision = tracking.sourceRevision;
  fs.writeFileSync(roadmap, fs.readFileSync(roadmap, "utf8").replace("- [ ] EX-1", "- [x] EX-1"));
  tracking.refreshSource(1);
  assert.notEqual(tracking.sourceRevision, revision);
  assert.equal(tracking.needsReconciliation, false);
  assert.match(fs.readFileSync(tracking.sourceSnapshot, "utf8"), /- \[x\] EX-1/);
  fs.appendFileSync(roadmap, "\nNew acceptance criterion.\n");
  tracking.refreshSource(2);
  assert.equal(tracking.needsReconciliation, true);
  const changedRevision = tracking.sourceRevision;
  fs.writeFileSync(roadmap, fs.readFileSync(roadmap, "utf8").replace("- [ ] EX-2", "- [x] EX-2"));
  tracking.refreshSource(3);
  tracking.finishWorker(changedRevision, { code: 0 });
  assert.equal(tracking.needsReconciliation, false);
});
