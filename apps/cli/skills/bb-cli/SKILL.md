---
name: bb-cli
description: "Inspect or manage BB state with the bb CLI; use for BB commands and configuration."
---

# BB CLI

`bb` reads and changes everything in bb: threads, projects, environments,
machines, terminals, files, settings and plugins. Inside a bb thread it is on
`PATH` and already points at the right server.

## Start with context

```sh
bb status --json     # .project.id, .thread.id, .thread.environment, .childThreads
```

`BB_THREAD_ID`, `BB_PROJECT_ID`, `BB_ENVIRONMENT_ID` and `BB_THREAD_STORAGE`
describe the thread you are running in. `--self` means "this thread".

## Rules that prevent most mistakes

- Add `--json` whenever a later step reads the output; parse stdout only. A
  failure prints `{"ok": false, "error": {"code", "message", "hint"?}}` on
  stdout and exits non-zero.
- Read the whole error before running `--help`: it names the nearest command or
  flag and, for a missing ID, the value to add.
- Pass long or multi-line text from a file: `--prompt-file <path>`,
  `--message-file <path>` (`-` reads stdin). Inside double quotes the shell runs
  backticks and `$(...)` before bb sees the text.
- Timeouts take seconds or a unit: `90s`, `20m`, `4h`.
- Destructive commands need `--yes` when there is no terminal.
- Do not spawn threads or message other threads unless the user asked for it.
- Mention a thread to the user as `@thread:thr_abc123`, never as a URL.

## Recipes

```sh
# spawn a child in my workspace, parented to me (I am notified when it is done)
bb thread spawn --project "$BB_PROJECT_ID" --parent-self \
  --environment "$BB_ENVIRONMENT_ID" --provider codex --model <model> \
  --reasoning-level high --permission-mode accept-edits \
  --title "…" --prompt-file brief.md --json            # → .id

# …or in a fresh worktree on a machine
bb thread spawn --project <proj> --machine <id-or-name> \
  --new-environment worktree --base-branch origin/main --parent-self \
  --provider claude-code --prompt "…"

# message a thread (never fails because it is busy: the message queues)
bb thread tell <thr> "…" [--mode steer|queue|auto] [--message-file path|-] --json

# wait for it and read the result
bb thread wait <thr> --status idle --timeout 25m --poll-interval 5s --json
#   exit 2 = timeout, 3 = invalid request, 4 = it failed and will not go idle
bb thread output <thr>                 # final message of its last turn
bb thread show <thr> --json            # .thread.status, .environment.path
bb thread log <thr> --limit 5          # recent turns; --all, --format verbose
bb thread log <thr> --json --after-seq <seq>     # raw events

# housekeeping
bb thread list --parent-thread "$BB_THREAD_ID" --include-hidden --json
bb thread update --self --section <sec> --json
bb thread stop <thr>
bb thread archive --self

# a long-running command
bb terminal create --thread "$BB_THREAD_ID" --title dev --command "pnpm dev" --json
bb terminal wait <term> --contains "ready" --timeout 60s    # exit 124 if not
bb terminal output <term> --tail-bytes 4000
bb terminal close <term>

# another machine
bb machine list --json
bb provider models codex --machine <id-or-name> --json
bb file read /abs/path --machine <id-or-name>
```

## Find the rest

- `bb guide` explains the concepts; `bb guide threads`, `environments`,
  `machines`, `plugins` and `json` cover one area each.
- `bb guide commands [group]` lists every command with its flags;
  `bb <command> --help` shows one.
- Plugins add top-level commands such as `bb tasks`. `bb plugin list` shows
  which exist; `bb <name> --help` is answered by the plugin, and its own skill
  documents it.
