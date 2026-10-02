# JSON output

`--json` prints one JSON value on stdout (two-space indented). Shapes differ by
command; the ones scripts read most:

- `bb status`:
  `{project: {id, name} | null, thread: {id, status, title, projectId, parentThreadId, environmentId, …, environment} | null, childThreads: [{id, status, title}] | null, pendingTodos, pluginsNeedingAttention: [{id, status}], dataDir, serverUrl}`
- `bb thread spawn`: the created thread,
  `{id, status, title, projectId, environmentId, parentThreadId, …}`
- `bb thread show`: `{thread, environment, pendingTodos}`. Thread fields are
  under `.thread`.
- `bb thread list`: a bare array of threads; `--count` gives `{count}`.
- `bb thread tell`:
  `{threadId, ok, delivery: "sent" | "queued", queuedMessage?, mode}`
- `bb thread wait`: `{threadId, matched: true, target}`
- `bb thread output`: `{output}`, `null` when the thread has not answered yet.
- `bb thread log --json`: a bare array of raw events
  `{id, seq, type, createdAt, threadId, scope, data}`, oldest first. Page with
  `--after-seq <seq>`.
- `bb thread archive`: `{ok, threadId, archivedThreadIds}`
- `bb thread stop`, `unarchive`, `compact`, `clear`, `delete`: `{ok, threadId}`
- `bb thread update`, `pin`, `unpin`, `read`, `unread`: the thread.
- `bb thread search`: `{active: {total, results}, archived: {total, results}}`
- `bb project list`, `bb machine list`, `bb env list`, `bb provider list`,
  `bb provider models`: bare arrays.
- `bb terminal create`: the session,
  `{id, title, status, exitCode, cols, rows, …}`
- `bb terminal list`: `{sessions: […]}`
- `bb terminal output`:
  `{chunks: [{seq, dataBase64}], nextSeq, truncated, status, exitCode, closeReason}`.
  `status` is `"exited"` once the command has finished.
- `bb terminal wait`: `{terminalId, matched, nextSeq, exitCode}`
- `bb plugin list`: `{plugins: […]}`

## Failures

```json
{
  "ok": false,
  "error": { "code": "thread_not_found", "message": "…", "hint": "…" }
}
```

The envelope goes to stdout, the readable message to stderr. `hint` is present
only when bb has one. Codes from the CLI itself: `unknown_command`,
`unknown_option`, `missing_required`, `unexpected_argument`, `invalid_value`,
`timeout`, `unreachable`, `terminal_exited`, `server_unreachable`, `cancelled`.
Every other code comes from the server.

## Exit codes

- 0: success.
- 1: any other failure.
- 2: `bb thread wait` timed out.
- 3: `bb thread wait` was given an invalid request.
- 4: `bb thread wait`: the thread failed and cannot reach the status by waiting.
- 124: `bb terminal wait`: the terminal exited, or the wait timed out, before a
  match.

A plugin command exits with the code its plugin returned.
