# Architecture

bb is one server process, a web UI it serves, a `bb` CLI, and optional runner processes on other
machines. This document is the working contract between the packages. `INVENTORY.md` has the line
budgets; this file has the shapes.

## Packages

| Package | Role |
|---|---|
| `apps/server` | The only stateful process. SQLite, HTTP API under `/api/v1`, WebSockets, thread engine, plugin host, runner hub, static web app |
| `packages/runner` | Everything that happens on a machine: provider sessions (Codex, Claude Code, echo), git and worktrees, files, terminals, file watching. Runs in-process inside the server for the server's own machine, and as `bb runner` on every other machine |
| `apps/cli` | `bb`: every user feature, plus `bb server` and `bb runner` |
| `apps/app` | Web UI |
| `packages/thread-view` | Events → timeline rows. Projection runs in the server; row helpers run in the browser |
| `packages/domain`, `packages/server-contract` | Shared schemas: events, rows, entities, routes |
| `packages/sdk` | Typed HTTP + WebSocket client used by the app, the CLI and plugins |
| `packages/plugin` | The plugin API (types and helpers) |
| `plugins/*` | In-repo plugins compiled into the server and the app |

Dependency direction: `domain` ← `server-contract` ← `thread-view`, `sdk`, `runner` ← `server` ← `cli`.
The runner never imports the server. The server talks to machines only through the `Runner` interface.

## Process and data model

- Default data directory `~/.bb-150k` (`BB_DATA_DIR`), default port `48886` (`BB_SERVER_PORT`), bind
  `127.0.0.1` (`BB_SERVER_BIND_HOST`). These differ from the original on purpose.
- The server refuses to start when the data directory contains a database with a
  `__drizzle_migrations` table (an original bb data directory).
- `<dataDir>/bb.db` (WAL), `attachments/<projectId>/`, `thread-storage/<threadId>/`, `worktrees/`,
  `plugins/<id>/` (plugin `data.db`, secrets, files), `theme/<name>/theme.css`, `AGENTS.md`,
  `config.json`, `connect.json` (0600), `host-id`, `logs/`.
- One schema file, `apps/server/src/db/schema.sql`, applied through `PRAGMA user_version` steps. No ORM:
  `better-sqlite3` prepared statements behind small typed query modules. Never mock the database in tests;
  use `:memory:`.

Tables: `hosts`, `projects`, `project_sources`, `environments`, `threads`, `events`,
`queued_thread_messages`, `pending_interactions`, `thread_sections`, `thread_tabs`,
`prompt_history_entries`, `thread_search_segments` (+ FTS5 table and triggers), `project_attachments`,
`terminal_sessions`, `settings`, `ui_preferences`, `environment_variables`, `plugins`, `plugin_kv`,
`plugin_settings`.

Differences from the original schema, chosen to delete derivation code:

- `threads` also stores `provider_thread_id`, `active_turn_id`, and the last execution tuple (`model`,
  `reasoning_level`, `permission_mode`, `service_tier`). The matching events are still appended, because
  the projection reads them.
- `hosts` stores `token_hash`, `join_token_hash`, `join_expires_at`, `connect_machine_id`,
  `last_instance_id`, `last_seen_at`. No sessions table, no `user`, no `apikey`.
- `projects.execution_defaults` is a JSON column. Theme and keybinding overrides live in `settings`.
- `events` keeps the original envelope and columns exactly: `(id, thread_id, environment_id, scope_kind,
  turn_id, provider_thread_id, sequence, type, item_id, item_kind, parent_tool_call_id, data, created_at)`.

Ids keep their prefixes (`thr_`, `proj_`, `env_`, `host_`, `evt_`, `qmsg_`, `pint_`, `term_`, `sec_`,
`creq_`). The personal project is always `proj_personal`. Timestamps are epoch milliseconds.

## Trust

Principals: `owner`, `runner(hostId)`, `anonymous`.

- A loopback request without the tunnel marker is the owner. If it carries an `Origin`, the origin must be
  the server's own loopback origin or its stored public URL, and `Host` must be loopback.
- The tunnel client adds `x-bb-via-tunnel: 1` to everything it forwards (and strips inbound copies). With
  the marker, `x-bb-gate-auth: session` is the owner, `x-bb-gate-auth: machine` is runner-class (allowed on
  `/internal/runner/*` and on `/api/v1/*` except machine management and settings writes), and anything
  else is anonymous and gets 404.
