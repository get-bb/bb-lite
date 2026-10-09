---
name: modal-sandboxes
description: Connect Modal and create reusable cloud machines with the bundled standard image, on-demand daemon installation, and snapshot lifecycle.
---

# Modal machines

1. Install `builtin:environment-modal-sandbox` and configure `tokenId` and
   `tokenSecret` in plugin Settings. Do not print credentials. `appName` defaults
   to `bb-sandboxes`. The plugin page defines named sandbox size presets and
   images; the initial Default image contains the bundled Dockerfile.
2. Run `bb modal account inspect --json` to test the connection without allocating
   compute. Exit status 1 means configuration or connection failed; the JSON gives
   a secret-free message. Other callers use the operation `modal.account`.
3. Resolve the project with `bb project list --json`. It needs a Git remote,
   credentials to clone it, and machine server access reachable from Modal.
4. Start a thread in the `modal-sandbox` environment (below). Standalone
   Modal machines are not available in this version; a sandbox is removed
   with its thread's environment.
   Use a stable creation key for retries. Composed thread creation accepts
   optional configured names as `{"preset":"Large","image":"Node 22"}`.

Settings edits the Default image's Dockerfile, adds named Dockerfile or Modal
image-ID entries, and adds named CPU/memory presets. Without a preset, new
machines reserve 1 CPU and 2 GiB; Modal lets a sandbox burst above its
reservation and bills whichever is higher. One or zero choices use the
default without adding a composer chip; multiple choices share one chip. Agents
can run
`bb modal image show > Dockerfile`, edit the file, then run `bb modal image set
--file ./Dockerfile`. `bb modal image reset` restores the bundled default.
Append `--json` for structured output. File paths resolve from the CLI directory
on the current thread's host, or the server machine without thread context.
Typed RPCs `image.definition`, `image.set({dockerfile})`, and `image.reset`
return `{dockerfile, customized}` through `sdk.plugins.callRpc`.

Only one FROM followed by RUN, ENV, WORKDIR, and USER is supported. Comments and
line breaks are preserved; no COPY, ADD, uploaded context, or multi-stage builds.
Maximum length is 65,536 characters. Failed validation leaves the saved definition
unchanged. Save/reset is plugin-wide and affects new machines only; it does not
allocate resources or build. The next launch builds/reuses the content-hashed
image. The image must provide `bb` on the PATH: the plugin enrolls the
sandbox as a BB machine and runs the `bb runner join` command inside it, then
clones the project's Git remote into the sandbox's home directory. Creation progress
reports build/allocation/bootstrap failures. Cancelling a launch prevents subsequent
sandbox allocation, but an already submitted shared image build may finish.

Project dependencies and services belong in `.bb-env-setup.sh`. Core runs it after
creating the checkout. Restoring a machine does not rerun setup. Core also owns
`.bb-env-teardown.sh` for owned environments. Attached user-maintained paths skip
both hooks. Configure runtime secrets through core Machine environment settings;
never bake them into the image. There are no user recipes, context uploads, smoke
verification records or promotion commands.

Use `bb machine list --json` for core suspension state and
`bb modal machine inspect HOST_ID --json` for Modal expiry and saved-image
status. Idle pause defaults to 15 minutes; compute lifetime is fixed at Modal's
24-hour maximum. There is no retention/keep policy; remove machines explicitly.

Manual and idle pauses drain BB work, stop the daemon, snapshot the filesystem,
and durably record the snapshot before terminating compute. Resume restores the
saved filesystem without rerunning setup. Core defers idle pause while persisted state
ties a starting thread launch or provisioning environment to the machine, or while project
checkout setup is pending; the next scheduled sweep retries. Continue interrupted turns
explicitly.

There is no pre-expiry scheduler. If a sandbox runs for its full 24-hour
lifetime, changes since the last successful pause may be lost.
Pause before the timeout to save work. Failed saves retain compute while it exists.
Missing compute never silently restores an older snapshot; a checkpoint from an
interrupted planned suspension remains recoverable.

Remove with `bb machine remove MACHINE --yes --json`. This removes
owned environments, compute and private snapshots. Shared standard images remain
cached for future launches. Builds and machines incur Modal usage; obtain task
authorization before allocating them during testing.

## Debug an image

The debug commands of earlier versions (`bb modal image build`, `bb modal sandbox
run|exec|stop`) are not available in this version. Create a machine with the
image instead and inspect it.

`bb modal machine inspect HOST_ID [--json]` and the operation `modal.machine({ hostId })` read the saved sandbox, size, image and snapshot of a machine.

### New thread with a new sandbox

Use `bb thread spawn --project <id> --environment-provider modal-sandbox --prompt "..."`.
The composed environment creates a Modal machine and uses core project-checkout
setup to clone the project from its Git remote. Do not pass machine selectors with this environment.
The same option appears once in the environment picker. Existing sandbox hosts
retain their normal checkout/worktree choices. Machine creation, checkout setup
and environment setup report into the thread's provisioning details. A clone
failure keeps the machine for retry or explicit removal.

## Idle pause

Once a minute the plugin pauses Modal machines that saw no thread or terminal
activity for `idleMinutes` with `machines.suspend`: it
snapshots the filesystem, terminates the sandbox and deletes the previous
snapshot. Resuming creates a sandbox from the snapshot and reconnects the runner.
Removing the thread's environment terminates the sandbox and deletes its snapshot.
