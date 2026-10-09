# Writing a bb plugin

A plugin is a directory with a `package.json` that has a `bb` block, a contract, and a part for
each place it runs code. `docs/plugin-api-proposal.html` explains why the API has this shape;
`docs/architecture.md` ("Kernel") is the exact behaviour. This file is how to use it.

```
plugins/notes/
  package.json     "bb": { "name", "description", "icon", "server", "app", "runner", "requires", "skills", "themes" }
  contract.ts      names and schemas only; imported by every part and by other plugins
  server.ts        export default function server(bb: PluginServerApi) { ... }
  app.tsx          export default function app(bb: PluginAppApi) { ... }
  runner.ts        export default function runner(bb: PluginRunnerApi) { ... }
```

`requires` lists plugin ids that must be running first. A plugin id is the package name without
scope and without `bb-plugin-`.

## The rules the API follows

1. **A part is a plain function that takes `bb`.** The server, the app and each machine get the same
   handle shape: the verbs, `pluginId`, `log`, `onStart` and `onDispose`. Each side adds only what
   that side's host provides.
2. **`bb` holds verbs and host services, never a feature.** Everything a feature offers is a member
   of a contract: an operation, an event, a slot, a service, a live value or a table.
3. **One way to do each thing.** A slot is filled with `bb.add`, whoever declared it. An operation is
   called with `bb.call`. The shared database is `bb.db`.
4. **A slot is declared in the contract of the plugin that reads it.** Its entries name their
   component `view`.
5. **Names.** Operations use `create`, `get`, `list`, `update`, `delete`, or a noun for what a read
   returns. Events are named for what happened (`created`, `deleted`, `connected`) or the state
   entered (`active`, `idle`). Inputs are one object with named fields.
6. **Core has no private API.** The built-in plugins are written with exactly what is described here.
7. **The REST API is operations.** Every JSON route under `/api/v1` is the HTTP door of an operation,
   and its path starts with the contract's name. The app, the CLI and other programs call operations;
   there is no separate client library to keep in step.

## The contract

```ts
import { contract, event, live, op, service, slot, table } from "@bb/plugin";
import { z } from "zod";

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
  exporter: slot<{ id: string; label: string; run(notes: Note[]): string }>({
    key: "id",
  }),
  store: service<{ all(projectId: string): Note[] }>(),
  rows: table<{ projectId: string; text: string }>(),
});
```

