# bb in one page

bb runs coding agents (Codex, Claude Code) as **threads**. One **server**
process owns all state and serves the web UI. The `bb` CLI talks to that server
over HTTP and can do everything the UI can. Agents running inside bb threads use
the same CLI to start, message and read other threads.

| Thing       | What it is                                                                                                                  | ID prefix |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- | --------- |
| Project     | A codebase. It has one source directory per machine. `proj_personal` is the built-in project for work outside any codebase. | `proj_`   |
| Thread      | One conversation with one agent. It has a status, a timeline of events, and at most one parent thread.                      | `thr_`    |
| Environment | The directory a thread works in on a machine: the project checkout, a git worktree bb manages, or a personal workspace.     | `env_`    |
| Machine     | A computer that runs agents. The server's own machine always exists; others join with `bb runner`.                          | `host_`   |
| Provider    | An agent backend (`codex`, `claude-code`) with its models.                                                                  |           |
| Plugin      | A directory that adds server features, UI and `bb <name>` commands.                                                         |           |

## Where the CLI points

- `BB_SERVER_URL` selects the server. Default: `http://127.0.0.1:48886`.
- The server keeps its data in `~/.bb-lite` (`BB_DATA_DIR`).
- `bb server` runs the server in the foreground; `bb server status` checks it.

## Inside a thread

Every agent process started by bb has these variables set:

| Variable            | Meaning                                                         |
| ------------------- | --------------------------------------------------------------- |
| `BB_THREAD_ID`      | This thread. `--self` and `--parent-self` read it.              |
| `BB_PROJECT_ID`     | This thread's project. Pass it as `--project "$BB_PROJECT_ID"`. |
| `BB_ENVIRONMENT_ID` | This thread's environment.                                      |
| `BB_THREAD_STORAGE` | A scratch directory that belongs to this thread.                |
| `BB_SERVER_URL`     | The server (on another machine: a local proxy to it).           |
| `BB_CLI`            | The absolute path of the matching `bb`.                         |

`bb status` prints the current project, thread, environment and child threads.

## Output and errors

- Every command takes `--json`. Use it whenever a later step reads the output.
- With `--json` a failure prints
  `{"ok": false, "error": {"code", "message", "hint"?}}` on stdout, a readable
  message on stderr, and exits non-zero. Parse stdout only.
- Pass long or multi-line text from a file: `--prompt-file`, `--message-file`
  (`-` reads stdin). Inside double quotes the shell runs backticks and `$(...)`
  before bb sees them.
- Durations are seconds or carry a unit: `90s`, `20m`, `4h`.
- Destructive commands ask for confirmation on a terminal and need `--yes`
  everywhere else.
- Refer to a thread in a message as `@thread:thr_abc123`; the UI renders it as a
  link.

## More

`bb guide threads`, `bb guide environments`, `bb guide machines`,
`bb guide people`, `bb guide plugins`, `bb guide json`, and
`bb guide commands [group]` for every command with its flags.
`bb <command> --help` shows one command.
