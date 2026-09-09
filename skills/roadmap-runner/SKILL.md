---
name: roadmap-runner
description: Execute a long repository roadmap through fresh sequential Codex workers, using a token-free shell supervisor and restart-safe progress in the source file. Use when asked to run or continue roadmap implementation.
---

# Roadmap Runner

Read [references/procedure.md](references/procedure.md) before starting a roadmap.

For unattended local execution, run `scripts/run-roadmap.sh` with the roadmap's absolute path from the repository workspace.

The script starts fresh `gpt-5.6-sol` workers serially and consumes no coordinator-model tokens between runs. Existing roadmap checkboxes are the queue: each worker reconciles the checklist and current diff, completes at most one small batch, validates it, checks off proven work, and adds concise evidence with the shell run ID to the existing delivery record. Do not create a parallel execution-state block or ledger.

Treat a request to run or continue a roadmap as authorization for bounded local worker runs while preserving narrower approval, external-mutation, deployment, publication, destructive-operation, paid-inference, and product-decision gates.

Report the log directory and terminal status. Distinguish local completion from full roadmap completion.
