// Investigation prototype: returns a dispatch intent, never launches a model or job.
import { createHash } from 'node:crypto';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function planRecovery(observation, saved = null, authorized = false) {
  for (const key of ['workspace', 'roadmap', 'progressFile', 'sourceRevision', 'blockerFingerprint']) {
    if (typeof observation[key] !== 'string' || !observation[key]) throw new Error(`Missing ${key}`);
  }
  if (saved && (saved.version !== 1 || !Array.isArray(saved.attempted))) throw new Error('Invalid recovery checkpoint');
  if (observation.processState !== 'exited' || observation.roadmapState !== 'blocked' || observation.reason !== 'blocked') {
    return { action: 'wait', reason: 'not_terminal_blocked', checkpoint: saved };
  }
  const scope = digest([observation.workspace, observation.roadmap, observation.progressFile, observation.sourceRevision, observation.blockerFingerprint]);
  const input = observation.unblockInputFingerprint || null;
  if (input !== null && (typeof input !== 'string' || input.length > 128)) throw new Error('Invalid unblock input fingerprint');
  if (!saved || saved.scope !== scope) {
    return { action: 'observe', reason: 'baseline_recorded', checkpoint: { version: 1, scope, input, attempted: [] } };
  }
  if (!input || input === saved.input) return { action: 'wait', reason: 'unblock_input_unchanged', checkpoint: saved };
  const key = digest([scope, input]);
  if (saved.attempted.includes(key)) return { action: 'wait', reason: 'already_claimed', checkpoint: saved };
  if (saved.attempted.length >= 2) return { action: 'attention', reason: 'recovery_budget_exhausted', checkpoint: saved };
  if (!authorized) return { action: 'attention', reason: 'recovery_not_authorized', checkpoint: saved };
  // The host must persist this claim under an exclusive lock BEFORE dispatching.
  return {
    action: 'dispatch', reason: 'changed_unblock_input',
    checkpoint: { ...saved, input, attempted: [...saved.attempted, key] },
    request: { workspace: observation.workspace, roadmap: observation.roadmap, progressFile: observation.progressFile,
      recoverBlocked: true, notify: 'attention', idempotencyKey: `recovery-${key}` },
  };
}
