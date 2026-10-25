import test from 'node:test';
import assert from 'node:assert/strict';
import { selectContinuation, rememberContinuation, missingContinuationThread } from '../lib/continuation.js';
import { buildClientInvocation } from '../lib/clients.js';
import { parseArgs } from '../lib/runner.js';
import { providerIdentityTracker } from '../lib/telemetry.js';

const thread = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const scope = { enabled: true, client: 'codex', task: 'API-01.1', role: 'worker',
  scopeRevision: 'criteria-and-boundary-v1', workdir: '/workspace', model: 'fixture-model', effort: 'high' };
const successful = () => ({ code: 0, providerThreadId: thread, usageComplete: true, usage: { inputTokens: 1024 } });

test('continuation defaults on for Codex, supports opt-out, and leaves other adapters fresh', () => {
  assert.equal(parseArgs(['r.md'], {}).sessionContinuation, true);
  assert.equal(parseArgs(['r.md', '--session-continuation'], {}).sessionContinuation, true);
  assert.equal(parseArgs(['r.md', '--no-session-continuation'], { ROADMAP_SESSION_CONTINUATION: 'true' }).sessionContinuation, false);
  for (const value of ['0', 'false']) assert.equal(parseArgs(['r.md'], { ROADMAP_SESSION_CONTINUATION: value }).sessionContinuation, false);
  assert.equal(parseArgs(['r.md', '--session-continuation'], { ROADMAP_SESSION_CONTINUATION: '0' }).sessionContinuation, true);
  for (const client of ['claude', 'gemini', 'grok', 'kimi', 'muse']) {
    assert.equal(parseArgs(['r.md', '--client', client], {}).sessionContinuation, false);
  }
  assert.throws(() => parseArgs(['r.md', '--client', 'claude', '--session-continuation'], {}), /requires --client codex/);
  assert.equal(selectContinuation({ ...scope, enabled: false }).persistSession, false);
  assert.equal(selectContinuation({ ...scope, client: 'claude' }).persistSession, false);
  const original = buildClientInvocation({ client: 'codex', workdir: scope.workdir, prompt: 'fixture' });
  assert.deepEqual(original.args.slice(0, 7), ['exec', '--dangerously-bypass-approvals-and-sandbox', '--json', '--skip-git-repo-check', '--ephemeral', '--cd', scope.workdir]);
});

test('same task resumes only the explicitly recorded provider thread', () => {
  const first = selectContinuation(scope);
  assert.equal(first.persistSession, true);
  assert.equal(first.resumeSessionId, null);
  const previous = rememberContinuation(null, first, successful());
  const choice = selectContinuation({ ...scope, previous });
  assert.equal(choice.resumeSessionId, thread);
  const invocation = buildClientInvocation({ ...scope, ...choice, prompt: 'Continue the existing task.' });
  assert.equal(invocation.args.includes('--ephemeral'), false);
  assert.equal(invocation.args.includes('--last'), false);
  assert.ok(invocation.args.indexOf('--cd') < invocation.args.indexOf('resume'));
  assert.deepEqual(invocation.args.slice(-3), ['resume', thread, 'Continue the existing task.']);
  const saved = rememberContinuation(previous, choice, successful());
  assert.equal(saved.sessions, 2);
  assert.equal(saved.inputTokens, 2048);
  assert.throws(() => buildClientInvocation({ client: 'codex', persistSession: true, resumeSessionId: '--last', prompt: 'bad' }), /valid provider thread ID/);
  assert.throws(() => buildClientInvocation({ client: 'claude', persistSession: true, prompt: 'bad' }), /only by the Codex/);
});

test('task, role, scope, workspace, model and effort boundaries always start fresh', () => {
  const first = selectContinuation(scope);
  const previous = rememberContinuation(null, first, successful());
  for (const override of [{ task: 'API-01.2' }, { role: 'resolver' }, { scopeRevision: 'amended' },
    { workdir: '/another-workspace' }, { model: 'other-model' }, { effort: 'low' }, { executable: '/other/client' }, { task: undefined }]) {
    assert.equal(selectContinuation({ ...scope, previous, ...override }).resumeSessionId, null, JSON.stringify(override));
  }
});

test('large cached-input reports preserve same-task continuity for eight turns', () => {
  let previous = null;
  for (let turn = 1; turn <= 8; turn++) {
    const choice = selectContinuation({ ...scope, previous });
    assert.equal(choice.resumeSessionId, turn === 1 ? null : thread);
    previous = rememberContinuation(previous, choice, { ...successful(),
      usage: { inputTokens: 6_760_321, cachedInputTokens: 6_642_816, outputTokens: 38_238 } });
    assert.equal(previous.sessions, turn);
    assert.equal(previous.inputTokens, turn * 6_760_321, 'aggregate usage remains recorded');
    previous = JSON.parse(JSON.stringify(previous)); // Same persisted state shape as 0.12.
  }
  assert.equal(selectContinuation({ ...scope, previous }).reason, 'session_limit');
});

test('explicit aggregate usage budgets remain enforced separately from context', () => {
  const choice = selectContinuation({ ...scope, maxInputTokens: 65536 });
  const previous = rememberContinuation(null, choice, { ...successful(), usage: { inputTokens: 65536 } });
  assert.equal(selectContinuation({ ...scope, previous, maxInputTokens: 65536 }).reason, 'input_budget');
  assert.equal(selectContinuation({ ...scope, previous }).resumeSessionId, thread);
  for (const maxInputTokens of [0, -1, NaN, Infinity]) {
    assert.throws(() => selectContinuation({ ...scope, maxInputTokens }), /Invalid continuation limits/);
  }
});

test('continuation resets on turn limits, missing usage and unsuccessful or replaced threads', () => {
  const first = selectContinuation(scope);
  const previous = rememberContinuation(null, first, successful());
  for (const override of [{ sessions: 8 }, { inputTokens: null }, { providerThreadId: null }]) {
    assert.equal(selectContinuation({ ...scope, previous: { ...previous, ...override } }).resumeSessionId, null);
  }
  for (const override of [{ code: 1 }, { timedOut: true }, { interrupted: true }, { cleanupIncomplete: true },
    { usageComplete: false }, { usage: null }, { providerThreadId: null }, { usageLimit: {} }]) {
    assert.equal(rememberContinuation(null, first, { ...successful(), ...override }), null);
  }
  const resumed = selectContinuation({ ...scope, previous });
  assert.equal(rememberContinuation(previous, resumed, { ...successful(), providerThreadId: 'another-thread' }), null);
});

test('provider identity comes only from supported JSON events', () => {
  const tracker = providerIdentityTracker();
  tracker.observe({ type: 'thread.started', thread_id: thread }, 'text');
  tracker.observe({ type: 'thread.started', thread_id: '--last' }, 'codex-json');
  tracker.observe({ type: 'agent_message', thread_id: thread }, 'codex-json');
  assert.equal(tracker.result().providerThreadId, null);
  tracker.observe({ type: 'thread.started', thread_id: thread }, 'codex-json');
  assert.equal(tracker.result().providerThreadId, thread);
});

test('missing-continuation diagnostics must name the exact requested provider thread', () => {
  assert.equal(missingContinuationThread(`Error: no rollout found for thread id ${thread}`, thread), true);
  assert.equal(missingContinuationThread(`thread not found: ${thread}`, thread), true);
  assert.equal(missingContinuationThread(`thread not found: ${thread}-other`, thread), false);
  assert.equal(missingContinuationThread('Failed command. Authentication required.', thread), false);
});
