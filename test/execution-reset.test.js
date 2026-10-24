import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ExecutionPlan } from '../lib/execution.js';
import { prepareTracking } from '../lib/tracking.js';
import { Supervision, REVIEW_SUMMARY_BYTES } from '../lib/supervision.js';
import { activityTracker } from '../lib/telemetry.js';
import { runClient } from '../lib/runner.js';
import { parseArgs } from '../lib/runner.js';
import { Recovery, recoverySettings } from '../lib/recovery.js';
import { startSchema } from '../dist/run-manager.js';
import { RunManager } from '../dist/run-manager.js';

const cli = fileURLToPath(new URL('../bin/roadmap-runner.js', import.meta.url));
const hash = text => createHash('sha256').update(text).digest('hex');
const save = (file, plan) => fs.writeFileSync(file, '# Existing progress authority\n\n```roadmap-runner-execution\n' + JSON.stringify(plan) + '\n```\n');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-reset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const n of [1, 2]) fs.writeFileSync(path.join(dir, `owner${n}.md`), `# Original scope\n- [ ] API-01.${n} Original criterion ${n}\n`);
  const tracking = prepareTracking(path.join(dir, 'owner1.md'), path.join(dir, 'progress.md'), dir);
  const file = path.join(dir, 'authority.md');
  fs.writeFileSync(path.join(dir, 'service.ts'), 'export const complete = false;\n');
  const plan = { version: 1, denominator: 2, operationDenominator: 2,
    operations: [1,2].map(n => ({ id: `operation${n}`, owner: `API-01.${n}` })),
    parents: [1,2].map(n => ({ id: `API-01.${n}`, roadmap: `owner${n}.md`,
    implementation: 'partial', operations: [`operation${n}`], missing: ['Finish actual implementation'], evidence: [] })),
    batches: [1,2].map(n => ({ id: `deliver-${n}`, task: `API-01.${n}`, roadmap: `owner${n}.md`, implementation: 'not_started',
      budgetMinutes: 40, deliverable: `Deliver outcome ${n}`, boundary: 'One source path', completion: 'Source integrated', checkpoint: 'Exact remaining symbol', prerequisites: [], sourcePointers: ['service.ts'] })) };
  save(file, plan);
  return { dir, tracking, file, plan, execution: new ExecutionPlan(file, dir, tracking) };
}

test('a verified delivery counts once and configuration must be an explicit changed source', t => {
  const f = fixture(t);
  const config = path.join(f.dir, 'policy.json');
  fs.writeFileSync(config, '{"assigned":false}\n');
  f.plan.batches[0].kind = 'configuration';
  f.plan.batches[0].sourcePointers = ['policy.json'];
  save(f.file, f.plan);
  const batch = f.execution.select(); f.execution.context(batch);
  fs.writeFileSync(config, '{"assigned":true}\n');
  f.plan.batches[0].implementation = 'implemented';
  f.plan.batches[0].implementationEvidence = [{path:'policy.json', sha256:'0'.repeat(64)}];
  save(f.file, f.plan);
  assert.throws(() => f.execution.finish(batch, {code:0}), /does not match/);
  f.plan.batches[0].implementationEvidence = [{path:'status.json', sha256:'0'.repeat(64)}];
  save(f.file, f.plan);
  assert.throws(() => f.execution.finish(batch, {code:0}), /churn/);
  f.plan.batches[0].implementationEvidence = [{path:'policy.json', sha256:hash(fs.readFileSync(config))}];
  save(f.file, f.plan);
  assert.equal(f.execution.finish(batch, {code:0}).delivered, true);
  assert.equal(f.execution.finish(batch, {code:0}).delivered, false, 'replayed evidence cannot reset the guard');
  assert.match(fs.readFileSync(path.join(f.dir, 'owner1.md'), 'utf8'), /\[ \]/);
});

