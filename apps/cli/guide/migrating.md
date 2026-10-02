# Moving from an original bb install

This build keeps its data in its own directory (`~/.bb-150k`, or `BB_DATA_DIR`)
and never opens an original data directory in place. `bb import-legacy` copies
what carries over.

```sh
bb import-legacy --from ~/.bb --dry-run     # counts per --threads choice
bb import-legacy --from ~/.bb               # unarchived threads + families
bb import-legacy --from ~/.bb --threads all # archived threads too
bb import-legacy --from ~/.bb --threads none --json
```

Stop this build's server first (the command refuses while one answers on the
configured port for the same data directory), import, then start it again.
`BB_DATA_DIR` selects the target, exactly as for `bb server`.

## What is copied

- Projects, their paths per machine and remembered provider/model defaults.
- Machines. The old server's own machine becomes this server's machine; every
  other machine arrives offline and without a credential. Re-join each with
  `bb machine reconnect <name>` (it keeps its ID, so its threads stay attached).
- Sections, and the sidebar preferences that hold their order.
- Threads chosen by `--threads`: `active` (default) is every unarchived thread
  plus all of its ancestors and descendants, `all` adds the archived rest,
  `none` copies no thread. Deleted threads are never copied. Title, parent,
  section, pin, read state and timestamps are kept. A thread that was running is
  imported idle, an open approval or question is imported as interrupted, and
  queued messages are dropped.
- Each thread's events, prompt history and search text. Streaming deltas of
  completed items are dropped except the first, as this build does on write.
- The provider session ID of each thread, so the next message resumes the same
  Codex or Claude Code session. Do not continue one thread from both installs.
- Environments used by the copied threads, at their existing paths. A directory
  that is gone shows as missing.
- General settings, theme and favicon colour, keybinding overrides, disabled
  providers and UI preferences. Custom theme directories are not carried over:
  a custom theme selection falls back to the default palette.

Not copied: plugin data (tasks, account pool accounts, secrets), automations,
attachments, terminals, right-panel tabs, machine credentials, provider logins.

## Worktrees stay where they are, and are never removed

A worktree or personal workspace the old install created is imported as a
plain directory: this build runs threads in it but does not retire or delete
it, even after its threads are archived. Both installs can therefore run side
by side without one removing the other's directories; remove leftovers by hand
once the old install is gone. An environment the old install had already
removed is restored under this build's own data directory on the next message.

## Running it again

Rows are matched on their ID and existing ones are left alone, so a second run
only adds what is new: more threads after `--threads none`, or threads created
in the old install since. A thread that already has events here is skipped
whole; its newer events in the old install are not merged.

## What happens to the old directory

`bb.db` is opened read-only with `query_only` on: nothing is migrated,
checkpointed or written to the database or its `-wal`. SQLite itself maintains
the small `-shm` index for any reader of a WAL database: if the old server is
stopped and shut down cleanly, an empty `bb.db-wal` and a `bb.db-shm` appear
next to the database and are removed the next time the old server opens and
closes it. Point `--from` at a copy of the directory to leave the original
byte-for-byte untouched.
