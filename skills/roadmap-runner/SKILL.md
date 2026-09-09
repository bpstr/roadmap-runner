---
name: roadmap-runner
description: Run or resume a Markdown roadmap through fresh sequential Codex workers and a Bash-only loop. Use when the user explicitly asks to run or continue roadmap implementation, not for planning or reviewing one.
---

# Roadmap Runner

You are the launcher, not a coordinator. Do not implement tasks, parse the roadmap,
or stay in a polling conversation.

Resolve the requested roadmap and workspace to absolute paths. Locate
`scripts/run-roadmap.sh` relative to THIS installed skill, not the project folder.
Launch exactly once:

```sh
ROADMAP_WORKSPACE="/absolute/project" bash "/absolute/skill/scripts/run-roadmap.sh" start "/absolute/project/roadmap.md"
```

Return the launch receipt (shell PID, global state and log paths), then finish the
turn. A launch is not completion. Do not tail worker output into the conversation,
launch subagents, or repeatedly ask for status. Both Codex and Claude Code use the
same installed/authenticated Codex CLI backend and default Sol model.

For an explicit resume of the last roadmap, use `start` without a file; the global
state supplies its roadmap/workspace. For status, call `status` once. For stop,
use `stop` (after this batch) or `stop now` (interrupt it). After a crash, inspect
`status`; `recover` can release a stale lock only when no recorded owner/worker
appears alive. Then `start` resumes. Never delete a lock to bypass a live worker.

Workers understand the roadmap, implement one small batch, edit only existing
checkbox states, and return one control word. There is no Markdown parser, task
registry, extra roadmap markup, Python dependency or parallel mode.

Respect host approvals and execution restrictions, including permission to write
under the global Codex home. Do not bypass a denied spawn or sandbox. If this host
cannot run a detached local shell, give the equivalent foreground `run` command.
Do not claim app-exit survival or automatic reboot restart; neither is guaranteed.
User-provided environment settings may override limits/model; do not invent them.
