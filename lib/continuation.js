import path from 'node:path';
import { createHash } from 'node:crypto';

// Only explicit, provider-reported IDs are accepted. Never resume --last.
export const validProviderThreadId = value => typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

// Exact provider diagnostics, verified in openai/codex app-server's
// request_processors/thread_processor.rs. This is not a generic error retry.
export function missingContinuationThread(message, threadId) {
  if (!validProviderThreadId(threadId) || typeof message !== 'string') return false;
  return new RegExp(`(?:thread not found: |no rollout found for (?:thread|conversation) id )${threadId}(?![A-Za-z0-9_-])`).test(message);
}

/** Select an opt-in, bounded continuation of exactly the same worker scope. */
export function selectContinuation({ enabled = false, previous = null, client,
  task, role = 'worker', scopeRevision, workdir, model = '', effort = '', executable = '',
  maxSessions = 4, maxInputTokens = 65536 } = {}) {
  const fresh = reason => ({ persistSession: false, resumeSessionId: null, identity: null, reason });
  if (!enabled) return fresh('disabled');
  if (client !== 'codex') return fresh('unsupported_client');
  if (role !== 'worker') return fresh('role_boundary');
  if (typeof task !== 'string' || !task.trim() || typeof scopeRevision !== 'string' || !scopeRevision.trim() || !workdir) return fresh('unbound_scope');
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 16 ||
      !Number.isSafeInteger(maxInputTokens) || maxInputTokens < 1) throw new Error('Invalid continuation limits');
  const identity = createHash('sha256').update(JSON.stringify([
    client, path.resolve(workdir), task, role, scopeRevision, model, effort, executable,
  ])).digest('hex');
  const choice = { persistSession: true, resumeSessionId: null, identity, maxSessions, maxInputTokens, reason: 'new_task_session' };
  if (!previous || previous.identity !== identity) return { ...choice, reason: previous ? 'scope_changed' : choice.reason };
  if (!validProviderThreadId(previous.providerThreadId)) return { ...choice, reason: 'missing_provider_id' };
  if (!Number.isSafeInteger(previous.sessions) || previous.sessions < 1 || previous.sessions >= maxSessions) return { ...choice, reason: 'session_limit' };
  // Cumulative observed input is a conservative budget, not a claimed measure of
  // the provider's active context window. Unknown usage must not bypass the cap.
  if (!Number.isSafeInteger(previous.inputTokens) || previous.inputTokens < 0) return { ...choice, reason: 'usage_unknown' };
  if (previous.inputTokens >= maxInputTokens) return { ...choice, reason: 'input_budget' };
  return { ...choice, resumeSessionId: previous.providerThreadId, reason: 'same_task' };
}

/** A failed/interrupted turn is not reusable conversation state. */
export function rememberContinuation(previous, choice, result) {
  if (!choice?.persistSession || !choice.identity || !result || result.code !== 0 ||
      result.error || result.timedOut || result.interrupted || result.cleanupIncomplete || result.usageLimit || result.retryableCapacity ||
      !validProviderThreadId(result.providerThreadId) || result.usageComplete !== true ||
      !Number.isSafeInteger(result.usage?.inputTokens) || result.usage.inputTokens < 0) return null;
  const resumed = choice.resumeSessionId && previous?.identity === choice.identity &&
    previous.providerThreadId === choice.resumeSessionId && result.providerThreadId === choice.resumeSessionId;
  // Unexpected replacement of the requested provider thread is never silently
  // adopted as a continuation. The caller will start fresh on the next turn.
  if (choice.resumeSessionId && !resumed) return null;
  const inputTokens = (resumed ? previous.inputTokens : 0) + result.usage.inputTokens;
  if (!Number.isSafeInteger(inputTokens)) return null;
  return { version: 1, identity: choice.identity, providerThreadId: result.providerThreadId,
    sessions: (resumed ? previous.sessions : 0) + 1, inputTokens };
}
