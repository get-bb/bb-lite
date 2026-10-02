Dispatch presets are user-defined; Tasks ships with none. Before dispatching
work, run `bb tasks preset list` and create a preset if the required one does
not exist. Dispatch requires an existing preset.

`preset set <name>` creates the preset, or updates the one with that name. A new
preset needs `--provider`, `--model`, `--reasoning`, and `--permission`:

```sh
bb tasks preset set "Codex high" --provider codex \
  --model gpt-5.6-sol --reasoning high --service-tier fast \
  --permission auto
```

Optional flags: `--service-tier default|fast|none` (`none` clears it),
`--environment project-default|worktree` with `--base-branch` and `--machine`,
and `--instructions` for text added to every dispatch. `--delete` removes the
preset.

Dispatch a task to a new worker thread. The task's tracker project must be
linked to a bb project:

```sh
bb tasks dispatch ABC-12 --preset "Codex high" \
  --instructions "Only touch the parser."
```

The new thread is attached to the task, and a `backlog` or `todo` task moves
to `in_progress`.
