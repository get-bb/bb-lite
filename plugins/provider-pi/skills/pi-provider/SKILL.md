---
name: pi-provider
description: "Inspect BB Pi provider support for message editing and context compaction."
---

# Pi provider

Pi compacts a thread's context automatically when it fills; the thread then
shows a compacted-context item, or a warning when Pi skipped compaction.
Manual compaction (`bb thread compact`) and editing or rerunning earlier user
messages are not supported for Pi threads yet. Inspect the thread first and use
live command help for arguments.

Use the target host's provider catalog for available models and execution options.
