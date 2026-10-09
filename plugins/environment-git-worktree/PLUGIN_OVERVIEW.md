# Worktree

The `git-worktree` environment kind: each thread gets its own git worktree of the project checkout, on a managed branch from the default or a named base branch, copying `.worktreeinclude` files. Inputs `{ kind: "existing", path }` attach to an existing checkout instead. Core retires the worktree after the last thread is archived.
