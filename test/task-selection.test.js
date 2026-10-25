import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseRoadmapTasks, taskSnapshot } from '../lib/task-index.js';
import { RoadmapPlan } from '../lib/task-plan.js';
import { ExecutionPlan } from '../lib/execution.js';

const section = (id, { dependencies = 'none', checked = false, acceptance = `Only ${id} behavior.` } = {}) =>
  `### Task ${id} — Deliver result\n\n- [${checked ? 'x' : ' '}] ${id} Deliver result\n\n` +
  `Purpose: A useful result.\nContext: service.ts.\nDependencies: ${dependencies}.\nSession scope: One result.\n` +
  `Acceptance: ${acceptance}\n\nImplementation:\n- [${checked ? 'x' : ' '}] ${id}-I1 Implement result.\n\n` +
  `Validation:\n- [${checked ? 'x' : ' '}] ${id}-V1 Check result.\n\nEvidence: receipt.json.\n` +
  'Handoff: Exact next action.\nBlocked behavior: Defer missing prerequisite.\n';
const roadmap = (...sections) => '# Roadmap\n\nStatus: IN_PROGRESS\n\n## Shared constraints\nKeep the public API stable.\n\n## Epic A\n\n' + sections.join('\n');
const writeAuthority = (file, plan) => fs.writeFileSync(file, '```roadmap-runner-execution\n' + JSON.stringify(plan) + '\n```\n');

function fixture(t, text = roadmap(section('AUTH-01'), section('AUTH-02'))) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-task-selection-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'roadmap.md');
  fs.writeFileSync(file, text);
  fs.writeFileSync(path.join(dir, 'service.ts'), 'export const ready = false;\n');
  const evidenceDir = path.join(dir, 'evidence'); fs.mkdirSync(evidenceDir);
  const tracking = { stateDir: dir, evidenceDir };
  const plan = new RoadmapPlan(file, dir, tracking);
  return { dir, file, tracking, plan };
}

function finiteFixture(t) {
  const f = fixture(t);
  const parents = ['AUTH-01', 'AUTH-02'].map((id, i) => ({ id, roadmap: 'roadmap.md',
    implementation: 'partial', operations: [`operation-${i}`], missing: ['Finish result'], evidence: [] }));
  const authority = { version: 1, denominator: 2, operationDenominator: 2, parents,
    operations: parents.map((parent, i) => ({ id: `operation-${i}`, owner: parent.id })),
    batches: parents.map((parent, i) => ({ id: `batch-${i}`, task: parent.id, roadmap: parent.roadmap,
      implementation: 'partial', budgetMinutes: 40, deliverable: parent.id, boundary: 'service.ts',
      completion: 'Result works', checkpoint: 'Exact remaining action', prerequisites: [], sourcePointers: ['service.ts'] })) };
  const authorityFile = path.join(f.dir, 'authority.md'); writeAuthority(authorityFile, authority);
  return { ...f, authority, authorityFile, execution: new ExecutionPlan(authorityFile, f.dir, f.tracking) };
}

test('selected general task IDs end at the next section and retain shared constraints', () => {
  const index = parseRoadmapTasks(roadmap(section('AUTH-01'), section('AUTH-02')));
  assert.equal(index.reliable, true);
  assert.deepEqual(index.tasks.map(task => task.id), ['AUTH-01', 'AUTH-02']);
  const snapshot = taskSnapshot(index, index.tasks[0]);
  assert.match(snapshot, /Keep the public API stable/);
  assert.match(snapshot, /Only AUTH-01 behavior/);
  assert.doesNotMatch(snapshot, /AUTH-02/);
});

