// Keep runner telemetry credentials out of providers, hooks, and verification commands.
export function withoutMonitorCredentials(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !name.startsWith("ROADMAP_MONITOR"),
    ),
  );
}
