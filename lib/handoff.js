import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { roadmapStatus } from './runner.js';
import { workspacePath } from './verification.js';

export const contentHash = value => createHash('sha256').update(value).digest('hex');

export function validateControl(contents, file = 'handoff') {
  try { return roadmapStatus(contents); }
  catch (error) {
    const lines = contents.split('\n');
    let line = 1;
    for (; line <= lines.length; line++) {
      try { roadmapStatus(lines.slice(0, line).join('\n')); } catch { break; }
    }
    throw Object.assign(new Error(`${file}:${line}: ${error.message}`), { exitCode: 64 });
  }
}

export function validateControlFile(file) {
  if (fs.statSync(file).size > 256 * 1024) throw new Error(`${file}: control file exceeds 256 KiB`);
  return validateControl(fs.readFileSync(file, 'utf8'), file);
}

// Cooperating updates use a lock and compare both the source and progress bytes.
// Validation precedes replacement; a rejected candidate leaves the old file intact.
export function updateHandoff(spec, { workdir = process.cwd() } = {}) {
  const source = workspacePath(workdir, spec.roadmap, { allowMissing: false });
  const file = workspacePath(workdir, spec.progressFile, { allowMissing: false });
  if (fs.realpathSync(source) === fs.realpathSync(file) ||
      (fs.statSync(source).dev === fs.statSync(file).dev && fs.statSync(source).ino === fs.statSync(file).ino)) throw new Error('Progress must be separate from the source');
  if (typeof spec.contents !== 'string' || Buffer.byteLength(spec.contents) > 32 * 1024) throw new Error('Candidate handoff must be text at most 32 KiB');
  validateControl(spec.contents, file);
  validateControlFile(source);
  const lock = `${file}.update.lock`, temporary = path.join(path.dirname(file), `.${randomUUID()}.handoff`);
  const fd = fs.openSync(lock, 'wx', 0o600);
  try {
    const check = () => {
      if (contentHash(fs.readFileSync(source)) !== spec.sourceRevision) throw new Error('Stale source/criteria binding');
      if (contentHash(fs.readFileSync(file)) !== spec.expectedHash) throw new Error('Stale handoff update');
    };
    check();
    fs.writeFileSync(temporary, spec.contents, { flag: 'wx', mode: 0o600 });
    check();
    fs.renameSync(temporary, file);
    return { progressFile: file, sha256: contentHash(spec.contents), sourceRevision: spec.sourceRevision };
  } finally {
    fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
    fs.rmSync(lock, { force: true });
  }
}
