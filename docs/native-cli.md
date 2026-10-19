# Native `bb` CLI

`crates/bb-cli` is the `bb` command-line program in Rust. It exists for start-up time: an agent
runs `bb` many times per turn, and the native binary answers in a few milliseconds where the Node
CLI takes about two hundred. The server, the machine runner and the plugins are TypeScript only.

## How it fits

- **The Node CLI (`apps/cli`) stays the reference.** Its table (`src/table.ts`) defines every
  command, flag and line of help; `crates/bb-cli/src/table.rs` mirrors it, and
  `crates/bb-cli/tests/help_parity.rs` fails when any help page differs. Change the Node CLI
  first, then the Rust one.
- **It is an HTTP client.** Every command it runs itself talks to the server over the same routes
  the Node CLI uses, and plugin commands are sent to the server as before.
- **Three commands are handed to the Node CLI** with the same command line, because they run
  server-side code: `bb server`, `bb runner join|run` and `bb import-legacy`
  (`crates/bb-cli/src/commands/node.rs`).
- **`apps/cli/bin/bb` chooses.** It runs the native binary when one is built
  (`target/release/bb`, or `apps/cli/native/bb` in a packaged install) and the Node CLI otherwise.
  `BB_CLI_NATIVE=0` forces the Node CLI. Sessions get `bin/bb` as their `bb`, so agents use the
  native binary whenever it exists.
- **`crates/bb-thread-view`** is the part of `packages/thread-view` that `bb thread log` prints
  with: view rows and row titles, compared with TypeScript output in its tests.

## Building and testing

```sh
cargo build --release -p bb-cli     # target/release/bb, about 5 MB
cargo test --workspace              # needs node and node_modules for the end-to-end tests
scripts/server.sh start --build     # rebuilds the web app and the native CLI, restarts the server
```

`tests/recipes_cli.rs` drives the native CLI against a real Node server on a temporary data
directory; the other tests use a fake HTTP server.

## Rules for code in `crates/`

- The TypeScript file is the specification: port behaviour and every user-visible string exactly.
- The crate creates no async runtime and links no server code, so that start-up stays in
  milliseconds; check `bb --help` timing after adding a dependency.
- `cargo fmt` (100 columns, `rustfmt.toml`) and `cargo clippy` without warnings. No code comments
  beyond a doc comment on a public item whose name cannot carry its contract.
- Tests never touch `~/.bb`, `~/.bb-lite*` or ports 38886, 38887 and 48886. Use temp directories
  and port 0.