test('fenced task examples, substeps and checkboxes cannot alter real task boundaries', () => {
  const example = '\n````md\n### Task FAKE-01\n- [ ] FAKE-01 Example\n```\n````\n';
  const index = parseRoadmapTasks(roadmap(section('API-01.1') + example, section('API-01.2')));
  assert.deepEqual(index.tasks.map(task => task.id), ['API-01.1', 'API-01.2']);
  assert.equal(index.checkboxes.some(item => item.id === 'FAKE-01'), false);
  assert.match(index.tasks[0].section, /### Task FAKE-01/);
  assert.doesNotMatch(index.tasks[0].section, /API-01\.2/);
  assert.equal(index.reliable, true);
});

test('formatted acceptance checkboxes remain open even when their parent is checked', t => {
  for (const description of ['`GET /api` returns 200', '[response](contract.md) succeeds', '*response* is valid', '! required result']) {
    const first = section('AUTH-01', { checked: true }).replace('- [x] AUTH-01-V1 Check result.', '- [ ] ' + description);
    const f = fixture(t, roadmap(first, section('AUTH-02', { dependencies: 'AUTH-01' })));
    assert.equal(f.plan.reliable, true);
    const index = parseRoadmapTasks(fs.readFileSync(f.file, 'utf8'));
    assert.equal(index.tasks[0].complete, false, description);
    assert.equal(index.tasks[0].checkboxes.filter(checkbox => !checkbox.checked).length, 1);
    assert.ok(taskSnapshot(index, index.tasks[0]).includes('- [ ] ' + description));
    assert.equal(f.plan.select().task, 'AUTH-01', 'open acceptance must not unlock the dependent task');
  }
});

test('formatted orphan acceptance checkboxes require the legacy full-roadmap path', () => {
  const index = parseRoadmapTasks('# Roadmap\n- [ ] `Global constraint` must hold\n\n' + section('AUTH-01', { checked: true }));
  assert.equal(index.orphanCheckboxes.length, 1);
  assert.equal(index.reliable, false);
});

test('flat finite task IDs are separated without mistaking substeps for parents', () => {
  const text = '# Constraints\nPreserve records.\n- [ ] AUTH-01 First task\n- [ ] AUTH-01-I1 First step\n- [ ] AUTH-02 Second task\n';
  const index = parseRoadmapTasks(text, { parentIds: ['AUTH-01', 'AUTH-02'] });
  assert.deepEqual(index.tasks.map(task => task.id), ['AUTH-01', 'AUTH-02']);
  assert.match(index.tasks[0].section, /AUTH-01-I1/);
  assert.doesNotMatch(index.tasks[0].section, /AUTH-02/);
  assert.match(taskSnapshot(index, index.tasks[0]), /Preserve records/);
  assert.equal(index.reliable, false, 'ordinary flat checklists retain the legacy worker path');
});

test('criteria revisions ignore checkmarks and delivery prose but track acceptance and global rules', () => {
  const text = roadmap(section('AUTH-01'), section('AUTH-02'));
  const revision = value => parseRoadmapTasks(value).tasks[0].criteriaRevision;
  const changedState = text.replaceAll('[ ]', '[x]').replace('Status: IN_PROGRESS', 'Status: COMPLETE');
  assert.equal(revision(text), revision(changedState));
  const delivery = '<!-- roadmap-runner:delivery:start -->\nStatus: COMPLETE\nDelivered yesterday.\n<!-- roadmap-runner:delivery:end -->\n';
  assert.equal(revision(text), revision(text + delivery));
  assert.notEqual(revision(text), revision(text.replace('Only AUTH-01 behavior.', 'A changed acceptance rule.')));
  assert.notEqual(revision(text), revision(text.replace('Keep the public API stable.', 'Change the public API.')));
  assert.equal(revision(text), revision(text.replace('Only AUTH-02 behavior.', 'Another task changed.')));
});

test('unknown dependencies, cycles, orphan checklists and ambiguous prose gracefully fall back', t => {
  for (const text of [
    roadmap(section('AUTH-01', { dependencies: 'MISSING-99' })),
    roadmap(section('AUTH-01', { dependencies: 'AUTH-02' }), section('AUTH-02', { dependencies: 'AUTH-01' })),
    '# Work\n- [ ] Implement authentication\n- [ ] Review behavior\n',
    '# Work\n- [ ] EXTRA-01 Global criterion\n' + section('AUTH-01'),
  ]) {
    const f = fixture(t, text);
    assert.equal(f.plan.reliable, false);
    assert.equal(f.plan.select(), null);
    assert.equal(f.plan.schedulingOutcome().fallback, true);
  }
});

test('alternative and conditional dependency prose falls back instead of inventing an AND graph', () => {
  const prefix = roadmap(section('API-1'), section('API-2'));
  for (const dependencies of ['API-1 or API-2', 'either API-1 or API-2', 'API-1 if deployment is enabled', 'API-1 once prepared']) {
    const index = parseRoadmapTasks(prefix + '\n' + section('API-3', { dependencies }));
    assert.equal(index.reliable, false, dependencies);
  }
  for (const dependencies of ['API-1, API-2', 'API-1 and API-2', 'API-1; API-2']) {
    const index = parseRoadmapTasks(prefix + '\n' + section('API-3', { dependencies }));
    assert.equal(index.reliable, true, dependencies);
  }
});

test('default scheduling honors acceptance dependencies and carries scoped immutable context', t => {
  const f = fixture(t, roadmap(section('AUTH-01'), section('AUTH-02', { dependencies: 'AUTH-01' })));
  const task = f.plan.select();
  assert.equal(task.task, 'AUTH-01');
  const context = f.plan.context(task);
  const snapshot = JSON.parse(context.match(/^Selected original task snapshot: (.+)$/m)[1]);
  assert.doesNotMatch(fs.readFileSync(snapshot, 'utf8'), /AUTH-02/);
  fs.writeFileSync(f.file, roadmap(section('AUTH-01', { checked: true }), section('AUTH-02', { dependencies: 'AUTH-01' })));
  assert.equal(f.plan.finish(task, { code: 0 }).delivered, true);
  assert.equal(f.plan.select().task, 'AUTH-02');
  assert.match(fs.readFileSync(snapshot, 'utf8'), /\[ \] AUTH-01/, 'old snapshot is immutable');
});

test('useful exact partial continuation keeps task affinity for at most eight attempts', t => {
  const f = fixture(t);
  for (let attempt = 1; attempt <= 8; attempt++) {
    const task = f.plan.select();
    assert.equal(task.task, 'AUTH-01');
    f.plan.setContinuation(task.task, { outcome: 'partial', criteriaRevision: task.criteriaRevision,
      completed: [`step-${attempt}`], nextAction: 'Finish the remaining return branch.' });
    f.plan.finish(task, { code: 0 });
  }
  assert.equal(f.plan.select().task, 'AUTH-02');
  const restarted = new RoadmapPlan(f.file, f.dir, f.tracking);
  assert.equal(restarted.select().task, 'AUTH-02', 'fairness survives restart');
});

test('missing progress, changed acceptance and task skip remove affinity without blocking independent tasks', t => {
  const f = fixture(t);
  const first = f.plan.select();
  f.plan.setContinuation(first.task, { outcome: 'partial', completed: [], nextAction: 'Try again' });
  f.plan.finish(first, { code: 0 });
  assert.equal(f.plan.select().task, 'AUTH-02');
  f.plan.setContinuation(first.task, { outcome: 'partial', criteriaRevision: first.criteriaRevision,
    completed: ['Progress'], nextAction: 'Finish next branch' });
  assert.equal(f.plan.select().task, 'AUTH-01');
  f.plan.setSkippedTaskIds(['AUTH-01']);
  assert.equal(f.plan.select().task, 'AUTH-02');
  f.plan.setSkippedTaskIds([]);
  fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace('Only AUTH-01 behavior.', 'Changed behavior.'));
  assert.equal(f.plan.select().task, 'AUTH-02', 'old criteria outcome cannot retain affinity');
});

