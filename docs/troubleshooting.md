# Sandbox-blocked validation and stale installations

## Identify the runner that actually executed

A report containing `RR-...` run IDs, per-project `.codex/roadmap-runs/<id>` logs,
`local_complete`, or a six-line `retryable=yes` result comes from the legacy
protocol. It may be an old cached install or a process launched before an update.
It does not prove what is installed now. Version 0.2 uses a global state/log and
one-word results; version 0.2.1 adds explicit installed/run version diagnostics.

Locate the script relative to the installed skill, not an unrelated Git clone:

```sh
RUNNER=/actual/installed/skill/scripts/run-roadmap.sh
bash "$RUNNER" version
bash "$RUNNER" status
```

`version` prints `roadmap-runner 0.2.1` and the exact script path without starting
Codex or writing run state. `status` prints the inspected `installed_version` and
`installed_script` separately from the saved run's `version` and `script`. Older
state may not have the latter fields. Launch receipts and log run boundaries also
identify the executable version. `--version` is an alias for `version`.

Stop and confirm exit of any legacy supervisor/worker before upgrading. Its lock
is separate from the v0.2 global lock. Preserve its logs and partial code; do not
blindly remove locks, reset the checkout, or remove existing roadmap text. Update
the installed plugin using the host's supported plugin update/reinstall flow,
refresh its marketplace as needed, then start a new task. Verify the actual script
again. Pulling a source checkout alone does not update a cached plugin [1]. No
running process hot-reloads this update. Do not delete the entire Codex home.

On the first launch after moving from v0.1, supply the absolute roadmap and workspace:

```sh
ROADMAP_WORKSPACE=/absolute/project bash "$RUNNER" start /absolute/project/roadmap.md
```

There is no importer for old per-project state. Code, checkboxes, and the old log
remain available for deliberate inspection. After a v0.2 run, `start` without a path
uses the saved reference, but it does not remove an unresolved environment blocker.

## Why PostgreSQL can block a batch

The runner explicitly uses `workspace-write`, approval policy `never`, and shell
network disabled. A desktop launcher with broader permissions does not remove
these child CLI settings. `never` means the worker does not ask for escalation;
it does not mean approve everything. A child can also inherit restrictions from
the host. Codex uses OS sandbox enforcement, including Seatbelt on macOS [2][3].

If PostgreSQL is denied a required System V shared-memory/semaphore operation,
another fresh worker with the same permissions cannot repair that by retrying.
Changing `shared_memory_type` is not a general solution: PostgreSQL normally uses
anonymous mmap for its large shared area while still allocating a small System V
segment; non-Linux platforms may also use System V semaphores [4]. An OS permission
denial is different from resource exhaustion or a SQL/assertion failure. Inspect
the actual diagnostic before attributing every PostgreSQL failure to the sandbox.

For the reported migration 00169 case, the migration and code can be present while
the migration acceptance test remains unexecuted. Compilation, vet, unit tests and
diff checks do not establish that migration criterion. Its checkbox must remain
open until the required test passes against the correct disposable database.

## Correct behavior

Check the relevant validation prerequisites before substantial implementation,
using the project's existing harness and authorized disposable resources. If the
required capability is denied, retain partial code and leave the dependent
checkbox unchecked. Put the attempted command (redact credentials), diagnostic,
roadmap reference and missing prerequisite in a concise log message.

Finish genuinely independent ready work when possible; do not repeatedly select
the blocked task. Once no independent local work remains, return `blocked` and
stop with exit 75, without consuming the retry budget. `retry` remains appropriate
for partial implementation that can progress with existing permissions. Do not
report `local` merely because an essential local test cannot run. SQL bugs and
failed assertions should still be investigated, not automatically labelled blocked.

Classification belongs to the worker. The shell does not parse Markdown or grep
transcripts for PostgreSQL errors. It still stops a nonzero CLI exit as `failed`
without automatic retries. The new instructions are not proof that every live model
will choose the correct word; offline tests only establish the process contract.

## Unblock the actual validation

The patch does not grant OS permissions. Use the existing test harness in an
operator-approved environment that supports the required database operations. For
one narrowly supervised check, an interactive Codex session supports per-command
approval [2]:

```sh
codex --cd /absolute/project --sandbox workspace-write --ask-for-approval on-request
```

Ask it to run only the pending disposable-database/migration validation, preserve
existing code, and request approval for the exact local command when necessary.
Review that request; do not grant unrestricted execution or approve a production
connection. If the host or managed policy denies it, stop and obtain an approved
test environment rather than changing flags or routes to evade the denial.

After a passing check, verify that its evidence matches the current implementation
and the full acceptance criterion. Then resume the roadmap. For future unattended
runs, establish the required disposable test environment in advance and verify
that the intended worker can use it. A running external database is not sufficient
when its socket/network transport is still disallowed. No host-side executor,
automatic permission escalation, Docker-socket fallback, or test skipping is added
by this release.

## References

[1] [OpenAI plugin packaging and installed caches](https://developers.openai.com/plugins/build/plugins).

[2] [Codex approvals and OS sandbox behavior](https://learn.chatgpt.com/docs/agent-approvals-security).

[3] [Codex non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode).

[4] [PostgreSQL 17: kernel resources and shared memory](https://www.postgresql.org/docs/17/kernel-resources.html).

Checked 2026-09-10. The user's local database, logs and native plugin installation
were not available for live verification; tests use fake subprocesses only.
