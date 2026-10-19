# bb-150k

A smaller rewrite of [bb](https://github.com/get-bb/bb). bb runs coding agents (Codex and Claude
Code) as **threads**: you follow a thread live, steer it while it runs, queue messages, and let
agents start and manage other threads. This repository does the same job for the way bb is
actually used day to day, in a fraction of the code, and adds multiplayer: several people can
share one server.

It started as an experiment: rebuild bb under a hard cap of 150,000 lines (hence the name) by
keeping what is used, cutting what is not, and redesigning the parts that had grown too large. The
cap was later lifted so features could come back as plugins. `pnpm count` reports the current size:
about 263,000 counted lines (42,000 of them tests), against about 1.6 million in get-bb/bb by the
same rule.

- `REPORT.md`: what the rewrite kept, cut and verified, and how it looks next to the original.
- `INVENTORY.md`: how the plan was made and the decisions behind it.
- `docs/architecture.md`: the exact behaviour of every part. This README is the overview.

## What it does

| Thing       | What it is                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Project     | A codebase, with one source directory per machine. `proj_personal` is for work outside any codebase.               |
| Thread      | One conversation with one agent: a status, a timeline of events, at most one parent thread.                        |
| Environment | The directory a thread works in: the project checkout, a git worktree bb manages, or a personal scratch workspace. |
| Machine     | A computer that runs agents. The server's own machine always exists; others join with `bb runner`.                 |
| Provider    | An agent backend (`codex`, `claude-code`, plus `pi` and ACP agents as add-ons) and its models.                     |
| Plugin      | A directory that adds server features, UI, agent tools and `bb <name>` commands. Almost everything in bb is one.   |

Three ways to drive it, all over the same API:

- **The web UI** the server serves: sidebar with sections and pinned threads, split panes, the
  conversation timeline, the composer (mentions, slash commands, attachments, queue and steer), and
  a right panel with files, diffs and terminals. It works on phones and tablets too.
- **The `bb` CLI**, which can do everything the UI can. Agents inside threads use it to spawn
  child threads, wait on them, read their output and message them. A native Rust build
  (`crates/bb-cli`) answers in milliseconds instead of ~200 ms; the Node CLI is the reference.
- **MCP** (the `mcp` plugin, off by default): ChatGPT, Claude and other MCP clients can search and
  run `bb` commands, signed in through OAuth.

Other machines join as runners (`bb runner join`) over one WebSocket, and a server with no public
address can be reached through bb connect: either the getbb.app tunnel or this repository's own
relay (`apps/relay`, a Cloudflare Worker, see `docs/relay.md`), which can also run hosted servers on
Fly (`docs/hosted.md`).

## Multiplayer

One bb server can be shared by several people, which the original bb does not do.

- **Users and roles.** Each person is a user, `owner` or `member`. An owner invites people
  (`bb user invite --name Ada --role member` prints a link that expires after seven days and works
  once). The person opens it, picks a name and password, and is signed in. Owners manage users,
  invites, plugins and server settings; members work in threads. `bb user sign-in-link` signs in a
  browser without a password.
- **Signing in.** On the server's machine a loopback request is the owner with no sign-in. Anyone
  else uses a session cookie, from a password or an invite or sign-in link. Through bb connect the
  relay's GitHub sign-in identifies people instead, and the server maps them to its users. Someone
  the server doesn't know yet sees "not a member yet" until they accept an invite.
- **Shared and private machines.** Every machine has an owner and is `private` (only its owner can
  run threads, terminals and file commands there) or `shared` (`bb machine share <machine>`).
  Everyone can read every thread; there are no private threads yet.
- **Per-person state.** Read and unread, pins, sidebar sections, open tabs, prompt history, UI
  preferences, theme and keybindings belong to each person. Plugin settings can be per user.