test('implementation outcome schedules scoped verification and cannot check acceptance itself', t => {
  const f = fixture(t, roadmap(section('AUTH-01')));
  const task = f.plan.select();
  f.plan.setContinuation(task.task, { outcome: 'implemented', criteriaRevision: task.criteriaRevision });
  f.plan.finish(task, { code: 0 });
  const scheduled = f.plan.schedulingOutcome();
  assert.equal(scheduled.status, 'ready');
  assert.equal(scheduled.task.phase, 'verification');
  assert.match(fs.readFileSync(f.file, 'utf8'), /\[ \] AUTH-01/);
  fs.writeFileSync(f.file, roadmap(section('AUTH-01', { checked: true })));
  assert.equal(f.plan.schedulingOutcome().status, 'complete');
});

test('finite snapshots use the shared task index for general IDs and scoped criteria revisions', t => {
  const f = finiteFixture(t);
  const batch = f.execution.select();
  const context = f.execution.context(batch);
  const snapshot = JSON.parse(context.match(/^Selected original task snapshot: (.+)$/m)[1]);
  const text = fs.readFileSync(snapshot, 'utf8');
  assert.match(text, /Keep the public API stable/);
  assert.doesNotMatch(text, /AUTH-02/);
  assert.equal(f.execution.tasks[0].criteriaRevision, batch.criteriaRevision);
});