test('queued implementation delivery is observed without closing original acceptance', async t => {
  const f = fixture(t);
  const client = path.join(f.dir, 'prepared-delivery.cjs');
  fs.writeFileSync(client, `#!/usr/bin/env node
const fs=require('node:fs'), crypto=require('node:crypto'), path=require('node:path');
const prompt=process.argv.at(-1);
const authority=${JSON.stringify(f.file)};
const count=path.join(${JSON.stringify(f.dir)},'prepared-count');
const n=fs.existsSync(count)?Number(fs.readFileSync(count))+1:1;
fs.writeFileSync(count,String(n));
if(n>4)process.exit(99);
const named=prompt.match(/^Named deliverable: (.+)$/m);
if(named){
 const text=fs.readFileSync(authority,'utf8');
 const plan=JSON.parse(text.match(/\x60\x60\x60roadmap-runner-execution\\n([\\s\\S]*?)\\n\x60\x60\x60/)[1]);
 const batch=plan.batches.find(b=>b.id===named[1]);
 fs.writeFileSync('service.ts','export const stage = '+n+';\\n');
 batch.implementation='implemented';
 batch.implementationEvidence=[{path:'service.ts',sha256:crypto.createHash('sha256').update(fs.readFileSync('service.ts')).digest('hex')}];
 fs.writeFileSync(authority,'# Authority\\n\\n\x60\x60\x60roadmap-runner-execution\\n'+JSON.stringify(plan)+'\\n\x60\x60\x60\\n');
 if(fs.readFileSync('owner1.md','utf8').includes('[x]'))process.exit(98);
}else{
 const source=n===3?'owner1.md':'owner2.md';
 fs.writeFileSync(source,fs.readFileSync(source,'utf8').replace('[ ]','[x]'));
 fs.writeFileSync(n===3?'progress.md':'progress2.md','Status: COMPLETE\\n');
}
`, {mode:0o755});
  const manager = new RunManager(f.dir, path.join(f.dir, 'registry'));
  let run;
  t.after(async () => { if(run) { try { await manager.stop(run.id); } catch {} } });
  run = await manager.start({workspace:f.dir, roadmap:'owner1.md', progressFile:'progress.md',
    executionPlan:'authority.md', queue:[{roadmap:'owner2.md',progressFile:'progress2.md'}],
    notify:'off', supervisorEvery:0, timeout:'5s'}, {executable:client,
    recovery:{...recoverySettings({}),maxIdleWorkers:1,delayMs:1,maxDelayMs:1}});
  const deadline=Date.now()+15000;
  let final;
  while(Date.now()<deadline){
    final=await manager.status(run.id);
    if(final.processState==='exited')break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(final.processState,'exited');
  assert.equal(final.reason,'complete',final.output);
  assert.equal(Number(fs.readFileSync(path.join(f.dir,'prepared-count'))),4);
  assert.deepEqual(final.queue.map(entry=>entry.state),['complete','complete']);
  assert.equal(final.events.filter(event => event.type === 'runner.progress_observed' && event.kind === 'implementation').length, 2);
});

test('finite baseline rotates real owners and rejects denominator drift and generator-only delivery', t => {
  const f = fixture(t); const first = f.execution.select();
  assert.match(f.execution.context(first), /Selected original task snapshot/);
  f.execution.finish(first, { code: 0 });
  assert.equal(f.execution.select().task, 'API-01.2');
  f.plan.parents.push({ ...f.plan.parents[0], id: 'API-01.3' }); f.plan.denominator++;
  save(f.file, f.plan); assert.throws(() => f.execution.read(), /Frozen original/);
  f.plan.parents.pop(); f.plan.denominator--; f.plan.batches[0].implementation = 'implemented';
  f.plan.batches[0].implementationEvidence = [{ path: 'service.ts', sha256: hash(fs.readFileSync(path.join(f.dir, 'service.ts'))) }];
  save(f.file, f.plan); assert.throws(() => f.execution.finish(first, { code: 0 }), /Unchanged source/);
  f.plan.batches[0].implementationEvidence = [{ path: 'generated/client.ts', sha256: 'a'.repeat(64) }];
  save(f.file, f.plan); assert.throws(() => f.execution.finish(first, { code: 0 }), /churn/);
  fs.writeFileSync(path.join(f.dir, 'service.ts'), 'export const complete = true;\n');
  f.plan.batches[0].implementationEvidence = [{ path: 'service.ts', sha256: hash(fs.readFileSync(path.join(f.dir, 'service.ts'))) }];
  save(f.file, f.plan); assert.equal(f.execution.finish(first, { code: 0 }).delivered, true);
  assert.match(fs.readFileSync(path.join(f.dir, 'owner1.md'), 'utf8'), /\[ \]/);
});

test('failed delivery resumes saved work and changed prerequisite evidence cannot schedule a worker', t => {
  const f = fixture(t); const first = f.execution.select(); f.execution.context(first);
  fs.writeFileSync(path.join(f.dir, 'service.ts'), 'export const complete = true;\n');
  f.plan.batches[0].implementation = 'implemented';
  f.plan.batches[0].implementationEvidence = [{ path: 'service.ts', sha256: hash(fs.readFileSync(path.join(f.dir, 'service.ts'))) }];
  f.plan.batches[1].implementation = 'blocked'; save(f.file, f.plan);
  f.execution.remember(first, 'saved-exact-remaining.md.gz', { sessionId: 'prepared', timedOut: true });
  assert.equal(f.execution.finish(first, { code: 124, timedOut: true }).delivered, false);
  const restarted = new ExecutionPlan(f.file, f.dir, f.tracking);
  assert.match(restarted.context(first), /saved-exact-remaining.md.gz/);
  assert.equal(restarted.select().id, first.id);
  assert.equal(restarted.finish(first, { code: 0 }).delivered, true, 'unfinished source survives restart without rewriting');
  f.plan.batches[1].implementation = 'not_started';
  f.plan.batches[1].prerequisiteEvidence = [{ path: 'service.ts', sha256: '0'.repeat(64) }]; save(f.file, f.plan);
  assert.equal(restarted.select(), null);
  f.plan.batches[1].prerequisiteEvidence[0].sha256 = hash(fs.readFileSync(path.join(f.dir, 'service.ts'))); save(f.file, f.plan);
  assert.equal(restarted.select().id, 'deliver-2');
});

test('checkbox edits cannot clear attempt review or establish implementation delivery', t => {
  const f = fixture(t); const batch = f.execution.select(); f.execution.context(batch);
  const first = f.execution.finish(batch, { code: 0 });
  assert.equal(first.delivered, false); assert.equal(first.reviewRequired, false);
  const owner = path.join(f.dir, batch.roadmap);
  fs.appendFileSync(owner, '- [x] API-01.1-new Completed decomposition\n');
  const second = f.execution.finish(batch, { code: 0 });
  assert.equal(second.delivered, false); assert.equal(second.reviewRequired, true);
});

test('legacy replan flags request review without establishing a terminal loop', t => {
  const f = fixture(t); const roadmap = path.join(f.dir, 'owner1.md');
  const settings = recoverySettings({}); const recovery = new Recovery({ tracking: f.tracking, roadmap, settings });
  recovery.state.replanRequired = true; recovery.save();
  const restarted = new Recovery({ tracking: f.tracking, roadmap, settings });
  assert.equal(restarted.state.reviewRequested, true);
  assert.equal(restarted.state.replanRequired, undefined);
  assert.equal(restarted.state.loopBlockedRevision, undefined);
});

test('CLI and managed schema carry the finite authority without changing token options', t => {
  const f = fixture(t);
  assert.equal(parseArgs(['owner1.md', '--execution-plan', 'authority.md'], {}).executionPlan, 'authority.md');
  const request = startSchema.parse({ workspace: f.dir, roadmap: 'owner1.md', executionPlan: 'authority.md' });
  assert.equal(request.executionPlan, 'authority.md');
  assert.equal(request.timeout, '90m');
  assert.equal(request.model, undefined);
});

test('supervisor aggregate stays bounded and due status survives restart and pending requirements', async t => {
  const f = fixture(t); const config = { every: 20, timeoutMs: 5000, roadmap: path.join(f.dir, 'owner1.md'), tracking: f.tracking, template: 'review' };
  const review = new Supervision(config);
  for (let iteration=1; iteration<=20; iteration++) {
    const output = review.capture(); output.write('stdout', 'x'.repeat(200_000));
    review.record({ iteration, result: { code: 0 }, output, before: 'a'.repeat(100_000), after: 'b'.repeat(100_000) });
  }
  assert.ok(fs.statSync(review.evidenceFile).size <= REVIEW_SUMMARY_BYTES);
  const records = JSON.parse(fs.readFileSync(review.evidenceFile)).records;
  assert.ok(records.length >= 2); assert.ok(records.every(r => fs.existsSync(r.evidence)));
  const restarted = new Supervision(config); assert.equal(restarted.due, true);
  fs.appendFileSync(config.roadmap, 'Genuine controller requirement\n'); f.tracking.refreshSource();
  assert.equal(f.tracking.needsReconciliation, true);
  const client = path.join(f.dir, 'review.cjs');
  fs.writeFileSync(client, '#!/usr/bin/env node\nconst fs=require("node:fs");const p=process.argv.at(-1);fs.appendFileSync(' + JSON.stringify(f.tracking.file) + ',"\\n## Latest supervisor review\\nReview ID: "+p.match(/^Review ID: (.+)$/m)[1]+"\\nHealth: HEALTHY\\n");', { mode: 0o755 });
  await restarted.review({ options: { client: 'codex', executable: client, capacity: { delayMs: 1, retries: 0 } }, workdir: f.dir, afterIteration: 20 });
  assert.match(fs.readFileSync(f.tracking.file, 'utf8'), /Health: HEALTHY/);
});

test('soft deadline saves exact mock handoff before hard timeout and preserves unfinished source', async t => {
  const f = fixture(t); const request = path.join(f.dir, 'checkpoint.json');
  const client = path.join(f.dir, 'deadline.cjs');
  fs.writeFileSync(client, `#!/usr/bin/env node
const fs=require('node:fs');
fs.writeFileSync('unfinished.ts','export const unfinished = true;');
console.log(JSON.stringify({type:'item.started',item:{id:'command',type:'command_execution'}}));
let saved=false;
setInterval(()=>{ if(!saved && fs.existsSync(${JSON.stringify(request)})) { fs.writeFileSync('progress.md.tmp','Status: IN_PROGRESS\\n\\n## Remaining functionality\\nFinish return branch in unfinished.ts; reuse compile receipt.\\n'); fs.renameSync('progress.md.tmp','progress.md'); saved=true; } },10);
`, { mode: 0o755 });
  const result = await runClient({ client: 'codex', executable: client, workdir: f.dir, prompt: 'prepared deadline', timeoutMs: 4000,
    checkpointAtMs: 3000, terminationGraceMs: 50, onCheckpoint: data => { fs.writeFileSync(request, JSON.stringify(data)); return request; } });
  assert.equal(result.timedOut, true); assert.equal(result.checkpoint.saved, request);
  assert.match(fs.readFileSync(f.tracking.file, 'utf8'), /Finish return branch/);
  assert.ok(fs.existsSync(path.join(f.dir, 'unfinished.ts')));
  assert.ok(result.timing.commandMs > 0); assert.ok(result.timing.shutdownMs >= 0);
  assert.equal(result.cleanupIncomplete, false);
});

test('event timing separates concurrent command time, shutdown and unattributed silence', () => {
  let now = 0; const timer = activityTracker(() => now);
  now=10; timer.output(); timer.observe({type:'item.started',item:{id:'1',type:'command_execution'}});
  now=30; timer.observe({type:'item.started',item:{id:'2',type:'mcp_tool_call'}});
  now=60; timer.observe({type:'item.completed',item:{id:'1',type:'command_execution'}});
  now=80; timer.observe({type:'item.completed',item:{id:'2',type:'mcp_tool_call'}});
  now=100; timer.shutdown(); now=120; const timing=timer.result();
  assert.equal(timing.commandMs,50); assert.equal(timing.toolMs,20); assert.equal(timing.unattributedMs,30); assert.equal(timing.shutdownMs,20);
  assert.equal(timing.elapsedMs,120); assert.match(timing.attribution,/not-proof-of-inactivity/);
});

test('repeated unchanged failed finite outcomes stop only after an evidenced loop review', t => {
  const f = fixture(t); const client = path.join(f.dir, 'nonprogress.cjs');
  fs.writeFileSync(client, `#!/usr/bin/env node
const fs=require('node:fs');const p=process.argv.at(-1);
if(p.includes('Runner role: SUPERVISOR')) {
 fs.appendFileSync('calls','review\\n');
 fs.appendFileSync('progress.md','\\n## Latest supervisor review\\nReview ID: '+p.match(/^Review ID: (.+)$/m)[1]+'\\nHealth: STUCK\\nLoop: DETECTED\\nLoop iterations: 1, 3\\nLoop attempt: deliver-1 implementation.\\nLoop failure: The implementation is still absent.\\nLoop unchanged inputs: Source and prerequisite receipt are unchanged between attempts.\\nLoop evidence: Both deliver-1 attempts returned without implementing the operation.\\nNext: revise finite boundary before retry.\\n');
} else { fs.appendFileSync('calls',p.match(/^Named deliverable: (.+)$/m)[1]+'\\n'); }
`, { mode: 0o755 });
  const result = spawnSync(process.execPath,[cli,path.join(f.dir,'owner1.md'),'--client-bin',client,'--progress-file',f.tracking.file,
    '--execution-plan',f.file,'--supervisor-every','20','--notify','off'], { cwd:f.dir,encoding:'utf8',timeout:10_000 });
  assert.equal(result.status,75,result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(f.dir,'calls'),'utf8').trim().split('\n'),['deliver-1','deliver-2','deliver-1','review']);
  assert.match(fs.readFileSync(f.tracking.file+'.events.jsonl','utf8'),/loop_detected/);
});


