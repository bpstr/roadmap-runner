# Periodic delivery supervision

A separate fresh-context supervisor runs after every **five successful or timed-out
workers**, before starting the next worker. It reads their output and delivery
evidence, diagnoses progress, and may revise the next delivery batch. This is an
iteration-driven checkpoint inside the existing CLI, not a timer, daemon or
parallel implementation agent.

## Usage

```sh
roadmap-runner docs/roadmap.md --progress-file docs/delivery-evidence.md
# Five workers per review is already the default. Explicit equivalent:
roadmap-runner docs/roadmap.md --progress-file docs/delivery-evidence.md \
  --supervisor-every 5 --supervisor-timeout 10m
# Disable reviews:
roadmap-runner docs/roadmap.md --supervisor-every 0
```

`ROADMAP_SUPERVISOR_EVERY` and `ROADMAP_SUPERVISOR_TIMEOUT` supply environment
defaults; explicit options win. The interval accepts integers from 0 to 20 to
bound the review window. The supervisor uses the selected client, executable,
model and effort through the existing adapter. It adds a model session at each
checkpoint; it is not a free deterministic progress classifier.

## Scheduling contract

```text
workers 1–5 -> supervisor -> workers 6–10 -> supervisor -> worker 11 -> ...
```

Successful no-op sessions count; that is one of the cases the review should catch.
Timed-out workers count after their shutdown finishes. Recognized capacity-only
failures do not count, but their count is included in the review evidence.
Supervisors never consume worker iteration numbers. Consequently, worker attempt
numbers in the terminal can exceed the counted work sessions when capacity retries
occur. Ordinary fatal failures and user cancellation still stop execution.

The selected tracking file's terminal status takes precedence: if worker 5 writes
COMPLETE or BLOCKED, the runner exits without launching a review. A three-task
smoke test still takes three workers and no supervisor. This is not a final
independent acceptance gate.

The cadence/window starts fresh on each invocation of `roadmap-runner`; it is not
reconstructed from model-written iteration history. Existing progress, review
notes and next delivery targets remain in the tracking file across restarts.

## What the supervisor inspects

Each worker record includes its attempt number, start time, elapsed milliseconds,
prompt revision, exit code/signal, timeout/interruption outcome, stdout/stderr
excerpts, and before/after tracking snapshots and hashes. Elapsed time covers the
whole worker call, including shutdown when applicable; it is not a fabricated
measurement of coding time. Hash equality is only a signal, not proof of no work.

The supervisor also reads the original roadmap, current files and verification
receipts, and the previous review. Its prompt looks for repeated rediscovery,
unchanged failures, unaddressed dependencies, early exits after narrow tests,
endless child-task splitting, and divergence between claimed and observed work.
Useful prerequisites and long integration tasks can advance without closing a
parent checkbox. Missing or truncated evidence must be reported as uncertainty.

## Permitted delivery-target changes

The **next batch target** may change; the **original requirements and acceptance
bar may not**. The supervisor can propose a better decomposition, reorder ready
work, focus on repairing a prerequisite, or change the proof strategy within the
same original gate. It records the old target, new target, evidence, expected
next-run result, verification artifact and fallback. Healthy work stays stable.

For example, after repeated component-only checks fail to advance a required
transport integration gate, the next target can become “compose the canonical
transport harness and produce receipt A1.” It cannot redefine that gate as
“component tests pass,” check it as done, or quietly drop the integration boundary.

The tracking file receives a compact Supervisor review with health
`HEALTHY / SLOW / STUCK / UNCERTAIN`, covered iteration numbers, diagnosis,
previous intervention result and the next delivery target. Current handoff / Batch
plan and dated history are updated for the next worker. The worker prompt asks
it to consume that review and test its next-run expectation.

One stuck gate is not a global block. The supervisor must consider other useful
authorized work before setting BLOCKED. It must not complete implementation tasks
or set COMPLETE; the runner rejects a supervisor-written COMPLETE in the current
invocation. A unique Review ID must be persisted before the checkpoint succeeds.
That ID verifies that a handoff was written, not that its reasoning is correct.

## Output retention and privacy

The runner keeps only the last N worker records. Each stdout/stderr excerpt keeps
at most 16 KiB of input bytes (head + tail); each tracking snapshot keeps 8 KiB.
`omittedBytes` makes truncation explicit. Codex capture includes raw JSON events,
not only the terminal's filtered agent messages. Other adapters are captured while
continuing to stream to the terminal. No growing transcript is passed in argv.

The bounded `recent-runs.json` and latest `supervisor-output.json` live in a unique
`roadmap-runner-review-*` directory under the OS temporary directory, outside the
repository. The evidence path is printed at review time. Files use owner-only
permissions on POSIX and are overwritten rather than appended throughout a run.
They are retained for diagnosis after exit; OS temporary-directory cleanup or
manual removal controls lifetime across separate runner invocations.

**Outputs are not redacted.** They can contain source code, paths, credentials or
other sensitive tool output. The supervisor can read these files through the same
selected coding-agent client. Do not publish or commit them as public evidence
without inspection. Truncation is a resource bound, not a privacy filter.

## Failure and authority boundaries

The review has its own timeout (default 10 minutes), plus a three-second shutdown
grace. Ctrl-C and repeated-interrupt handling reuse the normal process lifecycle.
Recognized Codex capacity failures retry the same review using the existing bounded
capacity settings, not another worker. A fatal review failure, timeout, exhausted
retry budget, missing Review ID, or source-integrity failure stops the runner.
This does not automatically label the roadmap BLOCKED. Inspect any partial handoff
before restarting; files are not silently restored.

In preserved-source mode the same source-integrity checks run before and after
supervisor attempts. The prompt permits only progress/handoff/evidence edits,
not application changes, deployment or new spending. The adapters still retain
their existing approval-free permissions: this is **not an OS write sandbox** or
an independent semantic acceptance validator.

The automated suite uses local mock executables to test cadence, output capture,
retargeted handoff consumption, failures, cancellation and integrity. It does not
establish live-model diagnosis quality or overnight delivery reliability.
