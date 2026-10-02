# Environments

An environment is the directory a thread works in, on one machine. Threads can
share one (a child spawned with `--environment "$BB_ENVIRONMENT_ID"` works in
its parent's directory) or get their own.

| `bb thread spawn` flag | Environment |
|---|---|
| `--environment <env id>` | Reuse that environment. It already fixes the machine, so `--machine` is refused. |
| `--environment <path>` | Run in an existing directory on the chosen machine. A value with `/`, or starting with `.` or `~`, is a path. |
| `--new-environment worktree [--base-branch <ref>]` | A new git worktree that bb creates and later removes. `--base-branch origin/main` starts from a remote ref; without it bb uses the project's default branch. |
| `--new-environment checkout` | The project's own checkout on that machine. |
| `--new-environment personal` | The personal workspace: a directory outside any project. |
| none of these | The server picks the project's default. |

`--machine <id-or-name>` chooses the machine. Without it, a new environment is
created on the machine the calling thread runs on, or on the server's machine
when bb is called from outside a thread.

## Inspect and change

```sh
bb env list --project <proj> --json
bb env show <env> --json        # hostId, path, branchName, baseBranch, status
bb env status <env>             # git state; --merge-base-branch adds ahead/behind
bb env diff <env> [--target uncommitted|branch_committed|all|commit]
bb env commit <env>             # commit every change
bb env update <env> --name "…" | --merge-base-branch <branch>
bb env delete <env> --yes       # refused while live threads use it
```

`bb environment …` is the same command group.

## Files and terminals in an environment

```sh
bb terminal create --environment <env> --command "pnpm test" --json
bb terminal create --thread "$BB_THREAD_ID" --title dev --command "pnpm dev"
bb terminal wait <term> --contains "ready" --timeout 60s    # exit 124 if not
bb terminal wait <term> --exit --timeout 20m --json         # .exitCode
bb terminal output <term> --tail-bytes 4000
bb terminal send <term> --text "q" --enter
bb terminal close <term>
bb file read <path> --machine <id-or-name>      # any machine, absolute path
printf '…' | bb file write <path> --stdin --create-parents --machine <host>
```

A terminal keeps running after the command that created it returns. `terminal
output --json` returns base64 chunks and `nextSeq`; pass it back as
`--since-seq` to read only what is new.
