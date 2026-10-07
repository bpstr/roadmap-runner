#!/usr/bin/env node
import { spawnSync } from "node:child_process";

// Use as ROADMAP_NOTIFY_BIN=/absolute/path/to/notify-macos.js.
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 16384) throw new Error("notification payload too large");
}
const event = JSON.parse(input);
const titles = {
  "runner.blocked": "Roadmap needs help",
  "runner.needs_attention": "Roadmap task deferred",
  "runner.usage_paused": "Roadmap paused for usage reset",
  "runner.usage_wait_expired": "Roadmap usage wait expired",
  "runner.failed": "Roadmap runner stopped",
  "runner.completed": "Roadmap completed",
  "runner.supervisor_deferred": "Roadmap review deferred",
};
if (titles[event.type]) {
  if (process.platform !== "darwin") throw new Error("this notification example requires macOS");
  const tasks = (event.items || []).map(item => item.task).join(", ");
  const body = `${tasks || event.type}. Open progress: ${event.progressFile}`;
  // Payload is passed as AppleScript arguments, never interpolated into code.
  const result = spawnSync("/usr/bin/osascript", ["-e", "on run argv\ndisplay notification (item 1 of argv) with title (item 2 of argv)\nend run", "--", body, titles[event.type]], { timeout: 5000, stdio: "ignore" });
  process.exitCode = result.status === 0 ? 0 : 1;
}
