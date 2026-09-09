---
name: roadmap-runner
description: Run or continue a Markdown implementation roadmap in small, fresh Codex Sol batches. Use only when the user explicitly requests roadmap-runner execution with a roadmap file, not for planning, summarizing, or reviewing a roadmap.
---

# Roadmap Runner

This skill is a launcher, NOT the implementation agent or a long-running manager.
Both Codex and Claude Code launch the same Codex CLI worker backend. Claude Code
must also have a locally installed, authenticated `codex` CLI.

1. Resolve the user-provided roadmap and the intended Git worktree. A relative
   roadmap path is relative to the repository root. Never assume the plugin's
   installation directory is the target project. If no file was provided, ask
   for the file. Do not read the entire roadmap or implement any tasks yourself.
2. Locate `scripts/roadmap-runner.sh` relative to THIS installed `SKILL.md`.
   Claude may supply `${CLAUDE_SKILL_DIR}`; otherwise use the skill file's actual
   absolute location. Do not guess a cache path or use the current directory.
3. Run one shell command, quoting each path as a separate argument:
   `bash <skill-directory>/scripts/roadmap-runner.sh start <roadmap.md> --repo <repo-root>`
   Pass additional limits, verification command, context files or model/effort
   only when explicitly supplied by the user. Default: `gpt-5.6-sol`, medium,
   batch size 3, one worker, workspace-write sandbox, shell network disabled.
4. Return the launch receipt (PID, state and log paths) and finish this turn.
   "Launched" is not "completed". Do not repeatedly poll, tail worker output into
   the chat, call subagents, run a watcher agent, or promise ongoing monitoring.
   The shell itself launches the next fresh worker after the previous one exits.

The host must permit local process execution. Respect its approvals and sandbox;
do not bypass restrictions or automatically add `--allow-network`. If detachment
is restricted by the host, report the limitation and provide the equivalent
foreground `run` command for the user's own terminal. Do not claim that closing
the desktop application or suspending the computer is guaranteed to keep it alive.

For an explicit status request, call `status <roadmap> --repo <root>` once. For
stop, call `stop` (finish this batch) or `stop --now` (interrupt it). For an explicit
resume, call `start` again with the same options: Markdown plus local recovery
artifacts determine what remains. Run options are not implicitly inherited from
an earlier launch. For a preview request, use `preview`; it never invokes Codex.

Never launch a second runner in the same worktree. Shared-worktree parallelism is
research-only in v0.1.0. Never delete the lock file, reset Git, delete recovery
state, or mark tasks complete to bypass a blocked runner.
