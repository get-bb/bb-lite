# Rust backend

The server, the machine runner and the `bb` CLI are being rewritten in Rust under `crates/`. The
TypeScript backend (`apps/server`, `packages/runner`, `apps/cli`) stays in the repo as the reference
until the Rust one matches it; `docs/architecture.md` describes the behaviour both must have. The web
app, the SDK and the zod packages (`packages/domain`, `packages/server-contract`) are unchanged and
remain the source of truth for JSON shapes.

## Decisions

- **Same wire, same disk.** HTTP routes, WebSocket messages, the runner protocol, `schema.sql` and
  the data directory layout are identical, so either backend can open a data directory and a runner
  of one kind can join a server of the other.
- **One process model.** The server runs on a current-thread tokio runtime, so code between two
  `.await`s is atomic exactly as it is in Node. CPU-heavy work (timeline projection, compression)
  goes to `spawn_blocking`. All types are still `Send + Sync` so this can change later.
- **Events are JSON with accessors.** Stored thread events are `serde_json::Value` read through
  accessor helpers, never a closed enum: a database imported from the original product holds shapes
  this build no longer writes, and they must keep decoding. Entities, requests and responses are
  typed serde structs.
- **Runner calls are data.** `bb_core::RunnerApi::call(method, params)` is the whole machine
  interface (`RUNNER_METHODS` lists the names). The local runner, the remote link and test fakes
  implement it; typed argument and result structs live with the code that implements each method.
- **Plugins.** `account-pool` and `connect` are native Rust plugins. `tasks`, `secrets`,
  `ask-user-question`, `custom-instructions` and `thread-list` keep their TypeScript server halves
  and run in an embedded QuickJS runtime (`bb-js`). App halves are untouched.
- **Claude Code** is driven by speaking the CLI's stream-json protocol directly (there is no Rust
  Agent SDK). Codex is `codex app-server` over JSON-RPC as before.

## Crates

| Crate            | Ports                                                                            |
| ---------------- | -------------------------------------------------------------------------------- |
| `bb-core`        | `runner/src/types.ts`, `workspace/exec.ts`, `sessions/agent-env.ts`, the method table |
| `bb-git`         | `runner/src/workspace/git.ts`, `workspace-types.ts`                              |
| `bb-fs`          | `runner/src/files/{read,write,commands}.ts`                                      |
| `bb-procs`       | `runner/src/workspace/{scripts,open-targets}.ts`, `terminals/terminals.ts`       |
| `bb-workspace`   | `runner/src/workspace/{diff,watch,worktrees}.ts`, `files/list.ts`                |
| `bb-provider`    | `runner/src/events/event-builder.ts`, `providers/provider.ts`                    |
| `bb-codex`       | `runner/src/providers/codex*.ts`                                                 |
| `bb-claude`      | `runner/src/providers/claude*.ts`, over the CLI's stream-json protocol           |
| `bb-echo`        | `runner/src/providers/echo.ts`                                                   |
| `bb-sessions`    | `runner/src/sessions/session-manager.ts`                                         |
| `bb-remote`      | `runner/src/remote/*`, `sessions/outbox.ts`                                      |
| `bb-runner`      | `runner/src/{index,local}.ts`: the local runner and the default adapters         |
| `bb-thread-view` | `packages/thread-view` (timeline projection, view rows, row titles)              |
| `bb-tunnel`      | `packages/tunnel-contract`, `packages/tunnel-client`                             |
| `bb-connect`     | `plugins/connect/src` (account, hosted service, tunnel)                          |
| `bb-pool`        | `plugins/account-pool/src` (stores, logins, the hub)                             |
| `bb-js`          | new: the QuickJS plugin runtime with Node shims and a SQLite handle              |
| `bb-server`      | `apps/server/src`, module for module; `plugins/native/` holds the two native plugins |
| `bb-cli`         | `apps/cli/src`: the `bb` binary, including `bb server` and `bb runner`           |