- A runner authenticates to `/internal/runner/ws` with `Authorization: Bearer <runner token>`; the server
  stores only the SHA-256. `bb runner join <blob>` exchanges a 15-minute single-use join token for it at
  `POST /internal/runner/join`. Runner endpoints must stay under `/internal/` (the hosted gate only passes
  machine credentials there).
- A request without the tunnel marker that carries `Authorization: Bearer bbr_…` is judged by that token
  alone, whatever its peer address: a token that matches a host is the same runner-class principal as a
  gate-authenticated machine (so `/api/v1/*` minus the machine and settings writes), any other is
  anonymous. This is how the runner's loopback CLI proxy reaches the API on a direct connection; through
  the tunnel the gate's verdict stands and the bearer token only authenticates the runner socket.

## The Runner interface

`packages/runner/src/types.ts` (sessions) and `workspace-types.ts` (git, files, terminals) define
`Runner = SessionApi & WorkspaceApi`. Two implementations:

- `createLocalRunner({ dataDir, serverUrl, sink })`: direct calls, events through a callback.
- `connectRemoteRunner(socket, sink)` on the server and `serveRunner(runner, socket)` in `bb runner`:
  the same interface as JSON frames over one WebSocket (`packages/runner/src/remote/protocol.ts`):
  `{t:"req",id,method,params}` → `{t:"res",id,ok,result|error}`, `{t:"evt",event}`, `{t:"ack",seq}`,
  `{t:"ping"}`/`{t:"pong"}`. Only the methods of `Runner` can be called.

Remote transport rules:

- The runner speaks first: `{t:"hello",instanceId,version,lastAckedSeq?}`. The server answers requests
  from then on, registers the machine, and replies `{t:"welcome",lastSeq}`: the highest reliable `seq` of
  that instance it has already handed to its handlers. The runner sends no event before `welcome`, then
  re-sends every unacked reliable event after `lastSeq`. The server also drops any reliable event at or
  below that mark, and stores the acked `seq` in `hosts.last_event_seq`, so a server restart resumes from
  the last event whose handlers finished (at-least-once across a server crash, exactly-once otherwise).
- The server pings every 5 s. Either side terminates the socket after 30 s without an inbound frame. The
  runner redials forever, 1 s doubling to 10 s; sessions and terminals keep running meanwhile.
- No frame exceeds 768 KiB on the wire (tunnel limit 1 MiB): a larger one is sent as consecutive
  `{t:"part",data,last}` frames of at most 256 Ki characters and reassembled by the receiver.
- Requests time out by method class: 15 s (describe, snapshot, resolves, terminal input), 60 s (files,
  repository reads, provider lists, interrupt), 10 min (`submitTurn`, worktree and branch operations,
  commit), and its own `timeoutMs` + 30 s for `runLifecycleScript`. A timeout or a lost socket rejects
  with a retryable `unavailable`; the request is not replayed.
- Live events queue behind a 1 MiB socket buffer; while it is full only the newest 32 `terminal.output`
  frames are kept (the viewer sees a `seq` gap and re-attaches by `sinceSeq`). Other live events and all
  reliable events are never shed.
- Close code 4001 means the machine was removed or another runner took its place: that runner process
  stops instead of redialing.
- `<dataDir>/runner.json` (0600) holds `{serverUrl, hostId, runnerToken, headers}`; `headers` go on the
  join request, the socket upgrade and everything the CLI proxy forwards. Default directory
  `~/.bb-150k-runner/<server host>`.

Rules:

- **`submitTurn` carries the whole `SessionSpec` every time.** The runner starts, resumes
  (`providerThreadId` set) or rebuilds the provider session itself. `mode.kind`: `start` fails with
  `competing_turn` if a turn is active; `steer` fails with `stale_turn` if that turn is gone; `auto`
  steers if a turn is active and starts otherwise. `clientRequestId` is the idempotency key: a repeated
  id returns the first result.
- **Provider-initiated requests are events plus a resolve call**, never reverse RPC:
  `interaction.requested` → `resolveInteraction`, `toolCall.requested` → `resolveToolCall`.
  `delivered: false` means the request is no longer pending.
- **Two event lanes.** `reliable` events carry a runner-wide `seq`, are kept until acked and are re-sent
  after a reconnect; the server dedupes on `(instanceId, seq)`. `live` events (terminal bytes, workspace
  change signals) are best effort. Thread events are batched for up to 100 ms and flushed immediately on
  `turn/started`, `item/completed`, `turn/completed`, a non-retrying `provider/error`, `system/error`, and
  before any interaction or tool-call request for that thread.
