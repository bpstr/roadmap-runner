#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const prompt = process.argv.at(-1) || "";
const revision = prompt.match(/Loaded prompt revision: ([a-f0-9]{12})/);
const iteration = prompt.match(/^Iteration: ([1-9][0-9]*)$/m);
if (!revision || !iteration || !/^Session started \(UTC\): /m.test(prompt)) {
  console.error("mock-codex: runner context missing");
  process.exit(2);
}
console.log(JSON.stringify({ type: "item.completed", item: {
  type: "agent_message", text: `Context ${revision[1]} iteration ${iteration[1]}`,
} }));

const sourceMatch = prompt.match(/Work on this implementation roadmap:\s*\n\s*([^\n]+)/);
const trackingMatch = prompt.match(/Tracking file \(progress \/ delivery evidence\):\s*\n\s*([^\n]+)/);
if (!sourceMatch || !trackingMatch) {
  console.error("mock-codex: source/tracking path not found in prompt");
  process.exit(2);
}

const roadmap = sourceMatch[1].trim();
const tracking = trackingMatch[1].trim();
const dir = path.dirname(roadmap);
const outputDir = path.join(dir, "example-output");
fs.mkdirSync(outputDir, { recursive: true });

const source = fs.readFileSync(roadmap, "utf8");
let contents = fs.readFileSync(tracking, "utf8");
const tasks = [
  { id: "EX-1", file: "one.txt", text: "one\n" },
  { id: "EX-2", file: "two.txt", text: "two\n" },
  { id: "EX-3", file: "three.txt", text: "three\n" },
];

if (!/- \[[ x]\] EX-/.test(contents)) {
  const gates = source.match(/^- \[ \] EX-[^\r\n]+/gm) || [];
  contents = contents.replace(
    "No gates recorded yet; this is not completion evidence.",
    gates.join("\n"),
  );
}

const current = tasks.find((task) => contents.includes(`- [ ] ${task.id} —`));
if (!current) {
  console.error("mock-codex: no unchecked task found");
  process.exit(3);
}

fs.writeFileSync(path.join(outputDir, current.file), current.text, "utf8");
contents = contents.replace(`- [ ] ${current.id} —`, `- [x] ${current.id} —`);

const remaining = tasks.filter((task) => contents.includes(`- [ ] ${task.id} —`));
contents = contents.replace(
  /## Current handoff[\s\S]*?(?=\n## Acceptance gates)/,
  `## Current handoff\n\n- Active checkbox: ${remaining[0]?.id || "none"}\n- Next ready checkbox: ${remaining[0]?.id || "none"}\n`,
);

const evidenceLine = `- ${current.id} — implemented and verified by mock fixture.`;
if (contents.includes("_No completed items yet._")) {
  contents = contents.replace("_No completed items yet._", evidenceLine);
} else {
  contents = contents.replace("## Deferred gates", `${evidenceLine}\n\n## Deferred gates`);
}

if (remaining.length === 0) {
  contents = contents.replace("Status: IN_PROGRESS", "Status: COMPLETE");
}

fs.writeFileSync(tracking, contents, "utf8");

process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: {
    type: "agent_message",
    text: `Completed ${current.id}`,
  },
}) + "\n");
