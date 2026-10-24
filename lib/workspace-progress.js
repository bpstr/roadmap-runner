import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

// Observe implementation inputs, not generated evidence or the worker's claims.
// Git supplies ignored-file handling; content hashes ignore mtimes and commits.
const extensions = new Set(("c cc cpp cxx h hh hpp cs fs fsx vb java kt kts scala clj cljs " +
  "go rs swift m mm js jsx mjs cjs ts tsx mts cts vue svelte astro py pyi rb php " +
  "pl pm r R jl lua ex exs erl hrl hs lhs ml mli dart sh bash zsh fish ps1 sql " +
  "graphql gql proto thrift html htm css scss sass less json toml yaml yml xml " +
  "ini cfg conf cmake gradle lock sum mod ipynb").split(/\s+/));
const excluded = /(^|\/)(?:\.git|\.roadmap-runner|node_modules|vendor|dist|build|target|coverage|logs?|evidence|streams|receipts|docs?|tasks|__pycache__)(\/|$)/i;

const canonical = file => {
  try { return fs.realpathSync(file); }
  catch {
    const parent = path.dirname(file);
    return parent === file ? file : path.join(canonical(parent), path.basename(file));
  }
};

export function workspaceFingerprint(workdir, excludedPaths = []) {
  workdir = canonical(path.resolve(workdir));
  const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: workdir, encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (listed.error || listed.status !== 0) return null;
  const omit = excludedPaths.filter(Boolean).map(file => canonical(path.resolve(workdir, file)));
  const digest = createHash("sha256");
  try {
    for (const file of [...new Set(listed.stdout.split("\0").filter(Boolean))].sort()) {
      const full = path.resolve(workdir, file);
      if (excluded.test(file) || omit.some(root => full === root || full.startsWith(root + path.sep))) continue;
      const extension = path.extname(file).slice(1);
      if (!extensions.has(extension) && !/^(?:Makefile|Dockerfile|Containerfile|Gemfile|Rakefile|Justfile|CMakeLists\.txt|\.gitignore|\.dockerignore)$/.test(path.basename(file))) continue;
      let content;
      try {
        const stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) content = `symlink:${fs.readlinkSync(full)}`;
        else if (stat.isFile()) content = fs.readFileSync(full);
        else continue; // Submodule directories are not implementation bytes.
        digest.update(file + "\0" + (stat.mode & 0o111) + "\0");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        continue; // Missing files stay absent when their deletion is staged.
      }
      digest.update(createHash("sha256").update(content).digest());
    }
    return digest.digest("hex");
  } catch { return null; } // Unavailable observations never grant progress.
}
