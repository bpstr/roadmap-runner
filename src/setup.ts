import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { atomicJson } from './run-state.js';
import { assertController } from './run-manager.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
const adapters = {
  codex: { executable: 'codex', config: '.codex/config.toml', userConfig: '.codex/config.toml', skills: '.agents/skills', agent: 'codex' },
  claude: { executable: 'claude', config: '.mcp.json', userConfig: '.claude.json', skills: '.claude/skills', agent: 'claude-code' },
  grok: { executable: 'grok', config: '.grok/config.toml', userConfig: '.grok/config.toml', skills: '.grok/skills', agent: 'grok' },
};
const sameEntry = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b) || (a?.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args) && Object.keys(a).every(key => key in b));
const treeHash = (dir: string): string => {
  const hash = createHash('sha256');
  const visit = (base: string, relative = '') => {
    for (const name of fs.readdirSync(base).sort()) {
      if (name === '.roadmap-runner-owner.json') continue;
      const file = path.join(base, name); const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('Skill directory contains a symlink; preserving it');
      hash.update(path.join(relative, name)); if (stat.isDirectory()) visit(file, path.join(relative, name)); else hash.update(fs.readFileSync(file));
    }
  }; visit(dir); return hash.digest('hex');
};
const writeText = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
};
export const setup = (options: { apps: string[]; scope?: string; workspace: string; dryRun?: boolean }, dependencies: any = {}) => {
  assertController(); const workspace = fs.realpathSync(options.workspace); const scope = options.scope || 'project';
  if (!['project', 'user'].includes(scope)) throw new Error('Scope must be project or user');
  if (!options.apps.length) throw new Error('Name at least one --app: codex, claude, grok');
  const home = dependencies.home || os.homedir(); const run = dependencies.spawnSync || spawnSync;
  const results: any[] = [];
  for (const name of [...new Set(options.apps)]) {
    if (!(name in adapters)) throw new Error(`Unsupported setup app: ${name}`);
    const adapter = adapters[name]; const targetRoot = scope === 'user' ? home : workspace;
    const config = path.join(targetRoot, scope === 'user' ? adapter.userConfig : adapter.config);
    const entrypoint = path.join(packageRoot, 'bin', 'roadmap-runner.js');
    const entry = { command: process.execPath, args: [entrypoint, 'mcp', '--workspace', workspace] };
    const item: any = { app: name, scope, config, mcp: 'pending', skill: 'pending', workspace, connectivity: 'not_run', changes: [] };
    const skillSource = path.join(packageRoot, 'skills', 'write-runner-roadmap');
    const skillTarget = path.join(targetRoot, adapter.skills, 'write-runner-roadmap'); item.skillPath = skillTarget;
    try {
      const detected = run(adapter.executable, name === 'grok' ? ['mcp', '--help'] : ['--version'], { cwd: workspace, encoding: 'utf8', timeout: 3000, maxBuffer: 65536 });
      item.detected = detected.status === 0;
      if (name === 'grok' && !(detected.status === 0 && /mcp|add/i.test(detected.stdout || ''))) throw new Error('Grok Build MCP interface was not detected; install Grok Build before setup');
      let text = ''; try { text = fs.readFileSync(config, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (text.length > 1024 * 1024) throw new Error('Configuration is too large to edit safely');
      const isJson = name === 'claude'; const parsed: any = text ? (isJson ? JSON.parse(text) : parseToml(text)) : {};
      const key = isJson ? 'mcpServers' : 'mcp_servers'; const existing = parsed[key]?.['roadmap-runner'];
      const effective = isJson ? { type: 'stdio', ...entry } : entry;
      if (existing && !sameEntry(existing, effective)) throw new Error('Conflicting roadmap-runner entry; preserving existing configuration');
      if (existing) item.mcp = 'unchanged';
      else {
        const updated = isJson ? JSON.stringify({ ...parsed, mcpServers: { ...parsed.mcpServers, 'roadmap-runner': effective } }, null, 2) + '\n'
          : `${text}${text && !text.endsWith('\n') ? '\n' : ''}\n${stringifyToml({ mcp_servers: { 'roadmap-runner': entry } })}`;
        const validated: any = isJson ? JSON.parse(updated) : parseToml(updated);
        if (!sameEntry(validated[key]['roadmap-runner'], effective)) throw new Error('Configuration validation failed');
        item.changes.push({ path: config, entry: effective });
        // Claude's native registration preserves JSON fields; TOML appending preserves comments verbatim.
        const native = name === 'claude' && item.detected;
        const args = ['mcp', 'add', '--transport', 'stdio', '--scope', scope, 'roadmap-runner', '--', process.execPath, ...entry.args];
        if (native) item.command = [adapter.executable, ...args];
        if (!options.dryRun) {
          if (text) fs.copyFileSync(config, `${config}.roadmap-runner.bak`, fs.constants.COPYFILE_EXCL);
          if (native) {
            const outcome = run(adapter.executable, args, { cwd: workspace, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
            if (outcome.status !== 0) throw new Error('Native MCP registration failed; skill installation remains separately repairable');
            const after = JSON.parse(fs.readFileSync(config, 'utf8')); if (!sameEntry(after.mcpServers?.['roadmap-runner'], effective)) throw new Error('Native registration did not produce the requested workspace binding');
          } else writeText(config, updated);
        }
        item.mcp = options.dryRun ? 'planned' : 'installed';
      }
    } catch (error) { item.mcp = 'failed'; item.mcpError = error.message; }
    try {
      const sourceHash = treeHash(skillSource); let shouldInstall = true;
      if (fs.existsSync(skillTarget)) {
        const currentHash = treeHash(skillTarget);
        if (currentHash === sourceHash) { item.skill = 'unchanged'; shouldInstall = false; }
        else {
          const owner = JSON.parse(fs.readFileSync(path.join(skillTarget, '.roadmap-runner-owner.json'), 'utf8'));
          if (owner.package !== '@bpstr/roadmap-runner' || owner.hash !== currentHash) throw new Error('User-modified skill; preserving its contents');
        }
      }
      if (shouldInstall) {
        item.changes.push({ path: skillTarget, source: skillSource });
        const installer = run('skills', ['--version'], { cwd: workspace, encoding: 'utf8', timeout: 3000, maxBuffer: 65536 });
        const compatible = installer.status === 0 && /\b1\.7\.1\b/.test(installer.stdout || '') &&
          /--copy/.test(run('skills', ['add', '--help'], { cwd: workspace, encoding: 'utf8', timeout: 3000, maxBuffer: 65536 }).stdout || '');
        item.skillInstaller = compatible ? 'skills@1.7.1' : 'unavailable_or_unqualified; local copy fallback';
        const installerArgs = ['add', path.join(packageRoot, 'skills'), '--skill', 'write-runner-roadmap', '--agent', adapter.agent, '--yes', '--copy'];
        if (compatible) item.skillCommand = ['skills', ...installerArgs];
        if (!options.dryRun) {
          fs.mkdirSync(path.dirname(skillTarget), { recursive: true });
          const temporary = `${skillTarget}.${randomUUID()}.tmp`;
          const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-skill-stage-'));
          try {
            let source = skillSource;
            if (compatible) {
              // Stage project installation, then atomically publish to the requested scope.
              // This protects user edits and shared canonical skill directories.
              const outcome = run('skills', installerArgs, { cwd: stage, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
              const installed = path.join(stage, adapter.skills, 'write-runner-roadmap');
              if (outcome.status === 0 && fs.existsSync(installed) && treeHash(installed) === sourceHash) source = installed;
              else item.skillInstallerWarning = 'Installer failed verification; used the bundled local copy';
            }
            fs.cpSync(source, temporary, { recursive: true });
          } finally { fs.rmSync(stage, { recursive: true, force: true }); }
          atomicJson(path.join(temporary, '.roadmap-runner-owner.json'), { package: '@bpstr/roadmap-runner', version, hash: sourceHash });
          const backup = `${skillTarget}.${randomUUID()}.bak`; const existed = fs.existsSync(skillTarget);
          try { if (existed) fs.renameSync(skillTarget, backup); fs.renameSync(temporary, skillTarget); if (existed) fs.rmSync(backup, { recursive: true }); }
          catch (error) { if (existed && !fs.existsSync(skillTarget)) fs.renameSync(backup, skillTarget); throw error; }
          finally { fs.rmSync(temporary, { recursive: true, force: true }); }
        }
        item.skill = options.dryRun ? 'planned' : 'installed'; item.skillMethod = 'owned_local_copy';
      }
    } catch (error) { item.skill = 'failed'; item.skillError = error.message; }
    if (!options.dryRun && item.mcp !== 'failed') {
      const messages = [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'roadmap-setup-check', version: '1' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      ];
      const check = run(process.execPath, [path.join(packageRoot, 'bin/roadmap-runner.js'), 'mcp', '--workspace', workspace], {
        cwd: workspace, encoding: 'utf8', timeout: 5000, maxBuffer: 65536, input: messages.map(message => JSON.stringify(message)).join('\n') + '\n',
      });
      try {
        const replies = (check.stdout || '').trim().split('\n').map(line => JSON.parse(line));
        const tools = replies.find(reply => reply.id === 2)?.result?.tools;
        item.connectivity = check.status === 0 && tools?.length === 3 ? 'passed_no_inference' : 'failed_no_inference';
      } catch { item.connectivity = 'failed_no_inference'; }
    }
    results.push(item);
  }
  return results;
};
