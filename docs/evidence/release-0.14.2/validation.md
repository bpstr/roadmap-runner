# GitHub release 0.14.2

Scope: issue #21 and PR #22, worker-context read-only MCP initialization.
GitHub release only; no npm publication or installed-runner update.

Validation plan and retained evidence:

- Reproduce both new worker protocol regressions against origin/main before the fix; require two failures. Observed: legacy and modern initialization timed out (2 failed, 0 passed).
- Run only the affected MCP/authorization selectors on the fixed PR: `worker (modern|legacy) MCP|prepared (modern|legacy) MCP (tools|event)|control rejects unauthenticated ownership` in `test/agent-integration.test.js`. Observed: 7 passed, 0 failed/cancelled/skipped, about 10 seconds on Node 26.4.0. This covers reads, denied direct controls, controller behavior, subscriptions and direct manager guards.
- Exercise installed Grok 1.0.70 using `grok --trust mcp doctor rr21-worker --json`, with an isolated project registration and nonempty ROADMAP_WORKER_CONTEXT. The unfixed CLI fails at initialize; the fixed CLI completes protocol 2025-11-25 initialization and discovers exactly two tools. Trust applies only to the temporary diagnostic workspace. No model request is made.
- Preserve passing PR CI run 41815844387: six Node 20/22/24 Linux/macOS jobs. Version/changelog/evidence changes do not invalidate runtime regression evidence.
- Run `npm run check:package` for final version 0.14.2, plus whitespace/version consistency checks. Completion requires exit 0 and matching package/lock versions.
- Await the explicit `.github/workflows/ci.yml` release gate at the release commit: six Linux/macOS Node 20/22/24 jobs run the full prepared suite and package checks. This gate justifies hosted full-suite execution; no local full-suite run is required.
- Package the checked source with scripts disabled; attach its tarball, SHA-256 and release-validation.json to v0.14.2 at the checked commit.

All inference tests use prepared fixtures. No credentials, paid inference, live dogfood or provider-quality claims. Full local logs: /tmp/rr21-evidence/.

Release preparation results (2026-11-04): package check passed for @bpstr/roadmap-runner@0.14.2 (92 files, 225,865 packed bytes), including extracted version/help and saved monitor configuration/outbox preservation. Grok doctor also passed against version 0.14.2 (one healthy server, zero failures, handshake OK, two tools). Package and lock versions match; whitespace check passed. Hosted release CI and artifact hashes are recorded in the attached release-validation.json.