- **Attribution.** Each thread records who started it, and each message who sent it, shown on the
  user rows in the timeline. Each user's avatar comes from GitHub when they sign in through the
  relay. An agent's `bb` calls run as the person who last wrote in that thread, and the audit log
  records who did what.
- **Presence.** The app shows who is online and who else has a thread open, in the thread's
  header and its row in the sidebar.

`apps/cli/guide/people.md` is the how-to; `docs/architecture.md` ("Trust") has the exact rules.

## Running it

Needs Node 24 (`.nvmrc`; at least 22.19) and pnpm. Rust is optional, for the native CLI.

```sh
pnpm install
scripts/server.sh start --build   # builds the web app (and the native CLI if cargo exists), starts the server
scripts/server.sh status | logs | stop
```

Then open `http://127.0.0.1:48886`. On the server's own machine a loopback request is the owner,
so there is nothing to sign in to. `apps/cli/bin/bb` is the CLI (`bb guide` is the manual, and
`bb <command> --help` covers one command); `bb server` runs the server in the foreground instead.

| Setting                   | Default                  |                                                            |
| ------------------------- | ------------------------ | ---------------------------------------------------------- |
| `BB_DATA_DIR`             | `~/.bb-150k`             | Database, worktrees, plugin data, `config.json`            |
| `BB_SERVER_PORT`          | `48886`                  |                                                            |
| `BB_SERVER_BIND_HOST`     | `127.0.0.1`              |                                                            |
| `BB_SERVER_ALLOWED_HOSTS` |                          | Extra host names, for a reverse proxy or `tailscale serve` |
| `BB_PROFILE`              | `default`                | `headless` (no UI plugins) or `minimal`                    |
| `BB_SERVER_URL`           | `http://127.0.0.1:48886` | Which server the CLI talks to                              |

The data directory and port differ from the original bb on purpose, so both can run side by side.
The server refuses to open an original bb database; `bb import-legacy --from ~/.bb` copies projects,
machines, sections, threads (with their events and provider sessions) and settings across
(`apps/cli/guide/migrating.md`).

Development: `pnpm check` runs typecheck, lint and tests; `pnpm format` formats; `pnpm -C apps/app
dev` serves the UI with hot reload.

## How the API works

bb is a small **kernel** plus **plugins**. The kernel knows nothing about threads or projects; it
only knows how plugins declare things, call each other and hook into each other. The server's own
features (threads, projects, machines, sessions, environments, terminals, settings, identity) and
the app's own screens (shell, thread view, composer, side panel, settings) are plugins written with
exactly the API an outside plugin gets. There is no private API.

The server, the browser and each runner machine hold a kernel of their own, all from
`packages/plugin`.

### Contracts

A plugin declares what it offers in a contract: names and zod schemas, nothing else, so every part
and every other plugin can import it.

```ts
import { contract, event, live, op, slot } from "@bb/plugin";
import { z } from "zod";

const Note = z.object({ id: z.number(), text: z.string() });

export const notes = contract("notes", {
  list: op({
    input: z.object({ projectId: z.string() }),
    output: z.array(Note),
  }),
  create: op({
    input: z.object({ projectId: z.string(), text: z.string() }),
    output: Note,
    kind: "write",
    doors: {
      agent: {
        name: "AddNote",
        description: "Remember a note for this project",
      },
      cli: {
        path: "notes add",
        summary: "Remember a note",
        positionals: ["text"],
      },
      http: { method: "POST", path: "/notes", status: 201 },
    },
  }),
  created: event(z.object({ note: Note })),
  count: live(z.number()),
  exporter: slot<{ id: string; label: string }>({ key: "id" }),
});
```

| Member    | What it is                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------- |
| `op`      | An operation: validated input and output, `read` or `write`, who may call it, and what hooks may do   |
| `event`   | Something that happened, for listeners                                                                |
| `slot`    | A list other plugins add to (nav items, providers, environment kinds, settings pages, timeline rows…) |
| `service` | A pick-one slot holding an object                                                                     |
| `live`    | A value the server holds and pushes to apps when it changes                                           |
| `table`   | A database table other plugins may read                                                               |

