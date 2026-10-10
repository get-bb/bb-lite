---
name: bb-plugin-authoring
description: Write or change a bb plugin: operations, hooks, slots, CLI and agent doors, app panels. Use when asked to extend bb or build a plugin.
---

# Writing a bb plugin

A plugin is a directory with a `package.json` `bb` block, a `contract.ts` and up to three parts:
`server.ts`, `app.tsx`, `runner.ts`. Everything in bb is built from the same pieces, so look at what is
already running before you write anything.

## Loop

1. `bb dev inspect` lists every live operation, event, slot and hook. `bb dev inspect threads.` narrows
   it. Hook or call what is there; do not guess names.
2. `bb dev new <id>` creates a working plugin (one operation with a CLI and an agent door, one live
   value, one app panel) in `./<id>`.
3. `bb dev watch <dir>` loads it and reloads it whenever a file changes. `bb plugin list` shows whether
   it is running and why not.
4. `bb dev validate <dir>` checks the manifest and lists what the plugin implements, hooks, calls and
   adds, and where it reaches outside bb (Node built-ins, network, environment variables).
5. `bb audit list --plugin <id>` shows what the plugin did on someone's behalf.

To change something bb already does instead of starting empty, copy it: `bb dev fork <id>` copies any
built-in plugin (`bb plugin list` names them, core ones such as `threads`, `composer` and
`thread-view` included) into `./<id>` and runs the copy in the original's place, reloading on save.
`bb plugin remove <dir> --yes` brings the original back. `bb dev fork <id> --as <new-id>` makes a
renamed copy that runs beside the original.

A plugin written for the original bb (`@get-bb/plugin-sdk`): `bb dev port <dir>` lists every old call
it makes and what it is now.

## The pieces

- **Operation**: a named, typed function. `bb.implement(op, run)` makes this plugin its one
  implementation. `bb.call(op, input)` calls any operation. `bb.on(op, hook)` wraps one:
  `hook(input, next)`; call `next()` to continue, change what you pass or return to rewrite, and on
  operations that allow it return without `next` to answer or `deny("reason")` to refuse.
- **Errors**: `fail(code, message, { reason, hint })` from `@bb/plugin`, with code `not_found`,
  `conflict`, `unavailable` or `invalid`; the CLI prints the message and hint. In a hook,
  `deny(reason)` refuses.
- **Doors**: `doors.cli` makes `bb <path>`; `doors.agent` offers the operation to agents as a tool;
  `doors.http` serves it at a REST path under `/api/v1` (path parameters, query or JSON body become
  the one input object). Every operation is callable from an app with `callOp`, `useOp` or
  `useCall`, and from any program with `createOpClient().call(op, input)`. Core's REST API is the
  core contracts' operations (`threads.get`, `machines.list`, …); call those instead of fetching
  URLs.
- **CLI doors** replace hand-written CLIs: `positionals`, `flags` (`aliases`, `split`, `placeholder`,
  `duration`), `from` (fill a field from where the command ran: `cwd`, `projectId`, `threadId`,
  `hostId`), `constraints` (`exactly-one`, `at-most-one`, `at-least-one`, `requires`), `print`,
  `exitCode`, `aliases`, `description`. Use `defineCli`/`cliCommand` only for what a door cannot say.
- **Offered**: `bb.implement(op, run, { offered: ({ threadId, projectId, hostId, providerId }) => … })`
  hides the agent tool where it does not apply.
- **Versions**: state the API you need in `package.json` (`"engines": { "bb": "^1" }`); the loader
  refuses a plugin outside that range. `requires` may name versions: `{ "tasks": "^2" }`.
- **On a machine**: git, files and terminals are operations from `@bb/runner` (`git.status`,
  `machineFiles.read`, `machineTerminals.open`); a server part calls them with
  `bb.runners.call(hostId, op, input)` and a runner part can hook them.
- **Event**: `bb.emit(event, payload)`, `bb.on(event, listener)`. `{ userId }` as a third argument
  (also on `bb.changed(op, { userId })`) delivers to one user only.
- **Slot**: a list other plugins add to. `bb.add(slot, item)`, `bb.wrap(slot, matcher, change)`.
  `service<T>()` is a slot with one winner that holds an object: `bb.use(service)`.
- **Live value**: `bb.provide(live, initial)` on the server, `useLive(live)` in an app.
- **Parts**: each part is a plain function that takes `bb`. The server, the app and each machine
  get the same handle shape: the verbs above plus `pluginId`, `log`, `onStart` and `onDispose`. An
  app part fills slots the same way: `bb.add(shell.navPanel, { id, title, icon, path, view })`. In
  components use `useOp`, `useCall`, `useLive`, `useSlot`.
- **Host services** (server): `bb.db`, `bb.realtime`, `bb.runners`, `bb.server`, `bb.http.api`,
  `bb.http.socket`. Core plugins are written with these too; there is no private API.

- **Other plugins' contracts**: import by package name, `import { pullRequests } from
"bb-plugin-github/contract"`, and name the plugin in `bb.requires` (`["github"]`). In this repo
  also add `"bb-plugin-github": "workspace:*"` to `dependencies`. Never import another plugin's
  server or app files.
- **Settings**: `bb.settings.define(fields, { scope })` with scope `workspace` (default), `user` or
  `project`.

What core offers (threads, sessions, interactions, files, projects, machines, users, sections,
environments, terminals, audit, plugins) is in the output of `bb dev inspect`. Operations use the
verbs `create`, `get`, `list`, `update`, `delete`; events are named for what happened; a slot lives
in the contract of the plugin that reads it, and its entries name their component `view`.

## Rules

- Write mutations as `kind: "write"` so they are recorded with who asked.
- A hook that guards must be registered with `.failClosed()`.
- Reach the rest of bb through operations. Direct file, process or network access works, but it is
  not attributed to anyone.
- A plugin's part for machines (`runner.ts`) is sent to every connected machine; keep it small.
- Built-in plugins that should start off set `"bb": { "enabledByDefault": false }`; run
  `pnpm gen:builtins` after adding or changing a built-in.

## Tests

In this repo, `createTestServer()` from `apps/server/test/helpers.ts` starts a server with the
baseline plugins (providers, environment kinds, thread list, navigation, …) plus the plugin whose
`test/` folder the file is in and everything in its `bb.requires`. Pass the fourth argument (a list
of plugin ids, or `"all"`) for more. Drive it with `server.send("/ops/<op>", input)` and
`/plugins/<id>/cli`. Outside the repo, `createPluginHarness()` from `@bb/plugin/testing` loads one
server part against a kernel with `stub(op, run)` for what it calls.
