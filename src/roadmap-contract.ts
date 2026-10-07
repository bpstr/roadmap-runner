// Deterministic structure validation; acceptance quality still needs controller review.
export const validateRoadmap = (text: string): string[] => {
  const errors: string[] = [];
  const checkboxIds = new Set<string>();
  for (const match of text.matchAll(/^- \[[ x]\] ([A-Za-z0-9_.-]+)(?:\s|$)/gm)) {
    if (checkboxIds.has(match[1])) errors.push(`Duplicate checkbox ID: ${match[1]}`);
    checkboxIds.add(match[1]);
  }
  const headings = [...text.matchAll(/^### Task ([A-Za-z0-9_.-]+)[^\n]*$/gm)];
  if (!headings.length) return ['No parent tasks found'];
  const tasks = headings.map((heading, index) => {
    const section = text.slice(heading.index, headings[index + 1]?.index ?? text.length);
    const epics = [...text.slice(0, heading.index).matchAll(/^## Epic[^\n]*$/gm)];
    const release = /deployment|production access|dogfood|release qualification/i.test(epics.at(-1)?.[0] || '');
    return { id: heading[1], section, release, dependencies: [...(section.match(/^Dependencies:\s*(.+)$/m)?.[1] || '').matchAll(/\b[A-Z][A-Z0-9]*-\d+(?:\.\d+)*\b/g)].map(match => match[0]) };
  });
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) errors.push(`Duplicate task ID: ${task.id}`); ids.add(task.id);
    const escaped = task.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`^- \\[[ x]\\] ${escaped}(?:\\s|$)`, 'm').test(task.section)) errors.push(`${task.id}: missing parent checkbox`);
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