### Parts and verbs

A plugin is a directory with a `package.json` `bb` block and up to three parts, each a plain
function that receives `bb`: `server.ts`, `app.tsx` and `runner.ts` (code that runs on every
machine, such as a provider adapter). Every part has the same verbs:

- `implement(op, fn)`: be the one implementation of an operation. `call(op, input)`: call any.
- `on(op, hook)`: wrap an operation. A hook gets `(input, next)` and, depending on what the
  operation allows, observes, rewrites the input or output, answers itself, or `deny()`s.
  `on(event, listener)` / `emit(event, payload)` for events.
- `add(slot, item)`, `wrap(slot, matcher, change)`, and `read` / `find` / `pick` / `use` to read.
- `provide(live, initial)` and `changed(op)` to tell apps to refetch.

The server side also gets host services: `bb.db` (the shared SQLite), `bb.storage` (KV, a private
database, tables of its own), `bb.settings.define` (typed settings with a generated page),
`bb.runners.call(hostId, op, input)` (run an operation a runner part implements on a machine),
`bb.http`, `bb.background` (services and cron), `bb.cli.register`. The app side gets React hooks
from `@bb/plugin/app` (`useOp`, `useLive`, `ThreadChat`, the sidebar and composer hooks) and fills
the screen plugins' slots.

### Doors

One operation reaches every surface through its **doors**, so nothing is written twice:

- **HTTP.** Every JSON route under `/api/v1` is an operation's HTTP door: `GET /api/v1/threads`,
  `POST /api/v1/threads/:threadId/send`, and so on. Any operation not marked `internal` can also be
  called as `POST /api/v1/ops/<name>` with its input as the body, answering `{ok, result}`. Errors
  are `{code, message, details?}` with the HTTP status. `GET /api/v1/kernel` lists every operation,
  hook, slot, live value and plugin. Raw routes remain only for sign-in, uploads, file bytes and
  plugin assets.
- **WebSocket.** `/ws` sends "changed" signals (entity, id, kinds) and plugin signals; the UI
  refetches on them. `/ws/terminals/:id` streams terminal bytes.
- **Agent.** `doors.agent` offers the operation to every agent session as a tool.
- **CLI.** `doors.cli` turns it into `bb <words> …`, with flags derived from the input schema and
  `--json` for free. Commands a plugin adds are dispatched to the server, so the CLI never needs
  updating for them.

The app, the CLI (`packages/plugin/src/client.ts`, `call(op, input)`) and other programs all call
operations, so one hook chain sees every caller. Each call carries a caller: the user, the door it
came through, the agent's thread, and which plugins it passed through. Every write is recorded in
an audit log (`bb audit`).

### Machines and providers

The server talks to machines only through one `Runner` interface: in-process for its own machine,
and over a single WebSocket for every other one, with a reliable event lane that survives
reconnects and server restarts. A turn is submitted with its whole session spec each time, so the
runner can start, resume or rebuild the provider session itself. Providers are plugins: a runner
part adds a `ProviderAdapter` (Codex through `codex app-server`, Claude Code through the agent SDK)
and a server part declares its models and settings. Both translate into the same stored event
format as the original bb, so imported history renders unchanged.

### Writing and installing plugins

`docs/plugin-api.md` is the guide. External plugins load from directories listed in
`<dataDir>/config.json` (`bb plugin add <dir>`), are bundled by the server with no build step, and
can hot-reload. `bb dev new | validate | types | watch | install` helps write them, `bb dev port
<dir>` shows what an original-bb plugin's calls become here, and `bb dev fork <id>` copies any
built-in plugin, core ones included, and loads the copy in its place. `bb marketplace` installs from
catalogs. The API is versioned (`API_VERSION`, currently 1.11) against a committed description,
`packages/plugin/api.lock.json`, and `pnpm api:lock` refuses a breaking change without a major
bump.

