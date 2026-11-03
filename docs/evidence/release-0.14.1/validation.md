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
