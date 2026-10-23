Compact the active handoff for the next fresh worker session.

Work on this implementation roadmap:

{{ROADMAP}}

Tracking file (progress / delivery evidence):

{{PROGRESS_FILE}}

Tracking mode: ROADMAP_CHECKBOXES

1. Read the current handoff. Runner context supplies an immutable pre-compaction
   snapshot, the history index and a directory for detailed evidence.
2. Keep the current active gate, next action, unresolved blockers and retry
   conditions, outstanding validation/release gates, and latest supervisor target.
   Keep the opening status exactly as it was. Do not implement, run tests, edit
   the roadmap, change checkboxes or declare completion during this session.
3. Move detailed completed-task evidence, older failures and deferred-gate
   explanations into evidence files by task ID, or link to the supplied snapshot
   and its relevant heading. Preserve original criteria and evidence without
   weakening them. Reference existing files instead of copying them again.
   Keep concrete pointers for unresolved obligations and retained passing checks
   so the next worker can retrieve proof without rerunning unchanged checks.
4. Replace the handoff with the compact current state and those pointers. Measure
   its UTF-8 byte size and meet the target in Runner context. If it cannot fit
   without losing required state or usable references, explain the blocker and
   stop. The runner checks the size before starting further implementation.

Read a specific historical snapshot or evidence file when current state is
ambiguous. Keep archive files and the runner-owned history index unchanged.
Print a short summary of the size reduction and evidence locations, then stop.
