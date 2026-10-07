import test from "node:test";
import assert from "node:assert/strict";
import { buildClientInvocation } from "../lib/clients.js";
import { parseArgs, parseDuration, roadmapStatus } from "../lib/runner.js";

const base = {
  prompt: "PROMPT",
  workdir: "/workspace",
  model: "",
  effort: "",
  executable: "",
};

test("Codex adapter preserves accepted unattended invocation", () => {
  const result = buildClientInvocation({ ...base, client: "codex" });
  assert.equal(result.command, "codex");
  assert.deepEqual(result.args.slice(0, 7), [
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--cd",
    "/workspace",
  ]);
  assert.equal(result.args.at(-1), "PROMPT");
  assert.equal(result.approvalFree, true);
});

test("Claude adapter bypasses permission prompts", () => {
  const result = buildClientInvocation({ ...base, client: "claude" });
  assert.deepEqual(result.args, ["-p", "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose", "PROMPT"]);
  assert.equal(result.approvalFree, true);
});

test("Gemini adapter uses current noninteractive YOLO mode", () => {
  const result = buildClientInvocation({ ...base, client: "gemini" });
  assert.deepEqual(result.args, [
    "-p",
    "PROMPT",
    "--skip-trust",
    "--approval-mode=yolo",
    "--output-format",
    "text",
  ]);
  assert.equal(result.approvalFree, true);
});

test("Campfire-compatible secondary adapters are stable", () => {
  assert.deepEqual(
    buildClientInvocation({ ...base, client: "grok" }).args,
    ["-p", "PROMPT", "--yolo"],
  );
  assert.deepEqual(
    buildClientInvocation({ ...base, client: "muse" }).args,
    ["exec", "--yolo", "PROMPT"],
  );
  const kimi = buildClientInvocation({ ...base, client: "kimi" });
  assert.deepEqual(kimi.args, ["-p", "PROMPT"]);
  assert.equal(kimi.approvalFree, false);
});

test("Codex model and effort overrides are applied", () => {
  const result = buildClientInvocation({
    ...base,
    client: "codex",
    model: "example-model",
    effort: "high",
  });
  assert.ok(result.args.includes("--model"));
  assert.ok(result.args.includes("example-model"));
  assert.ok(result.args.includes('model_reasoning_effort="high"'));
});

test("duration parsing supports runner units", () => {
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("45m"), 2_700_000);
  assert.equal(parseDuration("30s"), 30_000);
  assert.throws(() => parseDuration("0h"));
});

test("roadmap completion states are exact line based", () => {
  assert.equal(roadmapStatus("# Roadmap\nStatus: IN_PROGRESS\n"), "in-progress");
  assert.equal(roadmapStatus("# Roadmap\nStatus: COMPLETE\n"), "complete");
  assert.equal(roadmapStatus("# Roadmap\nStatus: BLOCKED\n"), "blocked");
});

test("client can be selected through args or environment", () => {
  assert.equal(parseArgs(["roadmap.md", "--client", "claude"], {}).client, "claude");
  assert.equal(parseArgs(["roadmap.md"], { ROADMAP_CLIENT: "gemini" }).client, "gemini");
  assert.throws(() => parseArgs(["roadmap.md", "--client", "unknown"], {}));
});
