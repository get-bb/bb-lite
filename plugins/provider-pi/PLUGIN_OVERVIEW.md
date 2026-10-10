Start a thread, pick Pi, and let the Pi coding agent work in your repository from bb. The plugin drives the Pi CLI on the host machine. It streams the agent's work into the bb timeline.

## What you get

- Reasoning levels from None to Max.
- Pi's model list in the model picker.
- Streaming replies, thinking, shell commands and file edits in the timeline, with token usage.
- Stop a running turn.
- Attach images to a prompt; images Pi reads are shown in the timeline.
- Pick a skill with `$name` or `/name` to run it as Pi's `/skill:name`.

## How it works

The runner part starts `pi --mode rpc` on the host for each thread and speaks Pi's JSON-lines RPC protocol over stdin and stdout. Each thread keeps its Pi session file in `~/.bb/pi-bridge-sessions` (or `BB_PI_BRIDGE_SESSION_DIR`), so a thread resumes where it left off. Pi runs with full permissions in bb threads.

## Requirements

- Install the Pi coding agent 0.84.0 or newer on the host machine: `npm install -g @earendil-works/pi-coding-agent`. Older versions are refused with an update hint.
- Sign in with `pi` on that machine.
- Optional: set `BB_PI_BRIDGE_COMMAND` and `BB_PI_BRIDGE_ARGS` on the host to use a Pi executable that is not on `PATH`.
