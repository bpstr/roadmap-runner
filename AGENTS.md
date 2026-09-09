# Working agreement

Keep the runner deterministic and single-worker. No coordinator LLM, orchestration
framework, service, database, automatic commits, parallel workers, or worktrees.
The shell owns repetition; Python standard-library helpers own filesystem safety,
process lifetime, validation, and recovery. Runtime code stays inside the skill.

Test with `python3 -m unittest discover -s tests -v`. Tests MUST use the fake Codex
fixture only. Never invoke an authenticated provider, paid AI API, live Codex CLI,
or Claude Code model during development/CI without explicit spending approval.
Do not install credentials or add secrets to CI. Do not weaken tests to pass.

Keep task selection, receipt validation, stop/cancellation, lock ownership,
checkpoint replay and spending boundaries covered by offline tests. Preserve
existing file bytes except accepted checkbox characters. Never execute commands
from worker receipts. Do not advertise exactly-once execution, semantic proof,
hard token/dollar limits, or guaranteed desktop-host survival.

Use clear imperative commit subjects without dotted prefixes. Bump all manifests
and runner VERSION together when shipping a new plugin version.
