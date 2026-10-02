# Plugins

A plugin is a directory whose `package.json` has a `bb` field (`name`,
`description`, optional `server`, `app`, `skills`). Its server entry runs inside
the bb server; its app entry runs in the web UI. Built-in plugins ship with bb;
others are loaded from directories listed in `<dataDir>/config.json`.

```sh
bb plugin list                 # id, status, the commands each plugin adds
bb plugin add ./my-plugin      # add the directory to config.json and load it
bb plugin remove ./my-plugin --yes
bb plugin disable <id>         # keep it listed, stop running it
bb plugin enable <id>
bb plugin reload [id]          # after editing a plugin's source
```

Status is `running`, `needs-configuration`, `error` (with the message) or
`disabled`. `bb status` mentions enabled plugins that are not running.

## Plugin commands

A plugin can register one top-level command, for example `bb tasks …`. The CLI
does not know these commands: it asks the server which plugin owns the first
word and sends the remaining arguments there, together with the caller's
working directory, `BB_THREAD_ID` and `BB_PROJECT_ID`. The server runs the
command and returns its exit code, stdout and stderr.

- `bb <name> --help` is answered by the plugin.
- `--<flag>-stdin` reads one line from stdin and passes it as `--<flag>
  <value>`, so a secret never appears in a process list.
- File paths given to a plugin command are read on the server side.
- An unknown first word that no enabled plugin owns is an `unknown_command`
  error.