- `op` options: `input`, `output` (zod), `kind` (`"read"` default, `"write"` is recorded in the audit
  log), `audit` (`false` keeps a frequent write out of the log), `hooks` (what another plugin's hook
  may do: `"observe"`, `"rewrite"` default, `"answer"`), `allow` (`"member"` default; `"user"` refuses
  a machine's credential; `"owner"`), `secret` (input field names kept out of the audit log),
  `internal` (not callable over HTTP; use it when the schema cannot validate the input), `doors`.
- An input is one flat object. Ids are named for what they identify (`threadId`, `hostId`), never
  `id`.
- `event(schema)`: something that happened. `live(schema)`: a value the server holds and pushes.
- `slot<Item>({ key?, pick?, check? })`: a list other plugins add to. `key` names the field that
  identifies an item (one winner per key). `pick: "one"` has one winner. `check(item, mine)` returns
  a message to refuse an entry; `mine` is what the same plugin already added.
- `service<Interface>()` is a pick-one slot that holds an object. `table<Row>()` names a database
  table other plugins may join.
- Any plugin can declare any of these. The kernel creates each one the first time it is used.
- Contract files import only `@bb/plugin`, `zod` and types. Apps import the same file, so nothing in
  it may touch Node or the DOM. In an app part import the helpers from `@bb/plugin/app`.

## What every part has

| Member                                        | Meaning                                                                                                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `bb.pluginId`, `bb.log`                       | The plugin's id; `log.debug`, `info`, `warn`, `error(message, fields?)`                                                                        |
| `bb.onStart(start)`                           | Runs once every plugin's entry has run. A function it returns runs on unload                                                                   |
| `bb.onDispose(stop)`                          | Runs on unload. Only for resources of your own; everything registered through a verb is undone for you                                         |
| `implement(op, run)`                          | This plugin is the operation's one implementation. `run(input, { caller, signal })`                                                            |
| `call(op, input, { signal? })`                | Call any operation. The call is attributed to this plugin (`caller.via`), unless it is the plugin's own operation                              |
| `on(op, [matcher], hook)`                     | Wrap an operation. `hook(input, next)`; `next(changedInput?)` runs the rest; `next.origin` is the caller. `.failClosed()` makes a crash refuse |
| `on(event, listener)`, `emit(event, payload)` | Listen, and tell listeners                                                                                                                     |
| `add(slot, item)`                             | Add to a slot; returns a function that removes it                                                                                              |
| `wrap(slot, matcher, change)`                 | Change items others added: `change(item) => item`                                                                                              |
| `read` / `entries` / `find` / `pick` / `use`  | Read a slot: items, items with their plugin, by key, the winner or null, the winner or throw                                                   |
| `provide(live, initial)`, `value(live)`       | Hold a live value (`{ get, set, update }`; setting it pushes to apps), or read one                                                             |
| `changed(op or live)`                         | Tell apps that what an operation returns has changed; `useOp` refetches                                                                        |

Also exported: `deny(reason)` to refuse from a hook, `toolError(text)` to fail an agent tool call,
`OpError`.

## Server part

```ts
import { deny, sessions, threads, type PluginServerApi } from "@bb/plugin";
import { notes } from "./contract.js";

export default function server(bb: PluginServerApi): void {
  const count = bb.provide(notes.count, 0);

  bb.implement(notes.create, async ({ projectId, text }, { caller }) => {
    const note = insert(projectId, text, caller.user);
    count.update((n) => n + 1);
    bb.changed(notes.list);
    bb.emit(notes.created, { note });
    return note;
  });
  bb.implement(notes.list, ({ projectId }) => all(projectId));

  bb.on(sessions.instructions, async (context, next) => [
    { source: bb.pluginId, text: "Use AddNote for things worth keeping." },
    ...(await next()),
  ]);
  bb.on(threads.idle, ({ thread }) => { ... });
  bb.on(threads.send, { threadId }, () => deny("Not now")).failClosed();

  bb.add(notes.store, { all });
}
```

### What the server's host provides

| Member                                   | What it is                                                                                                                                                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bb.server`                              | The server's configuration (`dataDir`, `hostId`, `version`, `port`, …) plus `url` and `tunnelToken`                                                                                                                                       |
| `bb.now()`                               | The server's clock                                                                                                                                                                                                                        |
| `bb.db`                                  | The shared SQLite database: `get`, `all`, `run`, `transaction`, `now`. Core tables are read through `@bb/server-kit/db/*`                                                                                                                 |
| `bb.realtime`                            | Tells connected apps what changed: `thread`, `project`, `environment`, `host`, `system`, `threadOpen`, `presence`, `onChanged`                                                                                                            |
| `bb.runners`                             | Every connected machine: `call(hostId, op, input)` runs an operation a runner part implements there (git, files, terminals and your own); `get(hostId)` is the machine's session handle with the same `call`; `isConnected`, `onEvent`, … |
| `bb.http.api(routes, { internal? })`     | Mounts Hono routes under `/api/v1` (or `/internal`), beside core's own                                                                                                                                                                    |
| `bb.http.route(method, path, handler)`   | A raw `Request` to `Response` handler under `/api/v1/plugins/<id>/http/`, with `auth: "local" \| "token" \| "none"`                                                                                                                       |
| `bb.http.socket(resolver)`               | Answers a WebSocket upgrade for a path                                                                                                                                                                                                    |
| `bb.dataDir`, `bb.storage`               | The plugin's own directory and storage (below)                                                                                                                                                                                            |
| `bb.settings.define(fields, { scope })`  | Settings: `string` (`secret`, `multiline`), `boolean`, `select`, `number`. `scope: "user"` keeps a value per person                                                                                                                       |
| `bb.background.service(name, { start })` | A supervised long-running task. `bb.background.schedule(name, "*/15 * * * *", run)` runs on a five-field cron                                                                                                                             |
| `bb.cli.register(defineCli(...))`        | A hand-written CLI, for commands that are not one operation. It is merged with the plugin's `doors.cli` commands                                                                                                                          |
| `bb.status.needsConfiguration(message)`  | Shows the plugin as waiting for setup                                                                                                                                                                                                     |

Storage is in two places, by who owns the data:

- **Yours.** `bb.storage.kv` for small values; `bb.storage.database(migrations?)` for a private
  SQLite file; `bb.storage.tables` for tables of your own in the shared database.
- **Everyone's.** `bb.db` queries the shared database, including tables other plugins published.

Prefer an operation to a route: another plugin can hook or call it, it is recorded, and it can be
served over REST with `doors.http`. Core keeps raw routes only for what an operation cannot carry:
cookies (sign-in), uploads and file bytes. A plugin reaches another plugin only through a contract.

### Doors

- Every operation that is not `internal` is callable from an app (`POST /api/v1/ops/<name>`, `useOp`,
  `useCall`).
- `doors.agent` offers it to agents as a tool: `{ name, description, instructions?, presentation?,
enabledFor?(context) }`. The implementation sees `caller.thread` (the calling thread) and
  `caller.door === "agent"`. A string result is returned as is, anything else as JSON.
- `doors.cli` makes `bb <path>`: `{ path, summary, positionals?, print?(output, input) }`. Flags come
  from the input schema (`projectKey` is `--project-key`; booleans are switches; arrays repeat;
  `.describe()` is the help text). `--json` prints the output. All of a plugin's CLI doors share their
  first word.
- `doors.http` serves it at a REST path: `{ method, path, status?, empty?, body? }` under `/api/v1`.
  `:name` segments, the query (for `GET`) or the JSON body (otherwise) are merged into the one input
  object and validated by the input schema, so a query flag or count may arrive as text
  (`flagField`, `countField` in `@bb/server-contract` accept both forms). `body: "lines"` puts a body
  that is not an object into that field. `status: 201` answers a creation; `empty: 204` answers
  `null` with no content. An operation that returns nothing answers `{ "ok": true }`. A path with a
  fixed segment wins over one with a parameter in the same place. The path's first segment is the
  contract's name, and a test holds core to that.

Callers outside the server use one function for every operation:

```ts
import { createOpClient, threads } from "@bb/plugin";

const bb = createOpClient({ baseUrl: "http://127.0.0.1:48886", door: "cli" });
const thread = await bb.call(threads.get, { threadId });
```

`call` uses the operation's REST door when it has one and `POST /api/v1/ops/<name>` otherwise, takes
`{ signal }` as a third argument, and throws `CallError` (`status`, `code`, `body`, `details`). The
app's `callOp`, `useOp` and `useCall` and the CLI are built on it.

### What core offers (`packages/plugin/src/core-contracts.ts`)

| Contract                        | Operations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Events, slots, services, tables                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `threads`                       | `create`, `get`, `list`, `search`, `update`, `delete`, `send`, `stop`, `archive`, `unarchive`, `compact`, `clearContext`, `pin`, `unpin`, `reorderPinned`, `markRead`, `markUnread`, `open`, `tabs`, `updateTabs`, `timeline`, `timelineTurnSummaryDetails`, `output`, `events`, `nextEvent`, `childSummary`, `promptHistory`, `recentPrompts`, `defaultExecutionOptions`, `resolveMentions`, `listQueuedMessages`, `createQueuedMessage`, `updateQueuedMessage`, `deleteQueuedMessage`, `sendQueuedMessage`; server only: `workspace`, `storageLocation`, `addRow`, `hold` (hook it to keep a message queued), `release`, `waitSettled`, `sweep` | events `created`, `active`, `idle`, `failed`, `archived`, `unarchived`, `deleted`, `retired`, `appended`, `messageQueued`, `messageDispatched`, `messageDeleted`; table `table` |
| `interactions`                  | `list`, `get`, `resolve`, `respond`, `cancel`; server only: `ask` (ask the user through a thread)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | event `pending`                                                                                                                                                                 |
| `projects`                      | `list`, `create`, `get`, `update`, `delete`, `sidebar`, `createSource`, `updateSource`, `deleteSource`, `paths`, `commands`, `branches`, `branchOptions`, `promptHistory`, `defaultExecutionOptions`, `copyAttachments`, `machineEnvironment`, `updateMachineEnvironment`                                                                                                                                                                                                                                                                                                                                                                         | table `table`; event `deleted`                                                                                                                                                  |
| `environments`                  | `list`, `get`, `update`, `delete`, `providers`, `status`, `diffFiles`, `diffFile`, `diffPatch`, `diffBranches`, `paths`, `runAction`, `archiveThreads`; server only: `instructions`, `sweep`; `ensure` in `bb-plugin-environments/contract`                                                                                                                                                                                                                                                                                                                                                                                                       | slot `kind`; event `destroyed`                                                                                                                                                  |
| `machines`                      | `list`, `create`, `get`, `update`, `updateSharing`, `updatePermissionCeiling`, `delete`, `enrollmentCommand`, `createReconnectCommand`, `directory`, `pathsExist`, `readFile`, `writeFile`, `listFiles`, `openTargets`, `open`; server only: `enroll`, `waitConnected`, `suspend`, `resume`                                                                                                                                                                                                                                                                                                                                                       | events `connected`, `disconnected`, `deleted`, `signaled`; slot `provider`; services `access`, `guard`                                                                          |
| `terminals`                     | `list`, `create`, `get`, `update`, `close`, `write`, `output`; server only: `resize`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | event `inputReceived`                                                                                                                                                           |
| `sessions`                      | `providers`, `providerCatalog`, `updateProvider`, `executionOptions`; `instructions`, `env`, `tools`, `skillDirs` (hook these to contribute or filter per thread); server only: `title`, `searchMentions`, `resolveMention`                                                                                                                                                                                                                                                                                                                                                                                                                       | slots `provider`, `mention`, `inference`, `usage`; service `titleFallback`                                                                                                      |
| `files`                         | server only: `read`, `write`, `list`, `mkdir`, `delete`, `move` (in a thread's workspace)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |                                                                                                                                                                                 |
| `sections`                      | `list`, `create`, `update`, `delete`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |                                                                                                                                                                                 |
| `users`                         | `list`, `update`, `setPassword`, `createSignInLink`, `listInvites`, `createInvite`, `deleteInvite`, `presence`, `current`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |                                                                                                                                                                                 |
| `settings`                      | `updateGeneral`, `updateKeyboard`, `updateAppearance`, `uiPreferences`, `updateUiPreference`, `resetUiPreference`, `machineEnvironment`, `updateMachineEnvironment`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | in the app: slots `page`, `section`                                                                                                                                             |
| `plugins`                       | `list`, `contributions`, `reload`, `enable`, `disable`, `settings`, `updateSettings`, `inspect`, `describe`, `install`, `uninstall`; server only: `agentTools`, `callAgentTool`, `agentInstructions`, `skillDirs` (the host answers these)                                                                                                                                                                                                                                                                                                                                                                                                        |                                                                                                                                                                                 |
| `server`, `appearance`, `audit` | `server.config`, `audit.list`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | services `server.publicUrl`, `server.authenticator`; slot `appearance.theme`                                                                                                    |

- Every operation not marked "server only" has a REST door; `GET /api/v1/kernel` lists each one with
  its doors. `threads.get` is `GET /threads/:threadId`, `machines.list` is `GET /machines`,
  `sections.create` is `POST /sections`.
- `threads.create` takes a `CreateThreadRequest`; a plugin sets `origin: "plugin"` and
  `originPluginId`. `threads.send` takes `{ threadId, input, mode, … }`; `threads.update` takes
  `{ threadId, title?, sectionId?, … }`. The queue operations take `{ threadId, queuedMessageId, … }`
  and the interaction operations `{ threadId, interactionId, … }`. `threads.get` and
  `environments.get` fail with 404 when there is nothing to return.
- `threads.recentPrompts({ cursor?, limit?, projectId? })` (`GET /threads/prompt-history`) pages
  the user's own prompts across every thread, newest first: `{ entries: [{ id, text, mentions?,
threadId, projectId, scope: "project" | "thread", sentAt }], nextCursor }` (limit 50 by default,
  at most 200). `threads.promptHistory` stays the one-thread history.
- `threads.createQueuedMessage` takes an optional `sendAt` (ms): the message waits (`waitingOn:
{ kind: "time" }`) until then, and the queued-message reads return it.
- `threads.failed` carries what a retry needs: `errorInfo` (the turn's last `provider/error`
  info), `rateLimits` (the turn's last rate-limit state) and `turn: { requestId, attempt, input }`
  (the failed turn's request), each `null` when unknown.
- A `threads.hold` hook gets `{ threadId, projectId, providerId, sendNow, hostId, queuedMessageId,
input }`: `hostId` is the machine the turn will run on (also before the thread has an
  environment), `queuedMessageId` the queued message being held (`null` for a message that is not
  queued yet) and `input` its prompt. `threads.release({})` without a `threadId` re-checks every
  thread the calling plugin holds.
- Writes that happen constantly (`threads.markRead`, `pin`, `updateTabs`, `open`, `terminals.write`,
  `settings.updateUiPreference`) are not recorded in the audit log. Records older than the audit
  plugin's "Days to keep" setting (90) are removed nightly.
- A machine's own credential may call operations, but not those marked `allow: "user"`: changing
  machines, settings, users, providers or the machine environment.
- Contributions that depend on the thread are hooks on an operation (`sessions.instructions`,
  `env`, `tools`, `skillDirs`): the hook gets the thread's context and may filter what others added.
  Registrations that do not are slot entries (`sessions.provider`, `mention`, `inference`, `usage`).
- A `sessions.provider` declaration may set `instructionMode: "replace"` (bb's instructions replace
  the provider's system prompt; the runner gets `SessionSpec.instructionMode`), `nativeSkillRoots:
  { user, project }` (folders under home / each project ancestor whose skills bb lists with its own)
  and `capabilities.fork: "checkpoint"` (a fork-origin thread's session gets `SessionSpec.forkFrom:
  { providerThreadId, checkpointId }` from the source thread's last checkpoint).
- The runner part's `ProviderSession.compact?()` is called by `threads.compact` instead of sending
  `/compact` as a prompt; it must open and close a turn. `ProviderStatus` may carry `minimumVersion`,
  `versionUnsupported` and `installAction: { kind: "install" | "update", command }`.
- Sign-in is a service: the host asks `server.authenticator` who a request is from. The identity
  plugin provides it, and a plugin that adds its own takes over.

### Timeline rows

`bb.call(threads.addRow, { threadId, kind, title, status?, detail?, data?, id? })` puts a row of your
own kind in a thread's timeline. `kind` is a slug; `status` is `pending`, `completed` or `error`;
`data` is any JSON. Calling it again with the `id` it returned replaces the row in place, which is how
a progress row is updated. Without a renderer the row shows as a system row with your title and
detail. To draw it yourself, add a renderer in the app part:

```tsx
bb.add(threadView.pluginRow, { kind: "my-plugin/ci-run", view: CiRun });
function CiRun({ title, status, data }: PluginRowProps) { … }
```

The key is `<plugin id>/<kind>`. The CLI shows the title.

### Shared tables

A plugin's private database (`bb.storage.database()`) cannot be joined with anything else. For data
that other plugins should read, or that you want to join with threads, keep tables in the shared
database:

```ts
const items = bb.storage.tables.name("items");
bb.storage.tables.migrate([
  `CREATE TABLE ${items} (thread_id TEXT NOT NULL, note TEXT)`,
]);
bb.storage.tables.publish(tracker.items, "items");
bb.db.run(`INSERT INTO ${items} VALUES (?, ?)`, threadId, "ship it");
```

- Your tables are named `p_<plugin id>_<name>`. Migrations are an append-only list, checked by hash,
  and may only create, alter or drop your own tables, indexes and views.
- Publish through the contract: `items: table<{ threadId: string; note: string }>()`, then
  `tables.publish(contract.items, "items")`. Another plugin joins with
  `bb.storage.tables.of(tracker.items)` in a `bb.db` query.
- Core publishes `threads.table` and `projects.table`, read-only views of live threads and projects.
- Column names are snake_case in SQL; rows come back with camelCase keys.

### Machines and environments

An environment kind is `bb.add(environments.kind, { id, displayName, icon, inputs?, validate?,
create(context), delete(context) })`.

- `create(context)` receives `thread`, `project`, `host`, `checkoutPath`, `branchName`, the user's
  `inputs`, the `machine` request if the user asked for a new machine, the `resource` you stored
  before, `instanceKey` (stable per environment), `restoring` (true when recreating one that
  existed, keeping its `branchName`), `baseBranch`, `report(text, status?, { key?, startedAt? }?)`
  for progress lines and a `signal`. It returns `{ path }` and optionally `hostId` (the machine it
  created), `resource` (JSON to keep), `branchName` and `mergeBaseBranch`.
- `place(inputs, { threadId, projectId, hostId })` (optional) decides where the thread goes:
  `{ type: "owned", instanceKey?, baseBranch? }` (the default: a directory this kind creates for
  the thread) or `{ type: "checkout", kind?, path?, branch? }` (attach to an existing checkout,
  shared by every thread at that path, optionally switching branch; `create` is not called).
- `delete({ hostId, path, resource })` undoes it. `validate(inputs, { projectId, hostId })` returns a
  message to refuse a thread before it is created.
- Give the kind `inputs` (any non-null JSON) and add a form in the app part:
  `bb.add(composer.environmentInputs, { kind: "<id>", view })`. The view gets `value`, `onChange`,
  `projectId` and `hostId`.
- The built-in kinds are plugins too (`plugins/environment-git-worktree`,
  `environment-personal-workspace`, `environment-project-checkout`). Using one of their ids
  replaces that kind.

To create machines (a sandbox, a VM), add a `machines.provider` (`{ id, displayName, suspend?,
resume?, delete? }`) and use the machine operations:

```ts
const { hostId, command } = await bb.call(machines.enroll, {
  name: "Sandbox",
  providerId: "sandbox",
  resource: { box },
});
await runInSandbox(box, command);
await bb.call(machines.waitConnected, { hostId });
return { path: "/workspace", hostId, resource: { box } };
```

`command` is the `bb runner join …` line to run on the new machine; `bb` must be installed there.
`machines.suspend`, `resume` and `delete` call your provider and update the machine;
`machines.connected`, `disconnected` and `deleted` are events. Hook `threads.send` to resume a
suspended machine before a message is delivered.

### Providers

A provider is a runner part that adds a `ProviderAdapter` to `runner.provider` and a server part
that adds a `ProviderDeclaration` to `sessions.provider`. The declaration may set `permissionModes`
and `modelCatalogScope`; it defaults to all modes and a per-machine catalog. Add a
`sessions.usage` source to report quota. To configure the runner part (for example a list of agents
to launch), keep the configuration in settings, implement an operation in the runner part that
takes it, and call it with `bb.runners.call(hostId, op, input)` on `machines.connected` and when the
setting changes.

## App part

```tsx
import {
  shell,
  useCall,
  useLive,
  useOp,
  useSlot,
  type PluginAppApi,
} from "@bb/plugin/app";
import { notes } from "./contract";

