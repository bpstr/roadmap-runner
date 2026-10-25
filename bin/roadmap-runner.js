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
import { requestNotificationPermission } from '../dist/notification-permission.js';
import { runVerification, recordReview, workspacePath } from '../lib/verification.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
function help() {
  console.log(`Roadmap Runner ${PACKAGE.version}

Usage:
  roadmap-runner <roadmap-file> [options]
  roadmap-runner start <roadmap-file> [options] [--json]
  roadmap-runner queue <run-id> <roadmap-file> [--progress-file <path>] [--json]
  roadmap-runner status [run-id] [--workspace <path>] [--json]
  roadmap-runner stop <run-id> [--workspace <path>] [--json]
  roadmap-runner mcp --workspace <absolute-path>
  roadmap-runner setup --app codex|claude|grok [--scope project|user] [--dry-run]
  roadmap-runner doctor [--app codex|claude|grok] [--scope project|user] [--json]
  roadmap-runner notifications request-permission [--json]
  roadmap-runner check --spec <json-file> [--workspace <path>]
  roadmap-runner record-review --spec <json-file> [--workspace <path>]

Management options:
  --workspace <path>     Explicit workspace binding; defaults to cwd for CLI
  --idempotency-key <id> Repeat the same managed start safely
  --queue <path>        Run another roadmap after completion; repeat for FIFO order
  --prevent-sleep        Prevent idle system sleep for the entire run
  --no-prevent-sleep     Override ROADMAP_PREVENT_SLEEP
  --recover-blocked     Retry a stopped recovery with a resolver
  --session-continuation Enable bounded same-task Codex conversation reuse (default)
  --no-session-continuation Disable conversation reuse; keep every invocation fresh
  --notify attention|off Desktop notification mode (default attention)
  --notify-on <events>   Extra desktop event types; requires --notify attention
  --monitor-id <id>      Doctor: inspect saved Codex hourly-monitor registration
  --run-id <id>          Doctor: require that monitor to name this managed run

Options:
  --client <name>        CLI client: ${CLIENT_NAMES.join(", ")}. Default: codex
  --progress-file <path> Override the bounded progress-state path; workers never edit source
  --execution-plan <path> Select at most three finite outcomes from an existing progress authority
  --timeout <duration>   Per-run timeout. Default: 90m
  --resolver-timeout <duration> Blocker resolver timeout; default 10m
  --supervisor-every <n> Deprecated; accepted without scheduling supervisors
  --supervisor-timeout <duration> Deprecated alias for --resolver-timeout
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
  ROADMAP_SESSION_CONTINUATION
  ROADMAP_CLIENT_BIN
  ROADMAP_NOTIFY            Desktop mode: attention (default) or off
  ROADMAP_PREVENT_SLEEP      Set to 1 or true to prevent idle system sleep
  ROADMAP_NOTIFY_BIN         Notification executable; receives event JSON on stdin
  ROADMAP_USAGE_MAX_WAIT     Quota wait ceiling in seconds; default/max 86400
  ROADMAP_CAPACITY_RETRIES    Consecutive capacity retries; default 10
  ROADMAP_CAPACITY_DELAY      Initial delay in seconds; default 300
  ROADMAP_CAPACITY_MAX_DELAY  Maximum delay in seconds; default 300

The current directory is always the workspace.
`);
}