- **`snapshot()` after every (re)connect.** A new `instanceId` means the runner process restarted: the
  server interrupts every thread it believed active there. Same `instanceId`: nothing is interrupted;
  sessions the server thinks are active but the snapshot lacks are interrupted.
- The server assigns the stored per-thread `sequence`. The runner never does.
- The runner synthesizes: `provider.env-resolved` when a session is built or its env changes; on provider
  process death during a turn, `turn/completed {status:"failed"}` then `system/error
  {code:"provider_process_exited"}`; `system/error {code:"provider_turn_start_timeout"}` when an accepted
  turn has not opened after 120 s; on interrupt without provider settlement in 5 s, open items closed as
  `interrupted` then `turn/completed {status:"interrupted"}`.
- Agent environment: a scrubbed base (no `NODE_ENV`, no inherited `BB_*`), the login-shell `PATH` with the
  directory of this build's `bb` first, `BB_CLI`, `BB_SERVER_URL`, `BB_THREAD_STORAGE`, plus
  `SessionSpec.env` (`BB_THREAD_ID`, `BB_PROJECT_ID`, `BB_ENVIRONMENT_ID`, plugin-contributed variables).
  On a remote machine `BB_SERVER_URL` points at a loopback proxy inside the runner that forwards to the
  server with the machine's credentials.

### Provider adapters

`packages/runner/src/providers/{codex,claude,echo}.ts` implement `ProviderAdapter` and emit canonical
`ThreadEvent`s (minus `threadId`) through one shared `EventBuilder`, the only place turn and item ids are
minted (`<prefix>-t<n>`, `<prefix>-i<n>`, prefix `da` + 8 hex per session). The invariants the UI depends
on (scope per event type, item statuses, `presentation`, `parentToolCallId`, text coalescing, settling
open items when a session ends, never throwing on unknown provider traffic) are listed in research note
03, sections 1.6 and 8.

- Codex: one `codex app-server` child per thread over JSON-RPC stdio; `thread/start` or `thread/resume`,
  `turn/start`, `turn/steer`, `turn/interrupt`.
- Claude Code: one streaming-input `query()` per thread; `resume` by session id; approvals, questions and
  plan exit through `canUseTool`; bb dynamic tools through an in-process SDK MCP server.
- Echo: a scripted provider for development and tests, driven by directives in the prompt.

## Thread engine (server)

A thread's `status` is one of `pending | idle | starting | active | stopping | error`, changed only by one
compare-and-set writer. Work for one thread is serialized through a per-thread async queue.

- **Create** (`POST /threads`): validate; resolve provider, model, reasoning, permission mode and the
  environment intent (reuse | project checkout | managed worktree | personal workspace); insert the row;
  append `client/turn/requested` (the user message) and `client/thread/start`; answer 201; then, off the
  request: provisioning steps as `system/thread-provisioning` events, environment creation through the
  runner, title generation, and the first `submitTurn`.
- **Send** (`POST /threads/:id/send`) goes through one dispatch checkpoint that either submits or records
  a `queued_thread_messages` row with a typed `waiting_on` (`time`, `stopping`, `host-offline`,
  `thread-busy`, `turn-starting`, `provisioning`, `interaction`). Modes: `start`, `steer`,
  `steer-if-active`, `queue-if-active`, `auto`. Steer-on-Enter is a client choice between
  `steer-if-active` and an explicit queue row.
- **Queue drain** re-runs the checkpoint when a wait could have cleared: turn completed, stop settled,
  workspace ready, interaction settled, host connected, time reached. After a manual stop, rows that were
  waiting for the turn are held until the user sends again.
- **Ingest** (events from a runner): allocate sequences; drop `turn/diff/updated`, duplicate
  `turn/started`, second terminal event for an item; when an item completes, delete its earlier deltas
  except the first; upsert search segments for user and assistant messages; then apply effects: root
  `turn/started` → `active`; root `turn/completed` → `idle` / `error` / stop settled, drain the queue,
  notify the parent thread; `thread/identity` → store `provider_thread_id`.
- **Interactions**: at most one pending per thread; each state change appends
  `system/interaction/lifecycle`; stop, host loss and provider exit interrupt them.
