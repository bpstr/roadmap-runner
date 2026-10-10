import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as parseToml } from 'smol-toml';
import { assertController } from './run-manager.js';
import { adapters, checkConnectivity, packageRoot, sameEntry, setupPaths, treeHash, version } from './setup.js';

const readBounded = (file: string, limit: number) => {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > limit) throw new Error('Unsupported configuration file');
  return fs.readFileSync(file, 'utf8');
};
const mentions = (text: string, value: string) => {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(?:^|[\\s"\x27\x60(=])' + escaped + '(?=$|[\\s"\x27\x60),;]|\\.(?=\\s|$))').test(text);
};
const hourly = (rule: unknown) => {
  if (typeof rule !== 'string') return false;
  const fields: Record<string, string> = {};
  for (const part of rule.replace(/^RRULE:/, '').split(';')) {
    const [key, value, extra] = part.split('=');
    if (!key || !value || extra !== undefined || key in fields || !['FREQ', 'INTERVAL', 'BYMINUTE', 'BYSECOND'].includes(key)) return false;
    fields[key] = value;
  }
  return fields.FREQ === 'HOURLY' && (!fields.INTERVAL || fields.INTERVAL === '1') &&
    ['BYMINUTE', 'BYSECOND'].every(key => !fields[key] || (/^\d{1,2}$/.test(fields[key]) && Number(fields[key]) < 60));
};
const monitorStatus = (options: { monitorId?: string; runId?: string }, workspace: string, workspaceAlias: string, codexHome: string, apps: string[]) => {
  const result: any = { status: 'not_checked', execution: 'not_verified' };
  if (!options.monitorId) {
    result.detail = 'Create an hourly host monitor, then pass its Codex --monitor-id to verify saved registration.';
    return result;
  }
  result.id = options.monitorId;
  result.basis = 'local_codex_configuration';
  if (!apps.includes('codex')) return { ...result, status: 'unsupported_host', detail: 'Saved monitor inspection currently supports Codex only.' };
  const file = path.join(codexHome, 'automations', options.monitorId, 'automation.toml');
  result.path = file;
  try {
    const root = fs.realpathSync(path.join(codexHome, 'automations'));
    const resolved = fs.realpathSync(file);
    if (!resolved.startsWith(root + path.sep)) throw new Error('Monitor path escapes the automation directory');
    const saved: any = parseToml(readBounded(file, 65536));
    if (saved.version !== 1 || saved.id !== options.monitorId || !['heartbeat', 'cron'].includes(saved.kind) || typeof saved.prompt !== 'string' ||
      (saved.kind === 'heartbeat' && (typeof saved.target_thread_id !== 'string' || !saved.target_thread_id))) {
      return { ...result, status: 'invalid', detail: 'Unrecognized saved Codex monitor format.' };
    }
    if (saved.status !== 'ACTIVE') return { ...result, status: 'inactive', detail: 'The saved monitor is not active.' };
    if (!hourly(saved.rrule)) return { ...result, status: 'cadence_unverified', detail: 'Expected FREQ=HOURLY;INTERVAL=1, optionally with one minute and second. Restricted or other schedules are not qualified.' };
    const cwdMatches = Array.isArray(saved.cwds) && saved.cwds.some(cwd => {
      try { return typeof cwd === 'string' && fs.realpathSync(cwd) === workspace; } catch { return false; }
    });
    if (!cwdMatches && ![workspace, workspaceAlias].some(value => mentions(saved.prompt, value))) return { ...result, status: 'workspace_mismatch', detail: 'The saved monitor must name this absolute workspace in its prompt or project directories.' };
    if (options.runId && !mentions(saved.prompt, options.runId)) return { ...result, status: 'run_mismatch', detail: 'The saved monitor does not name the requested run ID.' };
    return { ...result, status: 'registered_hourly', runId: options.runId, detail: 'Saved active hourly registration matches. Host availability and successful scheduled execution are not verified.' };
  } catch (error) {
    return { ...result, status: error.code === 'ENOENT' ? 'missing' : 'invalid', detail: 'The saved monitor is missing, unreadable or invalid; inspect it in the host scheduler.' };
  }
};

export const doctor = (options: { apps: string[]; scope?: string; workspace: string; monitorId?: string; runId?: string }, dependencies: any = {}) => {
  assertController();
  const workspace = fs.realpathSync(options.workspace);
  const scope = options.scope || 'project';
  if (!['project', 'user'].includes(scope)) throw new Error('Scope must be project or user');
  const names = [...new Set(options.apps.length ? options.apps : ['codex'])];
  for (const name of names) if (!Object.hasOwn(adapters, name)) throw new Error(`Unsupported doctor app: ${name}`);
  if (options.runId && !options.monitorId) throw new Error('--run-id requires --monitor-id');
  for (const id of [options.monitorId, options.runId]) if (id !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error('Monitor and run IDs must contain only letters, numbers, underscores or hyphens');
  const home = dependencies.home || os.homedir();
  const env = dependencies.env ?? (dependencies.home ? {} : process.env);
  const apps = names.map(name => {
    const paths = setupPaths(name, scope, workspace, home, env);
    const item: any = { app: name, scope, ...paths, mcp: 'missing', skill: 'missing', connectivity: 'not_run' };
    const expected = { command: process.execPath, args: [path.join(packageRoot, 'bin/roadmap-runner.js'), 'mcp', '--workspace', workspace] };
    try {
      const text = readBounded(paths.config, 1024 * 1024);
      const parsed: any = name === 'claude' ? JSON.parse(text) : parseToml(text);
      const entry = parsed[name === 'claude' ? 'mcpServers' : 'mcp_servers']?.['roadmap-runner'];
      item.mcp = !entry ? 'missing' : sameEntry(entry, name === 'claude' ? { type: 'stdio', ...expected } : expected) ? 'registered' : 'conflict';
      // Do not execute commands from app configuration. Probe only our verified entrypoint.
      if (item.mcp === 'registered') item.connectivity = checkConnectivity(workspace, dependencies.spawnSync);
    } catch (error) { item.mcp = error.code === 'ENOENT' ? 'missing' : 'invalid'; }
    try {
      item.skill = treeHash(paths.skillPath) === treeHash(path.join(packageRoot, 'skills', 'write-runner-roadmap')) ? 'current' : 'different';
    } catch (error) { item.skill = error.code === 'ENOENT' ? 'missing' : 'invalid'; }
    item.ready = item.mcp === 'registered' && item.connectivity === 'passed_no_inference';
    if (!item.ready || item.skill !== 'current') item.nextStep = `Run roadmap-runner setup --app ${name} --scope ${scope} --workspace ${JSON.stringify(workspace)}; conflicts and user-modified skills are preserved.`;
    return item;
  });
  const monitor = monitorStatus(options, workspace, path.resolve(options.workspace), env.CODEX_HOME || path.join(home, '.codex'), names);
  return { version, workspace, apps, monitor, ok: apps.every(item => item.ready) && (!options.monitorId || monitor.status === 'registered_hourly') };
};
