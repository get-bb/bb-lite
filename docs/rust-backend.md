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

| Crate         | Ports                                                                  |
| ------------- | ---------------------------------------------------------------------- |
| `bb-core`     | `runner/src/types.ts`, `workspace/exec.ts`, `sessions/agent-env.ts`, the method table |
| `bb-git`      | `runner/src/workspace/git.ts`                                          |
| `bb-fs`       | `runner/src/files/{read,write,commands}.ts`                            |
| `bb-procs`    | `runner/src/workspace/{scripts,open-targets}.ts`, `terminals/terminals.ts` |
| `bb-provider` | `runner/src/events/event-builder.ts`, `providers/provider.ts`          |
| `bb-codex`    | `runner/src/providers/codex*.ts`                                       |
| `bb-remote`   | `runner/src/remote/*`, `sessions/outbox.ts`                            |
| `bb-tunnel`   | `packages/tunnel-contract`, `packages/tunnel-client`                   |
| `bb-pool`     | `plugins/account-pool/src`                                             |
| `bb-js`       | new: the QuickJS plugin runtime                                        |
| `bb-cli`      | `apps/cli/src`                                                         |

More crates are added as the port proceeds (workspace assembly, sessions, Claude, timeline
projection, the server).

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
