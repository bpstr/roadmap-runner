import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

export const MAX_TRACKING_BYTES = 128 * 1024;
export const MAX_SOURCE_BYTES = 128 * 1024;
export const COMPACT_TRACKING_BYTES = 24 * 1024;
export const TARGET_TRACKING_BYTES = 16 * 1024;

const idFor = (roadmap) => createHash("sha256").update(path.resolve(roadmap)).digest("hex").slice(0, 12);
const safeName = (file) => path.basename(file, path.extname(file)).replace(/[^a-zA-Z0-9._-]+/g, "-") || "roadmap";

// Completion marks and the machine status are delivery state, not new scope.
// Keep task text, ordering and all other requirements in the revision comparison.
function requirements(contents) {
  // Only explicitly delimited delivery prose is excluded. Malformed blocks,
  // fenced examples and blocks containing task checkboxes stay scope-sensitive.
  const lines = contents.toString().split(/\r?\n/);
  const kept = [];
  let fence = null;
  let validBlocks = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[\\t ]*$`).test(line)) fence = null;
    } else {
      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (opening) fence = opening[1];
      else if (line === "<!-- roadmap-runner:delivery:start -->") {
        const end = lines.indexOf("<!-- roadmap-runner:delivery:end -->", i + 1);
        const block = end < 0 ? [] : lines.slice(i + 1, end);
        if (end >= 0 && !block.some(text => /roadmap-runner:delivery:|^\s*[-*+] \[[ xX]\]/.test(text))) {
          i = end;
          continue;
        }
        validBlocks = false;
      } else if (line === "<!-- roadmap-runner:delivery:end -->") {
        validBlocks = false;
      }
    }
    kept.push(line);
  }
  return (validBlocks ? kept : lines).join("\n").trimEnd().replace(/^(\s*[-*+] \[)[ xX](\])/gm, "$1 $2")
    .replace(/^Status:[\t ]*(?:IN_PROGRESS|COMPLETE|BLOCKED)[\t ]*\r?$/gim, "Status: IN_PROGRESS");
}

export function hasOpenRoadmapTasks(contents) {
  let fence = null;
  for (const line of contents.toString().split(/\r?\n/)) {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[\\t ]*$`).test(line)) fence = null;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) { fence = opening[1]; continue; }
    if (/^\s*[-*+] \[ \]\s+/.test(line)) return true;
  }
  return false;
}

// Read one bounded revision. Controllers should publish with an atomic rename so
// a boundary never observes a partly written roadmap.
function readSource(roadmap) {
  try {
    const stat = fs.statSync(roadmap);
    if (!stat.isFile()) throw new Error(`source roadmap is not a regular file: ${roadmap}`);
    const assertSize = (bytes) => {
      if (bytes > MAX_SOURCE_BYTES) {
        throw new Error(
          `source roadmap exceeded ${MAX_SOURCE_BYTES} bytes (${bytes}): ${roadmap}. ` +
          "Prepare a compact requirements-only roadmap; historical delivery logs must not be used as source context.",
        );
      }
    };
    assertSize(stat.size);
    const contents = fs.readFileSync(roadmap);
    assertSize(contents.length);
    return { contents, sha256: createHash("sha256").update(contents).digest("hex") };
  } catch (cause) {
    if (cause.code) {
      throw new Error(`source roadmap is no longer readable: ${roadmap}; stopping without restoring files`, { cause });
    }
    throw cause;
  }
}

function writeAtomic(file, contents) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function loadSourceState(file, source, progress, sha256) {
  try {
    if (fs.statSync(file).size > 4096) throw new Error("source revision state exceeds 4096 bytes");
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (state.version !== 1 || state.source !== source || state.progress !== progress ||
        !/^[a-f0-9]{64}$/.test(state.sha256) || typeof state.pending !== "boolean") {
      throw new Error("invalid source revision state or source/progress binding");
    }
    return state;
  } catch (cause) {
    // Older installations have no revision metadata. Bind their existing evidence
    // without rewriting it; only changes observed from this baseline are detectable.
    if (cause.code === "ENOENT") return { version: 1, source, progress, sha256, pending: false };
    throw new Error(`cannot read source revision state: ${file}`, { cause });
  }
}

function assertSeparate(roadmap, file, allowMissing = false) {
  if (roadmap === file) throw new Error("progress file must be different from the source roadmap");
  let progress;
  try {
    progress = fs.statSync(file);
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return;
    throw error;
  }
  if (!progress.isFile()) throw new Error(`progress file is not a regular file: ${file}`);
  const source = fs.statSync(roadmap);
  if (source.dev === progress.dev && source.ino === progress.ino) {
    throw new Error("progress file must be different from the source roadmap (same file or link)");
  }
}

