import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomicJson, privateDir, registryRoot } from "./run-state.js";
export type MonitorConfig = {
  version: 1;
  endpoint: string;
  apiKey: string;
  installationId?: string;
  connectionId: string;
  enabled: boolean;
  verified: boolean;
  label?: string;
};
export const monitorRoot = () => path.join(registryRoot(), "monitor");
const configFile = () => path.join(monitorRoot(), "config.json");
export const readMonitorConfig = (): MonitorConfig | null => {
  try {
    return JSON.parse(fs.readFileSync(configFile(), "utf8"));
  } catch {
    return null;
  }
};
export function endpoint(value: string) {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
    )
  )
    throw new Error(
      "Monitor endpoint requires HTTPS (HTTP is allowed only on localhost)",
    );
  return u.href;
}
export function monitorConfig(): MonitorConfig | null {
  if (process.env.ROADMAP_MONITOR === "off") return null;
  const saved = readMonitorConfig();
  if (saved?.enabled === false) return null;
  const url = process.env.ROADMAP_MONITOR_URL ?? saved?.endpoint;
  const key = process.env.ROADMAP_MONITOR_API_KEY ?? saved?.apiKey;
  if (!url || !key) return null;
  try {
    const resolved = endpoint(url);
    if (!/^rm_[a-f0-9]{16}_[a-f0-9]{64}$/.test(key)) return null;
    if (saved && saved.endpoint === resolved && saved.apiKey === key)
      return saved;
    return {
      version: 1,
      endpoint: resolved,
      apiKey: key,
      enabled: true,
      verified: false,
      connectionId: createHash("sha256")
        .update(resolved + "\n" + key)
        .digest("hex")
        .slice(0, 32),
    };
  } catch {
    return null;
  }
}
export async function probe(
  config: MonitorConfig,
  transport: typeof fetch = fetch,
) {
  const response = await transport(config.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ protocol_version: 1, kind: "probe" }),
    signal: AbortSignal.timeout(4000),
    redirect: "error",
  });
  if (!response.ok)
    throw Object.assign(
      new Error(`Monitor rejected probe (${response.status})`),
      { status: response.status },
    );
  let body: any;
  try {
    body = await response.json();
  } catch {
    throw Object.assign(new Error("Monitor protocol is incompatible"), {
      status: 400,
    });
  }
  if (
    !body ||
    typeof body.installation_id !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      body.installation_id,
    ) ||
    !Array.isArray(body.protocol_versions) ||
    !body.protocol_versions.includes(1)
  )
    throw Object.assign(new Error("Monitor protocol is incompatible"), {
      status: 400,
    });
  return body;
}
export function saveMonitorConfig(config: MonitorConfig) {
  privateDir(monitorRoot());
  privateDir(path.join(monitorRoot(), "connections"));
  atomicJson(
    path.join(monitorRoot(), "connections", `${config.connectionId}.json`),
    config,
  );
  atomicJson(configFile(), config);
}
export async function configureMonitor(
  url: string,
  key: string,
  label?: string,
  transport: typeof fetch = fetch,
) {
  if (!/^rm_[a-f0-9]{16}_[a-f0-9]{64}$/.test(key))
    throw new Error("Invalid monitor write key");
  const previous = readMonitorConfig();
  let config: MonitorConfig = {
    version: 1,
    endpoint: endpoint(url),
    apiKey: key,
    connectionId: randomUUID(),
    enabled: true,
    verified: false,
    ...(label ? { label: label.slice(0, 80) } : {}),
  };
  try {
    const result = await probe(config, transport);
    config = {
      ...config,
      verified: true,
      installationId: result.installation_id,
    };
    if (
      previous?.endpoint === config.endpoint &&
      previous.installationId === config.installationId
    )
      config.connectionId = previous.connectionId;
  } catch (error) {
    if (error.status) throw error;
  }
  saveMonitorConfig(config);
  return diagnostics(config);
}
export function diagnostics(config = monitorConfig()) {
  if (!config)
    return {
      enabled: false,
      configured: Boolean(readMonitorConfig()),
      protocol_version: 1,
    };
  let delivery;
  try {
    delivery = JSON.parse(
      fs.readFileSync(path.join(monitorRoot(), "delivery.json"), "utf8"),
    );
  } catch {}
  return {
    enabled: config.enabled,
    endpoint_origin: new URL(config.endpoint).origin,
    key_id: config.apiKey.split("_")[1] + "…",
    installation_id: config.installationId ?? null,
    verified: config.verified,
    protocol_version: 1,
    last_delivery: delivery ?? null,
  };
}