test('finite continuation is bounded while legacy outcomes retain rotation', t => {
  const f = finiteFixture(t);
  const first = f.execution.select(); f.execution.context(first);
  f.execution.finish(first, { code: 0 });
  assert.equal(f.execution.select().task, 'AUTH-02');
  f.execution.setContinuation(first.task, { outcome: 'partial', criteriaRevision: first.criteriaRevision,
    changedFiles: ['service.ts'], nextAction: { action: 'Finish the return branch' } });
  for (let attempt = 1; attempt < 8; attempt++) {
    assert.equal(f.execution.select().task, 'AUTH-01');
    f.execution.finish(first, { code: 0 });
  }
  assert.equal(f.execution.select().task, 'AUTH-02');
});

test('finite scheduler distinguishes missing batches, open verification, blocked work and acceptance completion', t => {
  const f = finiteFixture(t);
  assert.equal(f.execution.schedulingOutcome().status, 'ready');
  f.authority.batches.forEach(batch => { batch.implementation = 'implemented'; });
  writeAuthority(f.authorityFile, f.authority);
  assert.equal(f.execution.schedulingOutcome().status, 'needs_next_batch');
  f.authority.parents.forEach(parent => { parent.implementation = 'implemented'; });
  writeAuthority(f.authorityFile, f.authority);
  assert.equal(f.execution.schedulingOutcome().status, 'awaiting_verification');
  f.authority.batches[0].implementation = 'blocked'; writeAuthority(f.authorityFile, f.authority);
  assert.equal(f.execution.schedulingOutcome().status, 'blocked');
  f.authority.batches[0].implementation = 'implemented'; writeAuthority(f.authorityFile, f.authority);
  fs.writeFileSync(f.file, roadmap(section('AUTH-01', { checked: true }), section('AUTH-02', { checked: true })));
  assert.equal(f.execution.schedulingOutcome().status, 'complete');
});

test('missing or changed finite prerequisite evidence rotates instead of throwing', t => {
  const f = finiteFixture(t);
  f.authority.batches[0].prerequisiteEvidence = [{ path: 'missing-receipt.json', sha256: '0'.repeat(64) }];
  writeAuthority(f.authorityFile, f.authority);
  assert.equal(f.execution.select().task, 'AUTH-02');
  f.execution.setSkippedTaskIds(['AUTH-02']);
  assert.equal(f.execution.schedulingOutcome().status, 'blocked');
});

test('source edits between selection and context retain the selected immutable acceptance in both adapters', t => {
  const f = finiteFixture(t);
  const ordinary = f.plan.select();
  const finite = f.execution.select();
  const changed = fs.readFileSync(f.file, 'utf8').replace('Only AUTH-01 behavior.', 'New controller requirements.');
  fs.writeFileSync(f.file, changed);
  f.plan.read(); f.execution.read();
  for (const [plan, selected] of [[f.plan, ordinary], [f.execution, finite]]) {
    const context = plan.context(selected);
    const snapshot = JSON.parse(context.match(/^Selected original task snapshot: (.+)$/m)[1]);
    assert.match(fs.readFileSync(snapshot, 'utf8'), /Only AUTH-01 behavior/);
    assert.doesNotMatch(fs.readFileSync(snapshot, 'utf8'), /New controller requirements/);
    assert.notEqual(plan.select().criteriaRevision, selected.criteriaRevision);
  }
});

test('repeated restored outcomes do not rewrite sidecars or duplicate full outcome payloads', t => {
  const f = finiteFixture(t);
  for (const plan of [f.plan, f.execution]) {
    const selected = plan.select();
    const outcome = { outcome: 'partial', criteriaRevision: selected.criteriaRevision,
      completed: ['A completed step'], findings: ['d'.repeat(128 * 1024)], nextAction: 'Finish branch' };
    plan.setContinuation(selected.task, outcome);
    const before = fs.statSync(plan.stateFile);
    assert.ok(before.size < 4096);
    plan.setContinuation(selected.task, { ...outcome });
    assert.equal(fs.statSync(plan.stateFile).mtimeMs, before.mtimeMs);
    assert.equal(fs.readFileSync(plan.stateFile, 'utf8').includes(outcome.findings[0]), false);
  }
});

test('invalid and oversized optional default cache is preserved and ignored without blocking dispatch', t => {
  const f = fixture(t);
  for (const contents of ['{invalid', 'x'.repeat(1024 * 1024 + 1)]) {
    fs.writeFileSync(f.plan.stateFile, contents);
    const before = new Set(fs.readdirSync(f.dir));
    const restarted = new RoadmapPlan(f.file, f.dir, f.tracking);
    assert.equal(restarted.select().task, 'AUTH-01');
    const archive = fs.readdirSync(f.dir).find(file => !before.has(file) && file.startsWith('task-plan.json.invalid-'));
    assert.ok(archive);
    assert.equal(fs.readFileSync(path.join(f.dir, archive), 'utf8'), contents);
  }
});