// Workers may record checks/reviews, but still cannot start or control runners.
// These commands use argv from an explicit specification, never a shell string.
const verificationCommand = async (command, argv) => {
  let specFile, workspace = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--spec', '--workspace'].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${command} accepts --spec <json-file> and --workspace <path>`);
    if (flag === '--spec') { if (specFile) throw new Error('--spec must be supplied once'); specFile = argv[++i]; }
    else workspace = argv[++i];
  }
  if (!specFile) throw new Error(`${command} requires --spec <json-file>`);
  workspace = fs.realpathSync(workspace);
  const file = workspacePath(workspace, specFile, { allowMissing: false });
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > 64 * 1024) throw new Error('Verification specification must be a regular file at most 64 KiB');
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const controller = new AbortController(); const cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const result = command === 'check' ? await runVerification(spec, { workdir: workspace, signal: controller.signal }) : recordReview(spec, { workdir: workspace });
    const receipt = result.receipt;
    console.log(JSON.stringify({ receiptId: receipt.id, receiptFile: result.receiptFile, reused: result.reused ?? false,
      kind: receipt.kind, exitCode: receipt.exitCode ?? null, counts: receipt.counts ?? null,
      completed: receipt.completed ?? null, cleanupIncomplete: receipt.cleanupIncomplete ?? false,
      stdout: receipt.stdout, stderr: receipt.stderr, acceptanceAuthority: false }, null, 2));
    if (command === 'check') process.exitCode = receipt.aborted ? 130 : receipt.timedOut ? 124 :
      receipt.cleanupIncomplete || receipt.error || !receipt.completed ? 1 : receipt.exitCode ?? 1;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
};

const main = async () => {
  let argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { help(); return; }
  if (argv.includes('--version') || argv.includes('-v')) { console.log(PACKAGE.version); return; }
  if (['check', 'record-review'].includes(argv[0])) return await verificationCommand(argv[0], argv.slice(1));
  assertController();
  const commands = ['start', 'queue', 'stop', 'status', 'mcp', 'setup', 'doctor', 'notifications'];
  const command = commands.includes(argv[0]) ? argv.shift() : 'foreground';
  const take = (flag, fallback) => { const index = argv.indexOf(flag); if (index < 0) return fallback; if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(flag + ' requires a value'); const value = argv[index + 1]; argv.splice(index, 2); return value; };
  const workspaceArg = take('--workspace', undefined);
  const workspace = workspaceArg || process.cwd();
  const json = argv.includes('--json'); argv = argv.filter(arg => arg !== '--json');
  if (command === 'notifications') {
    if (argv.length !== 1 || argv[0] !== 'request-permission') throw Object.assign(new Error('notifications requires request-permission [--json]'), { exitCode: 64 });
    const controller = new AbortController(); const cancel = () => controller.abort();
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    try {
      const result = await requestNotificationPermission({ signal: controller.signal });
      console.log(json ? JSON.stringify(result) : result.message);
      if (!result.ok) process.exitCode = result.result === 'cancelled' ? 130 : 1;
    } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    return;
  }
  if (command === 'queue') {
    const progressFile = take('--progress-file', undefined);
    if (argv.length !== 2 || argv.some(arg => arg.startsWith('-'))) throw new Error('queue requires a run ID and roadmap file');
    const value = await new RunManager(workspace).enqueue(argv[0], { roadmap: argv[1], progressFile });
    console.log(JSON.stringify(value, null, json ? 0 : 2)); return;
  }
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
  const queue = []; while (argv.includes('--queue')) queue.push({ roadmap: take('--queue', undefined) });
  const idempotencyKey = take('--idempotency-key', undefined); const options = parseArgs(argv);
  if (!options.roadmap) { help(); process.exitCode = 64; return; }
  if (command === 'start' || command === 'foreground') {
    const manager = new RunManager(workspace);
    const result = await manager.start({ workspace, roadmap: options.roadmap, progressFile: options.progressFile || undefined, executionPlan: options.executionPlan || undefined, client: options.client, timeout: options.timeout, supervisorEvery: Number(options.supervisorEvery), resolverTimeout: options.resolverTimeout, model: options.model || undefined, effort: options.effort || undefined, notify: options.notify, notifyOn: options.notifyOn, preventSleep: options.preventSleep, recoverBlocked: options.recoverBlocked, sessionContinuation: options.sessionContinuation, idempotencyKey, queue }, { executable: options.executable }, command === 'foreground');
    if (command === 'start') console.log(JSON.stringify(result, null, json ? 0 : 2));
    else process.exitCode = result.exitCode ?? 1;
    return;
  }
};
main().catch(error => { console.error('roadmap-runner: ' + error.message); process.exitCode = error.exitCode || 1; });