export default function app(bb: PluginAppApi): void {
  bb.add(shell.navPanel, {
    id: "notes",
    title: "Notes",
    icon: "ListTodo",
    path: "notes",
    view: Notes,
  });
}

function Notes() {
  const list = useOp(notes.list, { projectId });
  const create = useCall(notes.create);
  const count = useLive(notes.count);
  const exporters = useSlot(notes.exporter);
}
```

`bb` in an app part is the shared handle and nothing more. `bb.call(op, input)` and
`callOp(op, input, { signal? })` run an operation the app implements locally, else on the server.
Either way the call passes through the app's kernel, so an app part can hook a server operation
(`bb.on(sections.create, (input, next) => next({ name: input.name.trim() }))`) before it is sent.
A call made with `bb.call`, `useOp` or `useCall` names its plugin to the server, and the audit log
shows it as `app:<plugin id>`; that name is the app's word, not proof.
The core contracts (`threads`, `projects`, `machines`, …) are exported from `@bb/plugin/app` too. An
app part may implement a server operation to act first: the shell implements `threads.update` to
update the sidebar at once and batch the requests.

### Slots

Every slot is filled with `bb.add` and can be changed with `bb.wrap`. Core fills them the same way.

| Contract     | Slots                                                                                                                                                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell`      | `route`, `navItem`, `navPanel`, `overlay`, `command`, `threadAction`, `sidebarFooter`, `threadRowStatus`; providers the user picks between: `threadList`, `sidebarNavigation`, `sidebarHeader`                                                 |
| `threadView` | `row` (a renderer per timeline row kind), `rowDetail` (per work-row kind), `pluginRow` (rows a plugin stored), `messageAction`, `header` (a component in the thread header), `interaction` (a form for `interactions.ask`), `messageDirective` |
| `composer`   | `menuItem` (the "+" menu), `footerControl`, `sendMenuItem`, `banner`, `textEffect`, `environmentInputs`, `homeSection`                                                                                                                         |
| `sidePanel`  | `tab` (per tab kind: body, icon, title), `fileViewer` (per file extension), `panel` (a plugin's own panel and the action that opens it)                                                                                                        |
| `settings`   | `page`, `section` (a section on the plugin's own settings page)                                                                                                                                                                                |
| `app`        | `icon` (`{ name, view }`, usable wherever an icon name is taken); `parts` (a plugin's published components); `root` is the service that draws the screen, provided by the shell                                                                |

- An entry's component is always `view`. Entries with an `id` are checked when added: the id must
  match `[a-zA-Z0-9_-]+`, be unique within the plugin and come with its `view` (or `run`, for a
  command).
- `bb.add(shell.threadRowStatus, { threadId, icon, label, tone? })` shows a status on a thread's row
  in the sidebar; call the function it returns to clear it.
- `bb.add(sidePanel.fileViewer, { id, extensions: ["pdf"], view })` draws files with those
  extensions; the view gets `{ path, name, url, mimeType, content, refresh }`.
- `bb.add(threadView.messageAction, { id, label, icon, run(message) })` adds a button under a
  message.
- A `shell.sidebarFooter` entry is `{ id, label, icon, run }` or `{ id, label, icon, view }`.
- For example `bb.wrap(threadView.row, { kind: "work" }, (item) => ({ ...item, view: Wrapped }))`.
- Wrap what a slot's owner draws in `<SlotMount pluginId slot id>` so a crash in one entry is
  contained.

### Hooks and components from `@bb/plugin/app`

| Group                | Names                                                                                                                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operations and slots | `useOp(op, input, { enabled? })` gives `{ status, data, error, refetch }` and refetches on `bb.changed(op)`; `useCall(op)`; `callOp`; `useLive(live)`; `useChanged(member, handler)`; `useSlot`, `useSlotEntries` (with the plugin id), `useSlotEntry(slot, key)`; `SlotMount`               |
| The host             | `usePluginId`, `useSettings`, `useRealtimeConnectionState`, `useBbContext`, `useBbNavigate` (`toThread`, `toProject`, `toPluginPanel`, `toCompose`, `openThreadPanel`, `openUrl`, `openFile`), `useProviders`, `useEnvironmentProviders`, `useQuestionFormHost`                              |
| Components           | `Icon`, `ProviderIcon`, `UrlLink`, `Markdown`, `ImageLightbox`, `ThreadViewers`                                                                                                                                                                                                              |
| From the shell       | `useSidebarThreads`, `useSidebarThreadActions`, `useSidebarThreadSplit`, `useSidebarNavigationSplit`, `useSidebarSplitLayout`, `useSidebarThreadShortcut`, `useSidebarThreadDraft`, `useSidebarThreadDraftIds`, `useSidebarThreadRowStatus`, `useSidebarNavigation`, `SidebarNavigationIcon` |
| From the thread view | `ThreadChat`, `ThreadTitle`                                                                                                                                                                                                                                                                  |
| From the composer    | `useComposer`, `useComposers`                                                                                                                                                                                                                                                                |

The last three rows are services (`shell.api`, `threadView.api`, `composer.api`) that those plugins
provide and `@bb/plugin/app` forwards to. Each has a typed interface (`ShellApi`, `ThreadViewApi`,
`ComposerApi`), so a plugin that replaces the shell must supply the same hooks. The app host itself
knows no feature: it renders whatever provides `app.root`.

### The composer

`useComposer()` gives the handle of the composer a component is drawn in (a banner, a footer
control), or the focused one elsewhere; `useComposers()` gives every composer on screen.

| Member                                                                                          | What it is                                                                                  |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `key`, `surface`, `threadId`, `projectId`                                                       | Which composer this is (`surface` is `"new-thread"` or `"follow-up"`)                       |
| `text`, `isEmpty`, `attachmentCount`, `layout`                                                  | The draft, read on each render                                                              |
| `isRunning`, `isSubmittingBlocked`, `submittingBlockedReason`                                   | Whether a turn is running and whether Enter would send                                      |
| `selection`, `setSelection({ providerId, model, reasoningLevel, serviceTier, permissionMode })` | The pickers' values. A provider the composer does not list is ignored, and the rest with it |
| `setText`, `updateText`, `insert`, `insertMention`, `addQuote`, `clear`, `focus`                | Change the draft                                                                            |
| `setInputLock(locked)`, `setTextEffect({ className } \| null)`                                  | Stop editing, or put a class on the whole editor                                            |
| `submit()`, `onSubmitted(listener)`                                                             | Send, and hear about each send                                                              |

Menu items, send-menu items and footer controls receive a context: `{ surface, threadId, projectId,
composer }`. `bb.add(composer.banner, { id, view })` draws a component above the editor; it receives
`{ composer }`. `bb.add(composer.textEffect, { id, className, match })` paints parts of the draft:
`match(text, { offset })` is called for each run of text with its offset in the draft and returns
`{ from, to }` ranges within that run. The text itself is never changed.

### Themes

A plugin declares palettes in its manifest and needs no code for them:

```json
"bb": {
  "name": "Dusk",
  "themes": [
    { "id": "dusk", "name": "Dusk", "css": "./themes/dusk.css", "codeTheme": { "dark": "nord" } }
  ]
}
```

The CSS sets the same custom properties the built-in palettes do (`--canvas`, `--ink`, `--primary`
and the rest, under `:root, .light` and `.dark`). The theme appears in Settings as
`plugin:<plugin id>:<theme id>` and is listed in `themes` of the `server.config` operation. `codeTheme` takes
names of syntax themes bb already has, not files.

### Using another feature's components

Beyond the public hooks above, a screen plugin publishes its own components as parts.
`plugins/composer/contract.ts` exports `FollowUpPromptBox`, `ModelReasoningPicker`,
`PermissionModePicker`, `BranchPicker`, `useNewThreadComposer`, the draft storage hooks and more.
Import them from `bb-plugin-composer/contract` and use them like the originals. A part is a thin
stand-in that finds the current provider when it renders (a component) or is called (a hook or
function), so it renders nothing, or throws when called, while no plugin provides it. To publish one
of your own: export it from `parts.ts`, declare it in `contract.ts` with
`part<typeof Module.Name>("<your id>", "Name")` or `callPart<…>`, and keep
`bb.add(app.parts, { plugin: "<your id>", parts })` in `app.tsx`. Values that are not functions
(atoms, contexts, constants) cannot be parts; they belong in a kit.

A part is typed by its current implementation; a service is typed by an interface. Use a service
for something others depend on, a part for a component you are sharing as it is. Diff and code views
are library code in `@bb/app-kit/components/code` and `@bb/app-kit/components/git-diff`.

## Runner part

Code that must run on the machine (a provider, anything touching its files or processes).

```ts
import { runner, type PluginRunnerApi } from "@bb/runner";
import { probe } from "./contract.js";

export default function part(bb: PluginRunnerApi): void {
  bb.add(runner.provider, adapter);
  bb.implement(probe.diskFree, () => freeBytes());
}
```

`bb` is the shared handle plus `dataDir` and `signal(name, payload)`. `runner.provider` takes a
`ProviderAdapter` (`packages/runner/src/providers/provider.ts`). The server sends an external
plugin's runner part to every machine when it connects and when the plugin changes.

What bb itself does on a machine is operations too, declared in `@bb/runner` and implemented by the
built-in `workspace` runner part:

| Contract           | Operations                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `git`              | `inspect`, `source`, `branches`, `status`, `diffFiles`, `diffPatch`, `diffFile`, `commit`, `createWorktree`, `deleteWorktree`, `switchBranch` |
| `machineFiles`     | `read`, `readChunk`, `write`, `writeChunk`, `list`, `browse`, `exist`, `mutate`                                                               |
| `machineTerminals` | `open`, `attach`, `write`, `resize`, `close`                                                                                                  |
| `workspaces`       | `ensurePersonal`, `runScript`, `cancelScript`, `watch`, `commands`, `openTargets`, `openIn`                                                   |

A server part calls them with `bb.runners.call(hostId, git.status, { path })`. Another runner part
can hook them (`bb.on(machineFiles.write, (input, next) => …)`), refuse with `deny`, or answer in
place of the built-in one. Starting and steering agent sessions is not an operation: that is the
runner's own host, and a provider plugs into it through `runner.provider`.

How the three sides reach each other:

| From   | To     | How                                                                |
| ------ | ------ | ------------------------------------------------------------------ |
| app    | server | `useOp`, `useCall`, `callOp`                                       |
| server | app    | `bb.changed(op)`, a live value, `bb.realtime`                      |
| server | runner | `bb.runners.call(hostId, op, input)`                               |
| runner | server | `bb.signal(name, payload)`, heard as the `machines.signaled` event |

## Forking a built-in plugin

`bb dev fork <id> [--path <dir>]` copies a plugin from `plugins/` to a directory of yours and loads
the copy in place of the original, reloading it when a file changes. `bb plugin remove <path>` brings
the original back. Every plugin in `plugins/` forks this way: the providers, the add-ons, the ten
core server plugins and the five core app plugins.

- The copy keeps the original's id, so its contract names, settings and data carry over and it
  takes the original's place.
- `bb dev fork <id> --as <new-id>` makes a plugin of your own instead: the copy gets the new id and
  runs beside the original. Its package name, contract id, parts, CLI name and agent tool names are
  renamed for you. Check anything else it shares with the original, such as a pick-one slot both
  fill.
- `bb.forkOf` in the copy's `package.json` names the original. The copy's `node_modules` holds links
  to the packages the original uses, so it builds and typechecks (`tsc -p .`, or an editor) without
  an install. Installing packages of your own there is fine; existing links are left alone.
- A fork's app part may import what the in-repo plugins import: `@bb/shared-ui/*`, `@bb/app-kit/*`,
  `@bb/client-core`, `@bb/core-ui`, `@tanstack/react-query`, `jotai` and `react-router-dom` resolve
  to the app's own copies, loaded on demand.
- Tailwind classes in an external app part work. Classes the app does not already ship are compiled
  by the server into one utilities sheet for the app and every external plugin together, so the
  order of responsive and state variants is the same as in a single build. A plugin's own imported
  `.css` files are served separately and unlayered rules in them win over utilities.
- `import.meta.url` in a server or runner part still points at the source file, so reading files
  beside the source (`new URL("./logo.svg", import.meta.url)`) works from a fork.
- Core server features fork the same way: `threads`, `environments`, `terminals`, `machines`,
  `sessions`, `projects`, `identity`, `settings`, `workspace` and `audit-log`. They use the host
  services above and library code from `@bb/server-kit/*`, which a fork shares with the running
  server.
- What does not fork: the two kits (`packages/server-kit`, `packages/app-kit`). They are libraries:
  the data layer and helpers. The app kit holds only what two or more screen plugins use.

## Versions

- `API_VERSION` in `@bb/plugin` (now `1.0.0`) is the version of everything in this file: the handle,
  the verbs and every contract. A plugin states what it needs in `package.json`:
  `"engines": { "bb": "^1.2" }`. The loader refuses a plugin whose range does not include the
  running version and shows why in the plugin list.
- `"requires"` may be a list of plugin ids or `{ "tasks": "^2.1" }`, checked against the required
  plugin's own `version`.
- `packages/plugin/api.lock.json` describes every contract: names, input and output shapes, doors,
  who may call. A test fails when the code and the lock differ. `pnpm api:lock` accepts a change:
  an addition (a new operation, a new optional field) needs a higher minor version, anything that
  breaks a caller (a removal, a new required field, a changed shape, a moved door) needs a higher
  major version. Shapes declared with `z.custom` are not visible to it; use `typed(schema)` to
  record a shape without checking it at run time.
- To rename without breaking: keep the old operation with `deprecated: "threads.nextEvent"` and
  have its implementation call the new one; the kernel warns once per plugin that uses it. For a
  REST path, list the old one in the door's `aliases`.
- Clients send the version they speak in `x-bb-api`; the server answers 426 when the major version
  differs. `GET /health` and `bb dev inspect` report the server's.

## Tools

`bb dev inspect [name]` lists live operations, events, slots, live values and plugins.
`bb dev new <id>` writes a working plugin. `bb dev watch <dir>` loads a directory and reloads it when
a file changes (`bb plugin add <dir>` loads it without watching). `bb dev validate <dir>` checks the
manifest and lists what the source implements, hooks, calls and adds, and where it reaches outside bb.
`bb dev types <dir>` links bb's packages into the plugin's `node_modules` and writes
`.bb/tsconfig.json`, so an editor resolves bb's types.
`bb dev install <git:url[#ref] | npm:spec | dir>` fetches and loads a plugin (owner only).
`bb dev fork <id> [--path <dir>] [--as <new-id>]` copies a built-in plugin and runs the copy in its
place, or beside it under a new id (owner only).
`bb dev port <dir>` reads a plugin written for the original bb, without running it, and lists every
call it makes with what that call is now: unchanged, renamed, works differently, needs a feature
this bb does not have, or has no counterpart. `docs/plugin-migration-gaps.md` has the totals.
`bb audit list --plugin <id>` shows what a plugin did for whom.

`createPluginHarness()` from `@bb/plugin/testing` loads a server part against a bare kernel for unit
tests: `harness.load(id, entry, options)`, `harness.stub(op, run)` for core operations the plugin
calls, `harness.as(caller, work)`, and the audit `records`. Pass `db`, `realtime`, `runners` or
`server` in the options when the part uses them.

## Conventions

No code comments. `oxfmt` at 80 columns, `oxlint`. Parse at boundaries with zod; no `any`. In-repo
plugin tests go in `plugins/<id>/test/*.test.ts` and run against a real server
(`apps/server/test/helpers.ts`, `thread-harness.ts`) with an in-memory database. Lint rule
`bb/plugin-imports`: a file under `plugins/` imports its own files, libraries, `@bb/plugin`,
`@bb/runner` and another plugin's contract, never `apps/` or another plugin's internals.
