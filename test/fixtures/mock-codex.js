#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const prompt = process.argv.at(-1) || "";
const match = prompt.match(/Work on this implementation roadmap:\s*\n\s*([^\n]+)/);
if (!match) {
  console.error("mock-codex: roadmap path not found in prompt");
  process.exit(2);
}

const roadmap = match[1].trim();
const dir = path.dirname(roadmap);
const outputDir = path.join(dir, "example-output");
fs.mkdirSync(outputDir, { recursive: true });

let contents = fs.readFileSync(roadmap, "utf8");
const tasks = [
  { id: "EX-1", file: "one.txt", text: "one\n" },
  { id: "EX-2", file: "two.txt", text: "two\n" },
  { id: "EX-3", file: "three.txt", text: "three\n" },
];

const current = tasks.find((task) => contents.includes(`- [ ] ${task.id} —`));
if (!current) {
  console.error("mock-codex: no unchecked task found");
  process.exit(3);
}

fs.writeFileSync(path.join(outputDir, current.file), current.text, "utf8");
contents = contents.replace(`- [ ] ${current.id} —`, `- [x] ${current.id} —`);

const remaining = tasks.filter((task) => contents.includes(`- [ ] ${task.id} —`));
contents = contents.replace(
  /- Active checkbox: .*\n- Next ready checkbox: .*\n/,
  remaining.length
    ? `- Active checkbox: ${remaining[0].id}\n- Next ready checkbox: ${remaining[0].id}\n`
    : "- Active checkbox: none\n- Next ready checkbox: none\n",
);

contents = contents.replace(
  "_No completed items yet._",
  `- ${current.id} — implemented and verified by mock fixture.`,
);

if (remaining.length === 0) {
  contents = contents.replace("Status: IN_PROGRESS", "Status: COMPLETE");
}

fs.writeFileSync(roadmap, contents, "utf8");

process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: {
    type: "agent_message",
    text: `Completed ${current.id}`,
  },
}) + "\n");
