import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { trackingPaths, roadmapRequirementsRevision, hasOpenRoadmapTasks, MAX_SOURCE_BYTES } from './tracking.js';
import { parseRoadmapTasks } from './task-index.js';
import { TaskMemory } from './task-memory.js';

const manifestPath = tracking => path.join(tracking.stateDir, 'deferred.json');

export function saveDeferral(tracking, roadmap, tasks) {
  const sources = [...new Set(tasks.map(task => task.roadmap || roadmap))].map(file => ({
    file, revision: roadmapRequirementsRevision(fs.readFileSync(file))
  }));
  const value = { version: 1, roadmap, progressFile: tracking.file, sources,
    tasks: tasks.map(task => ({ task: task.task, roadmap: task.roadmap || roadmap, criteriaRevision: task.criteriaRevision })) };
  const serialized = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(serialized) > 1024 * 1024) throw new Error('Deferred task manifest exceeds 1 MiB');
  const file = manifestPath(tracking), temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
  return file;
}

// Inspect only deferred scopes at queue boundaries. Unchanged work is never
// dispatched just because another roadmap or a new process finished.
export function deferredRoadmapReady(item, workdir) {
  try {
    const file = item.deferralFile || manifestPath(trackingPaths(item.roadmap, item.progressFile, workdir));
    if (fs.statSync(file).size > 1024 * 1024) return false;
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.version !== 1 || fs.realpathSync(saved.roadmap) !== fs.realpathSync(item.roadmap) || !saved.tasks?.length || !saved.sources?.length) return false;
    const tracking = trackingPaths(saved.roadmap, saved.progressFile, workdir);
    const indexes = new Map();
    for (const source of saved.sources) {
      if (fs.statSync(source.file).size > MAX_SOURCE_BYTES) return false;
      const text = fs.readFileSync(source.file, 'utf8');
      if (!hasOpenRoadmapTasks(text)) return true;
      const index = parseRoadmapTasks(text);
      const deferred = saved.tasks.filter(task => task.roadmap === source.file);
      if (deferred.some(task => !index.tasks.some(candidate => candidate.id === task.task))) {
        if (roadmapRequirementsRevision(text) !== source.revision) return true;
      } else {
        if (deferred.some(task => index.tasks.some(candidate => candidate.id === task.task &&
            candidate.criteriaRevision !== task.criteriaRevision))) return true;
        // New independent work or a completed prerequisite may also make a
        // previously exhausted source runnable. Deferred criteria stay bound.
        if (index.reliable && index.tasks.some(task => !task.complete && !deferred.some(saved => saved.task === task.id) &&
            task.dependencies.every(id => index.tasks.some(candidate => candidate.id === id && candidate.complete)))) return true;
      }
      indexes.set(source.file, index);
    }
    const memories = new Map();
    for (const task of saved.tasks) {
      if (indexes.get(task.roadmap)?.tasks.some(candidate => candidate.id === task.task && candidate.complete)) return true;
      if (!memories.has(task.roadmap)) {
        const locations = trackingPaths(task.roadmap, tracking.file, workdir);
        memories.set(task.roadmap, new TaskMemory({ workdir, roadmap: task.roadmap,
          tracking: { ...locations, evidenceDir: path.join(locations.stateDir, 'evidence') } }));
      }
      if (!memories.get(task.roadmap).assessedBlocker(task.task, task.criteriaRevision)) return true;
    }
  } catch { /* Missing or invalid deferred evidence leaves the item parked. */ }
  return false;
}