function scaffold(roadmap) {
  return [
    "# Roadmap delivery state", "", "Status: IN_PROGRESS", "",
    `Source roadmap: ${JSON.stringify(roadmap)}`, "",
    "## Current handoff", "",
    "Read and update task checkboxes in the source roadmap; record only the active task and next step here.", "",
    "## Acceptance gates", "",
    "Task states and acceptance criteria live in the source roadmap; link to them without duplicating its checklist.", "",
    "## Checked-item evidence", "", "_No completed items yet._", "",
    "## Deferred gates", "", "_None._", "",
    "## Latest supervisor review", "", "_No review yet._", "",
  ].join("\n");
}

export function trackingPaths(roadmap, progressFile = "", workdir = process.cwd()) {
  roadmap = path.resolve(roadmap);
  const defaultStateDir = path.join(path.resolve(workdir), ".roadmap-runner", `${safeName(roadmap)}-${idFor(roadmap)}`);
  const file = path.resolve(progressFile || path.join(defaultStateDir, "progress.md"));
  const stateDir = progressFile
    ? path.join(path.dirname(file), ".roadmap-runner", `${safeName(roadmap)}-${idFor(roadmap)}`)
    : defaultStateDir;
  return { file, stateDir };
}

export function prepareTracking(roadmap, progressFile = "", workdir = process.cwd()) {
  roadmap = path.resolve(roadmap);
  const initialSource = readSource(roadmap);
  const { file, stateDir } = trackingPaths(roadmap, progressFile, workdir);
  assertSeparate(roadmap, file, true);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(stateDir, "history"), { recursive: true });
  fs.mkdirSync(path.join(stateDir, "evidence"), { recursive: true });
  try {
    fs.writeFileSync(file, scaffold(roadmap), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  assertSeparate(roadmap, file);

  const sourceStateFile = path.join(stateDir, `source-${idFor(file)}.json`);
  const sourceSnapshot = path.join(stateDir, `source-${idFor(file)}.md`);
  let sourceState = loadSourceState(sourceStateFile, roadmap, file, initialSource.sha256);
  let initialized = false;
  let stateOnlyPredecessor = null;

  const tracking = {
    file,
    source: roadmap,
    stateDir,
    historyDir: path.join(stateDir, "history"),
    historyFile: path.join(stateDir, "history.jsonl"),
    evidenceDir: path.join(stateDir, "evidence"),
    sessionsFile: path.join(stateDir, "sessions.jsonl"),
    maxBytes: MAX_TRACKING_BYTES,
    sourceStateFile,
    sourceSnapshot,
    get sourceRevision() { return sourceState.sha256; },
    get requirementsRevision() {
      return createHash("sha256").update(requirements(fs.readFileSync(sourceSnapshot))).digest("hex");
    },
    get needsReconciliation() { return sourceState.pending; },
    get needsCompaction() { return fs.statSync(file).size >= COMPACT_TRACKING_BYTES; },
    contextBytes(prompt) {
      const size = name => { try { return fs.statSync(name).size; } catch { return null; } };
      return { prompt: Buffer.byteLength(prompt), source: size(roadmap), progress: size(file) };
    },
    recordSession(record) {
      fs.appendFileSync(tracking.sessionsFile, JSON.stringify(record) + "\n", { mode: 0o600 });
    },
    evidenceContext() {
      return [
        `Detailed evidence directory: ${JSON.stringify(tracking.evidenceDir)}`,
        `History index: ${JSON.stringify(tracking.historyFile)}`,
        `Session metrics: ${JSON.stringify(tracking.sessionsFile)}`,
        `Keep the active handoff below ${COMPACT_TRACKING_BYTES} bytes; target ${TARGET_TRACKING_BYTES} bytes. Keep only current work, blockers, next steps and short evidence pointers in it.`,
        "Store detailed completed-task evidence by task ID in the evidence directory. Retrieve relevant evidence or a specific compressed snapshot when verifying a gate, resolving conflicting state or investigating a failed attempt. Search the index for the relevant iteration/time; do not bulk-load history.",
      ].join("\n");
    },
    refreshSource(iteration = 0) {
      const current = readSource(roadmap);
      assertSeparate(roadmap, file);
      const changed = current.sha256 !== sourceState.sha256;
      const previous = fs.existsSync(sourceSnapshot) ? readSource(sourceSnapshot) : null;
      const scopeChanged = changed && (!previous || previous.sha256 !== sourceState.sha256 ||
        requirements(previous.contents) !== requirements(current.contents));
      if (changed) stateOnlyPredecessor = scopeChanged ? null : sourceState.sha256;
      const next = changed ? { ...sourceState, sha256: current.sha256, pending: sourceState.pending || scopeChanged } : sourceState;
      if (changed) {
        tracking.archive({ kind: "roadmap-change", iteration, metadata: {
          previousSourceSha256: sourceState.sha256, sourceSha256: current.sha256,
        } });
      }
      // Only called between sessions. Each running agent gets a stable snapshot;
      // never restore or overwrite the controller-owned live roadmap.
      writeAtomic(sourceSnapshot, current.contents);
      if (changed || !initialized) writeAtomic(sourceStateFile, JSON.stringify(next) + "\n");
      sourceState = next;
      initialized = true;
      if (scopeChanged) console.log(`Roadmap requirements changed; revision ${current.sha256.slice(0, 12)} will be reconciled by the next worker.`);
      return changed;
    },
    deliveryStatus(status) {
      // Handoff prose cannot close tasks that are still open in the roadmap.
      return status === "complete" && hasOpenRoadmapTasks(readSource(roadmap).contents) ? "in-progress" : status;
    },
    finishWorker(revision, result) {
      // Old, failed, interrupted, timed-out, or capacity-only sessions cannot
      // acknowledge a replacement roadmap, even if they left a terminal status.
      if ((revision !== sourceState.sha256 && revision !== stateOnlyPredecessor) || result.code !== 0 || result.error ||
          result.interrupted || result.timedOut || result.retryableCapacity || result.usageLimit || !sourceState.pending) return;
      const next = { ...sourceState, pending: false };
      writeAtomic(sourceStateFile, JSON.stringify(next) + "\n");
      sourceState = next;
    },
    sourceContext() {
      return [
        `Source roadmap snapshot: ${JSON.stringify(sourceSnapshot)}`,
        `Source roadmap revision: ${sourceState.sha256}`,
        `Roadmap reconciliation required: ${sourceState.pending ? "YES" : "NO"}`,
        `Live roadmap (authoritative checkboxes): ${JSON.stringify(roadmap)}`,
        "Use the read-only snapshot for this session's acceptance criteria; update verified checkbox states in the live roadmap.",
        "An external controller may revise the live roadmap; adopt later revisions only on the next run.",
        ...(sourceState.pending ? [
          "Before choosing work, reconcile the checklist and handoff against this revision. Ignore stale COMPLETE/BLOCKED and supervisor targets.",
          "Preserve valid evidence and stable IDs; reopen changed criteria, add new gates, follow revised priorities, and retire removed gates from active work without deleting history.",
          "Reconcile roadmap checkbox states and the handoff against this revision; a previous terminal status is not completion or blocker evidence for it.",
        ] : []),
        "Workers update live roadmap checkbox states and concise status; preserve IDs and acceptance criteria and all unrelated controller edits. Snapshots remain read-only. Supervisors record evidence and correction targets in the handoff; they do not tick implementation checkboxes.",
      ].join("\n");
    },
    compactionContext() {
      const bytes = fs.statSync(file).size;
      if (bytes < COMPACT_TRACKING_BYTES) return "";
      return [
        `Progress compaction required: ${bytes} bytes; target below ${TARGET_TRACKING_BYTES} bytes; emergency read limit ${MAX_TRACKING_BYTES} bytes.`,
        "Compact the handoff before implementation. Preserve every gate ID, acceptance criterion, checkbox state, unresolved blocker and evidence reference needed to resume in the roadmap or referenced evidence; keep only current work and pointers in the handoff.",
        `Earlier full snapshots remain in ${JSON.stringify(tracking.historyDir)}. Do not move iteration logs into the source roadmap or load archived history in bulk.`,
        "If preserving the required state cannot fit the limit, report the context blocker and stop rather than deleting criteria or continuing with oversized context.",
      ].join("\n");
    },
    assertBounded() {
      const bytes = fs.statSync(file).size;
      if (bytes > MAX_TRACKING_BYTES) {
        throw new Error(
          `active progress file exceeded ${MAX_TRACKING_BYTES} bytes (${bytes}): ${file}. ` +
          `Detailed history belongs in ${tracking.historyDir}; compact the active handoff/evidence before continuing.`,
        );
      }
    },
    archive({ kind = "worker", iteration = 0, metadata = {} } = {}) {
      const contents = fs.readFileSync(file);
      const sha256 = createHash("sha256").update(contents).digest("hex");
      const stamp = String(iteration).padStart(6, "0");
      const name = `${stamp}-${kind}-${sha256.slice(0, 12)}.md.gz`;
      const target = path.join(tracking.historyDir, name);
      if (!fs.existsSync(target)) fs.writeFileSync(target, gzipSync(contents), { mode: 0o600 });
      fs.appendFileSync(tracking.historyFile, JSON.stringify({
        at: new Date().toISOString(), kind, iteration, trackingSha256: sha256,
        snapshot: path.relative(stateDir, target), ...metadata,
      }) + "\n", { mode: 0o600 });
      return target;
    },
  };

  tracking.assertBounded();
  tracking.refreshSource();
  return tracking;
}

export function renderPrompt(template, roadmap, file, historyDir = "") {
  const values = {
    ROADMAP: roadmap,
    PROGRESS_FILE: file,
    HISTORY_DIR: historyDir,
    TRACKING_MODE: "ROADMAP_CHECKBOXES",
  };
  return template.replace(/\{\{(ROADMAP|PROGRESS_FILE|HISTORY_DIR|TRACKING_MODE)\}\}/g, (_, key) => values[key]);
}
