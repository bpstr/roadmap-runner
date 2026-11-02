import fs from "node:fs";
import {
  configureMonitor,
  diagnostics,
  monitorConfig,
  probe,
  readMonitorConfig,
  saveMonitorConfig,
} from "./monitor-config.js";
import { flushMonitor } from "./monitor.js";
async function maskedKey() {
  if (!process.stdin.isTTY)
    throw new Error(
      "Use --api-key-stdin or ROADMAP_MONITOR_API_KEY when input is not a terminal",
    );
  process.stderr.write("Monitor API key: ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const done = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", read);
      process.stderr.write("\n");
    };
    const read = (buffer: Buffer) => {
      for (const char of buffer.toString()) {
        if (char === "\u0003") {
          done();
          reject(new Error("Cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          done();
          resolve(value.trim());
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= " " && value.length < 512) value += char;
      }
    };
    process.stdin.on("data", read);
  });
}
async function stdinKey() {
  let key = "";
  for await (const chunk of process.stdin) {
    key += chunk.toString();
    if (key.length > 512) throw new Error("Monitor key input is too long");
  }
  return key.trim();
}
export async function monitorCommand(argv: string[]) {
  const args = [...argv];
  const command = args.shift();
  const json = args.includes("--json");
  if (json) args.splice(args.indexOf("--json"), 1);
  const take = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return;
    const value = args[i + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`${name} requires a value`);
    args.splice(i, 2);
    return value;
  };
  let result: any;
  if (command === "configure") {
    const url = take("--url") ?? process.env.ROADMAP_MONITOR_URL;
    const label = take("--label");
    const useStdin = args.includes("--api-key-stdin");
    if (useStdin) args.splice(args.indexOf("--api-key-stdin"), 1);
    if (!url || args.length)
      throw new Error(
        "monitor configure requires --url <ingestion-url> [--api-key-stdin] [--label <name>]",
      );
    const key = useStdin
      ? await stdinKey()
      : (process.env.ROADMAP_MONITOR_API_KEY ?? (await maskedKey()));
    result = await configureMonitor(url, key, label);
  } else {
    if (args.length) throw new Error("Unexpected monitor arguments");
    if (command === "status") result = diagnostics();
    else if (command === "enable" || command === "disable") {
      const config = readMonitorConfig();
      if (command === "enable" && !config)
        throw new Error("Monitoring is not configured; use monitor configure first");
      if (config) saveMonitorConfig({ ...config, enabled: command === "enable" });
      result = diagnostics();
    } else if (command === "test") {
      const config = monitorConfig();
      if (!config)
        throw new Error("Monitoring is not configured or is disabled");
      const body = await probe(config);
      saveMonitorConfig({
        ...config,
        verified: true,
        installationId: body.installation_id,
      });
      result = { ok: true, ...diagnostics() };
    } else if (command === "flush") result = await flushMonitor();
    else
      throw new Error(
        "monitor requires configure, test, status, flush, enable, or disable",
      );
  }
  console.log(JSON.stringify(result, null, json ? 0 : 2));
  return result;
}
