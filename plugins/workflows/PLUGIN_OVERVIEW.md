# Workflows

Durable multi-agent workflows. Off by default.

An agent starts a run with the `bb_workflow_run` tool, passing a script that
begins with `export const meta = { name, description, phases }` and uses
`agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `budget()` and the
`args` global. Each `agent()` call creates a hidden worker thread
(`origin: "plugin"`) in the origin thread's environment and waits for it to go
idle; its last assistant text is the call's result.

Runs and their ordered agent calls are stored in the plugin's own database.
When the plugin starts, queued and running runs are evaluated again from the
beginning: finished calls return their stored result, a call whose worker is
still running is waited on again, and the rest run live. `resumeRunId` reuses
the unchanged prefix of a finished run the same way. A message is sent to the
origin thread when a run ends.

CLI: `bb workflows status <run-id>`, `bb workflows history <run-id> --cursor
--limit` (JSONL), `bb workflows list`, `bb workflows stop <run-id>`.
