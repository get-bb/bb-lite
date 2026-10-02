# Threads

A thread's status is one of `pending` (created, first message not sent yet),
`starting` (its workspace is being prepared), `active` (a turn is running),
`idle` (waiting for a message), `stopping`, or `error` (the last turn failed; a
new message resumes it).

## Start a thread

```sh
# a child in my own workspace, parented to me
bb thread spawn --project "$BB_PROJECT_ID" --parent-self \
  --environment "$BB_ENVIRONMENT_ID" --provider codex --model <model> \
  --reasoning-level high --permission-mode accept-edits \
  --title "Fix the flaky test" --prompt "…" --json        # → the thread; .id

# in a fresh worktree on another machine, prompt from a file
bb thread spawn --project <proj> --machine <id-or-name> \
  --new-environment worktree --base-branch origin/main --parent-self \
  --provider claude-code --prompt-file brief.md
```

- `--project` is required. An omitted provider or model falls back to the
  project's remembered choice, then the default; an omitted permission mode is
  inherited from the parent thread.
- Where it runs: `--environment <env id>` reuses an environment;
  `--environment <path>` runs in an existing directory;
  `--new-environment worktree|checkout|personal` creates one (`--base-branch`
  only with `worktree`); `--machine` picks the machine. With none of these the
  server picks the project's default.
- `--file` / `--image` attach files. An absolute path on this machine is
  uploaded to the server first.
- `--send-at 10m` (or an ISO time) schedules the first message; the thread
  stays `pending` until then.
- `--visibility hidden` keeps a helper thread out of the sidebar.
- When the parent is the calling thread, bb prints "You will be notified when
  this thread is done." The parent then receives a `[bb system]` message
  naming each child whose turn ended, so it does not have to wait.

## Message a thread

```sh
bb thread tell <thr> "…" [--mode steer|queue|auto] [--message-file path|-]
```

- `steer` (default): add the message to the running turn; start a turn when the
  thread is idle.
- `queue`: wait for the running turn to finish, then send.
- `auto`: steer a running turn, otherwise start one.

`tell` never fails because the thread is busy: the message joins the queue and
the answer says why it waits (`delivery: "queued"`, `queuedMessage.waitingOn`).
Sent from inside a thread, the message is marked as coming from that thread.
`bb thread queue list|send|delete <thr>` inspects and edits a thread's queue.

## Wait and read

```sh
bb thread wait <thr> --status idle --timeout 25m --poll-interval 5s --json
bb thread output <thr>                 # final assistant message of the last turn
bb thread show <thr> --json            # .thread.status, .environment.path
bb thread log <thr> [--limit N | --all] [--format minimal|verbose|json]
bb thread log <thr> --json --after-seq <seq>      # raw events, oldest first
```

`wait` exits 0 when the target is reached, 2 on timeout, 3 when the request is
invalid, 4 when the thread is in `error` and will not become idle by waiting.
`--event <type>` waits for an event type instead of a status.

## Approvals and questions

```sh
bb thread interactions list <thr>
bb thread interactions resolve <pint> <thr> --approve | --deny
bb thread interactions resolve <pint> <thr> --grant session
bb thread interactions resolve <pint> <thr> --answer <question>=<value>
bb thread interactions resolve <pint> <thr> --value '<json>'   # plugin form
```

## Housekeeping

```sh
bb thread list --parent-thread <thr> --include-hidden --json
bb thread update --self --section <sec> --title "…"
bb thread stop <thr>          # interrupt the turn, release the agent
bb thread archive --self      # also archives child threads
bb thread compact|clear <thr> # compact or clear the model context
bb thread pin|unpin|read|unread <thr>
bb thread section list|create|rename|delete
bb thread search "<words>"
bb thread open [thr] [path] [--line N]   # show a thread or file in the app
```
