# Git management validation — 0.14.0

Scope: opt-in worker prompt instructions, CLI/environment precedence, MCP start
schema and persisted run options. Remote checks fetch/compare without changing the
checkout or the runner's selected source binding. Git outcomes remain advisory.

Validation plan:

- Build TypeScript once for the changed lifecycle and managed-start schema.
- Run `test/manage-git.test.js`: deterministic option/schema checks and four real
  foreground CLI launches with a prepared executable, isolated state and simulated
  advisory Git failures. Completion requires the expected prompt setting and saved
  option in every case, with successful roadmap completion.
- Run only `lifecycle resumes productive same-task work by provider ID and starts
  fresh at the next task` and `Git instructions remain present in resumed sessions
  and across task boundaries` from `test/runtime-continuity-integration.test.js`.
  These cover default-off behavior, resumed prompt delivery and task boundaries.
- Run the package check for the 0.14.0 version and installed CLI help surface. This
  checks the release artifact; it is not an application full-suite gate.

No provider calls, Git network commands, credentials or live inference are used.
Prepared responses verify instruction delivery and runner behavior, not an agent's
compliance with those instructions or a real remote's availability.

Results (2026-11-03):

- `npm run build`: passed.
- `node --test test/manage-git.test.js`: 6 passed, 0 failed/cancelled/skipped.
- `node --test --test-name-pattern='^lifecycle resumes productive|^Git instructions remain' test/runtime-continuity-integration.test.js`:
  2 passed, 0 failed/cancelled/skipped. Same-task continuation and the next task
  both received the enabled instructions; default prompts omitted them.
- `npm run check:package`: passed for `@bpstr/roadmap-runner@0.14.0`, 92 files,
  226,263 packed bytes. Extracted version/help and existing saved-monitor checks
  passed. Its package lifecycle also rebuilt the published TypeScript output.
- `git diff --check`: passed.

Full local logs: `/tmp/roadmap-runner-0.14.0-validation/` (`build.log`,
`manage-git.log`, `continuation.log`, `package.log`). No application full suite was
required: the changed behavior is option parsing, managed configuration and worker
prompt delivery; the focused checks cover these paths. No live-agent compliance
or successful remote Git operation is claimed.

Hygiene: prepared fixture workspaces and package-check extraction/tarball are
removed by teardown. No browser or web server was started. The data volume has
about 25 GiB available; existing `node_modules` (39 MiB) and compiled `dist`
(300 KiB) are shared workspace inputs/output and were retained. Validation logs
occupy about 28 KiB; no substantial session artifact or unrelated cache was removed.
