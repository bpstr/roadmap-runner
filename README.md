# Roadmap Runner

Roadmap Runner executes a repository roadmap through fresh, sequential Codex workers. A Bash supervisor waits between runs, so there is no model-backed coordinator consuming context or tokens for the lifetime of the roadmap.

The roadmap remains the source of truth. Existing checkboxes are the queue, workers check off only validated work, and concise run evidence is written to the roadmap's existing item notes or delivery record. Local transcripts are retained for recovery and debugging.

## Install

```bash
codex plugin marketplace add bpstr/roadmap-runner
codex plugin add roadmap-runner@roadmap-runner
```

Start a new Codex task after installation so the bundled skill is loaded.

## Run

From the repository that owns the roadmap:

```bash
/path/to/installed/plugin/skills/roadmap-runner/scripts/run-roadmap.sh \
  /absolute/path/to/roadmap.md
```

The script uses `gpt-5.6-sol` by default. It starts one `codex exec` process per batch, stops at local or full completion, and fails closed on malformed worker status. It requires Bash, Codex, and standard Unix tools; Python and `jq` are not required.

Optional environment variables:

- `ROADMAP_WORKSPACE`: repository workspace; defaults to the current directory.
- `ROADMAP_MODEL`: Codex worker model; defaults to `gpt-5.6-sol`.
- `ROADMAP_MAX_RUNS`: maximum worker processes; defaults to `100`.
- `ROADMAP_MAX_FAILURES`: consecutive retryable failures; defaults to `2`.
- `ROADMAP_CODEX_BIN`: Codex executable; defaults to `codex`.

The supervisor prints its log directory at startup. Create the displayed `STOP` file to stop cleanly between workers.

## Safety boundary

The default worker prompt authorizes local implementation and deterministic local validation only. It excludes pushes, pull requests, hosted CI, publication, deployment, production mutation, production credentials, and paid or live provider calls unless the repository instructions and user explicitly authorize a broader workflow.
