# Release 0.13.0 validation

Scope: publish the optional private Roadmap Monitor integration from `2d6d682`, complete monitor configuration help and enable/disable controls, preserve saved settings after malformed probes, and release the package as 0.13.0. Protocol remains v1.

Validation plan: run the package check first (including its TypeScript prepack build), then only monitor unit and prepared foreground/detached/queue integration selectors. Capture those integration envelopes and validate them against the companion monitor's actual v1 parser. Package checks cover shipped reporter files, stdin configuration via the integration CLI, masked status, saved identity/configuration/outbox preservation, and enable/disable behavior. Completion requires all selected checks and whitespace validation to pass.

Retained evidence: the monitor's `docs/validation.md` records 43 passing task-selection and queue-deferral checks for the existing reporter integration. Scheduling, prompts, provider transports, and recovery rules have not changed in this release batch, so those results remain compatible. No local full-suite rerun is justified. The runner's existing CI workflow explicitly requires the full prepared suite and package check across Node 20/22/24 and Linux/macOS for each main push/PR; that hosted gate must pass before publication.

All workers and network responses in local checks are deterministic fixtures. No AI provider calls, paid inference, real monitor credentials, or real run registration are used. Full logs and captured synthetic reports are retained in `/tmp/roadmap-runner-release-0.13.0-evidence`.

Local results: package check passed (92 files, 222,081 packed bytes), including the TypeScript build, packaged CLI configuration controls and preservation checks. Monitor selectors passed 11/11, with zero failures or skips; the actual CLI accepted a stdin key, saved private configuration with 0600/0700 permissions and returned masked diagnostics. The monitor repository's actual `parseEnvelope` accepted all 20 captured envelopes (17 reports and three probes) for three runs; every report declared runner 0.13.0 and protocol v1. Foreground/detached runs used one prepared worker each, the two-roadmap queue used two, and no provider child received the monitor key. Whitespace validation passed.

Publication prerequisites: GitHub authentication is available. npm's saved authentication returned HTTP 401; npm publication requires refreshed authentication. CI and hosted release results will be recorded after the release commit is pushed.
