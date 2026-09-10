# Changelog

## 0.2.1 — 2026-09-10

Classify unchanged sandbox and validation-environment denials as blocked, not
retryable implementation failures. Preflight relevant validation prerequisites,
preserve partial code/unchecked acceptance, and keep diagnostics in the log.
Add a no-model version command, installed-versus-running version/path diagnostics,
and explicit blocked-stop messaging. Keep the same sandbox, one-word protocol,
Bash-only runtime and single global process record. Add offline regression fixtures
and upgrade/disposable-database troubleshooting. No blanket sandbox bypass.

## 0.2.0 — 2026-09-09

Simplify the shell-first runner: one-word worker responses, checkbox-only roadmap
edits, no Markdown parsing, one global process-state file, launch-and-return,
no-path resume, bounded retry/timeout, and explicit stale-lock recovery. Add Claude
Code packaging and Bash-only offline tests. No Python or parallel execution.

Stop v0.1 supervisors before upgrading; v0.2 uses a new global lock location.
