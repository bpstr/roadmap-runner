# Failed-attempt loop correction

Scope: replace checkbox/file novelty stopping with supervisor comparison of
repeated failed attempts and their relevant inputs. Work is isolated from the
concurrently edited primary checkout, based on PR 8 head 12813a2.

Validation plan before execution:

- Build TypeScript with existing local dependencies; no package installation.
- Run only `source-loop`, `supervisor`, `recovery`, `queue`, and `context-budget`
  test files. These cover changed scheduling, persisted review windows, legacy
  state migration, quota/global BLOCKED behavior, queue preservation and compaction.
- All client and review responses are prepared local subprocess fixtures. No
  credentials, provider requests, proxy calls or live fixture recording.
- Completion: build and affected tests pass; package and whitespace checks pass.
- No full suite: changes are bounded to recovery/review orchestration; unrelated
  clients, MCP, notifications and packaging behavior retain existing evidence.
  The original PR's 264-pass/3-failure full-suite record remains historical and
  is not represented as a passing result for this correction.

Results: pending.

Initial affected run: 35 passed, 9 failed, 1 cancelled. The managed fixture failures
came from incorrectly escaped new report fields in generated mock scripts; the
compaction assertion still required an obsolete recovery-counter file. The batch
was interrupted after the repeated fixture error. Original output is retained in
`affected-tests.log`; `compaction-diagnostic.log` retains the isolated assertion.

After correcting those test inputs, five failed/changed selectors pass in
`failed-selectors.log`. Re-run the queue and supervisor files because their shared
generated client scripts changed; retain the passing source-loop and recovery
results and unaffected compaction checks from the first run. No production source
changed after the passing build/package check.

Queue/supervisor run: 51 passed, 1 failed, 0 skipped. All orchestration and queue
checks passed. The remaining assertion expected checked boxes to clear/re-arm the
same STUCK attention incident. Corrected it to one deduplicated alert until a
HEALTHY review, and added explicit healthy-review state clearing to the retained
legacy-state migration test. Re-run only these two changed selectors.

Final corrected selectors: 2 passed, 0 failed, 0 skipped. Across the affected files, 86 distinct test outcomes pass with 0 unresolved failures, using compatible retained evidence in `test-results.json`. The interrupted file-level cancellation is superseded by the completed queue/supervisor run; original failures remain in their logs.

Build and package inspection passed. Whitespace passed before final documentation edits and will receive one final check. No full suite or live inference was run. Prepared reviews prove scheduling and report validation, not semantic accuracy of a live supervisor. Input hashes are retained in `inputs.json`.

Final whitespace check passed. No task-owned browser, web server or test subprocess remained. Removed inactive reproducible build output `/Users/bpstr/.codex/worktrees/failed-attempt-loops/roadmap-runner/dist` (184320 allocated bytes), plus the temporary dependency symlink (target preserved) and a redundant local diff snapshot. Preserved source, all failed/passing test logs and qualification records. Data-volume free space after cleanup: 38728093696 bytes (36.1 GiB). No unrelated project caches or live-runner processes were changed. This session created less than 1 MiB of artifacts; the lower free-space condition predates its small footprint.

The staged check also inspected newly added console logs and flagged their original trailing spaces/blank lines. Exact original logs are preserved in `raw-logs.tar.gz`; plain-text copies normalize only that whitespace. No test evidence was discarded. The final source-and-evidence whitespace check passed.
