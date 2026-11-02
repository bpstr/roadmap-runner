import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicJson, registryRoot } from "./run-state.js";
import { probe, type MonitorConfig } from "./monitor-config.js";
import { acquirePublisher } from "./monitor-lock.js";
export async function flushStored(
  config: MonitorConfig,
  file: string,
  state: any,
) {
  const release = acquirePublisher(file);
  if (!release) return false;
  try {
    // Reload under the lock: a publisher may have completed since directory enumeration.
    state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      state.connectionId !== config.connectionId ||
      (state.installationId && state.installationId !== config.installationId)
    )
      return false;
    const verified =
      config.verified && config.installationId
        ? { installation_id: config.installationId }
        : await probe(config);
    if (
      state.installationId &&
      state.installationId !== verified.installation_id
    )
      return false;
    const base = state.terminal ?? state.replayBase ?? state.initial;
    if (!base) return false;
    const events = [];
    for (const event of state.events.slice(0, 32)) {
      if (
        Buffer.byteLength(
          JSON.stringify({ ...base, events: [...events, event] }),
        ) > 65536
      )
        break;
      events.push(event);
    }
    const report = { ...base, kind: "replay", report_id: randomUUID(), events };
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(4000),
      redirect: "error",
    });
    if (!response.ok) return false;
    const result = await response.json();
    if (result.installation_id !== verified.installation_id) return false;
    const ids = new Set(events.map((e) => e.id));
    state.events = state.events.filter((e) => !ids.has(e.id));
    if (state.events.length === 0) {
      delete state.terminal;
      delete state.initial;
      delete state.replayBase;
    }
    atomicJson(file, state);
    return true;
  } catch {
    return false;
  } finally {
    release();
  }
}
