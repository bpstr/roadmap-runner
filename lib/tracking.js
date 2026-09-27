import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export const MAX_TRACKING_BYTES = 128 * 1024;\nexport const MAX_SOURCE_BYTES = 512 * 1024;

const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const idFor = (roadmap) => createHash("sha256").update(path.resolve(roadmap)).digest("hex").slice(0, 12);
const safeName = (file) => path.basename(file, path.extname(file)).replace(/[^a-zA-Z0-9._-]+/g, "-") || "roadmap";

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

export function prepareTracking(roadmap, progressFile = "", workdir = process.cwd()) {
  roadmap = path.resolve(roadmap);
  const sourceBytes = fs.statSync(roadmap).size;
  if (sourceBytes > MAX_SOURCE_BYTES) {
    throw new Error(
      `source roadmap exceeded ${MAX_SOURCE_BYTES} bytes (${sourceBytes}): ${roadmap}. ` +
      "Restore/prepare a compact requirements-only roadmap before running; historical delivery logs must not be used as source context.",
    );
  }
  const stateDir = path.join(path.resolve(workdir), ".roadmap-runner", `${safeName(roadmap)}-${idFor(roadmap)}`);
  const file = path.resolve(progressFile || path.join(stateDir, "progress.md"));
  assertSeparate(roadmap, file, true);

  const original = digest(roadmap);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(stateDir, "history"), { recursive: true });
  try {
    fs.writeFileSync(file, scaffold(roadmap), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  assertSeparate(roadmap, file);

  const tracking = {
    file,
    source: roadmap,
    stateDir,
    historyDir: path.join(stateDir, "history"),
    historyFile: path.join(stateDir, "history.jsonl"),
    maxBytes: MAX_TRACKING_BYTES,
    assertUnchanged() {
      let current;
      try {
        current = digest(roadmap);
      } catch (cause) {
        throw new Error(`preserved roadmap is no longer readable: ${roadmap}; stopping without restoring files`, { cause });
      }
      if (current !== original) {
        throw new Error(`preserved roadmap changed: ${roadmap}; stopping without restoring files`);
      }
      assertSeparate(roadmap, file);
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