- **Parent and child**: a child's root-turn outcome is batched for 2 s per parent and delivered as a
  `client/turn/requested` with `initiator:"system"` and body `[bb system]\n\n@thread:<id> completed: …`
  (steered into an active parent, started on an idle one, queued otherwise). `bb thread tell` from inside
  a thread prefixes `[bb message from thread:<id>]`.
- **Stop**: `stopping`, `interruptTurn`, then `idle`. **Archive** cascades to children and keeps a running
  turn for a 30 s undo window. **Delete** tombstones, removes storage through the runner, then deletes rows.
- **Restart**: at boot every thread that was `starting`, `active` or `stopping` on the local machine is
  interrupted (`turn/completed interrupted`, `system/thread/interrupted {reason:"host-daemon-restarted"}`,
  status `error`). The next message resumes the provider session from `provider_thread_id`.
- **Attention**: `latest_attention_at` moves on `active → idle` for threads without a parent and on any
  transition to `error`. Unread is `last_read_at < latest_attention_at`.

How the engine is built (`apps/server/src/threads`):

- Everything that changes a thread runs inside `engine.inThread(threadId, …)`. A task holds the queue only
  for short work (decisions, a transaction, building the `SessionSpec`). Runner calls that may take long
  (`submitTurn`, `interruptTurn`, environment creation) are fired from a task and settle in a later task, so
  a stop or a send never waits behind them. A task never awaits another thread's queue.
- Writes go through `engine.commit((out) => …)`: one transaction, with hub notifications and follow-ups
  collected in `out` and released after it commits.
- Queue rows are never claimed. The task that dispatches a row deletes it in the transaction that appends
  its `client/turn/requested`. A drain re-runs the checkpoint for the first group whose waits could have
  cleared; rows whose drain failed carry `failure_reason` and wait for "Send now".
- `status` is `starting` only while a workspace is being prepared. A send to a ready thread moves it straight
  to `active`; `active_turn_id` stays null until the root `turn/started` arrives (`turn-starting` wait).
- Seams on `ServerContext`: `threads` (the public operations, also for plugins), `environments`
  (`ensureForThread`, `pathFor`, `workspaceInstructions`, `onThreadDetached`; `environments/basic.ts` is the
  placeholder), `extensions` (plugin instructions, tools, env, events, title generation; empty by default).

## HTTP and WebSocket surface

Routes are declared once in `packages/server-contract/src/public-api.ts` and implemented with
`typedRoutes` from `@bb/hono-typed-routes`, so handlers are checked against the contract. Errors are
`{code, message, details?, retryable?}` with the HTTP status. Research note 01 lists every kept route, its
callers, the response shapes and the change notifications each mutation must emit.

- `/ws`: `subscribe` / `unsubscribe` / `ping` from the client; `changed` (entity, id, change kinds,
  metadata), `plugin-signal`, `thread-open`, `pong` from the server. Notifications are the only cache
  invalidation the UI has, so every mutation emits its change kind.
- `GET /threads/:id/timeline` returns projected rows for a window, with `afterSequence` deltas when the
  server still holds the rows it last served for that thread.
- `/ws/terminals/:id?sinceSeq=N`: terminal bytes with replay.
- `/internal/runner/join`, `/internal/runner/ws`: remote runners.
- File routes support a single `Range`.

## Plugins

A plugin is a directory with a `package.json` `bb` field (`name`, `description`, `icon`, optional
`server`, `app`, `skills`) and at most two entry files:

```ts
// server.ts
export default function plugin(bb: PluginServerApi) { ... }
// app.tsx
export default definePluginApp((app) => { ... });
```

In-repo plugins are listed in two static tables (`apps/server/src/plugins/builtin.ts`,
`apps/app/src/plugins/builtin.ts`) and compiled with the rest. External plugins are directories named in
`config.json`; the server bundles them with esbuild on load and the app imports the bundle. There is no
marketplace, installer, artifact store, version gating or CSS scoping.

Server API (`PluginServerApi` in `packages/plugin/src/server-api.ts`): `settings`, `storage.kv`,
`storage.database()` / `migrate`, `rpc`, `http`, `realtime.publish`, `background.service`,
`cli.register`, `events.on`, `agents.registerTool` / `contributeInstructions`, `ui.requestInput`,
`ui.registerMentionProvider`, `providers.contributeEnv`, `environments.register`,
`inference.register`, `threads` (spawn, send, get, list, stop, update, output, events — direct calls,
not HTTP), `projects`, `hosts`, `sections`, `files`, `status.needsConfiguration`, `onDispose`.