`bb-server` has no `Engine` object: a TypeScript function that took `engine` or `ctx` takes
`ctx: &Ctx` (`Arc<ServerContext>`), and in-memory state lives in `ctx.engine`, `ctx.environments`
and `ctx.terminals`. Built-in TypeScript plugins are bundled by `crates/bb-server/build.rs`
(`scripts/build-plugin-bundles.mjs`, which needs `node_modules`; set `BB_NODE_MODULES_ROOT` to a
checkout that has them when building from a bare worktree). A plugin loaded from a directory is
bundled at load time with the `esbuild` binary (`BB_ESBUILD_PATH`).

## Running

```sh
cargo build -p bb-cli                      # target/debug/bb
BB_DATA_DIR=/tmp/bb-rs/data BB_SERVER_PORT=58886 BB_APP_DIR=apps/app/dist \
  BB_DEV_PROVIDERS=echo target/debug/bb server
BB_SERVER_URL=http://127.0.0.1:58886 target/debug/bb status
```

The configuration variables, the default port and the data directory layout are those of the
TypeScript server, so always set `BB_DATA_DIR` and `BB_SERVER_PORT` when another instance exists.

## How parity is checked

- **Recorded sessions.** Codex fixtures (`packages/runner/test/fixtures`) and raw Claude Code CLI
  recordings (`crates/bb-claude/tests/fixtures/raw`, with `PROTOCOL.md`) replay through the real
  adapters to the events the TypeScript pipeline produced.
- **Timeline.** `scripts/rust-parity/timeline-goldens.ts` writes the TypeScript projection and rows
  for recorded event streams; `bb-thread-view` reproduces them, and view rows, row titles and the
  CLI log text are compared with TypeScript output case by case.
- **Server.** `scripts/rust-parity/record-server.ts` records a conversation with the TypeScript
  server (HTTP, waits, WebSocket messages, every thread's events and timelines) into
  `crates/bb-server/tests/fixtures/parity`; `tests/parity_replay.rs` replays it against the Rust
  server and `tests/timeline_parity.rs` compares the timeline responses.
- **Ported tests.** The TypeScript test files of the server, runner, CLI and plugins are ported
  next to the code they cover.

## Rules for code in `crates/`

- **The TypeScript file is the specification.** Port behaviour, limits, timeouts and every
  user-visible string (error messages, labels) exactly. Port the tests that cover the file too.
- **JSON shapes** follow the TypeScript types: `#[serde(rename_all = "camelCase")]`; a `T | null`
  field is `Option<T>` and serializes `null`; an optional `field?: T` is `Option<T>` with
  `#[serde(default, skip_serializing_if = "Option::is_none")]`. `serde_json` keeps key order.
- **Errors** on the machine side are `bb_core::RunnerError` with the same code and message as the
  TypeScript `RunnerError`. `std::io::Error` converts with the same code mapping as `toRunnerError`.
- **Async** is tokio. Types are `Send + Sync`: `Arc`, `parking_lot::Mutex`, tokio channels; no
  `Rc` or `RefCell`. Never hold a lock guard across `.await`. Child processes are
  `tokio::process::Command` with `kill_on_drop(true)`; nothing blocks the runtime thread (use
  `spawn_blocking` or a dedicated thread for blocking reads such as a PTY).
- **Machine operations** take `&bb_core::exec::Ctx` first and one argument struct that
  deserializes from the method's JSON parameters, and return `RunnerResult<T>` where `T`
  serializes to the method's JSON result: `pub async fn git_status(ctx: &Ctx, args: GitStatusArgs)
  -> RunnerResult<WorkspaceStatus>`. Git goes through `bb_core::exec::open_repo`.
- **Dependencies** come from `[workspace.dependencies]` (`tokio.workspace = true`). A crate that
  needs something else adds it to its own `Cargo.toml` with a version; the root manifest is edited
  only when a second crate needs the same thing.
- **Style**: `cargo fmt` (100 columns, `rustfmt.toml`), `cargo clippy` without warnings. No code
  comments beyond a doc comment on a public item whose name cannot carry its contract. No
  `unwrap()` on anything that can fail at run time outside tests.
- **Tests** never touch `~/.bb`, `~/.bb-150k*`, ports 38886, 38887 or 48886, getbb.app, or a real
  Codex or Claude Code login. Use temp directories and port 0.
