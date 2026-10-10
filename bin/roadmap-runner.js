#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_NAMES } from '../lib/clients.js';
import { parseArgs } from '../lib/runner.js';
import { RunManager, assertController } from '../dist/run-manager.js';
import { serveMcp } from '../dist/mcp.js';
import { setup } from '../dist/setup.js';
import { doctor } from '../dist/doctor.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
function help() {
  console.log(`Roadmap Runner ${PACKAGE.version}

Usage:
  roadmap-runner <roadmap-file> [options]
  roadmap-runner start <roadmap-file> [options] [--json]
  roadmap-runner status [run-id] [--workspace <path>] [--json]
  roadmap-runner stop <run-id> [--workspace <path>] [--json]
  roadmap-runner mcp --workspace <absolute-path>
  roadmap-runner setup --app codex|claude|grok [--scope project|user] [--dry-run]
  roadmap-runner doctor [--app codex|claude|grok] [--scope project|user] [--json]

Management options:
  --workspace <path>     Explicit workspace binding; defaults to cwd for CLI
  --idempotency-key <id> Repeat the same managed start safely
  --notify attention|off Desktop notification mode (default attention)
  --notify-on <events>   Comma-separated event types, e.g. runner.usage_paused
  --monitor-id <id>      Doctor: inspect saved Codex hourly-monitor registration
  --run-id <id>          Doctor: require that monitor to name this managed run

Options:
  --client <name>        CLI client: ${CLIENT_NAMES.join(", ")}. Default: codex
  --progress-file <path> Override the bounded progress-state path; workers never edit source
  --timeout <duration>   Per-run timeout. Default: 2h
  --supervisor-every <n> Review after n workers (1-20); default 5, 0 disables
  --supervisor-timeout <duration> Review timeout; default 10m
  --model <model>        Optional client model override
  --effort <level>       Optional reasoning effort override (Codex)
  --client-bin <path>    Override the selected client executable
  --help                 Show help
  --version              Show version

Environment:
  ROADMAP_CLIENT
  ROADMAP_PROGRESS_FILE
  ROADMAP_SUPERVISOR_EVERY
  ROADMAP_SUPERVISOR_TIMEOUT
  ROADMAP_TIMEOUT
  ROADMAP_MODEL
  ROADMAP_EFFORT
  ROADMAP_CLIENT_BIN
  ROADMAP_NOTIFY_BIN         Notification executable; receives event JSON on stdin
  ROADMAP_USAGE_MAX_WAIT     Quota wait ceiling in seconds; default/max 86400
  ROADMAP_RECOVERY_DELAY     No-progress recheck delay in seconds; default 60
  ROADMAP_RECOVERY_MAX_DELAY Maximum no-progress delay in seconds; default 900
  ROADMAP_CAPACITY_RETRIES    Consecutive capacity retries; default 10
  ROADMAP_CAPACITY_DELAY      Initial delay in seconds; default 300
  ROADMAP_CAPACITY_MAX_DELAY  Maximum delay in seconds; default 300

The current directory is always the workspace.
`);
}

const main = async () => {
  let argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { help(); return; }
  if (argv.includes('--version') || argv.includes('-v')) { console.log(PACKAGE.version); return; }
  assertController();
  const commands = ['start', 'stop', 'status', 'mcp', 'setup', 'doctor'];
  const command = commands.includes(argv[0]) ? argv.shift() : 'foreground';
  const take = (flag, fallback) => { const index = argv.indexOf(flag); if (index < 0) return fallback; if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(flag + ' requires a value'); const value = argv[index + 1]; argv.splice(index, 2); return value; };
  const workspaceArg = take('--workspace', undefined);
  const workspace = workspaceArg || process.cwd();
  const json = argv.includes('--json'); argv = argv.filter(arg => arg !== '--json');
  if (command === 'mcp') { if (!workspaceArg || !path.isAbsolute(workspaceArg) || argv.length) throw new Error('mcp requires --workspace <absolute-path>'); serveMcp(workspace); return; }
  if (command === 'doctor') {
    const apps = []; while (argv.includes('--app')) apps.push(take('--app', undefined));
    const scope = take('--scope', 'project'); const monitorId = take('--monitor-id', undefined); const runId = take('--run-id', undefined);
    if (argv.length) throw new Error('Unknown doctor argument: ' + argv[0]);
    const result = doctor({ apps, scope, workspace, monitorId, runId });
    console.log(JSON.stringify(result, null, json ? 0 : 2));
    if (!result.ok) process.exitCode = 1; return;
  }
  if (command === 'setup') {
    const apps = []; while (argv.includes('--app')) apps.push(take('--app', undefined));
    const scope = take('--scope', 'project'); const dryRun = argv.includes('--dry-run'); argv = argv.filter(arg => arg !== '--dry-run');
    if (argv.length) throw new Error('Unknown setup argument: ' + argv[0]);
    const result = setup({ apps, scope, workspace, dryRun }); console.log(JSON.stringify(result, null, 2));
    if (result.some(item => item.mcp === 'failed' || item.skill === 'failed' || item.connectivity === 'failed_no_inference')) process.exitCode = 1; return;
  }
  if (command === 'status' || command === 'stop') {
    if (argv.length > 1 || argv[0]?.startsWith('-') || (command === 'stop' && !argv[0])) throw new Error(command + ' requires a run ID (status may omit it)');
    const manager = new RunManager(workspace); const value = command === 'stop' ? await manager.stop(argv[0]) : await manager.status(argv[0]);
    console.log(JSON.stringify(value, null, json ? 0 : 2)); return;
  }
  const idempotencyKey = take('--idempotency-key', undefined); const options = parseArgs(argv);
  if (!options.roadmap) { help(); process.exitCode = 64; return; }
  if (command === 'start' || command === 'foreground') {
    const manager = new RunManager(workspace);
    const result = await manager.start({ workspace, roadmap: options.roadmap, progressFile: options.progressFile || undefined, client: options.client, timeout: options.timeout, supervisorEvery: Number(options.supervisorEvery), supervisorTimeout: options.supervisorTimeout, model: options.model || undefined, effort: options.effort || undefined, notify: options.notify, notifyOn: options.notifyOn, idempotencyKey }, { executable: options.executable }, command === 'foreground');
    if (command === 'start') console.log(JSON.stringify(result, null, json ? 0 : 2));
    else process.exitCode = result.exitCode ?? 1;
    return;
  }
};
main().catch(error => { console.error('roadmap-runner: ' + error.message); process.exitCode = error.exitCode || 1; });