test('supervision retains owner-spanning evidence and migrates both prior checkpoint formats', t => {
  const f = fixture(t); const roadmap = path.join(f.dir, 'owner1.md');
  const config = { every: 2, timeoutMs: 5000, roadmap, tracking: f.tracking, template: 'review' };
  const review = new Supervision(config);
  for (let iteration = 1; iteration <= 2; iteration++) {
    const output = review.capture(); output.write('stdout', 'Actual implementation receipt ' + iteration);
    review.record({ iteration, result: { code: 0 }, output, before: 'handoff before', after: 'handoff after' });
  }
  review.selectSource(path.join(f.dir, 'owner2.md'), f.tracking); review.checkpoint();
  const selected = new Supervision(config);
  assert.equal(selected.due, true); assert.equal(selected.records.length, 2);
  const stateFile = path.join(f.tracking.stateDir, 'supervision.json');
  const saved = JSON.parse(fs.readFileSync(stateFile));
  delete saved.version; delete saved.roadmap;
  fs.writeFileSync(stateFile, JSON.stringify(saved));
  assert.equal(new Supervision(config).due, true, 'unversioned local summaries remain usable');
  saved.version = 1; saved.roadmap = roadmap; delete saved.directory;
  saved.records = review.records.map(r => JSON.parse(fs.readFileSync(r.evidence)));
  fs.writeFileSync(stateFile, JSON.stringify(saved));
  const migrated = new Supervision(config);
  const summary = JSON.parse(fs.readFileSync(migrated.evidenceFile));
  assert.equal(summary.records.length, 2);
  assert.ok(summary.records.every(r => fs.existsSync(r.evidence)));
  assert.ok(fs.statSync(migrated.evidenceFile).size <= REVIEW_SUMMARY_BYTES);
});

