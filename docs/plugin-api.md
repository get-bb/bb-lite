# Writing a bb plugin

A plugin is a directory with a `package.json` that has a `bb` block, a contract, and a part for
each place it runs code. `docs/plugin-api-proposal.html` explains why the API has this shape;
`docs/architecture.md` ("Kernel") is the exact behaviour. This file is how to use it.

```
plugins/notes/
  package.json     "bb": { "name", "description", "icon", "server", "app", "runner", "requires", "skills" }
  contract.ts      names and schemas only; imported by every part and by other plugins
  server.ts        export default function plugin(bb: PluginServerApi) { ... }
  app.tsx          export default plugin((bb) => { ... })      from "@bb/plugin/app"
  runner.ts        export default function plugin(bb: PluginRunnerApi) { ... }
```

`requires` lists plugin ids that must be running first. A plugin id is the package name without
scope and without `bb-plugin-`.

## The contract

```ts
import { contract, event, live, op, service, slot } from "@bb/plugin";
import { z } from "zod";

export const notes = contract("notes", {
  list: op({
    input: z.object({ projectId: z.string() }),
    output: z.array(Note),
  }),
  add: op({
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
    },
  }),
  added: event(z.object({ note: Note })),
  count: live(z.number()),
  exporter: slot<{ id: string; label: string; run(notes: Note[]): string }>({
    key: "id",
  }),
  store: service<{ all(projectId: string): Note[] }>(),
});
```

