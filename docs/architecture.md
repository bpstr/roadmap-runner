# Architecture and platform qualification

Version 0.1.0 — reviewed 2026-09-09.

## Contract

The plugin is just a launcher. A Bash `while` loop is the sole scheduler. A Python
standard-library helper handles reliable JSON, task-list parsing, `flock`, process
groups, bounded disk logs and atomic file replacement. It is not an agent. Both
host plugins deliberately use Codex CLI workers; no Claude worker adapter exists.
There is one process implementing tasks at a time, in the original worktree.

The implementation's command shape is:

```sh
codex --ask-for-approval never exec \
  --model gpt-5.6-sol --sandbox workspace-write \
  -c 'model_reasoning_effort="medium"' \
  -c 'features.multi_agent=false' \
  -c 'sandbox_workspace_write.network_access=false' \
  --ephemeral --json --color never --cd /target/repo \
  --output-schema /plugin/result.schema.json \
  --output-last-message /target/repo/.roadmap-runner/.../result.json -
```

The prompt arrives on stdin, not through shell interpolation. Paths/model IDs
are argv elements. Only an explicitly user-supplied `--verify` string is executed
through `/bin/sh -c`. Reported test commands are NEVER treated as runnable input.

## State protocol

1. Acquire the Git worktree's persistent lock inode, without deleting it.
2. Read Markdown; select at most N ready tasks in one section and parent group.
3. Reserve the attempt and pending directory in atomic state BEFORE artifact
   creation. A crash here cannot produce an unrecoverable directory-name collision.
4. Write original Markdown and bounded prompt. Launch a fresh worker; preserve
   stdout/stderr directly to files rather than feeding a manager conversation.
5. Record process exit. Validate the final receipt's fields, lengths, allowed
   status, ordered task-ID prefix and reported checks.
6. Run the original batch's optional independent verification gate. It remains
   attached to a pending batch even when a resume command omits `--verify`.
7. Write an acceptance journal with before/after Markdown checksums and usage.
8. Replace the roadmap atomically, changing only accepted checkbox characters.
9. Atomically clear pending state, update counters and retain a bounded handoff.
10. The shell starts its next iteration. No LLM decides whether to invoke itself.

On restart, accepted journals are replayable before OR after Markdown replacement.
Current Markdown must match the expected before or after bytes. A trustworthy
completed process with a result can be validated/reverified; incomplete attempts
leave tasks unchecked and pass a partial-work warning to a new worker. Corrupt
state fails closed. No checkpoint deletes or rewinds code.

The state and logs are not immutable audit evidence against a malicious local
process. The same user runs the worker and runner. Prompt constraints complement,
not replace, process sandboxing, host permissions and repository trust.

## Stop conditions

All supported checkboxes checked; explicit stop; worker blocker/needs_split;
provider/auth/model failure; malformed result; roadmap drift; timeout; log growth;
maximum attempts; repeated no progress/verification failures; configured reported
token boundary reached or token accounting missing. Provider failures are not
retried endlessly. A fresh explicit launch acknowledges a paused run and permits
a bounded retry without discarding partial work.

## Desktop feasibility

A local skill can start an allowed shell command and return the launch receipt.
The detached shell can keep starting CLI workers without a central conversation.
This is different from recursively asking the desktop agent to supervise each
batch. Whether an app permits that spawn and whether app exit preserves child
processes depends on its actual host lifecycle, permissions, and execution mode.
`start_new_session` detaches a Unix session; it is not a promise that a host cannot
kill the process tree or container. The foreground terminal route is independent
of the app's conversation lifetime. No desktop lifecycle claim has been live-tested
for this release.

There is no automatic startup service, remote agent, or scheduled task. Reboot
recovery means rerunning the command and reconciling disk state, not continuing
inference while the machine is powered off.

## Cost model

Zero model calls for scheduling. Nonzero usage for every worker, including its
fresh initial context and code exploration. System instructions, enabled MCP/tool
definitions, and repository instructions can still be repeated. Small related
batches are a tradeoff between local context reuse and recovery granularity.
No percentage reduction is claimed without a like-for-like measured benchmark.
An idle tool wait is not continuous inference billing.

`turn.completed` usage is accumulated from streamed JSONL. Input already includes
cached input; output already includes any reasoning subcategory. Token limits act
at the next-launch boundary, not as a hard in-flight monetary cap. User/account
provider limits remain outside this runner's control. Missing usage is observable,
not silently represented as known zero cost.

## Qualification checklist

The offline suite covers shell sequencing, nested/duplicate tasks, Markdown byte
preservation, bounded context, result rejection, explicit retry, verification
success/failure, retained recovery gates, token boundaries/missing accounting,
large event lines, worktree exclusivity, shell termination, timeout, detached
launch, recursive-launch rejection, stopped/damaged inputs and checkpoint replay.
It does not prove that Sol follows prompts, that arbitrary target tests are good,
or that a native plugin host accepts installation on a user's specific build.

Before relying on an unattended production roadmap: install on the intended host,
preview a small disposable roadmap, run one authorized live batch with a meaningful
verification command, exercise graceful/immediate stop, interrupt/restart once,
and inspect token usage. This smoke test is intentionally not performed by CI.

## Primary references

Verified from official documentation on 2026-09-09; installed versions may differ.

- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode):
  `exec`, stdin, ephemeral sessions, JSONL events, structured output and auth reuse.
- [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli):
  model, sandbox, approval, output and configuration flags.
- [Current model identifiers](https://learn.chatgpt.com/docs/models):
  `gpt-5.6-sol` and reasoning-effort controls. Availability depends on the account.
- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins):
  portable root manifest, compatibility overlay, repo marketplaces and cached installs.
- [Codex skills](https://learn.chatgpt.com/docs/build-skills):
  `.agents/skills`, shared skill format and symlinked local discovery.
- [Claude Code plugins](https://code.claude.com/docs/en/plugins) and
  [marketplaces](https://code.claude.com/docs/en/plugin-marketplaces): manifest,
  directory loading, marketplace install and namespaced skill invocation.
- [Python file locking](https://docs.python.org/3/library/fcntl.html):
  exclusive nonblocking advisory locks for cooperating local processes.
