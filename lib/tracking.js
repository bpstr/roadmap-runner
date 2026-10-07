import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

export const MAX_TRACKING_BYTES = 128 * 1024;
export const MAX_SOURCE_BYTES = 512 * 1024;

const idFor = (roadmap) => createHash("sha256").update(path.resolve(roadmap)).digest("hex").slice(0, 12);
const safeName = (file) => path.basename(file, path.extname(file)).replace(/[^a-zA-Z0-9._-]+/g, "-") || "roadmap";

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
    "Initialize the checklist from the source roadmap; preserve its scope and IDs.", "",
    "## Acceptance gates", "",
    "No gates recorded yet; this is not completion evidence.", "",
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

  const tracking = {
    file,
    source: roadmap,
    stateDir,
    historyDir: path.join(stateDir, "history"),
    historyFile: path.join(stateDir, "history.jsonl"),
    maxBytes: MAX_TRACKING_BYTES,
    sourceStateFile,
    sourceSnapshot,
    get sourceRevision() { return sourceState.sha256; },
    get needsReconciliation() { return sourceState.pending; },
    refreshSource(iteration = 0) {
      const current = readSource(roadmap);
      assertSeparate(roadmap, file);
      const changed = current.sha256 !== sourceState.sha256;
      const next = changed ? { ...sourceState, sha256: current.sha256, pending: true } : sourceState;
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
      if (changed) console.log(`Roadmap changed; revision ${current.sha256.slice(0, 12)} will be reconciled by the next worker.`);
      return changed;
    },
    finishWorker(revision, result) {
      // Old, failed, interrupted, timed-out, or capacity-only sessions cannot
      // acknowledge a replacement roadmap, even if they left a terminal status.
      if (revision !== sourceState.sha256 || result.code !== 0 || result.error ||
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
        "Use this read-only snapshot for all source requirements in this session, not the changing live file.",
        "An external controller may revise the live roadmap; adopt later revisions only on the next run.",
        ...(sourceState.pending ? [
          "Before choosing work, reconcile the checklist and handoff against this revision. Ignore stale COMPLETE/BLOCKED and supervisor targets.",
          "Preserve valid evidence and stable IDs; reopen changed criteria, add new gates, follow revised priorities, and retire removed gates from active work without deleting history.",
          "Set the tracking status anew against this revision; a previous terminal status is not completion or blocker evidence for it.",
        ] : []),
        "Neither workers nor the periodic supervisor may edit the live source or snapshot, weaken criteria, or expand permissions/budgets.",
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
    TRACKING_MODE: "PRESERVE_ROADMAP",
  };
  return template.replace(/\{\{(ROADMAP|PROGRESS_FILE|HISTORY_DIR|TRACKING_MODE)\}\}/g, (_, key) => values[key]);
}
