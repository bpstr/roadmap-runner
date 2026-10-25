import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 64 * 1024;
const text = value => typeof value === 'string' && value.trim().length > 0;
const nextActionPresent = value => text(value) || (value && typeof value === 'object' && !Array.isArray(value) &&
  Object.values(value).some(text));
const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};

// Resolve existing ancestors so deleted/new edited paths can still be recorded,
// without accepting a symlink that sends a workspace-relative path outside it.
function canonical(file) {
  try { return fs.realpathSync(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(canonical(parent), path.basename(file));
  }
}

function readBounded(file, requestedAt) {
  if (!fs.lstatSync(file).isFile()) return null;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES || stat.mtimeMs < requestedAt) return null;
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes > MAX_BYTES) return null;
    return JSON.parse(buffer.subarray(0, bytes).toString('utf8'));
  } finally { fs.closeSync(fd); }
}

/**
 * Acknowledgment wire shape: { version: 1, requestId, resultFile }.
 * The runner supplies exact paths; foreground progress files may be external.
 * The worker result supplies changedFiles and nextAction so neither is copied.
 * This only reads bounded checkpoint/result files, never scans the repository.
 */
export function readCheckpointAcknowledgment(file, { requestId, resultFile, workdir,
  requestedAt, taskId, criteriaRevision, validateResult } = {}) {
  try {
    const at = typeof requestedAt === 'number' ? requestedAt : Date.parse(requestedAt);
    if (!text(requestId) || !text(resultFile) || !text(workdir) || !Number.isFinite(at)) return null;
    const expected = path.resolve(resultFile);
    const ack = readBounded(path.resolve(file), at);
    if (!ack || ack.version !== 1 || ack.requestId !== requestId || !text(ack.resultFile) ||
        !path.isAbsolute(ack.resultFile) || path.resolve(ack.resultFile) !== expected) return null;
    // Reject alias/symlink substitutions in the artifacts' own final component.
    if (!fs.lstatSync(expected).isFile()) return null;
    const result = readBounded(expected, at);
    if (!result || result.version !== 1 || result.sessionId !== requestId ||
        !text(result.taskId) || !text(result.criteriaRevision) ||
        !['partial', 'implemented', 'verified', 'reused', 'blocked'].includes(result.outcome) ||
        (taskId !== undefined && result.taskId !== taskId) ||
        (criteriaRevision !== undefined && result.criteriaRevision !== criteriaRevision) ||
        !Array.isArray(result.changedFiles) || result.changedFiles.length > 512 ||
        !nextActionPresent(result.nextAction)) return null;
    const workspace = fs.realpathSync(workdir);
    const editedPaths = [];
    for (const value of result.changedFiles) {
      if (!text(value) || value.includes('\0')) return null;
      const resolved = canonical(path.resolve(workspace, value));
      if (!within(workspace, resolved) || resolved === workspace ||
          (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory())) return null;
      editedPaths.push(path.relative(workspace, resolved));
    }
    if (validateResult && validateResult(result) !== true) return null;
    return { version: 1, requestId, resultFile: expected, taskId: result.taskId,
      criteriaRevision: result.criteriaRevision, editedPaths, nextAction: result.nextAction };
  } catch { return null; }
}
