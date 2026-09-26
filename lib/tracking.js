import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

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
  // stat follows symlinks; device/inode equality also catches hard-link aliases.
  if (source.dev === progress.dev && source.ino === progress.ino) {
    throw new Error("progress file must be different from the source roadmap (same file or link)");
  }
}

export function prepareTracking(roadmap, progressFile = "") {
  roadmap = path.resolve(roadmap);
  if (!progressFile) return { file: roadmap, assertUnchanged() {} };

  const file = path.resolve(progressFile);
  assertSeparate(roadmap, file, true);
  const original = digest(roadmap);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    // Never truncate an existing delivery-evidence file, even on restart.
    fs.writeFileSync(file, [
      "# Roadmap delivery evidence", "", "Status: IN_PROGRESS", "",
      `Source roadmap: ${JSON.stringify(roadmap)}`, "",
      "## Current handoff", "",
      "Initialize the checklist from the source roadmap; preserve its scope and IDs.", "",
      "## Acceptance gates", "",
      "No gates recorded yet; this is not completion evidence.", "",
      "## Checked-item status log", "", "_No completed items yet._", "",
      "## Iteration history", "", "_No iterations yet._", "",
    ].join("\n"), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  assertSeparate(roadmap, file);

  return {
    file,
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
  };
}

export function renderPrompt(template, roadmap, file) {
  const values = {
    ROADMAP: roadmap,
    PROGRESS_FILE: file,
    TRACKING_MODE: roadmap === file ? "EDIT_ROADMAP" : "PRESERVE_ROADMAP",
  };
  // A callback inserts literal paths (including $&) without re-expanding tokens.
  return template.replace(/\{\{(ROADMAP|PROGRESS_FILE|TRACKING_MODE)\}\}/g, (_, key) => values[key]);
}