test('a later legacy handoff cannot reuse an older partial outcome as new productive affinity', t => {
  const f = finiteFixture(t);
  for (const plan of [f.plan, f.execution]) {
    const selected = plan.select();
    const outcome = { outcome: 'partial', criteriaRevision: selected.criteriaRevision,
      changedFiles: ['service.ts'], nextAction: 'Finish branch' };
    plan.setContinuation(selected.task, outcome);
    plan.remember(selected, 'handoff.md.gz', { sessionId: 'legacy', code: 0, taskResultFile: null });
    plan.finish(selected, { code: 0 });
    plan.setContinuation(selected.task, outcome);
    assert.equal(plan.select().task, 'AUTH-02');
  }
});

for (const rejection of [{ code: 1, usageLimit: { kind: 'session' } }, { code: 1, retryableCapacity: true }]) {
  const kind = rejection.usageLimit ? 'quota' : 'capacity';
  test(`${kind} after useful finite work preserves unaccepted implemented batch without counting a failed attempt`, t => {
    const f = finiteFixture(t);
    const first = f.execution.select(); f.execution.context(first);
    fs.writeFileSync(path.join(f.dir, 'service.ts'), 'export const delivered = true;\n');
    f.authority.batches[0].implementation = 'implemented';
    f.authority.batches[0].implementationEvidence = [{ path: 'service.ts', sha256: createHash('sha256').update(fs.readFileSync(path.join(f.dir, 'service.ts'))).digest('hex') }];
    f.authority.batches[1].implementation = 'blocked'; writeAuthority(f.authorityFile, f.authority);
    f.execution.setContinuation(first.task, { sessionId: kind, criteriaRevision: first.criteriaRevision,
      outcome: 'partial', completed: ['Source implemented'], nextAction: 'Validate existing implementation.' });
    f.execution.remember(first, 'handoff.md.gz', { sessionId: kind, taskResultFile: `worker-${kind}-result.json` });
    assert.equal(f.execution.finish(first, rejection).attempts, 0);
    assert.equal(f.execution.state.completed.includes(first.id), false);
    const restarted = new ExecutionPlan(f.authorityFile, f.dir, f.tracking);
    const resumed = restarted.select();
    assert.equal(resumed.id, first.id);
    assert.equal(restarted.finish(resumed, { code: 0 }).delivered, true, 'resumed source evidence can close without another implementation edit');
  });
  test(`${kind} with a matching default partial result preserves the last useful task`, t => {
    const f = fixture(t);
    const first = f.plan.select(); f.plan.finish(first, { code: 0 });
    const second = f.plan.select(); assert.equal(second.task, 'AUTH-02');
    f.plan.setContinuation(second.task, { sessionId: kind, criteriaRevision: second.criteriaRevision,
      outcome: 'partial', completed: ['Useful source step'], nextAction: 'Finish current task.' });
    f.plan.remember(second, 'handoff.md.gz', { sessionId: kind, taskResultFile: `worker-${kind}-result.json` });
    assert.equal(f.plan.finish(second, rejection).attempts, 0);
    assert.equal(f.plan.select().task, 'AUTH-02');
  });
}

test('a quota partial with old criteria cannot recover an implemented finite batch after scope changes', t => {
  const f = finiteFixture(t);
  const first = f.execution.select(); f.execution.context(first);
  f.authority.batches[0].implementation = 'implemented'; f.authority.batches[1].implementation = 'blocked';
  writeAuthority(f.authorityFile, f.authority);
  f.execution.setContinuation(first.task, { sessionId: 'old-scope', criteriaRevision: first.criteriaRevision,
    outcome: 'partial', completed: ['Source step'], nextAction: 'Finish old task.' });
  f.execution.remember(first, 'handoff.md.gz', { sessionId: 'old-scope', taskResultFile: 'old-result.json' });
  fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace('Only AUTH-01 behavior.', 'New acceptance requirements.'));
  assert.equal(f.execution.finish(first, { code: 1, usageLimit: { kind: 'session' } }).attempts, 0);
  assert.equal(f.execution.select(), null, 'old receipt cannot recover changed acceptance');
});
