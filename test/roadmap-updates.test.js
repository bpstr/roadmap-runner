import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { MAX_SOURCE_BYTES, prepareTracking } from "../lib/tracking.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const original = "# Roadmap\n\n## Requirements\n- [ ] OLD: original requirement.\n";
const revised = "# Roadmap\n\n## Requirements\n- [ ] NEW: controller-corrected requirement.\n";
const success = { code: 0, timedOut: false, interrupted: false };
const hash = (text) => createHash("sha256").update(text).digest("hex");

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roadmap-updates-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const roadmap = path.join(dir, "source roadmap.md");
  const progress = path.join(dir, "progress.md");
  fs.writeFileSync(roadmap, original);
  const tracking = prepareTracking(roadmap, progress, dir);
  return { dir, roadmap, progress, tracking };
}

function publish(file, contents) {
  fs.writeFileSync(`${file}.next`, contents);
  fs.renameSync(`${file}.next`, file);
}

test("edits are adopted only at a boundary; snapshots and evidence stay intact during a run", (t) => {
  const f = workspace(t);
  const before = fs.readFileSync(f.progress);
  const oldRevision = f.tracking.sourceRevision;
  publish(f.roadmap, revised);
  assert.equal(fs.readFileSync(f.tracking.sourceSnapshot, "utf8"), original);
  assert.equal(f.tracking.sourceRevision, oldRevision);
  assert.equal(f.tracking.refreshSource(4), true);
  assert.equal(f.tracking.sourceRevision, hash(revised));
  assert.equal(f.tracking.needsReconciliation, true);
  assert.equal(fs.readFileSync(f.tracking.sourceSnapshot, "utf8"), revised);
  assert.equal(fs.readFileSync(f.roadmap, "utf8"), revised);
  assert.deepEqual(fs.readFileSync(f.progress), before);
  const history = fs.readFileSync(f.tracking.historyFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(history.length, 1);
  assert.equal(history[0].kind, "roadmap-change");
  assert.equal(history[0].iteration, 4);
  assert.equal(history[0].previousSourceSha256, oldRevision);
  assert.equal(history[0].sourceSha256, hash(revised));
  assert.deepEqual(gunzipSync(fs.readFileSync(path.join(f.tracking.stateDir, history[0].snapshot))), before);
  assert.equal(f.tracking.refreshSource(4), false);
  assert.equal(fs.readFileSync(f.tracking.historyFile, "utf8").trim().split("\n").length, 1);
});

test("pending reconciliation and source/progress binding survive restarts", (t) => {
  const f = workspace(t);
  publish(f.roadmap, revised);
  const resumed = prepareTracking(f.roadmap, f.progress, f.dir);
  assert.equal(resumed.needsReconciliation, true);
  assert.equal(resumed.sourceRevision, hash(revised));
  assert.equal(prepareTracking(f.roadmap, f.progress, f.dir).needsReconciliation, true);
  resumed.finishWorker(resumed.sourceRevision, success);
  assert.equal(prepareTracking(f.roadmap, f.progress, f.dir).needsReconciliation, false);
  const other = prepareTracking(f.roadmap, path.join(f.dir, "other.md"), f.dir);
  assert.notEqual(resumed.sourceStateFile, other.sourceStateFile);
  assert.notEqual(resumed.sourceSnapshot, other.sourceSnapshot);
});

for (const [name, result] of [
  ["timeout", { ...success, timedOut: true }],
  ["interrupt", { ...success, interrupted: true }],
  ["failure", { ...success, code: 7 }],
  ["spawn error", { ...success, error: new Error("spawn failed") }],
  ["capacity", { ...success, code: 1, retryableCapacity: true }],
  ["quota with zero exit", { ...success, usageLimit: { kind: "session", resetAt: null } }],
]) {
  test(`${name} does not acknowledge a pending source revision`, (t) => {
    const f = workspace(t);
    publish(f.roadmap, revised);
    f.tracking.refreshSource();
    f.tracking.finishWorker(f.tracking.sourceRevision, result);
    assert.equal(prepareTracking(f.roadmap, f.progress, f.dir).needsReconciliation, true);
  });
}

test("a successful old worker cannot acknowledge a newer revision", (t) => {
  const f = workspace(t);
  const revision = f.tracking.sourceRevision;
  publish(f.roadmap, revised);
  f.tracking.refreshSource();
  f.tracking.finishWorker(revision, success);
  assert.equal(f.tracking.needsReconciliation, true);
});

test("multiple edits coalesce to the newest complete publication", (t) => {
  const f = workspace(t);
  publish(f.roadmap, revised);
  publish(f.roadmap, revised + "- [ ] LAST: highest priority.\n");
  f.tracking.refreshSource();
  assert.match(fs.readFileSync(f.tracking.sourceSnapshot, "utf8"), /LAST/);
  assert.equal(f.tracking.sourceRevision, hash(fs.readFileSync(f.roadmap)));
});

test("unreadable, non-file and oversized replacement sources remain errors", (t) => {
  const f = workspace(t);
  publish(f.roadmap, "x".repeat(MAX_SOURCE_BYTES + 1));
  assert.throws(() => f.tracking.refreshSource(), /compact requirements-only roadmap/);
  assert.equal(fs.statSync(f.roadmap).size, MAX_SOURCE_BYTES + 1);
  assert.equal(f.tracking.sourceRevision, hash(original));
  fs.unlinkSync(f.roadmap);
  assert.throws(() => f.tracking.refreshSource(), /no longer readable/);
  fs.mkdirSync(f.roadmap);
  assert.throws(() => f.tracking.refreshSource(), /not a regular file/);
});

test("corrupt revision metadata is not silently treated as a new baseline", (t) => {
  const f = workspace(t);
  fs.writeFileSync(f.tracking.sourceStateFile, "{broken");
  assert.throws(() => prepareTracking(f.roadmap, f.progress, f.dir), /cannot read source revision state/);
});

test("revision metadata cannot be reused for another source or progress file", (t) => {
  const f = workspace(t);
  const state = JSON.parse(fs.readFileSync(f.tracking.sourceStateFile, "utf8"));
  fs.writeFileSync(f.tracking.sourceStateFile, JSON.stringify({ ...state, progress: "/other" }));
  assert.throws(() => prepareTracking(f.roadmap, f.progress, f.dir), /cannot read source revision state/);
});

function fixture(t, { mode = "worker-edit", staleStatus = "COMPLETE", every = 0 } = {}) {
  const f = workspace(t);
  const mock = path.join(f.dir, "mock.cjs");
  fs.writeFileSync(mock, `#!/usr/bin/env node
const fs = require('node:fs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const prompt = process.argv.at(-1);
const source = ${JSON.stringify(f.roadmap)};
const progress = ${JSON.stringify(f.progress)};
const revised = ${JSON.stringify(revised)};
const mode = ${JSON.stringify(mode)};
const role = prompt.includes('Runner role: SUPERVISOR') ? 'S' : 'W';
const n = fs.existsSync(role) ? Number(fs.readFileSync(role)) + 1 : 1;
fs.writeFileSync(role, String(n));
if (n > 8) process.exit(99);
const snapshot = JSON.parse(prompt.match(/^Source roadmap snapshot: (.+)$/m)[1]);
const text = fs.readFileSync(snapshot, 'utf8');
const sha = prompt.match(/^Source roadmap revision: (.+)$/m)[1];
assert.equal(crypto.createHash('sha256').update(text).digest('hex'), sha);
const pending = prompt.includes('Roadmap reconciliation required: YES');
fs.appendFileSync('observations.jsonl', JSON.stringify({role, n, text, sha, pending}) + '\\n');
const publish = () => {
  fs.writeFileSync(source + '.next', revised);
  fs.renameSync(source + '.next', source);
  assert.equal(fs.readFileSync(snapshot, 'utf8'), text, 'active snapshot must remain stable');
};
const capacity = () => {
  console.log(JSON.stringify({type:'error', message:'Selected model is at capacity'}));
  process.exitCode = 1;
};
if (role === 'S') {
  const evidence = JSON.parse(prompt.match(/^Run evidence JSON: (.+)$/m)[1]);
  fs.writeFileSync('review-directory', require('node:path').dirname(evidence));
  publish();
  fs.writeFileSync(progress, '# State\\nStatus: COMPLETE\\n\\n## Evidence\\nPrior proof.\\n');
  if (mode === 'supervisor-capacity-edit') capacity();
  // No Review ID: this obsolete review must not prevent reconciliation.
} else if (n === 1 && ['worker-edit', 'capacity-edit', 'failure-edit', 'timeout-edit'].includes(mode)) {
  publish();
  fs.writeFileSync(progress, '# State\\nStatus: ${staleStatus}\\n\\n## Evidence\\nPrior proof.\\n');
  if (mode === 'capacity-edit') capacity();
  if (mode === 'failure-edit') process.exitCode = 7;
  if (mode === 'timeout-edit') {
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  }
} else if (n === 1 && mode.startsWith('supervisor-')) {
  fs.appendFileSync(progress, '\\nPrior proof.\\n');
} else if (n === 1 && mode === 'capacity-wait') {
  capacity();
} else {
  assert.equal(text, revised);
  assert.equal(pending, true);
  if (n > 1 && mode !== 'capacity-wait') assert.match(fs.readFileSync(progress, 'utf8'), /Prior proof/);
  fs.writeFileSync(progress, '# State\\nStatus: COMPLETE\\n\\n## Evidence\\nPrior proof.\\nNEW verified against corrected requirements.\\n');
}
`);
  fs.chmodSync(mock, 0o755);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ROADMAP_")));
  Object.assign(env, { ROADMAP_CAPACITY_RETRIES: "1", ROADMAP_CAPACITY_DELAY: "1", ROADMAP_CAPACITY_MAX_DELAY: "1" });
  const args = [path.join(root, "bin/roadmap-runner.js"), f.roadmap,
    "--progress-file", f.progress, "--client-bin", mock, "--supervisor-every", String(every)];
  if (mode === "timeout-edit") args.push("--timeout", "500ms");
  t.after(() => {
    const marker = path.join(f.dir, "review-directory");
    if (fs.existsSync(marker)) fs.rmSync(fs.readFileSync(marker, "utf8"), { recursive: true, force: true });
  });
  return { ...f, args, options: { cwd: f.dir, env, encoding: "utf8", timeout: 10_000 } };
}

function run(f) {
  const result = spawnSync(process.execPath, f.args, f.options);
  assert.equal(result.error, undefined);
  return result;
}
const observations = (f) => fs.readFileSync(path.join(f.dir, "observations.jsonl"), "utf8").trim().split("\n").map(JSON.parse);

for (const staleStatus of ["COMPLETE", "BLOCKED", "IN_PROGRESS"]) {
  test(`live edit overrides stale ${staleStatus} and runs corrected requirements next`, (t) => {
    const f = fixture(t, { staleStatus, every: 1 });
    const result = run(f);
    assert.equal(result.status, 0, result.stderr);
    const seen = observations(f);
    assert.deepEqual(seen.map(x => x.role), ["W", "W"]);
    assert.equal(seen[0].text, original);
    assert.equal(seen[1].text, revised);
    assert.equal(seen[1].pending, true);
    assert.match(result.stdout, /Roadmap changed/);
    assert.match(fs.readFileSync(f.progress, "utf8"), /NEW verified/);
    assert.equal(fs.readFileSync(f.roadmap, "utf8"), revised);
    assert.equal(prepareTracking(f.roadmap, f.progress, f.dir).needsReconciliation, false);
  });
}

for (const staleStatus of ["COMPLETE", "BLOCKED"]) {
  test(`edit between invocations reopens persisted ${staleStatus} without erasing evidence`, (t) => {
    const f = fixture(t, { mode: "resume" });
    fs.writeFileSync(f.progress, `# State\nStatus: ${staleStatus}\n\n## Evidence\nPrior proof.\n`);
    publish(f.roadmap, revised);
    const result = run(f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(observations(f).length, 1);
    assert.equal(observations(f)[0].pending, true);
    assert.match(fs.readFileSync(f.progress, "utf8"), /Prior proof/);
  });
}

for (const mode of ["capacity-edit", "timeout-edit"]) {
  test(`${mode} preserves the revision through recovery`, (t) => {
    const f = fixture(t, { mode });
    const result = run(f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(observations(f).length, 2);
    assert.equal(observations(f)[1].text, revised);
    if (mode === "capacity-edit") assert.match(result.stdout, /retry 1\/1/);
    else assert.match(result.stdout, /starting a fresh session/);
  });
}

for (const mode of ["supervisor-edit", "supervisor-capacity-edit"]) {
  test(`${mode} defers obsolete review results to a new worker`, (t) => {
    const f = fixture(t, { mode, every: 1 });
    const result = run(f);
    assert.equal(result.status, 0, result.stderr);
    const seen = observations(f);
    assert.deepEqual(seen.map(x => x.role), ["W", "S", "W"]);
    assert.equal(seen[1].text, original);
    assert.equal(seen[2].text, revised);
    assert.equal(seen[2].pending, true);
  });
}

test("real external controller edit during capacity backoff is adopted by the next attempt", async (t) => {
  const f = fixture(t, { mode: "capacity-wait" });
  const child = spawn(process.execPath, f.args, { ...f.options, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", edited = false;
  child.stdout.on("data", chunk => {
    stdout += chunk;
    if (!edited && stdout.includes("retry 1/1")) {
      publish(f.roadmap, revised);
      edited = true;
    }
  });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(edited, true);
  assert.equal(code, 0, stderr);
  assert.equal(observations(f)[1].text, revised);
});

test("source changes do not swallow an independent fatal client failure", (t) => {
  const f = fixture(t, { mode: "failure-edit" });
  const result = run(f);
  assert.equal(result.status, 7);
  assert.equal(observations(f).length, 1);
  assert.equal(prepareTracking(f.roadmap, f.progress, f.dir).needsReconciliation, true);
  assert.equal(fs.readFileSync(f.roadmap, "utf8"), revised);
});
