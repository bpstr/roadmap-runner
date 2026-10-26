import { createHash } from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('hex');
const idPattern = '[A-Za-z0-9_.-]+';

// Keep offsets and newlines intact so examples cannot create tasks or delimit
// real sections, while snapshots retain the original Markdown verbatim.
export function maskFencedCode(text) {
  let fence = null;
  return text.replace(/[^\n]*(?:\n|$)/g, line => {
    if (!line) return line;
    const value = line.replace(/\r?\n$/, '');
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[\\t ]*$`).test(value);
      if (close) fence = null;
      return line.replace(/[^\r\n]/g, ' ');
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(value);
    if (!opening) return line;
    fence = opening[1];
    return line.replace(/[^\r\n]/g, ' ');
  });
}

export function requirementsText(text) {
  let visible = maskFencedCode(text);
  const replacements = [];
  const blocks = /^<!-- roadmap-runner:delivery:start -->\r?\n[\s\S]*?^<!-- roadmap-runner:delivery:end -->[\t ]*(?:\r?\n|$)/gm;
  for (const match of visible.matchAll(blocks)) {
    if (!/^\s*[-*+] \[[ xX]\]/m.test(match[0]) &&
        (match[0].match(/roadmap-runner:delivery:/g) || []).length === 2) {
      replacements.push({ start: match.index, end: match.index + match[0].length, text: '' });
    }
  }
  let normalized = text;
  for (const item of replacements.sort((a, b) => b.start - a.start)) {
    normalized = normalized.slice(0, item.start) + item.text + normalized.slice(item.end);
  }
  visible = maskFencedCode(normalized);
  const marks = [];
  for (const match of visible.matchAll(/^(\s*[-*+] \[)[ xX](\])/gm)) {
    marks.push({ start: match.index + match[1].length, end: match.index + match[1].length + 1, text: ' ' });
  }
  for (const match of visible.matchAll(/^Status:[\t ]*(?:IN_PROGRESS|COMPLETE|BLOCKED|STOPPED)[\t ]*\r?$/gim)) {
    marks.push({ start: match.index, end: match.index + match[0].length, text: 'Status: IN_PROGRESS' });
  }
  for (const item of marks.sort((a, b) => b.start - a.start)) {
    normalized = normalized.slice(0, item.start) + item.text + normalized.slice(item.end);
  }
  return normalized.replace(/\r\n/g, '\n').trim();
}

const checkboxesIn = visible => [...visible.matchAll(/^([\t ]*)[-*+][\t ]+\[([ xX])\][\t ]+([^\n]*)/gm)]
  .map(match => ({
    // Every checkbox participates in completion. A stable ID is needed only
    // for parent identity; Markdown code, links and punctuation are valid
    // acceptance descriptions and must not silently disappear from the index.
    id: match[3].match(new RegExp(`^(?:\\*\\*)?(${idPattern})(?=$|[\\s:*—])`))?.[1] ?? null,
    checked: match[2].toLowerCase() === 'x', indent: match[1].length,
    start: match.index, end: match.index + match[0].length, text: match[0] }));

function dependenciesIn(text, ids) {
  const value = text.match(/^Dependencies:[\t ]*(.+)$/m)?.[1] || '';
  const tokens = value.match(/[A-Za-z0-9_.-]+/g) || [];
  const dependencies = [...new Set(tokens.map(token => token.replace(/[.]+$/, '')).filter(token =>
    ids.has(token) || /^[A-Za-z][A-Za-z0-9_]*-\d+(?:[.-][A-Za-z0-9]+)*$/.test(token)))];
  // Only an explicit list means conjunction. Do not silently reinterpret "or",
  // "either", conditions or explanatory dependency prose as an AND graph.
  const list = value.replace(/\band\b/gi, ' ').split(/[\s,;&+]+/).filter(Boolean).map(token => token.replace(/[.]+$/, ''));
  const none = !dependencies.length && /^none(?:\.|\s*;|$)/i.test(value.trim()) && !/\b(if|unless|until|when|except)\b/i.test(value);
  const dependenciesExplicit = none || (dependencies.length > 0 && list.length > 0 && list.every(token => dependencies.includes(token)));
  return { dependencyText: value, dependencies, dependenciesExplicit };
}

// Headings are authoritative when present. Flat task lists are also supported
// for existing finite plans, whose known parent IDs remove parent/substep
// ambiguity. Arbitrary prose checklists remain on the legacy worker path.
export function parseRoadmapTasks(text, { parentIds } = {}) {
  const visible = maskFencedCode(text);
  const checkboxes = checkboxesIn(visible);
  const headings = [...visible.matchAll(/^ {0,3}(#{1,6})[\t ]+([^\n]*)$/gm)]
    .map(match => ({ level: match[1].length, title: match[2].trim(), start: match.index }));
  const taskHeadings = headings.filter(heading => heading.level === 3 && new RegExp(`^Task[\\t ]+(${idPattern})(?=$|[\\s:—])`).test(heading.title));
  const format = taskHeadings.length ? 'headings' : 'flat';
  let ranges;
  if (taskHeadings.length) {
    ranges = taskHeadings.map(heading => ({
      id: heading.title.match(new RegExp(`^Task[\\t ]+(${idPattern})`))[1],
      start: heading.start,
      end: headings.find(next => next.start > heading.start && next.level <= 3)?.start ?? text.length,
    }));
  } else {
    const declared = parentIds ? new Set(parentIds) : null;
    const candidates = checkboxes.filter(item => declared ? declared.has(item.id) : /[A-Za-z]/.test(item.id) && /\d/.test(item.id));
    const minIndent = candidates.length ? Math.min(...candidates.map(item => item.indent)) : 0;
    const parents = candidates.filter(item => declared || (item.indent === minIndent &&
      !candidates.some(parent => parent !== item && parent.start < item.start &&
        (item.id.startsWith(parent.id + '-') || item.id.startsWith(parent.id + '.')))));
    ranges = parents.map((item, index) => ({ id: item.id, start: item.start,
      end: Math.min(parents[index + 1]?.start ?? text.length,
        headings.find(heading => heading.start > item.start && heading.level <= 2)?.start ?? text.length) }));
  }
  const ids = new Set(ranges.map(task => task.id));
  const shared = [];
  let offset = 0;
  for (const task of ranges) { shared.push(text.slice(offset, task.start)); offset = task.end; }
  shared.push(text.slice(offset));
  const globalContext = shared.map(part => part.trim()).filter(Boolean).join('\n\n');
  const tasks = ranges.map(range => {
    const section = text.slice(range.start, range.end).trimEnd();
    const visibleSection = visible.slice(range.start, range.end).trimEnd();
    const taskCheckboxes = checkboxes.filter(item => item.start >= range.start && item.start < range.end);
    const parents = taskCheckboxes.filter(item => item.id === range.id);
    const epic = headings.filter(heading => heading.start < range.start && heading.level === 2).at(-1)?.title || '';
    return { ...range, section, visibleSection, checkboxes: taskCheckboxes, parent: parents[0],
      complete: parents.length === 1 && taskCheckboxes.every(item => item.checked),
      release: /deployment|production access|dogfood|release qualification/i.test(epic),
      criteriaRevision: hash(requirementsText(globalContext + '\n\n' + section)),
      ...dependenciesIn(visibleSection, ids) };
  });
  const byId = new Map(tasks.map(task => [task.id, task]));
  const unknownDependencies = tasks.flatMap(task => task.dependencies.filter(id => !byId.has(id)));
  let cycle = false;
  const visited = new Set(); const active = new Set();
  const visit = id => {
    if (active.has(id)) { cycle = true; return; }
    if (visited.has(id)) return;
    active.add(id);
    for (const dependency of byId.get(id)?.dependencies || []) if (byId.has(dependency)) visit(dependency);
    active.delete(id); visited.add(id);
  };
  for (const task of tasks) visit(task.id);
  const orphanCheckboxes = checkboxes.filter(item => !ranges.some(task => item.start >= task.start && item.start < task.end));
  const reliable = format === 'headings' && tasks.length > 0 && ids.size === tasks.length && !cycle &&
    unknownDependencies.length === 0 && orphanCheckboxes.length === 0 && tasks.every(task =>
      task.checkboxes.filter(item => item.id === task.id).length === 1 && task.dependenciesExplicit && /^Acceptance:[\t ]*\S/m.test(task.visibleSection));
  return { format, reliable, tasks, globalContext, checkboxes, orphanCheckboxes, unknownDependencies, cycle };
}

export function taskSnapshot(index, task) {
  return [index.globalContext, task.section].filter(Boolean).join('\n\n') + '\n';
}

export function hasExactContinuation(outcome) {
  const action = outcome?.nextAction;
  return typeof action === 'string' ? action.trim().length > 0 : Boolean(action && typeof action === 'object' &&
    Object.values(action).some(value => typeof value === 'string' && value.trim().length > 0));
}

export function isProductivePartial(outcome) {
  if (outcome?.scheduling === 'defer') return false;
  if (outcome?.outcome === 'partial' && typeof outcome.productivePartial === 'boolean') return outcome.productivePartial;
  return outcome?.outcome === 'partial' && hasExactContinuation(outcome) &&
    ['completed', 'changedFiles', 'receiptIds', 'findings'].some(key => Array.isArray(outcome[key]) && outcome[key].length > 0);
}

// A deferred prerequisite can hold its dependents without completing any of them.
export function onlyDeferredTasks(tasks, deferredIds, completedIds = []) {
  if (!tasks.length || !deferredIds.length) return false;
  const waiting = new Set(deferredIds);
  const complete = new Set(completedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (!waiting.has(task.id) && task.dependencies?.some(id => waiting.has(id)) &&
          task.dependencies.every(id => waiting.has(id) || complete.has(id))) {
        waiting.add(task.id); changed = true;
      }
    }
  }
  return tasks.every(task => waiting.has(task.id));
}

// Detailed outcomes belong to task memory/evidence. Scheduling needs only these
// bounded facts, so restoring a receipt never copies its full findings or logs.
export function continuationSummary(outcome) {
  if (!outcome || !['partial', 'implemented', 'verified', 'reused', 'blocked'].includes(outcome.outcome)) return null;
  return { outcome: outcome.outcome,
    sessionId: typeof outcome.sessionId === 'string' ? outcome.sessionId : null,
    criteriaRevision: typeof outcome.criteriaRevision === 'string' ? outcome.criteriaRevision : null,
    productivePartial: isProductivePartial(outcome) };
}
