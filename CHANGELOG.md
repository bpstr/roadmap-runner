# Changelog

## 0.10.0 — 2026-10-13

- Add FIFO roadmap queues with automatic handoff after successful completion. Use repeated `--queue` flags when starting, the `queue` command to append to an active run, or MCP `roadmap_enqueue`.
- Preserve one run ID, workspace reservation and event cursor across handoffs, with separate progress/history for each roadmap. Expose queue states in status and leave later entries pending after stop or failure.

## 0.9.0 — 2026-10-12

- Alert on a current supervisor `Health: STUCK` report or two consecutive workers with unchanged progress. Persist one alert per stagnation episode across restarts; clear it when progress or the source revision changes.
- Apply the 128 KiB context limit to source roadmaps as well as progress files. Sources between 128 and 512 KiB that older versions accepted now require manual compaction before starting or resuming. Files are preserved on rejection.
- Request progress compaction at 96 KiB before the next worker or supervisor proceeds. Preserve requirements, checkbox states, blockers and current evidence references; keep archived snapshots as cold history.
- Distinguish stuck and blocked desktop messages. Explain how to install the macOS notification backend, and avoid treating failed notification submissions as successfully delivered.

Validation uses prepared clients and mocked notification transports. It does not establish live provider quality or Notification Center display permissions.
