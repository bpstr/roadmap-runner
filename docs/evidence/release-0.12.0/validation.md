# PR 9 review and 0.12.0 validation

Base review head: 8307b60237a1aa59c163e1a8b329d52fc174d148.

Retained evidence: GitHub CI at that head passed prepared tests and package checks
on Node 20, 22 and 24 on Ubuntu and macOS. No paid inference is authorized or run.

Changed behavior: Codex continuation defaults on through CLI and MCP, other
adapters remain fresh, explicit opt-out is preserved, and completion clears the
saved conversation before advancing the queue. Limits remain four turns and
65,536 cumulative observed input tokens; scope changes and unknown usage start
fresh. Package and lockfile target 0.12.0.

Selected checks: TypeScript build; continuation, runtime continuity, optional
memory, CLI runner, queue and managed-run tests; npm tarball contract. Completion
requires all affected checks passing, package version/help matching 0.12.0,
passing required GitHub checks, and no whitespace errors. Unchanged PR test
results are retained rather than rerunning the full suite locally. Updated GitHub
CI follows the existing workflow gate; its full matrix is required by that
workflow, not an additional local validation run.

Logs are retained at /tmp/roadmap-runner-pr9-release-0120/.

Initial affected run: 35 passed, 1 failed, 0 skipped. The failure showed repeated
warnings after an optional state write failure; a persistence-failure latch fixes
that without retrying an unusable state path. Initial log is preserved.

Dependency widening: npm audit identified GHSA-mrhx-c7xc-m3w5 in pinned Zod
4.3.6. Updated to 4.6.7 (audit: zero vulnerabilities). This invalidates schema and
managed-run evidence, so rerun queue and agent-integration tests. The lifecycle
persistence fix also requires rerunning optional-memory and runtime continuity
checks. Previously passing standalone CLI and selector tests remain reusable.

Final affected checks: 47 passed, 0 failed, 0 skipped (25.5 seconds), covering
optional memory failures, runtime continuation and opt-out, queue resets, and MCP
agent integration. Initial standalone continuation/CLI checks passed and remain
compatible. TypeScript build passed. npm package check passed: 73 files, 165,553
packed bytes, version/help 0.12.0, no development/private files. npm audit after
the Zod update reported 0 vulnerabilities. git diff --check passed. Local Codex
resume help confirms explicit session IDs and the adapter flags; no inference ran.

## Review findings resolved

- Codex continuation was opt-in through both CLI and MCP despite the requested
  default. Both now enable bounded reuse; explicit opt-out and other adapters
  are covered.
- Completed roadmaps retained continuation.json. Completion now removes this
  optional state before queue advancement; opting out also clears saved state.
  Unwritable state paths fall back to fresh sessions with one warning.
- The inherited Zod 4.3.6 pin had GHSA-mrhx-c7xc-m3w5. Version 4.6.7 removes the
  advisory, with the affected MCP/managed-run tests passing.

## Complexity assessment

The feature serves a CLI runner's concrete need to retain the next task action
and avoid repeating unchanged checks. Shared task parsing, bounded packets and
explicit provider IDs have concrete consumers. RCR: 4/10; no speculative
framework or new dependency was introduced. No additional vanity finding was
substantiated. Maintenance debt is not measured; no hours estimate is claimed.

Operational criteria: fall back to fresh sessions on unknown usage, failed
state persistence, role/scope changes or exhausted four-turn/65,536-input-token
budgets; release the active pointer at roadmap completion. Review regressions
if unrelated task context resumes or hot packets exceed 8 KiB. Preserve cold
evidence and avoid adding abstractions without multiple consumers, dependencies
without a concrete need, or architecture changes without considering a simpler
implementation. These criteria use existing deterministic controls, with no paid
benchmark or new monitoring system. The remaining question for later real usage
is whether bounded reuse reduces repeated discovery enough to retain it.
