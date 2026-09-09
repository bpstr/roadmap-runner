# Changelog

## 0.2.0 — 2026-09-09

Simplify the shell-first runner: one-word worker responses, checkbox-only roadmap
edits, no Markdown parsing, one global process-state file, launch-and-return,
no-path resume, bounded retry/timeout, and explicit stale-lock recovery. Add Claude
Code packaging and Bash-only offline tests. No Python or parallel execution.

Stop v0.1 supervisors before upgrading; v0.2 uses a new global lock location.
