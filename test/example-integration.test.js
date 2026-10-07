import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "roadmap-runner.js");
const fixture = path.join(root, "test", "fixtures", "mock-codex.js");
const example = path.join(root, "examples", "three-iteration-roadmap.md");

test("example roadmap completes in exactly three iterations", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "roadmap-runner-example-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const roadmap = path.join(temp, "roadmap.md");
  fs.copyFileSync(example, roadmap);
  const originalRoadmap = fs.readFileSync(roadmap);

  const result = spawnSync(process.execPath, [
    cli,
    roadmap,
    "--client",
    "codex",
    "--client-bin",
    fixture,
    "--timeout",
    "30s",
  ], {
    cwd: temp,
    encoding: "utf8",
    env: { ...process.env, ROADMAP_NOTIFY_BIN: "", ROADMAP_RECOVERY_DELAY: "1", ROADMAP_RECOVERY_MAX_DELAY: "1" },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const revision = createHash("sha256").update(fs.readFileSync(path.join(root, "prompt.md"))).digest("hex").slice(0, 12);
  assert.ok(result.stdout.includes(`Prompt:    ${revision}`));
  for (const iteration of [1, 2, 3]) {
    assert.ok(result.stdout.includes(`Context ${revision} iteration ${iteration}`));
  }

  const iterationStarts = result.stdout.match(/^===== iteration /gm) || [];
  assert.equal(iterationStarts.length, 3, result.stdout);

  assert.match(result.stdout, /Completed EX-1/);
  assert.match(result.stdout, /Completed EX-2/);
  assert.match(result.stdout, /Completed EX-3/);
  assert.match(result.stdout, /Roadmap complete after 3 iteration\(s\)\./);

  assert.deepEqual(fs.readFileSync(roadmap), originalRoadmap);
  const progressPath = result.stdout.match(/^Progress:\s+(.+?) \(bounded active state;/m)?.[1];
  assert.ok(progressPath, result.stdout);
  const finalProgress = fs.readFileSync(progressPath, "utf8");
  assert.match(finalProgress, /^Status: COMPLETE$/m);
  assert.equal((finalProgress.match(/- \[x\] EX-/g) || []).length, 3);
  assert.equal((finalProgress.match(/- \[ \] EX-/g) || []).length, 0);

  assert.equal(fs.readFileSync(path.join(temp, "example-output", "one.txt"), "utf8"), "one\n");
  assert.equal(fs.readFileSync(path.join(temp, "example-output", "two.txt"), "utf8"), "two\n");
  assert.equal(fs.readFileSync(path.join(temp, "example-output", "three.txt"), "utf8"), "three\n");

  assert.doesNotMatch(finalProgress, /## Iteration history/);
  const historyPath = result.stdout.match(/^History:\s+(.+?) \(archived snapshots;/m)?.[1];
  assert.ok(historyPath, result.stdout);
  assert.equal(fs.readdirSync(historyPath).filter(name => name.endsWith(".md.gz")).length, 3);
});