- `op` options: `input`, `output` (zod), `kind` (`"read"` default, `"write"` is recorded in the audit
  log), `hooks` (what another plugin's hook may do: `"observe"`, `"rewrite"` default, `"answer"`),
  `allow` (`"member"` default, `"owner"`), `secret` (input field names kept out of the audit log),
  `doors`.
- `event(schema)`: something that happened. `live(schema)`: a value the server holds and pushes.
- `slot<Item>({ key?, pick? })`: a list other plugins add to. `key` names the field that identifies an
  item (one winner per key). `pick: "one"` has one winner. `service<Interface>()` is a pick-one slot
  that holds an object.
- Contract files import only `@bb/plugin`, `zod` and types. Apps import the same file, so nothing in
  it may touch Node or the DOM. In an app part import the helpers from `@bb/plugin/app`.

## Server part

`bb` has the kernel verbs and a few primitives.

```ts
import { deny, sessions, threads, type PluginServerApi } from "@bb/plugin";
import { notes } from "./contract.js";

export default function plugin(bb: PluginServerApi): void {
  const count = bb.provide(notes.count, 0);

  bb.implement(notes.add, async ({ projectId, text }, { caller, signal }) => {
    const note = insert(projectId, text, caller.user);
    count.update((n) => n + 1);
    bb.changed(notes.list);
    bb.emit(notes.added, { note });
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
  const thread = await bb.call(threads.get, { threadId });
}
```

| Verb                                         | Meaning                                                                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `implement(op, run)`                         | This plugin is the operation's one implementation. `run(input, { caller, signal })`.                                                            |
| `call(op, input, { signal? })`               | Call any operation. The call is attributed to this plugin (`caller.via`).                                                                       |
| `on(op, [matcher], hook)`                    | Wrap an operation. `hook(input, next)`; `next(changedInput?)` runs the rest; `next.origin` is the caller. `.failClosed()` makes a crash refuse. |
| `on(event, listener)`                        | Listen.                                                                                                                                         |
| `emit(event, payload)`                       | Tell listeners.                                                                                                                                 |
| `add(slot, item)`                            | Add to a slot; returns a function that removes it.                                                                                              |
| `wrap(slot, matcher, change)`                | Change items others added: `change(item) => item`.                                                                                              |
| `read` / `entries` / `find` / `pick` / `use` | Read a slot: items, items with their plugin, by key, the winner or null, the winner or throw.                                                   |
| `provide(live, initial)`                     | Hold a live value: `{ get, set, update }`. Setting it pushes to apps.                                                                           |
| `changed(op or live)`                        | Tell apps that what an operation returns has changed; `useOp` refetches.                                                                        |
| `value(live)`                                | Read a live value another plugin provides.                                                                                                      |

Primitives that stay as they were: `bb.pluginId`, `bb.log`, `bb.dataDir`, `bb.settings.define`,
`bb.storage.kv`, `bb.storage.database()` / `migrate`, `bb.http.route` (raw `Request` to `Response`, for
bytes and webhooks), `bb.background.service`, `bb.status.needsConfiguration`, `bb.onDispose`,
`bb.server.url|dataDir|tunnelToken`, and `bb.cli.register(defineCli(...))` for a CLI that needs its own
argument parsing or output (its handlers should `bb.call` the plugin's operations).

`bb.settings.define(fields, { scope: "user" })` keeps a value per person (a member may change their
own; the default scope, `"workspace"`, is one value changed by an owner). `bb.machine(hostId).call(op,
input)` calls an operation that a runner part implements on that machine.

Everything a plugin registers through a verb is undone when it unloads. `onDispose` is only for
resources of its own (timers, sockets).

`internal: true` on an operation keeps it off the app door: only server code can call it. Use it when
the input cannot be validated by the schema alone.

### Doors

- Every operation is callable from an app (`POST /api/v1/ops/<name>`, `useOp`, `useCall`).
- `doors.agent` offers it to agents as a tool: `{ name, description, instructions?, presentation?,
enabledFor?(context) }`. The implementation sees `caller.thread` (the calling thread) and
  `caller.door === "agent"`. A string result is returned as is, anything else as JSON.
- `doors.cli` makes `bb <path>`: `{ path, summary, positionals?, print?(output, input) }`. Flags come
  from the input schema (`projectKey` is `--project-key`; booleans are switches; arrays repeat;
  `.describe()` is the help text). `--json` prints the output. All of a plugin's CLI doors share their
  first word.

### What core offers (`packages/plugin/src/core-contracts.ts`)

| Contract                                    | Operations                                                                                                                                           | Events, slots                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `threads`                                   | `create`, `send`, `stop`, `archive`, `unarchive`, `delete`, `get`, `list`, `output`, `events`, `update`, `compact`, `clearContext`, the queue writes | `created`, `active`, `idle`, `failed`, `archived`, `unarchived`, `deleted` |
| `sessions`                                  | `instructions`, `env` (hook these to contribute)                                                                                                     | `mention` (mention providers), `inference` (title and completion services) |
| `interactions`                              | `ask` (ask the user through a thread), `resolve`, `respond`, `cancel`                                                                                | `pending`                                                                  |
| `files`                                     | `read`, `write` (in a thread's workspace)                                                                                                            |                                                                            |
| `projects`, `machines`, `users`, `sections` | `list`; `users.current`; `sections.create`                                                                                                           | `machines.access` (how a machine reaches the server)                       |
| `server`                                    |                                                                                                                                                      | `publicUrl`                                                                |
| `environments`                              |                                                                                                                                                      | `kind`                                                                     |
| `audit`                                     | `list`                                                                                                                                               |                                                                            |

`threads.create` takes a `CreateThreadRequest`; a plugin sets `origin: "plugin"` and
`originPluginId`. `threads.send` takes `{ threadId, request }`. The remaining thread and interaction
writes take `{ threadId, args: [...] }`.

## App part

```tsx
import { plugin, useCall, useLive, useOp, useSlot } from "@bb/plugin/app";
import { notes } from "./contract";

export default plugin((bb) => {
  bb.slots.navPanel({
    id: "notes",
    title: "Notes",
    icon: "ListTodo",
    path: "notes",
    component: Notes,
  });
});

function Notes() {
  const list = useOp(notes.list, { projectId });
  const add = useCall(notes.add);
  const count = useLive(notes.count);
  const exporters = useSlot(notes.exporter);
}
```

- `bb` has the same verbs. `bb.slots.*` and `bb.commands.register` are short forms for the `shell`
  slots that also check the registration and stamp the plugin id; prefer them for those ten slots.
- `bb.call(op, input)` and `callOp(op, input)` run an operation the app implements locally, else on
  the server.
- Hooks: `useOp(op, input, { enabled? })` gives `{ status, data, error, refetch }` and refetches when
  the server calls `bb.changed(op)`; `useCall(op)`; `useLive(live)`; `useChanged(member, handler)`;
  `useSlot(slot)`, `useSlotEntries(slot)` (with the plugin id), `useSlotEntry(slot, key)`.
- Wrap what a slot's owner draws in `<SlotMount pluginId slot id>` so a crash in one entry is contained.
- App slots, all filled by core through this same API and open to `add` and `wrap`:

  | Contract     | Slots                                                                                                                                               |
  | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `shell`      | `route`, `navItem`, `threadAction`, `navPanel`, `threadPanel`, `settingsSection`, `appOverlay`, `pendingInteraction`, `messageDirective`, `command` |
  | `shell`      | pick-one: `threadList`, `sidebarNavigation`, `sidebarHeader`                                                                                        |
  | `threadView` | `row` (a renderer per timeline row kind), `rowDetail` (per work-row kind)                                                                           |
  | `composer`   | `menuItem` (the "+" menu), `footerControl`, `sendMenuItem`                                                                                          |
  | `sidePanel`  | `tab` (per tab kind: body, icon, title)                                                                                                             |
  | `settings`   | `page`                                                                                                                                              |

  For example `bb.wrap(threadView.row, { kind: "work" }, (item) => ({ ...item, view: Wrapped }))`.

- Components from `@bb/plugin/app`: `ThreadChat`, `ThreadTitle`, `ThreadViewers`, `Markdown`,
  `ImageLightbox`, `Icon`, `ProviderIcon`, `UrlLink`.

## Runner part

Code that must run on the machine (a provider, anything touching its files or processes).

```ts
import { runner, type PluginRunnerApi } from "@bb/runner";
import { probe } from "./contract.js";

export default function plugin(bb: PluginRunnerApi): void {
  bb.add(runner.provider, adapter);
  bb.implement(probe.diskFree, () => freeBytes());
}
```

`bb` has the kernel verbs plus `pluginId`, `dataDir` and `log`. `runner.provider` takes a
`ProviderAdapter` (`packages/runner/src/providers/provider.ts`); a provider plugin also adds a
`ProviderDeclaration` to `sessions.provider` in its server part. The server sends an external
plugin's runner part to every machine when it connects and when the plugin changes; a machine's own
operations are reached from the server part with `bb.machine(hostId).call(op, input)`.

An environment kind needs only a server part: `bb.add(environments.kind, { id, displayName, icon,
create(context), remove({ hostId, path }) })`. `create` returns `{ path }` and may itself call a
runner operation to make the directory. Using a built-in id (`git-worktree`, `personal-workspace`,
`project-checkout`) replaces that kind.

## Tools

`bb dev inspect [name]` lists live operations, events, slots, live values and plugins.
`bb dev new <id>` writes a working plugin. `bb dev watch <dir>` loads a directory and reloads it when
a file changes (`bb plugin add <dir>` loads it without watching). `bb dev validate <dir>` checks the
manifest and lists what the source implements, hooks, calls and adds, and where it reaches outside bb.
`bb dev types <dir>` writes `.bb/tsconfig.json` so an editor resolves bb's types.
`bb dev install <git:url[#ref] | npm:spec | dir>` fetches and loads a plugin (owner only).
`bb audit list --plugin <id>` shows what a plugin did for whom.

`createPluginHarness()` from `@bb/plugin/testing` loads a server part against a bare kernel for unit
tests: `harness.load(id, entry)`, `harness.stub(op, run)` for core operations the plugin calls,
`harness.as(caller, work)`, and the audit `records`.

## Moving a plugin off the old API

The old names are gone; this table is for porting a plugin that was written against them.

| Old                                                                                  | New                                                                                                        |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `bb.rpc.register(contract, handlers)` and `useRpc().call`                            | Operations in `contract.ts`; `bb.implement`; `useOp` for reads, `useCall` / `callOp` for writes            |
| `bb.agents.registerTool`                                                             | An operation with `doors.agent`                                                                            |
| `bb.agents.contributeInstructions`                                                   | `bb.on(sessions.instructions, …)`                                                                          |
| `bb.providers.contributeEnv(providerId, fn)`                                         | `bb.on(sessions.env, { providerId }, async (context, next) => [...mine, ...(await next())])`               |
| `bb.events.on("thread.idle", fn)`                                                    | `bb.on(threads.idle, fn)`                                                                                  |
| `bb.threads.spawn/send/get/list/stop/update/output/events`                           | `bb.call(threads.create                                                                                    | send          | get           | list       | stop          | update          | output     | events, …)`      |
| `bb.projects.list()`, `bb.hosts.list()`, `bb.users.*`, `bb.sections.*`, `bb.files.*` | `bb.call(projects.list                                                                                     | machines.list | users.current | users.list | sections.list | sections.create | files.read | files.write, …)` |
| `bb.ui.requestInput(request)`                                                        | `bb.call(interactions.ask, request)`                                                                       |
| `bb.ui.registerMentionProvider`, `bb.inference.register`                             | `bb.add(sessions.mention, provider)`, `bb.add(sessions.inference, service)`                                |
| `bb.machines.setAccessProvider`, `bb.server.setPublicUrl`                            | `bb.add(machines.access, provider)`, `bb.add(server.publicUrl, () => url)` (keep the remover to change it) |
| `bb.realtime.publish` and `useRealtime`                                              | `bb.changed(op)` with `useOp`, or a `live` value with `useLive`, or `useChanged`                           |
| `bb.cli.register` with simple commands                                               | `doors.cli`                                                                                                |
| `definePluginApp((app) => app.slots.x(...))`                                         | `plugin((bb) => bb.slots.x(...))` (the same function under its new name)                                   |

## Conventions

No code comments. `oxfmt` at 80 columns, `oxlint`. Parse at boundaries with zod; no `any`. In-repo
plugin tests go in `plugins/<id>/test/*.test.ts` and run against a real server
(`apps/server/test/helpers.ts`, `thread-harness.ts`) with an in-memory database. Lint rule
`bb/plugin-imports`: a file under `plugins/` imports its own files, libraries, `@bb/plugin`,
`@bb/runner` and another plugin's contract, never `apps/` or another plugin's internals.
