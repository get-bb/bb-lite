---
name: modal-sandboxes
description: Connect Modal and create reusable cloud machines with the bundled standard image, debug sandboxes, and snapshot lifecycle.
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

```sh
bb modal image build --json
bb modal sandbox run --json
bb modal sandbox exec SANDBOX -- bash -lc 'node --version && which git'
bb modal sandbox stop SANDBOX --json
```

Everything after `--` belongs to `sandbox exec` and is never parsed as an option.

Build uses the saved Dockerfile and the same account-wide image cache as machine
creation. It returns the image ID and the final 65,536 characters of build logs
when finished; failures include captured logs and the vendor error. Build logs
are collected through Modal 0.10's gRPC middleware because its image builder does
not forward them. Output is not streamed to the CLI. An already submitted build
can finish after CLI cancellation.

Run builds or reuses that image and returns `sandboxId`, `imageId`, `expiresAt`
and build `logs`. Debug sandboxes expire after 30 minutes, reserve 1 CPU and
2 GiB, and contain no injected BB credentials, runner, project clone or setup
hook. They are separate from BB machines and do not snapshot. Files and running
processes remain between exec calls until stop or expiry. Copy successful fixes
into the Dockerfile, save it, and run a new sandbox to verify them.

Exec passes arguments literally; use `bash -lc` for shell expressions. Commands
have a 60-second timeout and output is capped at 128 KiB per stream with a
truncation marker. Plain output prints stdout, stderr and, when it is not 0,
`Exit code N`; the CLI exits with the command's own exit code. `--json` returns
`{exitCode,stdout,stderr}`. Stopping is idempotent for known debug sandboxes.
Exec/stop only accept sandboxes created by this plugin's debug workflow in the
original Modal account. Stop removes compute without deleting the cached image.

Other callers use the operations `modal.createImage({})`, `modal.createSandbox({})`,
`modal.createSandboxCommand({ sandboxId, command })` and
`modal.deleteSandbox({ sandboxId })`. Build/run incur Modal usage.

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
