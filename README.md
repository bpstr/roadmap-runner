# Roadmap Runner

A deliberately small loop for working through a Markdown implementation roadmap
with fresh Codex sessions.

Each run:

1. reads the roadmap and current workspace,
2. chooses one coherent unfinished batch,
3. implements and verifies it,
4. updates the roadmap,
5. exits.

The shell then starts a completely fresh Codex session. Context is reconstructed
from the filesystem instead of growing one long-running agent conversation.

There is no coordinator, task database, plugin, daemon, detached supervisor,
lockfile, retry protocol, subagent pool, or Git-repository assumption.

## Requirements

- Bash
- Codex CLI installed and authenticated
- GNU `timeout`
  - Linux usually provides `timeout`
  - macOS: `brew install coreutils` provides `gtimeout`

## Usage

Run from the workspace Codex should operate in:

```sh
cd /path/to/workspace
bash /path/to/roadmap-runner/roadmap-runner.sh path/to/roadmap.md
```

The current directory from `pwd` is always used as the Codex working directory.
The roadmap can be relative to that directory or an absolute path.

Example:

```sh
cd /path/to/workspace

bash /path/to/roadmap-runner/roadmap-runner.sh \\
  docs/roadmap.md
```

The workspace may contain multiple Git repositories. Roadmap Runner does not try
to discover or select a repository root.

## Completion

The worker maintains one simple status line in the roadmap:

```md
Status: IN_PROGRESS
```

When the entire roadmap is implemented and verified:

```md
Status: COMPLETE
```

The shell stops when it sees `Status: COMPLETE`.

## Fresh sessions

Every iteration starts a new ephemeral `codex exec` invocation. Sessions are not
resumed. The roadmap, code, tests, diffs, and other files are the persistent
context between iterations.

Workers are explicitly instructed to select one bounded coherent batch and stop
after it. Subagents are prohibited so one iteration does not turn into a large
multi-hour agent tree.

## Runtime limit

Each Codex invocation has a two-hour hard limit by default:

```sh
ROADMAP_TIMEOUT=2h bash roadmap-runner.sh roadmap.md
```

Change it if needed:

```sh
ROADMAP_TIMEOUT=45m bash roadmap-runner.sh roadmap.md
ROADMAP_TIMEOUT=3h bash roadmap-runner.sh roadmap.md
```

A timeout ends that Codex invocation and starts a fresh session from the current
filesystem state. Other non-zero Codex exits stop the runner instead of retrying
forever.

## Codex configuration

The runner intentionally does **not** force an approval policy. In particular it
does not set `approval_policy=never`, because that can prevent configured MCP
tools from requesting the approvals they need.

The worker uses:

```text
codex exec
--sandbox workspace-write
--skip-git-repo-check
--ephemeral
--cd "$(pwd)"
```

Your existing Codex/MCP configuration remains responsible for approvals and tool
access.

Optional overrides:

```sh
ROADMAP_MODEL=<model> \
ROADMAP_EFFORT=high \
bash roadmap-runner.sh roadmap.md
```

The Codex executable itself can also be overridden:

```sh
ROADMAP_CODEX=/path/to/codex bash roadmap-runner.sh roadmap.md
```

## Philosophy

Roadmap Runner intentionally delegates semantic decisions to Codex.

The shell only:

- starts fresh workers,
- imposes a runtime ceiling,
- checks the completion marker,
- stops on unexpected CLI errors.

It does not parse roadmap tasks, generate task IDs, maintain hidden state, create
commits, choose repositories, or coordinate agents.

The intended loop is simply:

```text
roadmap + current filesystem
        ↓
fresh Codex
        ↓
one coherent implementation batch
        ↓
tests + roadmap update
        ↓
exit
        ↓
fresh Codex
        ↓
...
        ↓
Status: COMPLETE
```