App API: slots `navPanel`, `threadPanel`, `settingsSection`, `appOverlay`, `pendingInteraction`,
`messageDirective`, `threadList`, `sidebarNavigation`, `sidebarHeader`; `commands.register`; hooks `useRpc`,
`useRealtime`, `useSettings`, `useSdk`, `useBbContext`, `useBbNavigate`, the sidebar thread hooks; components
`ThreadChat`, `NewThreadComposer`, `ProviderModelPicker`, `PermissionModePicker`.

Plugin commands (`bb tasks …`) are parsed and run in the server: the CLI posts
`{argv, cwd, threadId, projectId}` to `POST /api/v1/plugins/<id>/cli` and prints the result. The
response body is newline keep-alives followed by one JSON object `{exitCode, stdout, stderr}`, so a
command that waits on the user (a secret request) survives idle timeouts; `--<name>-stdin` is
materialised by the CLI before the request.

### Plugin host (server)

- **Loading.** `apps/server/src/plugins/builtin.ts` lists `{directory, server}` rows; the manifest is
  always the directory's `package.json` `bb` field. External directories come from
  `<dataDir>/config.json` `plugins: [{path, enabled}]`. An external server entry is bundled by esbuild to
  `<dataDir>/plugins/<id>/.cache/server.<hash>.mjs` (ESM, `@bb/plugin` compiled in, `better-sqlite3`
  resolved to the server's copy, the server's `node_modules` as a fallback resolution root) and
  imported; the app entry is bundled in memory and served at `/api/v1/plugins/<id>/app.js|app.css?h=`.
  An external plugin with a builtin's id replaces it.
- **Shared modules.** In an app bundle every specifier in `PLUGIN_SHARED_MODULES` (`@bb/plugin`)
  resolves to a CommonJS shim over `globalThis.__bbPluginRuntime["<specifier>"]`, which the app fills
  with its own module namespaces before importing any bundle. No export lists are generated.
- **State.** `enabled` is the `plugins` table row (default on) AND the config entry's `enabled` (a hard
  off switch that works with the server down). Status is `disabled`, `error` (the factory, the bundle
  or the manifest failed; the message is kept), `needs-configuration` or `running`. Enable, disable and
  reload dispose the old instance (services aborted, `onDispose` hooks in reverse order, the plugin
  database closed) and run the factory again, one change at a time. A settings write reloads a
  plugin that asked for configuration. A failing plugin never stops the server.
- **Storage.** KV rows in `plugin_kv`, non-secret settings in `plugin_settings`, secret settings as
  0600 files in `<dataDir>/plugins/<id>/secrets/` (reads return only `{set: boolean}`), the plugin's
  SQLite file at `<dataDir>/plugins/<id>/data.db`.
- **Trust.** Every plugin route sits behind the server's trust guard, so the caller is the owner or a
  machine credential. Machine credentials may call rpc, cli, mention search and read the list and
  settings (agents on other machines run `bb tasks …`); only the owner may enable, disable, reload,
  write settings or mint the plugin token. For `http.route`: `local` (default) admits only the owner,
  `token` admits any admitted caller presenting the plugin token (`x-bb-plugin-token` or `?token=`),
  `none` adds no check beyond the guard. Nothing is reachable anonymously.
- **Thread engine seam.** `ctx.plugins` answers the engine's queries (`instructionsFor`, `toolsFor`,
  `callTool`, `contributedEnv`, `emit`, `searchMentions`, `resolveMention`, `generateTitle`,
  `environmentProviders`, `skillDirs`). The calls a plugin makes outward (`threads`, `projects`,
  `hosts`, `sections`, `files`, `ui.requestInput`) come from `createPluginHostDeps(ctx)` in
  `apps/server/src/plugins/deps.ts`, which receives the calling plugin's id.

## Conventions

- No code comments (lint tool directives excepted). Names and small functions carry the meaning; this
  document and the tests carry the rest.
- Formatting: `oxfmt`, 80 columns. Lint: `oxlint`.
- Parse at boundaries with zod, pass typed values inside. No `any`; `unknown` only at boundaries.
- Async child processes only (no `spawnSync` / `execSync` outside scripts and tests).
- Every counted line is budgeted. Prefer deleting a feature's edge case over adding a layer for it.
