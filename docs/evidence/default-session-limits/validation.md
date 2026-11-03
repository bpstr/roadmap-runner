# Default session limits

Decision: use the requester's 120-minute session ceiling, with the existing
checkpoint reserve leaving 115 minutes for implementation and affected checks.
The requester doubled the initially implemented 60-minute default and emphasized
graceful stops and proper handoffs. This is a policy choice, not a measured token-cost
optimum. Explicit CLI/environment/MCP timeouts still override the default.
Automatic roadmap continuation and cumulative progress-review settings are retained;
the session ceiling is not a total roadmap time or token cap. Existing runs retain
their saved options.

Validation plan:

- Build TypeScript for the managed-start schema. No dependency installation.
- Run the existing `progress budgets have finite defaults and CLI values override
  the environment` case in `test/runner.test.js` for defaults and precedence.
- Run `CLI and managed schema carry the finite authority without changing token
  options` in `test/execution-reset.test.js` for managed defaults and overrides.
- Run the existing checkpoint timing case in `test/checkpoint-ack.test.js`, including
  the parsed default's 115-minute soft deadline and retained explicit finite budgets.
- Run `soft deadline saves exact mock handoff before hard timeout and preserves
  unfinished source` in `test/execution-reset.test.js` for the affected shutdown path.
- Check CLI help, current default references and whitespace.

These selectors cover both entry points and checkpoint behavior; unrelated adapter,
monitor, recovery and application suites are unnecessary for a timeout default.
Use prepared local executables only. No provider calls or credentials.

Completion requires the build and all selected cases to pass, matching help/docs,
and no unexplained diff-check failures. Full logs belong in
`/tmp/roadmap-runner-default-session-limits/`.

Initial 60-minute results (2026-11-03; superseded default):

- `npm run build`: passed.
- The four named cases ran together: 4 passed, 0 failed/cancelled/skipped,
  approximately 4.7 seconds. Existing override and finite-budget cases passed.
- CLI help advertises `Default: 60m`. No former six-hour default references remain
  in current README, CLI, runtime source or tests; historical changelogs are retained.
- `git diff --check`: passed. Pre-existing Git-management changes were preserved.

Hygiene: no browser or web server was started; no session fixture process remains.
Other active roadmap workers/browser tests belong to separate tasks and were left
running. Data volume has about 15 GiB free. Touched compiled output is 300 KiB,
validation artifacts are below 300 KiB, and evidence is 4 KiB; no substantial inactive
reproducible artifacts were created. Removed paths: none; reclaimed space: 0 bytes.
Shared build output and validation evidence were retained. No cleanup outside this
session was attempted.

120-minute follow-up validation plan:

- Rebuild the changed managed schema and repeat only the three default/schema/timing
  selectors; their changed inputs invalidate the corresponding 60-minute evidence.
- Retain the passing prepared soft-deadline handoff-save case: its shutdown logic
  and fixture inputs are unchanged.
- The new explicit graceful-handoff requirement adds the two prepared checkpoint
  acknowledgment cases (worker exits voluntarily; acknowledgment at exit) and the
  two timeout descendant-cleanup cases in `test/runner-regressions.test.js`.
- Check updated help/docs and whitespace. No full-suite gate applies.

Follow-up logs use `/tmp/roadmap-runner-default-session-limits/120m/`.

120-minute results (2026-11-03): build passed; all seven selected cases passed
(0 failed/cancelled/skipped, about 5.6 seconds). The parsed default checkpoints at
115 minutes, CLI and MCP default to `120m`, and explicit overrides remain valid.
Prepared workers acknowledge and exit voluntarily without premature termination;
last-moment acknowledgments are retained. Both timeout fixtures verify SIGTERM
handling, descendant cleanup and no writes after shutdown. The earlier handoff-save
case remains compatible passing evidence. No live long-session/provider run occurred.
Help/docs and `git diff --check` passed. Corrected README's shutdown grace to the
existing three seconds; runtime signal behavior was unchanged.

Follow-up hygiene: no browser/server started and no fixture processes remain.
Only small build output and evidence/logs were touched; no cleanup candidates were
created, no paths removed, 0 bytes reclaimed. Data volume has about 18 GiB free.