test('productive partial finite batches continue after corrective reviews with parent checkboxes open', t => {
  const f = fixture(t); const client = path.join(f.dir, 'productive.cjs');
  fs.writeFileSync(client, `#!/usr/bin/env node
const fs=require('node:fs'),crypto=require('node:crypto');const p=process.argv.at(-1);
if(p.includes('Runner role: SUPERVISOR')) {
 const file=JSON.parse(p.match(/^Run evidence JSON: (.+)$/m)[1]);
 const records=JSON.parse(fs.readFileSync(file)).records.map(r=>JSON.parse(fs.readFileSync(r.evidence)));
 if(!records.some(r=>r.implementationBefore?.['service.ts']!==r.implementationAfter?.['service.ts']))process.exit(97);
 fs.appendFileSync('progress.md','\\n## Latest supervisor review\\nReview ID: '+p.match(/^Review ID: (.+)$/m)[1]+'\\nHealth: HEALTHY\\nLoop: CLEAR\\nAssessment: Distinct implementation and handoff progress.\\n');
} else {
 const n=fs.existsSync('productive-count')?Number(fs.readFileSync('productive-count'))+1:1;
 if(n>7)process.exit(99);fs.writeFileSync('productive-count',String(n));
 const file='authority.md';const text=fs.readFileSync(file,'utf8');
 const plan=JSON.parse(text.match(/\x60\x60\x60roadmap-runner-execution\\n([\\s\\S]*?)\\n\x60\x60\x60/)[1]);
 const batch=plan.batches.find(b=>b.id===p.match(/^Named deliverable: (.+)$/m)[1]);
 fs.writeFileSync('service.ts','export const stage = '+n+';\\n');
 batch.implementation=n>=5?'implemented':'partial';
 if(n>=5)batch.implementationEvidence=[{path:'service.ts',sha256:crypto.createHash('sha256').update(fs.readFileSync('service.ts')).digest('hex')}];
 fs.writeFileSync(file,'# Authority\\n\\n\x60\x60\x60roadmap-runner-execution\\n'+JSON.stringify(plan)+'\\n\x60\x60\x60\\n');
}
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [cli, path.join(f.dir, 'owner1.md'), '--client-bin', client,
    '--progress-file', f.tracking.file, '--execution-plan', f.file, '--supervisor-every', '20', '--notify', 'off'],
    { cwd: f.dir, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 75, result.stderr);
  assert.equal(Number(fs.readFileSync(path.join(f.dir, 'productive-count'))), 6);
  const events = fs.readFileSync(f.tracking.file + '.events.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).reason, 'finite_plan_exhausted', 'only the exhausted explicit plan ends this implementation phase');
  assert.equal(events.some(e => e.reason === 'loop_detected' || e.reason === 'replan_required'), false);
  assert.match(fs.readFileSync(path.join(f.dir, 'owner1.md'), 'utf8'), /- \[ \]/);
});


test('finite execution respects a global supervisor BLOCKED outcome without requiring loop evidence', t => {
  const f = fixture(t); const client = path.join(f.dir, 'global-blocked.cjs');
  fs.writeFileSync(client, `#!/usr/bin/env node
const fs=require('node:fs');const p=process.argv.at(-1);
if(p.includes('Runner role: SUPERVISOR')) {
 fs.appendFileSync('global-calls','review\\n');
 fs.writeFileSync('progress.md','Status: BLOCKED\\n## Latest supervisor review\\nReview ID: '+p.match(/^Review ID: (.+)$/m)[1]+'\\nHealth: STUCK\\nLoop: UNCERTAIN\\nBlocker: All authorized prerequisites are unavailable.\\n');
} else fs.appendFileSync('global-calls','worker\\n');
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [cli, path.join(f.dir, 'owner1.md'), '--client-bin', client,
    '--progress-file', f.tracking.file, '--execution-plan', f.file, '--supervisor-every', '1', '--notify', 'off'],
    { cwd: f.dir, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 75, result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'global-calls'), 'utf8').trim().split('\n'), ['worker', 'review']);
  const events = fs.readFileSync(f.tracking.file + '.events.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).reason, 'blocked');
});


test('quota and capacity rejections do not consume finite implementation attempts', t => {
  const f = fixture(t); const batch = f.execution.select(); f.execution.context(batch);
  for (const result of [{ code: 1, retryableCapacity: true }, { code: 1, usageLimit: { kind: 'session' } }]) {
    const outcome = f.execution.finish(batch, result);
    assert.equal(outcome.attempts, 0); assert.equal(outcome.delivered, false); assert.equal(outcome.reviewRequired, false);
  }
  assert.equal(f.execution.finish(batch, { code: 0 }).attempts, 1);
});
