import fs from 'node:fs';
import { parseDuration } from './runner.js';

export function resolverSettings(options) {
  const timeoutMs = parseDuration(options.resolverTimeout || options.supervisorTimeout || '10m');
  if (timeoutMs > 2_147_483_647) throw Object.assign(new Error('resolver timeout exceeds the timer limit'), { exitCode: 64 });
  return { timeoutMs };
}

// Preserve task/evidence text, including status examples inside fenced blocks.
export function withStatus(contents, status) {
  const lines = contents.split('\n');
  let fence;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^\uFEFF/, '').replace(/\r$/, '');
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[\\t ]*$`).test(line)) fence = undefined;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) { fence = opening[1]; continue; }
    if (/^ {0,3}#{2,6}(?:[\t ]|$)/.test(line)) break;
    if (/^ {0,3}Status:/i.test(line)) { lines[i] = `Status: ${status}`; return lines.join('\n'); }
  }
  return `Status: ${status}\n${contents}`;
}

export function readResolution(file, resolutionId) {
  try {
    if (fs.statSync(file).size > 8192) return null;
    const decision = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (decision.resolutionId !== resolutionId || !['resolved', 'stopped'].includes(decision.outcome) ||
        typeof decision.evidence !== 'string' || !decision.evidence.trim() ||
        typeof decision.nextAction !== 'string' || !decision.nextAction.trim()) return null;
    return decision;
  } catch { return null; }
}
