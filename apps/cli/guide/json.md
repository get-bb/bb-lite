# JSON output

`--json` prints one JSON value on stdout (two-space indented). Shapes differ by
command; the ones scripts read most:

| Command | Shape |
|---|---|
| `bb status` | `{project: {id, name} \| null, thread: {id, status, title, projectId, parentThreadId, environmentId, …, environment} \| null, childThreads: [{id, status, title}] \| null, pendingTodos, pluginsNeedingAttention: [{id, status}], dataDir, serverUrl}` |
| `bb thread spawn` | the created thread: `{id, status, title, projectId, environmentId, parentThreadId, …}` |
| `bb thread show` | `{thread, environment, pendingTodos}`: thread fields are under `.thread` |
| `bb thread list` | bare array of threads; `--count` gives `{count}` |
| `bb thread tell` | `{threadId, ok, delivery: "sent" \| "queued", queuedMessage?, mode}` |
| `bb thread wait` | `{threadId, matched: true, target}` |
| `bb thread output` | `{output}` (`null` when the thread has not answered yet) |
| `bb thread log --json` | bare array of raw events `{id, seq, type, createdAt, threadId, scope, data}`, oldest first; page with `--after-seq <seq>` |
| `bb thread archive` | `{ok, threadId, archivedThreadIds}` |
| `bb thread stop`, `unarchive`, `compact`, `clear`, `delete` | `{ok, threadId}` |
| `bb thread update`, `pin`, `unpin`, `read`, `unread` | the thread |
| `bb thread search` | `{active: {total, results}, archived: {total, results}}` |
| `bb project list`, `bb machine list`, `bb env list` | bare arrays |
| `bb provider list`, `bb provider models` | bare arrays |
| `bb terminal create` | the session `{id, title, status, exitCode, cols, rows, …}` |
| `bb terminal list` | `{sessions: […]}` |
| `bb terminal output` | `{chunks: [{seq, dataBase64}], nextSeq, truncated, status, exitCode, closeReason}`; `status` is `"exited"` once the command has finished |
| `bb terminal wait` | `{terminalId, matched, nextSeq, exitCode}` |
| `bb plugin list` | `{plugins: […]}` |

## Failures

```json
{ "ok": false, "error": { "code": "thread_not_found", "message": "…", "hint": "…" } }
```

The envelope goes to stdout, the readable message to stderr. `hint` is present
only when bb has one. Codes from the CLI itself: `unknown_command`,
`unknown_option`, `missing_required`, `unexpected_argument`, `invalid_value`,
`timeout`, `unreachable`, `terminal_exited`, `server_unreachable`, `cancelled`.
Every other code comes from the server.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Any other failure |
| 2 | `bb thread wait` timed out |
| 3 | `bb thread wait` was given an invalid request |
| 4 | `bb thread wait`: the thread cannot reach the status by waiting |
| 124 | `bb terminal wait`: the terminal exited, or the wait timed out, before a match |

A plugin command exits with the code its plugin returned.
