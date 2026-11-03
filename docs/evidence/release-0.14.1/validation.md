# GitHub release 0.14.1

Scope: the user-requested 120-minute session default and existing prepared Git
management changes, plus the committed stopped-runner attention and shared-workspace
evidence fixes since v0.13.1. GitHub release only; npm publication is outside scope.

Retained compatible evidence:

- `../default-session-limits/validation.md`: build and seven focused cases pass
  for the 120-minute default, 115-minute checkpoint, acknowledgment and timeout
  cleanup; the earlier handoff-save case remains compatible. No runtime inputs
  changed after these checks.
- `../release-0.14.0/validation.md`: six Git-management checks and two task
  continuation cases pass. The changed version and timeout do not invalidate
  these explicit-timeout fixtures. Preserve this record under its original name.

Release validation plan:

- Run `npm run check:package` because the version, default timeout/help and package
  checker changed since the prior package validation. It rebuilds TypeScript,
  checks the extracted CLI including `Default: 120m`, and preserves saved monitor
  configuration. Completion requires exit 0 for version 0.14.1.
- Check whitespace, commit the exact release changes and push main.
- Await the existing `.github/workflows/ci.yml` release gate: six Linux/macOS jobs
  on Node 20/22/24 run the complete prepared suite and package checks. This explicit
  CI gate requires the broad run; do not duplicate it with a local full suite.
- Package the unchanged checked source with scripts disabled, attach its tarball,
  SHA-256 and validation record, then publish tag/release v0.14.1 at the checked SHA.

All automated inference remains prepared/mocked; no paid provider calls or live
dogfood. Local logs and release artifacts: `/tmp/roadmap-runner-release-0.14.1/`.

Local results (2026-11-03): `npm run check:package` passed for
`@bpstr/roadmap-runner@0.14.1`: 92 files, 225,582 packed bytes. Extracted version,
120-minute help, Git-management help and monitor saved-state checks passed.
`git diff --check` passed. Retained focused results above remain applicable.

CI follow-up: run 41720785657 at 66bc30e passed Linux Node 20/22/24
(461 passed, 3 skipped each) and macOS Node 24 (464 passed), including package
checks. macOS Node 20/22 initially could not acquire hosted runners; check-run
annotations explicitly report macOS ARM capacity constraints. Retried only these
infrastructure failures, preserving all passing jobs and original annotations.

The Node 20 retry exposed a prepared test race: a 200 ms timeout can kill the child
before it appends its dispatch counter. Both checks are dispatched, but that counter
is not a reliable observation. The test now requires two distinct durable timeout
receipts with `reused: false`; runtime behavior is unchanged. Preserve the failed
log `ci-job-126221106198.log`. Validate only this case locally. The next push still
triggers the explicit six-job CI workflow; do not add a local full-suite run.
All other focused results and the package check remain compatible: only this test
and the excluded evidence document changed.

Focused receipt-race result: 1 passed, 0 failed/cancelled/skipped in about one second.
