# Machines

The server's own machine runs agents in-process. Every other machine runs a
**runner**: one process that connects to the server and starts agents,
terminals and git operations there.

## Add a machine

```sh
# on any machine that can reach the server
bb machine add --name build-box       # prints: bb runner join <blob>

# on the new machine, within 15 minutes
bb runner join <blob>                 # stores ~/.bb-150k-runner/<server>/runner.json
bb runner run                         # foreground; keep it under your supervisor
```

- The join command is single use. `bb machine reconnect <machine>` prints a new
  one for a machine that lost its credential; it keeps its ID.
- `bb runner join <blob> --header name=value` adds a header to every request
  the runner makes (for a gateway in front of the server).
  `--reuse-connect-credential [path]` takes the bb connect credential of an
  older bb install instead.
- A runner that loses its connection redials on its own; running agents and
  terminals continue meanwhile.

## Use a machine

```sh
bb machine list --json                 # id, name, status (connected | disconnected)
bb thread spawn --project <proj> --machine build-box --new-environment worktree …
bb project source add <proj> --path /srv/repo --machine build-box
bb provider list --machine build-box   # providers installed there
bb provider models codex --machine build-box
bb terminal create --machine build-box --cwd /srv --command "df -h"
bb file read /etc/hostname --machine build-box
bb machine rename <machine> <name>
bb machine remove <machine> --yes      # revokes its credential
```

`--machine` takes a machine ID or its unique name everywhere; `--host` is the
same flag. A project needs a source (its directory) on each machine that runs
its threads.

## Variables for agents

```sh
bb machine env list [--project <proj>]
printf %s "$TOKEN" | bb machine env set NPM_TOKEN --note "registry"
bb machine env unset NPM_TOKEN
```

These variables are stored encrypted on the server and exported to every agent
process, on every machine (or only for one project). Values are write-only.