## How it differs from get-bb/bb

|            | get-bb/bb                                                                                    | bb-150k                                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Size       | ~1.6M counted lines, ~800K of them tests                                                     | ~263K, ~42K tests                                                                                                                                               |
| Apps       | Desktop (Electron), web, mobile, CLI, server, host daemon, connect service, AI gateway, demo | Web app, CLI (Node + native Rust), server, relay. No desktop or native mobile app                                                                               |
| Processes  | Server plus a separate host daemon and a provider bridge process                             | One server process; a runner runs in it for the local machine and as `bb runner` elsewhere                                                                      |
| Storage    | SQLite through Drizzle with migrations                                                       | One `schema.sql` applied by `user_version` steps, plain prepared statements. Same event envelope and id prefixes                                                |
| Plugin API | `@get-bb/plugin-sdk`: RPC contracts (`rpc.register`, `useRpc`) beside a fixed server and UI  | A kernel of contracts, operations, hooks, slots and live values; the server's and app's own features are plugins built on it, and any can be forked or replaced |
| HTTP API   | Hand-written routes plus a client SDK                                                        | Every route is an operation's door; `/api/v1/ops/<name>` reaches any operation; no separate client library                                                      |
| CLI        | Commands written one by one                                                                  | One declarative table and engine; plugin commands come from operations; native binary for agents                                                                |
| Users      | Single-user: one owner; the auth tables hold machine credentials and API keys                | Multiplayer: owner and member roles, invites, shared or private machines, per-person state, presence                                                            |
| Plugins    | Marketplace, installer, updater, safe mode, version gating                                   | `bb plugin add`, `bb dev install`, `bb marketplace`; versioned against an API lock                                                                              |
| Defaults   | `~/.bb`, ports 38886/38887                                                                   | `~/.bb-150k`, port 48886                                                                                                                                        |

What the UI does not have (desktop, compared side by side with the original): forking or editing a
sent message, goal mode, the table-of-contents rail, Mermaid and math rendering, rich-text compose,
tab groups in the right panel, drag-to-split, the board view in Tasks, custom theme files, and
several settings pages (AI services, Browser, Updates, Experiments and others). Plan mode was
removed on purpose. `REPORT.md` lists every visible difference; some of what it lists as cut has
since come back as plugins (automations, workflows, browser automation, side chat, GitHub, memory,
the Pi and ACP providers and others: `profiles/default/profiles.ts` has the current list, and
`docs/plugin-migration-gaps.md` the port status of the original's plugins).

## Repository layout

| Path                                      | What it is                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `apps/server`                             | The host: kernel, plugin loader, HTTP and WebSocket shells, static web app         |
| `apps/app`                                | Web UI entry and plugin loader; the screens themselves are plugins                 |
| `apps/cli`                                | The `bb` CLI, `bb server`, `bb runner`; `guide/` is the manual                     |
| `apps/relay`                              | Cloudflare Worker for accounts, linking servers, the tunnel gate, hosted servers   |
| `apps/tunnel`                             | A second, frp-based tunnel gate, to compare against the relay's (`docs/tunnel.md`) |
| `crates/`                                 | Native `bb` CLI and its thread-log renderer                                        |
| `packages/plugin`                         | The kernel and the plugin API                                                      |
| `packages/runner`                         | Everything that happens on a machine: sessions, git, files, terminals              |
| `packages/server-kit`, `packages/app-kit` | What core plugins share on the server and in the browser                           |
| `packages/thread-view`                    | Events to timeline rows                                                            |
| `packages/domain`, `server-contract`      | Shared schemas                                                                     |
| `plugins/`                                | Every feature: core, providers, environment kinds and add-ons                      |
| `profiles/default`                        | Which plugins make up the product, per runtime, and the named profiles             |
| `hosted/`                                 | The Docker image for hosted servers                                                |

## License

MIT
