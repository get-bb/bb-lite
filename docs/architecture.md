# Architecture

bb is one server process, a web UI it serves, a `bb` CLI, and optional runner processes on other
machines. This document is the working contract between the packages. `INVENTORY.md` has the line
budgets; this file has the shapes.

## Packages

| Package                                       | Role                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server`                                 | The only stateful process, reduced to a host: the kernel, the plugin loader, the HTTP and WebSocket shells and the static web app. It names no feature                                                                                                                                                                                                                             |
| `packages/server-kit`                         | What server parts of core plugins share: the SQLite data layer, auth, the hub, HTTP helpers and trust, the runner registry. Its functions take the handles a plugin has on `bb` (`db`, `config`, `runners`, `realtime`); there is no server context object                                                                                                                         |
| `packages/runner`                             | Everything that happens on a machine: provider sessions (Codex, Claude Code, echo), git and worktrees, files, terminals, file watching. Runs in-process inside the server for the server's own machine, and as `bb runner` on every other machine                                                                                                                                  |
| `apps/cli`                                    | `bb`: every user feature, plus `bb server` and `bb runner`                                                                                                                                                                                                                                                                                                                         |
| `apps/app`                                    | Web UI host: the entry point, the route outlet and the loader for app parts. It names no screen                                                                                                                                                                                                                                                                                    |
| `packages/app-kit`                            | What app parts of core plugins share: the client data layer and hooks, UI primitives, the app's plugin runtime (registry, slots, parts) and components more than one feature uses. A file only one screen plugin uses lives in that plugin. Imported as `@bb/app-kit/<path>`                                                                                                       |
| `packages/thread-view`                        | Events → timeline rows. Projection runs in the server; row helpers run in the browser                                                                                                                                                                                                                                                                                              |
| `packages/domain`, `packages/server-contract` | Shared schemas: events, rows, entities, routes                                                                                                                                                                                                                                                                                                                                     |
| `apps/relay`                                  | bb-next relay: a Cloudflare Worker with one Durable Object per linked server. Accounts, device linking, and the public address `<label>.<domain>` that tunnels to a bb server. See `docs/relay.md`                                                                                                                                                                                 |
| `packages/plugin`                             | The kernel and the plugin API: contracts, operations, slots, core contracts, app hooks                                                                                                                                                                                                                                                                                             |
| `plugins/*`                                   | In-repo plugins. Core: ten server plugins (`identity`, `settings`, `projects`, `machines`, `sessions`, `threads`, `environments`, `terminals`, `workspace`, `audit-log`) and five app plugins (`shell`, `thread-view`, `composer`, `side-panel`, and the app part of `settings`). The rest are providers and add-ons (thread list, tasks, connect, audit, plugin tools and others) |
| `profiles/default`                            | Which in-repo plugins make up the product, as one table per runtime (`server.ts`, `runner.ts`, `app.ts`) and named profiles                                                                                                                                                                                                                                                        |

Dependency direction: `domain` ← `server-contract` ← `thread-view`, `plugin`, `runner` ← `server-kit` ←
`plugins/*` ← `profiles/default` ← `server` ← `cli`; in the browser `client-core`, `shared-ui` ←
`app-kit` ← `plugins/*` ← `profiles/default` ← `app`. A plugin imports `@bb/plugin`, the kits and the
shared schema packages, never `@bb/server`, `apps/` or another plugin's files (its `contract` aside).
The runner never imports the server. The server talks to machines only through the `Runner` interface
and the operations runner parts implement.

## Process and data model

- Default data directory `~/.bb-150k` (`BB_DATA_DIR`), default port `48886` (`BB_SERVER_PORT`), bind
  `127.0.0.1` (`BB_SERVER_BIND_HOST`). These differ from the original on purpose.
- The server refuses to start when the data directory contains a database with a
  `__drizzle_migrations` table (an original bb data directory).
- `bb import-legacy --from <dir>` (`apps/server/src/import-legacy.ts`) is the only code that reads an
  original database: read-only, with the server stopped, row for row into this schema and idempotent on
  primary keys. Thread content goes in one transaction per thread; a thread that already has events is
  skipped whole. Environments the original still had on disk are imported with `provider_owns_path = 0`
  (the runner only removes paths under its own data directory, and the original may still be using
  them). `apps/cli/guide/migrating.md` lists what is and is not copied.
- `<dataDir>/bb.db` (WAL), `attachments/<projectId>/`, `thread-storage/<threadId>/`, `worktrees/`,
  `plugins/<id>/` (plugin `data.db`, secrets, files), `AGENTS.md`,
  `config.json`, `connect.json` (0600), `host-id`, `logs/`.
- One schema file, `packages/server-kit/src/db/schema.sql`, applied through `PRAGMA user_version` steps. No ORM:
  `better-sqlite3` prepared statements behind small typed query modules. Never mock the database in tests;
  use `:memory:`.

Tables: `hosts`, `projects`, `project_sources`, `environments`, `threads`, `events`,
`queued_thread_messages`, `pending_interactions`, `thread_sections`, `thread_tabs`,
`prompt_history_entries`, `thread_search_segments` (+ FTS5 table and triggers), `project_attachments`,
`terminal_sessions`, `settings`, `ui_preferences`, `environment_variables`, `plugins`, `plugin_kv`,
`plugin_settings`, and from the second step (`schema-users.sql`) `users`, `user_sessions`,
`user_invites`, `thread_user_state`. That step also re-keys `thread_sections`, `ui_preferences` and
`thread_tabs` by user and hands everything that existed to the first owner; `threads.last_read_at`,
`pinned_at`, `pin_sort_key` and `section_id` remain as columns but are no longer read.

Differences from the original schema, chosen to delete derivation code:

- `threads` also stores `provider_thread_id`, `active_turn_id`, and the last execution tuple (`model`,
  `reasoning_level`, `permission_mode`, `service_tier`). The matching events are still appended, because
  the projection reads them.
- `hosts` stores `token_hash`, `join_token_hash`, `join_expires_at`, `connect_machine_id`,
  `last_instance_id`, `last_seen_at`, `owner_user_id`, `sharing`.
- `projects.execution_defaults` is a JSON column. Theme and keybinding overrides live in `settings`.
- `events` keeps the original envelope and columns exactly: `(id, thread_id, environment_id, scope_kind,
turn_id, provider_thread_id, sequence, type, item_id, item_kind, parent_tool_call_id, data, created_at)`.

Ids keep their prefixes (`thr_`, `proj_`, `env_`, `host_`, `evt_`, `qmsg_`, `pint_`, `term_`, `sec_`,
`creq_`). The personal project is always `proj_personal`. Timestamps are epoch milliseconds.

## Trust

Principals: `user(userId, role)`, `runner(hostId)`, `anonymous`. Roles are `owner` and `member`; the
first user (`usr_owner`, created by the schema and named after the server's OS user) is an owner.

- **Implicit owner.** A loopback request without the tunnel marker whose `Host` is a loopback name
  (`127.0.0.1`, `localhost`, `[::1]`) is the first active owner, with no sign-in: this is what keeps a
  local install and the `bb` CLI on the server machine working with no setup. If it carries an `Origin`,
  the origin must be the server's own loopback origin or its stored public URL.
- **Sessions.** Anything else needs the session cookie `bb_session_<port>` (HttpOnly, SameSite=Lax, 90
  days; the server stores only the SHA-256). That includes a loopback peer with any other `Host`, which
  is what a reverse proxy or `tailscale serve` looks like: a name in `BB_SERVER_ALLOWED_HOSTS` no longer
  makes a visitor the owner. A session request with an `Origin` must be same-origin (or the public URL).
- **Getting a session.** `POST /auth/login` (email and password, scrypt, ten failures per ten minutes
  per email); an invite link `/join?token=` (owner-created, seven days, single use, creates the account);
  a sign-in link `/signin?token=` (fifteen minutes, single use, for an existing user: `bb user
sign-in-link` on the server machine is how the owner signs a remote browser in the first time). Links
  are built from the public URL, else the request's `Origin`, else the request's own address.
- **Anonymous** requests on a direct connection may read the static app and call `/api/v1/auth/*` and
  `/internal/runner/*`; everything else under `/api/`, `/internal/` and `/ws` answers 401
  `unauthenticated`. Through the tunnel an anonymous request still gets 404.
- **Tunnel.** The tunnel client (bb connect, in process) marks what it forwards to the server with
  `x-bb-via-tunnel: <token>`, a secret the server makes at start and hands to plugins as
  `bb.server.tunnelToken`. A request carrying the header with any other value is anonymous and gets 404,
  so nobody who merely reaches the port can claim to be the gate. The marker is not sent to shared ports.
  With the marker, `x-bb-gate-auth: machine` is runner-class (allowed on `/internal/runner/*` and on
  `/api/v1/*` except writes to machines, settings, users and invites) and `x-bb-gate-auth: session` is a
  visitor the gate signed in:
  - no `x-bb-gate-user-id` (getbb.app, which only admits the account that owns the server), or
    `x-bb-gate-owner: 1`: the implicit owner;
  - a `x-bb-gate-user-id` stored as some user's `external_id`: that user;
  - `x-bb-gate-user-avatar` (an `https` URL) is kept as the user's `avatar_url` and refreshed when it
    changes; `User.avatarUrl` is what every avatar in the app shows, with initials as the fallback;
  - any other id: anonymous with an identity (name and email from `x-bb-gate-user-name` /
    `-email`), which may do what a direct anonymous request may. `GET /auth/session` then answers
    `{user: null, identity}`, and accepting an invite needs no password: the new user is created with
    that `external_id`. A sign-in link opened this way attaches the identity to an existing user.
- **Proxies.** A loopback request with a loopback `Host` that carries `X-Forwarded-For`,
  `X-Forwarded-Host`, `X-Forwarded-Proto`, `Forwarded`, `X-Real-IP`, `Via` or `Tailscale-User-Login` is
  not the implicit owner. A reverse proxy that adds none of these and rewrites `Host` to the upstream
  address (nginx's default `proxy_pass`) still looks local: configure it to send `X-Forwarded-For`.
- **Owner-only:** invites, other users' roles and disabling, plugin management, general settings, the
  shared machine environment, deleting a project. The last active owner cannot be demoted or disabled.

### Actors, machines and attribution

- Every request runs inside an actor (`packages/server-kit/src/auth/actor.ts`, an `AsyncLocalStorage`): the
  signed-in user, or for a runner-class request the user it acts for. An agent's `bb` sends
  `x-bb-thread-id` (from `BB_THREAD_ID`); when that thread lives on the calling machine the actor is the
  user who last sent a message there (`threads.last_actor_user_id`, else its creator), otherwise the
  machine's owner. Work with no request behind it (runner events, sweeps, timers) has no actor.
- A machine has `owner_user_id` (whoever added it; the server's own machine belongs to the first owner)
  and `sharing`: `private` (default) or `shared`. `RunnerRegistry.get` refuses an actor who neither owns
  the machine nor finds it shared with 403 `machine_not_shared`, so every route that would run something
  there is covered at one point; the thread engine checks the same before any write to a thread on that
  machine (send, queue, stop, archive, delete, interactions, rename), because a queued message never
  reaches a runner. Reading a thread is always allowed; private threads do not exist yet. Renaming,
  sharing, the permission limit, enrollment commands and removal belong to the machine's owner and to
  owners. `Host.usable` tells a client what the signed-in user may use, and the system config's
  `primaryHostId` is that user's default machine (their own, connected, the server's, in that order).
- `client/turn/requested` carries `actorUserId`, timeline user rows and queued messages carry it too,
  and `threads.created_by_user_id` records who started a thread. No actor means `null`.
- Per-user state: read, pin and section state live in `thread_user_state` (the thread list joins the
  viewer's row; a thread nobody touched counts as read for everyone but its creator), sections, UI
  preferences, thread tabs and prompt history are keyed by user, and appearance and keybindings are
  stored as `settings` rows `<key>@<userId>` that fall back to the shared row. Without an actor the
  viewer is the first owner.
- Presence: `/ws` sockets belong to a user; a client sends `{type:"presence", threadIds}` for the
  threads it shows and the hub broadcasts `{type:"presence", users:[{userId, threadIds}]}` when the set
  changes. `GET /users/presence` returns the same. The app shows it in three places: who is online (navigation
  rail), who else has a thread open (its header, and its row in the sidebar through the plugin component
  `ThreadViewers`). `thread-open` signals go to the acting user's sockets.

- A runner authenticates to `/internal/runner/ws` with `Authorization: Bearer <runner token>`; the server
  stores only the SHA-256. `bb runner join <blob>` exchanges a 15-minute single-use join token for it at
  `POST /internal/runner/join`. Runner endpoints must stay under `/internal/` (the hosted gate only passes
  machine credentials there).
- A request without the tunnel marker that carries `Authorization: Bearer bbr_…` is judged by that token
  alone, whatever its peer address: a token that matches a host is the same runner-class principal as a
  gate-authenticated machine (so `/api/v1/*` minus the operations a machine may not call), any other is
  anonymous. This is how the runner's loopback CLI proxy reaches the API on a direct connection; through
  the tunnel the gate's verdict stands and the bearer token only authenticates the runner socket.
- The server's public URL (`publicServerUrl(ctx)`: the `Origin` allow-list above, join commands, the URL
  handed to remote sessions, the system config) is what a plugin set with `bb.server.setPublicUrl`, else
  the `machineServerUrl` setting. bb connect sets it to the linked `serverUrl` while remote access is on.

## The Runner interface

`packages/runner/src/types.ts` defines `SessionApi`: describing the machine, the event outbox,
provider sessions and turns, loading runner parts and `callOp`. `Runner = SessionApi & { call }`,
where `call(op, input, { timeoutMs? })` runs an operation in the machine's own kernel. Git, files,
terminals, lifecycle scripts and file watching are operations (`packages/runner/src/contract.ts`:
`git`, `machineFiles`, `machineTerminals`, `workspaces`) implemented by the built-in `workspace`
runner part (`workspace/part.ts`), so another runner part can hook, refuse or answer them. Each
declares how long the server waits for it. Two implementations of `Runner`:

- `createLocalRunner({ dataDir, serverUrl, sink })`: direct calls, events through a callback.
- `connectRemoteRunner(socket, sink)` on the server and `serveRunner(runner, socket)` in `bb runner`:
  the same interface as JSON frames over one WebSocket (`packages/runner/src/remote/protocol.ts`):
  `{t:"req",id,method,params}` → `{t:"res",id,ok,result|error}`, `{t:"evt",event}`, `{t:"ack",seq}`,
  `{t:"ping"}`/`{t:"pong"}`. Only the methods of `SessionApi` can be called; an operation travels
  as `callOp`.

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
- `<dataDir>/runner.json` (0600) holds `{serverUrl, hostId, runnerToken, headers}`; `headers` (from the
  join blob, a reused legacy machine config and `--header`, later ones winning) go on the join request,
  the socket upgrade and everything the CLI proxy forwards. Default directory
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

`plugins/provider-{codex,claude-code,echo}/runner/` implement `ProviderAdapter` (the interface and
its helpers stay in `packages/runner/src/providers/provider.ts`) and emit canonical
`ThreadEvent`s (minus `threadId`) through one shared `EventBuilder`, the only place turn and item ids are
minted (`<prefix>-t<n>`, `<prefix>-i<n>`, prefix `da` + 8 hex per session). The invariants the UI depends
on (scope per event type, item statuses, `presentation`, `parentToolCallId`, text coalescing, settling
open items when a session ends, never throwing on unknown provider traffic) are listed in research note
03, sections 1.6 and 8.

- Codex: one `codex app-server` child per thread over JSON-RPC stdio; `thread/start` or `thread/resume`,
  `turn/start`, `turn/steer`, `turn/interrupt`.
- Claude Code: one streaming-input `query()` per thread; `resume` by session id; approvals and questions
  through `canUseTool`; `EnterPlanMode` and `ExitPlanMode` are disallowed tools; bb dynamic tools through
  an in-process SDK MCP server.
- Echo: a scripted provider for development and tests, driven by directives in the prompt.

**Custom models.** `<dataDir>/config.json` may list models the provider's own catalog does not
offer: `customModels: [{providerId, model, displayName?, description?, env?, unsetEnv?}]`. Each is
added to that provider's model list (hidden in streamer mode). An entry with `env` or `unsetEnv` is
also passed to the runner in `SessionSpec.customModels`; the Claude Code adapter then sets and
removes those variables in the agent's environment for sessions that run that model, and starts a
new process when a turn switches to or from it. Codex and echo ignore `env` and `unsetEnv`. An
invalid `customModels` value is logged and ignored as a whole.

## Thread engine (server)

A thread's `status` is one of `pending | idle | starting | active | stopping | error`, changed only by one
compare-and-set writer. Work for one thread is serialized through a per-thread async queue.

- **Create** (`POST /threads`): validate; resolve provider, model, reasoning, permission mode and the
  environment intent (reuse | project checkout | managed worktree | personal workspace); insert the row;
  append `client/turn/requested` (the user message) and `client/thread/start`; answer 201; then, off the
  request: provisioning steps as `system/thread-provisioning` events, environment creation through the
  runner, title generation, and the first `submitTurn`. Titles come from the first service in
  the `sessions.inference` slot; when the slot is empty, from the `sessions.titleFallback` service,
  which `provider-codex` provides (`plugins/provider-codex/title-service.ts`): it reads the Codex CLI's
  own `auth.json` (never written, never logged) and asks the Codex responses endpoint within 5 s. Under
  vitest the service refuses its real endpoints, so tests never call out.
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

How the engine is built (`plugins/threads`):

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
- Seams: the engine calls `environments.ensure` and `environments.instructions`, `sessions.instructions`,
  `sessions.env`, `sessions.tools`, `sessions.skillDirs` and `sessions.title`, and
  `plugins.callAgentTool` for a tool call. It emits the thread events and `threads.retired`
  (terminals close on it), and listens to `projects.deleted`. Other plugins reach it through the
  `threads` operations, including `threads.workspace`, and it implements the `interactions` contract. Startup order is
  local host, personal project, engine, then plugins.

## Environments (server)

An environment is the directory a thread runs in. Three built-in kinds, all in `plugins/environments`
(`manager.ts`, `scripts.ts`): **project checkout** (the project's own path on a machine, or any existing
directory; one row per `(project, machine, path)`, shared, never removed), **managed worktree**
(`<runner dataDir>/worktrees/<threadId>-1/<repo>` on branch `<managedBranchPrefix><title-slug>-<threadId>`) and
**personal workspace** (`<runner dataDir>/workspaces/<threadId>`). The last two are _managed_
(`provider_owns_path = 1`): bb created the path and removes it. A plugin adds further managed kinds through
the `environments.kind` slot (see "Runner parts").

- Work on one environment is serialized through a per-environment queue, so preparing, switching branch and
  tearing down never interleave. Status walks `creating → provisioning → ready | error`; every write notifies
  (`environment-created`, `status-changed`, `metadata-changed`).
- `ensureForThread` takes the engine's intent. `reuse` returns a ready environment or prepares it again;
  `project-default` asks the runner whether the project source has a default branch (worktree) or not
  (checkout). A managed row is created with `owner_thread_id` before its path exists; the owner counts as a
  user of the environment until the engine sets `threads.environment_id`, and a later attempt by the same
  thread (after a failed or cancelled setup) finds that row again and continues on it.
- Managed paths run `.bb-env-setup.sh` after creation (15 min, output streamed into the provisioning
  transcript; a failure or timeout leaves the environment in `error` and fails the thread's provisioning) and
  `.bb-env-teardown.sh` before removal (a failing script is logged, removal continues). Aborting the engine's
  signal cancels a running setup script through `cancelOperation`.
- A checkout branch switch (`inputs.branch`) is refused while another unarchived thread uses the checkout;
  the runner refuses a dirty or detached checkout.
- **Retirement.** A managed environment with no unarchived thread gets `retire_at = now + 5 min`; deleting
  its last thread sets `retire_at = now`; an unarchived thread clears it. A sweep (every 10 s, after
  `onThreadDetached`, and when a machine connects) tears down what is due on a connected machine: status
  `error` while it runs, then `destroyed` with `teardown_status = removed`. A failed removal records
  `teardown_status = failed` and the message and is retried every minute, five times in all. Branches are kept.
- **Restore.** A send to a thread whose environment is not `ready` goes through provisioning again with a
  `reuse` intent: a destroyed worktree is re-created on its branch at the same path (and fails if the branch
  is gone), setup runs again, and the provider session resumes there.
- `DELETE /environments/:id` (409 while unarchived threads use it) tears down at once; the row is deleted
  when no thread references it and kept as `destroyed` otherwise. Deleting a project removes its managed
  paths on connected machines without running teardown scripts.

## Stored data and shared schemas

`packages/domain` decodes what is already on disk, including rows `bb import-legacy` copied from the
original product, so its event, item, scope, presentation and pending-interaction schemas accept more than
this product writes. Facts the code no longer states in comments:

- `system/provider-turn-watchdog` and `system/manager/user_message` have no producer. They stay so stored
  events decode and render.
- A stored `client/turn/requested` carries `retryOfRequestId` and `retryAttempt` together or not at all
  (attempt 2 is the first retry, and the id is always the original request's). The stored-event parser
  checks the pair, because the discriminated union the base schema feeds cannot carry a refinement.
- Recorded execution options are history: the stored-event schema accepts the retired permission modes
  `workspace-write` and `readonly`, which are not current modes (a request may still say
  `workspace-write`, read as `accept-edits`).
- `systemMessageKind: "unlabeled"` marks system messages stored before the kinds existed; they render
  generically. `system-message.ts` is its own module because both `thread-events.ts` and
  `queued-message.ts` import it; folding it into either makes the two import each other and leaves the
  second one loaded holding `undefined` schemas.
- Queued messages: `waitingOn` is `null` for a row that is simply next in line (and for rows stored before
  waits were typed). `failureReason` is not part of `waitingOn` because every new wait replaces
  `waitingOn` whole. `waitHolder` repeats a plugin wait's owner in an indexed column and is only ever
  written with it. A `host-offline` wait stores the machine's display name because the code that words
  the wait has no database. `editable` is the server's answer; clients do not derive it. In a thread's
  queue state `failed` outranks `waiting`.
- Event scope (`thread-event-scope.ts`) is fixed per event type. Turn scope: what belongs to one turn's
  transcript. Thread scope: thread metadata (identity, name, goal, extension state, rate limits, resolved
  environment), client requests (recorded before a provider turn exists), provisioning, interruption, and
  background task and delegation progress and completion, which outlive the turn that spawned them (thread
  scope keeps every turn's sequence range contiguous). Either: context-window usage, provider errors,
  warnings, model fallback and unhandled events, system errors, operations and interaction lifecycle,
  which are turn-scoped inside a turn and thread-scoped outside one.
- Settings and preferences are read leniently, because an import copies the original's rows: a UI
  preference row whose key this build does not define is ignored, a keybinding override for a command
  that no longer exists is dropped without touching the others, unknown general settings are stripped,
  and an appearance naming a theme that is not built in shows the default palette.
- `code-themes/*.ts` describe the light syntax themes shiki does not ship (Nord, Dracula) as a recolouring
  of the bundled dark theme: a `swap` of the few colours that differ and the `colors` the highlighter
  reads (`editor.foreground`/`background`, `gitDecoration.*ResourceForeground`, `terminal.ansi*`). The
  app registers each one with a loader that resolves the dark theme and calls `deriveLightCodeTheme`
  (`packages/app-kit/lib/code-theme-registration.ts`); the result equals the hand-expanded themes of the
  original rule for rule.
- Only an `explicit` execution input source (a user choice) updates a project's execution defaults; a
  `client-preference` (a remembered default) does not.
- A plugin id is the npm package name without scope and without the `bb-plugin-` prefix, lowercased
  (`@me/bb-plugin-linear` → `linear`).
- `provisioning` and `waiting-for-host` are display-only refinements of a thread's stored status.

## HTTP and WebSocket surface

Every JSON route is the HTTP door of an operation (`doors.http` in
`packages/plugin/src/core-contracts.ts`), served by `apps/server/src/http/doors.ts`: path parameters,
the query or the JSON body become the operation's one input, the kernel validates it, checks who may
call it, runs the hooks and records the call. A path starts with its contract's name
(`/threads`, `/machines`, `/sections`, `/sessions/providers`). `packages/plugin/src/client.ts` is the
one client: `call(op, input)` builds the request from the same declaration, with one place for
timeouts and error bodies. Raw routes remain only for sign-in (cookies), uploads, file bytes and
plugin assets. Errors are
`{code, message, details?, retryable?}` with the HTTP status. Research note 01 lists every kept route, its
callers, the response shapes and the change notifications each mutation must emit.

- `/ws`: `subscribe` / `unsubscribe` / `ping` from the client; `changed` (entity, id, change kinds,
  metadata), `plugin-signal`, `thread-open`, `pong` from the server. Notifications are the only cache
  invalidation the UI has, so every mutation emits its change kind.
- `GET /threads/:id/timeline` returns projected rows for a window, with `afterSequence` deltas when the
  server still holds the rows it last served for that thread. The projection is kept per thread and request
  (page, nesting, display settings, thread status, name and workspace path) and reused while the thread's
  last event sequence is unchanged: 32 such keys, the four latest projections each. Turn details are always
  projected afresh. Event rows read from SQLite are kept by id up to 24M characters, which is what makes a
  re-projection after an append cheaper than the first one.
- Responses are compressed when the client accepts it (brotli, else gzip): JSON answers of 1 KB or more
  written through `c.json`, and compressible static assets (compressed once, kept by content). File bytes,
  attachments, plugin HTTP routes, the plugin CLI stream and the event long-poll are sent as they are.
- `/ws/terminals/:id?sinceSeq=N`: terminal bytes with replay.
- `/internal/runner/join`, `/internal/runner/ws`: remote runners.
- File routes support a single `Range`.

## Plugins

bb is a small kernel plus plugins. `docs/plugin-api-proposal.html` is the reasoning,
`docs/plugin-api.md` is how to write one, and this section is the exact behaviour. A plugin is a
directory with a `package.json` `bb` block (`name`, `description`, `icon`, optional `server`, `app`,
`runner`, `requires`, `skills`) and a contract. Its id is the package name without scope and without
`bb-plugin-`.

### Kernel

`packages/plugin/src/kernel.ts` is runtime-neutral. The server (`apps/server/src/kernel`), each
runner (`packages/runner/src/plugins.ts`) and the browser (`packages/app-kit/plugins/registry.ts`) each
hold one kernel.

- **Contracts** (`contract.ts`). `contract(id, { name: op | event | slot | service | live })` names
  each member `<id>.<name>`. An operation has zod `input` and `output`, a `kind` (`read` | `write`),
  what a hook may do (`observe` | `rewrite` | `answer`), who may call it (`member` | `owner`; work with
  no actor passes), `secret` field names and `doors`. `service<T>()` is a pick-one slot holding an
  object. `live(schema)` is a value the server holds.
- **Verbs.** A plugin's `bb` has `implement`, `call`, `on`, `emit`, `add`, `wrap`, `read`, `entries`,
  `find`, `pick`, `use`, `provide`, `value`, `changed`. One plugin implements an operation; a second
  `implement` throws. Hooks run by tier (`policy`, `installed`, `product`: external plugins are
  `installed`, in-repo and core ones `product`), then in registration order, and the implementation is
  the last link. `on(op, matcher, hook)` runs the hook only when every matcher field equals the
  input's. A hook is `(input, next)`; `next.origin` is the caller. The implementation receives
  `{ caller, signal }`.
- **What a hook may do** is the operation's `hooks`: `observe` ignores what the hook passes to `next`
  and returns; `rewrite` lets it change both but it must call `next`; `answer` also lets it return
  without `next` or `deny(reason)`, which rejects with `OpError` `denied` (HTTP 403 `denied_by_plugin`,
  `details.plugin`). A hook that throws, or whose own time (not counting time inside `next`) passes
  10 s, is logged and skipped (the result beneath it stands), unless it was registered `.failClosed()`
  (only on `answer` operations), which refuses the call. The implementation's own error passes through
  unchanged.
- **Slots.** `add` appends an entry and returns its remover. `read` returns items in order; a keyed slot
  returns one per key and `find(slot, key)` the winner; `pick` / `use` return the winner of a pick-one
  slot (or null / throw). The winner is the `installed` entry over the `product` one, then the later
  one. `wrap(slot, matcher, change)` replaces matching items with `change(item)` for every reader.
  `entries` adds the owning plugin. Results are cached until the slot changes; `watch` notifies.
- **Live values.** `provide(live, initial)` returns `{ get, set, update }`; setting it, or
  `changed(op | live)`, pushes a `plugin-signal` `{pluginId: "kernel", channel: "changed", {name}}` to
  every socket. Apps refetch `useOp` / `useLive` for that name.
- **Unload.** Everything a plugin registered through its `bb` is reversed when it is disposed, and a
  displaced slot winner or freed operation is available again. The verbs of a disposed plugin throw.
- **Caller.** `currentCaller()` (`kernel/caller.ts`) is the actor plus an origin: `door` (`agent` when
  the request named a thread, else the `x-bb-door` header when it is `app` or `cli`, else `http`;
  `system` with no actor), the agent `thread`, and `via`, the plugin ids the call passed through. A
  request made with a machine credential has the role `machine` whoever it acts for: it cannot call
  owner-only operations, nor those marked `allow: "user"` (changing machines, settings, users,
  providers or the machine environment), through REST or by name. A
  plugin's `bb.call` and its CLI handlers add the plugin to `via`. The app, the client and the
  native CLI send `x-bb-door`. An agent's tool call runs as the user who last wrote in that thread.
- **Audit.** The kernel writes one `audit_log` row (third schema step) per `write` operation, and per
  read that a hook answered or refused or that failed: time, operation, user, role, door, thread,
  `via`, the hooks that acted (`rewrote-input`, `rewrote-output`, `answered`, `denied`, `failed`),
  outcome, detail, duration and the input as JSON cut to 600 characters with secret fields replaced.
  `audit.list` returns them newest first; a member gets only their own. A plugin that acts without an
  operation (`node:fs`, `fetch`) leaves no row; that is accepted.

### Doors

- **App.** `POST /api/v1/ops/<name>` calls any operation not marked `internal` (the core operations
  whose inputs are not fully described by a schema are) with the JSON body as input (an empty body is
  `{}`) and answers `{ok, result}`; a live value's name answers its value. An implementation's plain
  `Error` is 500 `handler_error` with its message. `GET /api/v1/kernel` is the inspection: operations
  with owner, doors and hook chain, events with listeners, slots, live values, plugins.
- **Agent.** An operation with `doors.agent` (`name`, `description`, `instructions`, `presentation`,
  `enabledFor(context)`) is offered to sessions as a dynamic tool (`plugins/doors.ts`). The tool's
  input schema is the operation's. A string result is returned as is, anything else as JSON;
  `toolError(text)` returns `text` as a failed result.
- **CLI.** Operations with `doors.cli` (`path`, `summary`, `positionals`, `print`) owned by a plugin
  become that plugin's `bb <first word> …` command: flags come from the input schema (camelCase to
  kebab, booleans are switches, arrays repeat, objects take JSON, `cwd` is filled from the caller),
  `--json` prints the output. A plugin that also calls `bb.cli.register` gets both: its own commands
  and the door commands.
- **Machines.** `bb.runners.call(hostId, op, input)` calls an operation a runner part implements
  (`Runner.callOp`), validating input and output on the server.

### Core plugins (server)

The server's own features are plugins in `plugins/`, listed as `corePlugins` in
`profiles/default/server.ts` and loaded by the same loader as every other plugin: `identity`,
`settings`, `projects`, `machines`, `sessions`, `threads`, `environments`, `terminals`, `workspace`,
`audit-log`. Each is a directory with a manifest and a `server.ts` that receives the
ordinary `PluginServerApi`. `apps/server` keeps only what loads them (kernel scope `plugins`: the
`plugins.*` operations and the `/plugins` and `/kernel` routes).

- **Nothing beyond the plugin API.** A core plugin receives `bb` and nothing else. The host's
  services are members of it for every plugin: `bb.db`, `bb.realtime`, `bb.runners`, `bb.server`,
  `bb.now`, `bb.http.api(routes)` (Hono routes under `/api/v1` or `/internal`) and
  `bb.http.socket(resolver)` (a WebSocket endpoint). Each registration is removed when the plugin
  unloads; the HTTP app is assembled again from the current routes on the next request.
- **Between core plugins.** There is no shared context object. `threads`, `environments`,
  `terminals`, `sessions`, `projects`, `machines` and `identity` reach each other through
  operations, events and services in `packages/plugin/src/core-contracts.ts` (and
  `plugins/environments/contract.ts` for `environments.ensure`, whose types live in the kit). A
  call from one plugin to another is recorded with the calling plugin in its chain; a plugin
  calling its own operation adds nothing.
- **What the host still does.** Loads plugins, stores their settings and tables, assembles HTTP and
  sockets, writes the audit record, and turns operations into agent tools and CLI commands
  (`plugins.agentTools`, `plugins.callAgentTool`). It asks `server.authenticator` (identity) who a
  request is from and `machines.guard` (machines) whether the caller may use a machine.
- **Machines a plugin makes.** `plugins/machines/provided.ts` implements `machines.enroll`
  (a host row in `creating` with `machine_provider_id` and `resource`, plus a join command),
  `waitConnected`, `update`, `suspend` and `resume` (through the `machines.provider` entry, setting
  `suspended_at`), and `remove`; it emits `machines.connected`, `disconnected` and `signal` (a
  runner part's `bb.signal`, carried as the live runner event `plugin.signal`). An environment
  kind's `create` may return the machine it made; the environment row moves to it.
- **Plugin rows.** `threads.addRow` appends a `system/operation` event with operation
  `plugin_row`; the projection (`packages/thread-view`) carries `plugin: { id, kind, data }` on the
  generic operation row and replaces the row when the same operation id arrives again.
- **Order.** Plugins load in table order refined by `requires` (`threads` needs `machines` and
  `projects`; `environments` needs `threads`; `workspace` needs `terminals`).
  Every entry runs first; then each plugin's `bb.onStart` callbacks run in the same order (local
  host, personal project, engine, environments, terminals, workspace watch), then add-on services.
- **Always on.** A core plugin cannot be disabled; `InstalledPlugin.core` marks it and Settings
  lists it without a toggle.
- **Forkable.** `bb dev fork threads` copies the directory and loads the copy in the engine's
  place. A fork's bundle resolves `@bb/server-kit/*` and `@bb/runner` to the host's own module
  instances (`apps/server/src/plugins/runtime.ts`, checked by a test to cover every kit module),
  so actors, error classes and the database handle are shared.

What core offers to plugins is `packages/plugin/src/core-contracts.ts`: `threads` (the writes,
`get`, `list`, `output`, `events` and the lifecycle events), `sessions` (`instructions`, `env`, and
the slots `provider`, `mention`, `inference`, `titleFallback`), `interactions`, `files`, `projects`,
`machines` (`list`, the `access` service), `users`, `sections`, `environments.kind`,
`server.publicUrl`, `server.authenticator`, `plugins` (`inspect`, `install`, `uninstall`, `reload`,
the agent-tool operations), `audit.list`. Every thread write goes through its operation, so routes
and plugins share one hook chain.

### Plugin host (server)

- **Loading.** `profiles/default/server.ts` lists `{directory, server}` rows for in-repo plugins;
  `BB_PROFILE` (`default`, `headless`, `minimal` in `profiles/default/profiles.ts`) picks which of
  them load. External directories come from `<dataDir>/config.json`
  `plugins: [{path, enabled, watch}]`. An external server entry is bundled by esbuild to
  `<dataDir>/plugins/<id>/.cache/server.<hash>.mjs` and imported; the app entry is bundled in memory
  and served at `/api/v1/plugins/<id>/app.js|app.css?h=`. An external plugin with a builtin's id
  replaces it on the server, in the app and on every runner; removing it restores the builtin.
  `bb.forkOf` names the builtin a copy came from, whose `node_modules` then back the copy's imports. Plugins load in `requires` order; a plugin whose requirement is not running is in
  `error`. `watch: true` reloads a plugin 200 ms after a file in its directory changes.
- **Shared modules.** In an app bundle every specifier in `PLUGIN_SHARED_MODULES` resolves to a shim
  over `globalThis.__bbPluginRuntime`, which the app fills before importing any bundle. Host modules
  (`PLUGIN_HOST_MODULES`, `@bb/shared-ui/*` and `@bb/app-kit/*`) resolve the same way but are imported
  by the app only when a bundle lists them in `shared`.
- **Styles.** A bundle's imported `.css` is served as `app.css`. Tailwind classes are handled once
  for all external plugins: each bundle records the candidates the app's own sources do not contain,
  and when that set changes the host compiles the app's candidates plus the added ones against
  `packages/app-kit/components/ui/theme.css` into `/api/v1/plugin-utilities.css?h=`. The app loads that
  sheet after its own, so it supersedes the built utilities layer with the same rules in one order.
  With no added classes there is no sheet.
- **Own location.** In server and runner bundles `import.meta.url` is rewritten per source file to
  that file's URL.
- **Lifecycle.** A server entry may register `bb.onStart(start)`. At boot every plugin's entry runs
  before any `start`; on a single reload `start` follows the entry. A function returned by `start`
  runs on dispose. Unloading at shutdown goes in reverse dependency order.
- **State.** `enabled` is the `plugins` table row (default on) AND the config entry's `enabled`.
  Status is `disabled`, `error`, `needs-configuration` or `running`. Enable, disable and reload
  dispose the old instance (services aborted, `onDispose` hooks in reverse order, the kernel scope
  and the plugin database closed) and run the factory again, one change at a time. A failing plugin
  never stops the server.
- **Shared tables.** `bb.storage.tables` (`apps/server/src/plugins/tables.ts`) gives a plugin
  tables named `p_<id>_<name>` in the main database. Migrations are tracked per plugin in
  `plugin_table_migrations` and may only define the plugin's own objects; `run` only writes to
  them; `all` and `get` take a `SELECT`. A contract's `table()` member is a one-item slot holding
  the physical name, so publishing and reading go through the kernel like any service.
- **Storage.** KV rows in `plugin_kv`, non-secret settings in `plugin_settings`, secret settings as
  0600 files in `<dataDir>/plugins/<id>/secrets/`, the plugin's SQLite file at
  `<dataDir>/plugins/<id>/data.db`. A setting defined with `{ scope: "user" }` is stored per
  person as `<key>@<userId>` (a member may write their own); KV is one scope for the whole server.
- **Trust.** Every plugin route sits behind the server's trust guard. Any signed-in user or machine
  credential may call operations (each operation's `allow` decides further), a plugin's CLI and
  mention search; only an owner may enable, disable, reload, write settings or mint the plugin token.
  For `http.route`: `local` (default) admits only an owner, `token` admits any admitted caller
  presenting the plugin token, `none` adds no check beyond the guard.
- **`interactions.ask`.** Opens a plugin-origin pending interaction and resolves with `submitted` or
  `cancelled` (`reason`: `user`, `timeout`, `request-aborted`, or the interrupt reason of a stop). The
  submitted value goes to the waiting plugin only; the stored resolution keeps what the request's
  `describeSubmission(value)` returned.
- **`files`.** A relative path is confined to the thread's workspace; an absolute path may point
  anywhere on the thread's machine. Writes create parent directories and honour `mode` and
  `expectedSha256`.

### Runner parts

- `packages/runner/src/plugins.ts` gives every runner a kernel and the `runner` contract
  (`runner.provider`, a slot of `ProviderAdapter` keyed by id). The session manager reads providers
  from that slot on every call, so a provider can arrive or leave while the runner runs.
- A plugin's `runner` entry is `(bb: PluginRunnerApi) => void`. In-repo ones are listed in
  `profiles/default/runner.ts` and passed to `createLocalRunner` / `runRunner` as `parts`.
- For an external plugin the server bundles the runner entry (`@bb/runner` and `@bb/plugin` resolve
  to the runner's own modules through `globalThis.__bbRunnerRuntime`) and calls
  `Runner.loadPlugins({plugins: [{id, hash, code}]})` on every connected runner when plugins change
  and when a runner connects. The runner writes each bundle under
  `<runner dataDir>/plugins/<id>/.cache/`, imports it, and unloads shipped parts that are no longer
  in the list. A failed part is reported and logged; the others load.
- Providers are plugins: `plugins/provider-codex`, `provider-claude-code` and `provider-echo` each
  have a runner part that adds its adapter and a server part that adds a `ProviderDeclaration` to
  `sessions.provider` (name, logo, capabilities, reasoning levels, settings toggles). The echo plugin
  registers only under vitest or `BB_DEV_PROVIDERS=echo`. A provider's toggles are ordinary plugin
  settings of `provider-<id>`; the fourth schema step moves the old `providerSettings:*` rows there.
- An environment kind added to `environments.kind` (`{id, displayName, icon, create(context),
remove({hostId, path})}`) is a managed environment owned by its thread: `create` returns the path,
  setup and teardown scripts run as for a worktree, `remove` replaces the runner's removal. The
  `environments` core plugin adds its three built-in kinds to the same slot (with a `resolve` that
  finds or creates the row and, for managed ones, a `materialize`), so a plugin that adds a kind with
  a built-in's id replaces it: `project-default` on a git project then uses the plugin's
  `git-worktree`.

### App

- The app's registry is a kernel too (`packages/app-kit/plugins/registry.ts`). An app part is a
  plain function that receives the same handle shape as a server part: the verbs, `pluginId`,
  `log`, `onStart` (run once plugins have settled) and `onDispose`. There are no slot shorthands:
  every slot is filled with `bb.add`. `bb.call` and `callOp` run an operation the app implements,
  else `POST /ops/<name>`.
- **Slots and their readers.** A slot is declared in the contract of the plugin that reads it
  (`shell`, `threadView`, `composer`, `sidePanel`, `settings`, `app` in `packages/plugin/src`). A
  slot may carry a `check` that the kernel runs on `add`; the id-bearing shell slots use it to
  refuse malformed, duplicate or view-less entries. Readers that need the owner use
  `useOwned(slot)` (`packages/app-kit/plugins/slots.tsx`).
- **Feature hooks.** `useSidebarThreads`, `ThreadChat`, `useComposer` and the rest in
  `@bb/plugin/app` forward to typed services (`shell.api`, `threadView.api`, `composer.api`) that
  those plugins provide. The host table (`apps/app/src/plugins/host.tsx`) holds only what the
  host itself owns: routing, the client, settings, library components.
- **Core app plugins.** The screens are five plugins, listed as `coreAppPlugins` in
  `profiles/default/app.ts` and registered before the first render: `shell` (layout, sidebar,
  command palette, routes, navigation rail items, thread actions), `thread-view` (the thread page,
  timeline rows and row details), `composer` (prompt box, pickers, new-thread screen, "+" menu and
  footer controls), `side-panel` (tab kinds, files, diffs, plugin panels) and `settings` (pages and
  the settings routes). Each is `plugins/<id>/app.tsx` plus `plugins/<id>/app/`. `apps/app/src` is
  the entry, `App.tsx` (providers, then whatever provides `app.root`; the shell does, and it renders
  `shell.route` entries inside its layout) and the loader.
- **Parts.** A feature never imports another feature's files. What others need is published in
  `plugins/<id>/contract.ts` as typed parts: `part<typeof Module.Component>("<id>", "Component")`
  for a component and `callPart<typeof Module.useHook>(…)` for a hook or function
  (`packages/app-kit/plugins/parts.ts`). `plugins/<id>/parts.ts` re-exports the implementations and
  the entry adds them to the `app.parts` slot (`bb.add(app.parts, { plugin, parts })`). A part resolves when it renders or is called, so
  whichever plugin currently provides `<id>` is used; nothing renders while none does. Consumers
  import `bb-plugin-<id>/contract`; lint rejects any other path into another plugin.
- **What is in the kit.** Anything two features or the host share, and anything that must be one
  instance: jotai atoms, React contexts, the query client, the socket. Feature directories hold the
  rest.
- **Replacing a core app plugin.** When the server lists a core id with an external app, the loader
  unregisters the built-in registration and registers the bundle under the same id; removing the
  external plugin registers the built-in one again. Routes of the five core ids render without a
  plugin boundary wrapper, as before.
- In-repo add-ons' app parts are listed as `appPlugins` in `profiles/default/app.ts` and loaded on
  demand; external ones are imported from their bundle. Slot readers see entries sorted by plugin
  id, then registration order.

### Tooling

`plugins/plugin-dev` adds `bb dev …` through CLI doors: `inspect [name]`, `new <id>`,
`watch <dir>`, `validate <dir>` (manifest check plus what the source implements, hooks, calls, adds,
and where it reaches Node built-ins, `fetch` or `process.env`), `types <dir>` (links the packages bb shares into the plugin's `node_modules` and writes a tsconfig), `install <git:url[#ref] | npm:spec | dir>` (fetched under
`<dataDir>/plugins-src`). `fork <id> [path]` copies a builtin's directory
(without `node_modules`, tests or caches), marks it `forkOf`, writes its types and loads it
watched; a test forks every builtin and checks each copy runs. With `--as <new-id>` the copy is
renamed (package, contract id, parts, CLI name, agent tool names) and runs beside the original. It ships the `bb-plugin-authoring` skill. Lint rule `bb/plugin-imports`
keeps files under `plugins/` (tests excepted) from importing `@/…`, `@bb/server`, the profile, or
another plugin's files other than its contract.

## CLI

`apps/cli` is one table and one engine.

`apps/cli/bin/bb` runs the native build of this CLI (`crates/bb-cli`, see `docs/native-cli.md`)
when one exists and this Node CLI otherwise; the Node CLI is the reference for both.

- **The table** (`src/table.ts`) is text in the shape of help output: one line per command
  (`thread tell|message|send <id> [message]  Summary`), then indented lines for its flags
  (`--mode <mode>  Help`; `<v>...` repeats, `[v]` is optional, `--machine|host` declares an alias),
  examples (`$ …`) and the `--json` shape (`> …`). Two spaces separate a declaration from its text.
  `groups` and `aliases` (first-word rewrites such as `models` → `provider models`) sit beside it.
- **Handlers** are the exported functions of `src/commands/*.ts`, bound by name: `thread section list` runs
  `threadSectionList`. A command without a handler, or a flag line that does not parse, fails at startup; a
  handler that reads a flag its command does not declare throws.
- **The engine** (`src/engine.ts`) derives everything else from the table: resolution (longest path first,
  then group help, then plugin dispatch), flag and argument parsing, `--help` at every level, the short
  "did you mean" errors, and the reference `bb guide commands` prints. Every command gets `--json` and
  `--help`. A failure with `--json` prints `{"ok": false, "error": {code, message, hint?}}` on stdout.
- Handlers reach the server only by calling operations (`c.op(c.ops.threads.get, …)`, built on
  `createOpClient`). `@bb/plugin` and `@bb/domain` are loaded just before a
  handler runs, never for help, `bb guide`, `bb server` or `bb runner`, so those start without them.
- A first word that is not in the table is looked up in `GET /plugins/contributions` and dispatched to
  the server. That list holds each plugin's registered CLI and the commands built from operations
  with a CLI door (`bb audit`, `bb dev`, …).
- `bin/bb` runs `dist/bb.mjs` when `pnpm build:cli` has produced it and the TypeScript source through
  `tsx` otherwise. The bundle keeps native packages in `node_modules` and rewrites `import.meta.url` per
  source file, so it depends on the repository layout (schema, logos, plugin directories) but not on
  where the repository lives.
- `bb server` calls `startServer({ cliDir })` from `@bb/server`, the same function `apps/server/src/main.ts`
  runs. `ServerConfig.cliDir` is the CLI package root: the local runner gets `<cliDir>/bin/bb` as the agent's
  `bb`, and every local session gets `<cliDir>/skills` (the `bb-cli` skill) as a skill directory.
- Topic text for `bb guide` is Markdown under `apps/cli/guide/`.

## Conventions

- No code comments (lint tool directives excepted). Names and small functions carry the meaning; this
  document and the tests carry the rest.
- Formatting: `oxfmt`, 80 columns. Lint: `oxlint`.
- Parse at boundaries with zod, pass typed values inside. No `any`; `unknown` only at boundaries.
- Async child processes only (no `spawnSync` / `execSync` outside scripts and tests).
- Every counted line is budgeted. Prefer deleting a feature's edge case over adding a layer for it.
