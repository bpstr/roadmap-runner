import { parseRoadmapTasks } from '../lib/task-index.js';

// Deterministic structure validation; acceptance quality still needs controller review.
export const validateRoadmap = (text: string): string[] => {
  const errors: string[] = [];
  const index = parseRoadmapTasks(text);
  const checkboxIds = new Set<string>();
  for (const checkbox of index.checkboxes) {
    if (!checkbox.id) continue;
    if (checkboxIds.has(checkbox.id)) errors.push(`Duplicate checkbox ID: ${checkbox.id}`);
    checkboxIds.add(checkbox.id);
  }
  if (index.format !== 'headings') return ['No parent tasks found'];
  const tasks: Array<{ id: string; section: string; release: boolean; dependencies: string[]; parent?: unknown }> =
    index.tasks.map(task => ({ ...task, section: task.visibleSection }));
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) errors.push(`Duplicate task ID: ${task.id}`); ids.add(task.id);
    if (!task.parent) errors.push(`${task.id}: missing parent checkbox`);
    for (const field of ['Purpose', 'Context', 'Dependencies', 'Session scope', 'Acceptance', 'Evidence', 'Handoff', 'Blocked behavior']) {
      if (!new RegExp(`^${field}:\\s*\\S`, 'm').test(task.section)) errors.push(`${task.id}: missing ${field}`);
    }
    const implementation = task.section.indexOf('\nImplementation:'); const validation = task.section.indexOf('\nValidation:');
    if (implementation < 0 || validation < implementation) errors.push(`${task.id}: implementation must precede validation`);
    else {
      if (!/^- \[[ x]\]/m.test(task.section.slice(implementation, validation))) errors.push(`${task.id}: missing implementation steps`);
      if (!/^- \[[ x]\]/m.test(task.section.slice(validation))) errors.push(`${task.id}: missing validation steps`);
    }
  }
  const byId = new Map(tasks.map(task => [task.id, task]));
  for (const task of tasks) for (const dependency of task.dependencies) {
    if (!byId.has(dependency)) errors.push(`${task.id}: missing dependency ${dependency}`);
    if (!task.release && byId.get(dependency)?.release) errors.push(`${task.id}: development depends on release-only ${dependency}`);
  }
  const visited = new Set<string>(); const active = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) { errors.push(`Dependency cycle at ${id}`); return; }
    if (visited.has(id)) return; active.add(id);
    for (const dependency of byId.get(id)?.dependencies || []) if (byId.has(dependency)) visit(dependency);
    active.delete(id); visited.add(id);
  };
  for (const task of tasks) visit(task.id);
  return errors;
};
