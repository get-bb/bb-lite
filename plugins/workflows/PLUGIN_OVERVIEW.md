# Workflows

Durable multi-agent workflows. Off by default.

An agent starts a run with the `bb_workflow_run` tool (or `bb workflows run`),
passing a `script`, a `scriptPath` inside the workspace, or the `name` of
`.bb/workflows/<name>.js`. The script
begins with `export const meta = { name, description, phases }` and uses
`agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `budget()` and the
`args` global. Scripts run in a QuickJS sandbox (memory, stack and synchronous
time limits; no `eval`, `Function`, `Date` or `Math.random`, so a run replays
deterministically). Each `agent()` call creates a hidden worker thread
(`origin: "plugin"`) in the origin thread's environment and waits for it to go
idle; its last assistant text is the call's result. With `agent(prompt, { schema })` the worker is offered
`bb_workflow_result`; the value is checked against a restricted JSON Schema
subset (Ajv), with two corrective turns before the call fails. `meta.inputSchema`
and `meta.outputSchema` check `args` and the run's result.

Runs and their ordered agent calls are stored in the plugin's own database.
When the plugin starts, queued and running runs are evaluated again from the
beginning: finished calls return their stored result, a call whose worker is
still running is waited on again, and the rest run live. `resumeRunId` reuses
the unchanged prefix of a finished run the same way. A message is sent to the
origin thread when a run ends.

CLI: `bb workflows run`, `bb workflows validate`, `bb workflows status <run-id>`, `bb workflows history <run-id> --cursor
--limit` (JSONL), `bb workflows list`, `bb workflows stop <run-id>`.

App: the `::workflow-preview{run}` directive renders live progress in chat, a
composer banner lists the thread's active runs, and the `workflow-run` side
panel shows one run's calls and result. Each can stop a run.
