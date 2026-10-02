# Tasks

Tasks is a Linear-style tracker inside bb for planning work, dispatching it to
agents, and keeping the task record connected to the threads doing the work.
It provides projects, task keys, statuses and priorities, labels, subtasks,
Markdown comments, attachments, dispatch presets, and the `bb tasks` CLI.

Tasks is built in: it adds the Tasks sidebar panel, a **Task** panel inside
threads, the `::task{key="ABC-12"}` message card, the `@` task mention, the
`bb tasks` command, and a skill that teaches workers to report back to tasks.

## Quick start

Create a tracker project with **New project** in the Tasks navigation tab and
link it to the bb project where dispatched agents will run. Labels are created
under **Manage**. Then:

```sh
bb tasks create \
  --project PROD \
  --title "Ship task dispatch" \
  --description "Implement the flow and run focused validation." \
  --priority high

bb tasks list --project PROD
bb tasks show PROD-1
bb tasks preset set "Codex high" --provider codex --model gpt-5.6-sol \
  --reasoning high --permission auto
bb tasks dispatch PROD-1 --preset "Codex high"
```

When the CLI runs inside a linked bb project, `create` and `list` infer the
tracker project, so `--project` can be omitted. Task keys are case-insensitive.

The comment composer has a **Notify last responding agent** switch. When the
task has an agent reply, leave it on to send the new comment to the thread that
wrote the latest reply, resuming it when idle. Agents and scripts get the same
behavior with `bb tasks comment PROD-1 --body "New context" --notify`.

## CLI reference

Run `bb tasks --help` or `bb tasks <command> --help` for exact options. Unknown
options and stray arguments are errors. A failing command run with `--json`
prints `{ "ok": false, "error": { "code", "message", "hint"? } }` on stdout.

`--project` takes a tracker project prefix or id such as `PROD`, never a bb
project id (`proj_...`). Repeatable options (`--label`, `--status`,
`--priority`, `--add-label`, `--remove-label`) also accept one comma-separated
list. Long text can be piped with `--description-stdin` and `--body-stdin`.

| Command                                      | Purpose                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| `bb tasks status`                            | Show the Tasks plugin name and version.                                            |
| `bb tasks project list`                      | List tracker projects with their prefixes and linked bb projects.                  |
| `bb tasks create`                            | Create a task with description, status, priority, labels, and optional `--parent`. |
| `bb tasks list`                              | Filter tasks by project, status, priority, label, active agents, or search text.   |
| `bb tasks show <key-or-id>` (alias `get`)    | Show the task with comments, attachments, subtasks, and attached threads.          |
| `bb tasks update <key-or-id>`                | Update title, description, status, priority, parent, or labels.                    |
| `bb tasks comment <key-or-id>`               | Add a Markdown comment; `--notify` delivers it to the latest responding agent.     |
| `bb tasks attachment add <key-or-comment>`   | Attach `--file` to a task or comment.                                              |
| `bb tasks attachment get <attachment-id>`    | Save an attachment to `--out`.                                                     |
| `bb tasks preset list`                       | List dispatch presets.                                                             |
| `bb tasks preset set <name>`                 | Create or update a dispatch preset; `--delete` removes it.                         |
| `bb tasks dispatch <key>` (alias `delegate`) | Start a new agent thread from `--preset` and attach it to the task.                |
| `bb tasks attach <key-or-id>`                | Attach the current thread (or `--thread <id>`) to a task.                          |
| `bb tasks detach <key-or-id>`                | Detach the current thread (or `--thread <id>`) from a task.                        |
| `bb tasks threads <key>`                     | List the threads attached to a task.                                               |

Statuses are `backlog`, `todo`, `in_progress`, `in_review`, `done`, and
`canceled`. Priorities are `urgent`, `high`, `medium`, `low`, and `none`.

Inside a thread, `--file` and `--out` paths are on the thread's machine, must be
inside the thread's workspace, and are limited to 512 KiB. Outside a thread they
are on the server machine and limited to 25 MB.

## Dispatch and presets

A preset sets the provider, model, reasoning level, optional service tier,
permission mode, environment, and reusable instructions. Presets are managed
with `bb tasks preset list|set`; the task page offers them in its dispatch
menu.

Dispatch creates a worker thread in the linked bb project, attaches it to the
task, and moves a `backlog` or `todo` task to `in_progress`. The worker
receives the task description, subtasks, attachments, recent comments, preset
instructions, and a report-back contract. Thread lifecycle events keep the
link's status current on the task page.

## Task mentions

Type `@` in the bb composer and pick a task by key or title. Sending the
mention gives the agent the task's description, status, priority, labels,
subtasks, attachments, recent comments, and the CLI action contract. Tasks
linked to the current bb project rank first.

Task references in descriptions and comments are stored in Markdown as
`[PROD-1](bbtask://PROD-1)`.

## Data

Everything lives in the plugin's data directory: `data.db` (SQLite) and
`blobs/` (attachment files). The schema still carries columns for folders, due
dates, and key aliases from earlier versions; they are left untouched.
