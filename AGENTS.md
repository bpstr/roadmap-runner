# Design constraints

Keep this runner Bash-only, with standard Unix tools. No Python, jq, framework,
Markdown parser, task registry, model coordinator, multi-worker mode or worktrees.
The shell manages processes and interprets one-word results. The worker understands
and validates roadmap work. In the supplied roadmap change only existing checkbox
states; never add metadata, progress blocks, delivery records or evidence notes.
Use one persistent process-state file under the global Codex home. Do not introduce
per-task recovery files. Partial code/diffs and existing checkboxes are the context.

Test with `bash tests/supervisor-test.sh`. Use only the fake Codex fixture; never
invoke paid/live models, provider APIs or authenticated CLI sessions in tests/CI
without explicit spending authorization. Do not claim fixture tests prove model
compliance, semantic completion, sandbox security or desktop lifecycle behavior.

Keep plugin versions aligned. Use clear imperative commit titles without dotted
prefixes. Do not merge the alternative Python-based draft into this design.
