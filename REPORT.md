# bb-150k: final report

A rewrite of `~/projects/bb` (frozen at `2573ad5e85`) under a hard cap of 150,000 counted lines.

- **Final count: 143,297 lines** (1,427,083 in the original by the same rule), 7,429 of them tests.
- `pnpm check` passes: line cap, typecheck of all 25 packages, lint with zero errors, 167 tests.
- The web UI was copied and cut, then its containers and data plumbing were rewritten smaller. The
  server, the machine runtime, the CLI and the plugin system were redesigned.
- Defaults differ from the original on purpose so the two can run side by side: data in `~/.bb-150k`
  (`BB_DATA_DIR`), port 48886 (`BB_SERVER_PORT`). The server refuses to open an original database.

## Since this report was written

The sections below describe the rewrite as it stood at 143,297 lines. Later changes, newest last:

- **Plan mode removed** at the user's request: `/plan` is gone and Claude sessions start with
  `EnterPlanMode` and `ExitPlanMode` disallowed. Plans in old threads still render.
- **UI primitives moved from Radix to Base UI** with identical pixels. Only `cmdk` still brings Radix
  in. External plugins receive Base UI entry points.
- **Responses are compressed and projected timelines are cached** until the thread changes; both
  were regressions against the original found by timing the two side by side.
- **`BB_SERVER_ALLOWED_HOSTS`** lists extra host names the server answers to, so a local reverse proxy
  such as `tailscale serve` can front it.
- **Mobile web responsiveness restored** at the user's request, who lifted the line cap for it: the
  sidebar drawer, bottom sheets, touch sizing, the collapsed composer and compact home, touch actions
  and scrolling in the conversation, the full-screen right panel, long-press and press-and-hold drag
  in the thread list, and on-screen keyboard handling. The specification was the original at phone
  and tablet size; desktop stayed pixel-identical. The native mobile app, push and the features cut
  on every platform stay cut (the collapsed composer shows a send button where the original shows a
  microphone). The lists of visible differences below describe desktop; "mobile app and push" under
  "What was cut" now means only the native app.
- A newly pinned thread goes to the top of Pinned, as in the original.

**Current count: about 151,150 lines; `pnpm check:lines` allows 152,000.**

How the plan was made and what was decided with the user is in `INVENTORY.md`; how the pieces fit is
in `docs/architecture.md`.

## Line count per area

| Area                                                                        |       Lines | Of which tests |
| --------------------------------------------------------------------------- | ----------: | -------------: |
| `apps/app` (web UI)                                                         |      59,705 |            189 |
| `apps/server`                                                               |      19,113 |          3,627 |
| `packages/runner` (provider adapters, sessions, workspace, remote link)     |      11,345 |          2,000 |
| `packages/thread-view` (timeline projection)                                |       8,049 |              0 |
| `plugins/thread-list`                                                       |       7,217 |            149 |
| `plugins/tasks`                                                             |       6,963 |            374 |
| `packages/domain`                                                           |       5,520 |              0 |
| `packages/server-contract` + `hono-typed-routes`                            |       4,513 |              0 |
| `packages/shared-ui` + `core-ui`                                            |       4,097 |              0 |
| `plugins/account-pool`                                                      |       3,472 |            326 |
| `apps/cli`                                                                  |       3,285 |            331 |
| `packages/client-core` + `fuzzy-match` + `text-utils`                       |       3,386 |              0 |
| `plugins/connect` + `tunnel-contract` + `tunnel-client`                     |       1,986 |            433 |
| `packages/sdk`                                                              |       1,817 |              0 |
| `packages/plugin` (the plugin API)                                          |       1,231 |              0 |
| `plugins/navigation`, `secrets`, `ask-user-question`, `custom-instructions` |       1,273 |              0 |
| `scripts` and root                                                          |         325 |              0 |
| **Total**                                                                   | **143,297** |      **7,429** |

Inside `apps/app`: timeline and markdown 9,619; composer and pickers 12,317; right panel 7,274;
settings, dialogs, machines and plugin host 7,533; shell (layout, sidebar chrome, thread page, split
panes, palette) about 7,700; hooks 6,134 and lib 5,076; UI kit, styles and build about 4,300.

## What was verified, and how

All browser checks ran in Playwright Chromium against isolated instances on their own ports and data
directories. The live install (`~/.bb`, ports 38886 and 38887) was never started, stopped, called or
written.

| Check                                                                                                                                              | Result                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| New thread from the home screen, reply streaming line by line                                                                                      | pass (text updates every ~101 ms; the original ~108 ms)                                                                 |
| Steer with Enter into the running turn                                                                                                             | pass (one turn, `steer` request)                                                                                        |
| Two and three split panes, send from one pane, reload restores layout, close a pane                                                                | pass                                                                                                                    |
| Sidebar section created from the sidebar, thread moved into it from its context menu                                                               | pass                                                                                                                    |
| Worktree thread runs in its own git worktree on a new branch                                                                                       | pass                                                                                                                    |
| Child thread from `bb thread spawn --parent-self`, `bb thread wait`, `bb thread output`, child nested in the sidebar, parent told when it finishes | pass                                                                                                                    |
| One real Codex turn (5.6-Luna) and one real Claude Code turn (Haiku 4.5), each resumed after a server restart with the same provider session id    | pass, on the final build                                                                                                |
| Thread title generation                                                                                                                            | pass ("Connectivity check", "Connectivity")                                                                             |
| Timeline projection against the original server on nine real threads                                                                               | 297 recorded responses identical                                                                                        |
| Timeline projection package old vs new                                                                                                             | 229,518 cases byte-identical                                                                                            |
| Stored events decode with pruned schemas                                                                                                           | 35,283 decodes byte-identical, no rejects                                                                               |
| Side-by-side screenshots, original vs rewrite, 39 scenarios in dark and light                                                                      | in `.qa/comparison/` and `.qa/comparison-light/` (`<name>.ref.png`, `<name>.new.png`, `<name>.diff.png`, `results.txt`) |

The regression drivers, the comparison tool and the equivalence test that needs private thread
exports are in `.qa/kit/` (not tracked). Screenshots of the flows above are in `.qa/flows/`.

## Visible differences from the original

Each line is something the main user can see or reach. Nothing else differed in the 39 compared scenarios (dark and light) beyond a vertical text offset near the bottom of long threads: about one pixel on most, up to four on the 1,052-row thread.

### Sidebar and shell

- Navigation shows New thread, Tasks and More. The Plugins, Skills and Automations pages are gone.
- The footer has Settings and Report a bug only: no "…" menu, account pill or usage entry.
- Navigation items, footer items and the thread list cannot be customised, hidden or reordered.
- Thread list: the "By project" and "By machine" organise modes are gone ("Custom" sections and
  "By environment" grouping remain); the hover quick action on a row is always Archive.
- A thread cannot be dragged onto the workspace to split, and a pane cannot be dragged by its title.
  The context menu, Ctrl/Cmd-click, the palette command, the shortcut and the Move menu remain.
- A thread cannot be dragged onto the composer to insert a mention.
- Palette thread search has no filter chip, no "Show more" and no status glyphs; it shows an Active
  group and an Archived group.
- A mentioned thread that is not in the sidebar data shows "Thread" or its id in titles.
- The open-in-editor button shows a generic glyph rather than the editor's icon.

### Conversation

- No table-of-contents rail.
- Mermaid fences render as highlighted code; `$$` math renders as text.
- No floating "Add to chat" on selected text (the hover action remains).
- No Fork and no Edit-message actions.
- Claude Workflow rows expand to a one-line summary.
- Reopening a thread always starts at the latest message.

### Composer

- No microphone, no rich-text mode, no collapse chevron.
- No provider hand-off inside an existing thread.
- Queue: no drag reorder, no "send together" grouping, no scheduled send; the list is collapsed or
  open. The send dropdown offers Queue or Steer while a turn runs and nothing when idle.
- No Goal action, no editing of a sent message.
- The home screen has no right panel.
- The environment menu always uses the machine-list layout; no existing-worktree chooser; personal
  threads pick their machine inside the environment chip.
- The workflow banner, expanded, lists phases and agents flat rather than as a collapsible tree.
- Switching a checkout to a branch another thread is using is refused after the thread is created
  (shown as a provisioning failure) rather than before.
- No plan mode: `/plan` is gone and Claude cannot enter plan mode; plans in old threads still render.

### Right panel

- The panel cannot be split into tab groups; tabs cannot be dragged or reordered; no reopen closed
  tab; no "Recent" list on the new-tab page.
- Thread storage is gone from thread info, tabs and search.
- CSV, HTML, video and audio files show as source or as a size with a download link.
- Image and SVG changes in a diff show "Binary file".
- Selecting lines in a diff or preview does not offer "Add to chat".
- Plugin pages have no terminals or file tabs. The terminal has no right-click menu.
- A commit starts at once (no "Commit queued").

### Settings

- Gone: AI services, Browser, Files, Mobile, Updates, Plugin marketplaces, Experiments, Community,
  the notification centre, voice input, bb CLI skills install, the rich-text switch.
- Installed plugins is a list with enable switches, not a marketplace grid.
- Custom theme files in the data directory are not loaded; the six built-in palettes remain.
- Providers and projects cannot be dragged into a new order; no `.env` import; no "New folder" in
  the directory browser; the remove-machine dialog does not list threads; archived threads has
  search only; the Providers page has no "Configuration" card.

### Behaviour

- Unread dots follow read state changed in another tab or from the CLI. Drafts, theme and locally
  stored preferences do not sync live between tabs.
- A thread whose worktree was removed keeps its composer; sending a message restores the worktree.
  There is no Restore button.
- Thread titles are generated with the Codex CLI's own login, not through the account pool or the
  hosted service. A real server makes one small request per new thread whose first message has five
  or more words.
- Agents no longer have the tool that re-points a thread at another directory.
- CLI: `bb env diff` and `bb thread-list prefs` are gone; `bb thread queue list` needs a thread id
  or `--self`; `bb settings show --json` and `bb provider list --json` return fewer fields.
- Tasks: no board view, folders or due dates; descriptions and comments are a markdown text box;
  presets are managed with `bb tasks preset`.

## What was cut

- Whole apps and services: mobile app and push, desktop shell, hosted web and connect services, the
  AI gateway, the demo server.
- Authentication (users, API keys), telemetry, server-move, auto-update. Loopback is the owner;
  requests through the tunnel are authenticated by the gate; each machine holds one hashed token.
- The plugin marketplace, installer, updater, safe mode, SDK version gating and CSS scoping.
- The provider bridge process and its conformance tooling; the Pi and ACP providers.
- Plugins: automations, workflows, browser automation, side-chat, GitHub, memory, docs,
  provider-usage, provider-retry, scheduled-send, concurrency-limit, keep-awake, inline-vis,
  pdf-preview, monaco-editor, agent-annotations, push-notifications, theme-preview, bb-ai, drafts,
  the Modal sandbox environment, and the plugin API tester and docs.
- Thread fork, edit-message, goal mode, thread storage, custom themes, queue reorder and grouping.
- 703,515 lines of tests.

## What was kept but simplified

- **Server**: one process, one SQLite schema file without an ORM, typed routes, a WebSocket hub that
  sends only "changed" signals. The server and daemon split is gone.
- **Runner**: one `Runner` interface used in-process on the server machine and over a single
  WebSocket for other machines (`bb runner join`, `bb runner run`). Codex is driven through
  `codex app-server`, Claude Code through the agent SDK, both translating into the same stored event
  dialect as the original, so imported history renders as before.
- **Data layer in the browser**: one query-key factory, one table mapping 36 change signals to
  invalidations, optimistic updates only for send, steer, stop, queue, archive, rename, pin, read
  state and section moves. The timeline is the one incremental path.
- **CLI**: 84 commands from one declarative table; plugin commands are dispatched by the server.
- **Multi-machine and bb connect**: kept, with the tunnel wire format unchanged. Port shares work
  from the server machine only.
- **Account pool**: proxy hub, token refresh, threshold switching and one settings card.
- **Migration**: `bb import-legacy --from <old data dir>` copies projects, machines (without
  credentials), sections, threads with events and provider session ids, and settings.

## What could not be verified

- **bb connect against production.** One tunnel exists per server label and the live install holds
  it, so the tunnel, account link and machine credentials were tested against a local fake gate.
- **The importer on the real database.** A dry run on a copy counted 53 active threads (161,852
  events) and 5,603 threads in all (2.13 million events). The actual import was blocked by the
  permission system as personal-data handling and was not worked around. It ran on a nine-thread
  copy and on a 4.8 GB synthetic copy (70 s).
- **Account pool with real accounts** and **real providers on a second machine**. A second runner
  process was joined and used with the echo provider.
- **Composer banners for background commands, agents, workflows and model fallback** were compared
  with synthetic activity rows on both builds, not produced by a real Claude run.
- **Scale**: the sidebar and archived list were not exercised with thousands of threads.
- **Browsers other than Chromium.**
- **Test coverage given up for the cap**: server workspace routes that only forward to the runner,
  host rename and permission ceiling, connect device login and port sharing, account-adding flows
  in the pool, and sixteen runner behaviours (text-delta coalescing, chunked file transfer edges,
  diff size tiers, command and skill listing details).
- **Two flaky signals seen once each under heavy parallel load**: a syntax-highlight colour error on
  a large file (not reproducible at normal load or with the CPU throttled six times) and a terminal
  test that assumed one output chunk (fixed).

## The new plugin API

A plugin is a directory with a `package.json` that has a `bb` block, an optional server entry and an
optional app entry. There is no marketplace, no version gating and no build step for the author: the
server loads the server entry and bundles the app entry. In-repo plugins are listed in two static
tables and compiled in. An external plugin is added with `bb plugin add <dir>` and removed with
`bb plugin remove <dir>`.

Server side, `export default function (bb: PluginServerApi)` from `@bb/plugin`:

| Surface                                                                         | What it gives                                                                    |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `bb.settings.define`                                                            | Typed settings (text, multiline, secret, boolean) with a generated settings page |
| `bb.storage.kv`, `bb.storage.database()`, `bb.storage.migrate`                  | A key-value store and a private SQLite database                                  |
| `bb.rpc.register(contract, handlers)`                                           | Typed calls from the plugin's app half, validated with zod                       |
| `bb.http.route(method, path, handler, { auth })`                                | Raw `Request` to `Response` routes: `local`, `token` or `none`                   |
| `bb.realtime.publish(channel, payload)`                                         | Push to the plugin's app half                                                    |
| `bb.cli.register(defineCli(...))`                                               | `bb <name> ...` commands, run on the server                                      |
| `bb.agents.registerTool`, `bb.agents.contributeInstructions`                    | Tools and instructions for agent sessions                                        |
| `bb.ui.requestInput`, `bb.ui.registerMentionProvider`                           | Ask the user through a thread; add `@` mention sources                           |
| `bb.providers.contributeEnv`                                                    | Environment variables for provider processes                                     |
| `bb.threads`, `bb.projects`, `bb.hosts`, `bb.sections`, `bb.files`, `bb.events` | Read and drive bb itself                                                         |
| `bb.background.service`, `bb.inference.register`, `bb.status`, `bb.onDispose`   | Lifecycle and services                                                           |

App side, `export default definePluginApp((app) => ...)` from `@bb/plugin/app`: slots `navPanel`,
`threadPanel`, `settingsSection`, `appOverlay`, `pendingInteraction`, `messageDirective`,
`threadList`, `sidebarNavigation`, `sidebarHeader`; `app.commands.register`; hooks `useRpc`,
`useRealtime`, `useSettings`, `useSdk`, `useBbNavigate` and the sidebar hooks; the `ThreadChat`
component. For overlays, external plugins share the host's Base UI (`@base-ui/react/menu`,
`context-menu`, `dialog`, `popover`, `select`, `tooltip`), not Radix.

### Worked example: project notes that agents can read and add to

This plugin was loaded into a running instance and exercised: `bb notes add` and `bb notes list`
from the CLI, the RPC over HTTP, the panel in the browser (listing, adding, live refresh) and the
agent tool called from a thread. The files are in `.qa/kit/example-notes-plugin/`.

`package.json`

```json
{
  "name": "bb-plugin-notes",
  "private": true,
  "type": "module",
  "bb": {
    "name": "Notes",
    "description": "Per-project notes that agents can read and add to.",
    "icon": "EditFile",
    "server": "./server.ts",
    "app": "./app.tsx"
  }
}
```

`contract.ts`

```ts
import { defineRpcContract } from "@bb/plugin";
import { z } from "zod";

const note = z.object({ id: z.number(), text: z.string() });

export const contract = defineRpcContract({
  list: { input: z.null(), output: z.array(note) },
  add: { input: z.object({ text: z.string().min(1) }), output: note },
});
```

`server.ts`

```ts
import { cliCommand, defineCli, type PluginServerApi } from "@bb/plugin";
import { z } from "zod";
import { contract } from "./contract.js";

interface Note {
  id: number;
  text: string;
}

export default function notes(bb: PluginServerApi): void {
  const database = bb.storage.database();
  bb.storage.migrate(database, [
    "CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)",
  ]);
  const list = () =>
    database.prepare("SELECT id, text FROM notes ORDER BY id").all() as Note[];
  const add = (text: string): Note => {
    const { lastInsertRowid } = database
      .prepare("INSERT INTO notes (text) VALUES (?)")
      .run(text);
    bb.realtime.publish("changed", null);
    return { id: Number(lastInsertRowid), text };
  };

  bb.rpc.register(contract, { list, add: ({ text }) => add(text) });

  bb.agents.contributeInstructions(() => {
    const lines = list().map((note) => `- ${note.text}`);
    return lines.length === 0 ? null : `Notes:\n${lines.join("\n")}`;
  });

  bb.agents.registerTool({
    name: "addNote",
    description: "Save a note that every later thread will see.",
    parameters: z.object({ text: z.string().min(1) }),
    execute: ({ text }) => `Saved note ${add(text).id}`,
  });

  const commands = {
    list: cliCommand({
      summary: "Print the notes",
      run: () => ({
        exitCode: 0,
        stdout: list()
          .map((note) => `${note.id}  ${note.text}`)
          .join("\n"),
      }),
    }),
    add: cliCommand({
      summary: "Add a note",
      positionals: [
        { name: "text", description: "Note", required: true, variadic: true },
      ],
      run: ({ positionals }) => ({
        exitCode: 0,
        stdout: `Added ${add(positionals.text.join(" ")).id}`,
      }),
    }),
  };
  bb.cli.register(defineCli({ name: "notes", summary: "Notes", commands }));
}
```

`app.tsx`

```tsx
import { definePluginApp, useRealtime, useRpc } from "@bb/plugin/app";
import { useCallback, useEffect, useState } from "react";
import type { contract } from "./contract.js";

function NotesPanel() {
  const rpc = useRpc<typeof contract>();
  const [notes, setNotes] = useState<{ id: number; text: string }[]>([]);
  const [draft, setDraft] = useState("");
  const refresh = useCallback(
    () => void rpc.call("list", null).then(setNotes),
    [rpc],
  );
  useEffect(refresh, [refresh]);
  useRealtime("changed", refresh);
  const save = async () => {
    await rpc.call("add", { text: draft });
    setDraft("");
  };
  return (
    <div className="flex flex-col gap-2 p-4">
      <ul>
        {notes.map((note) => (
          <li key={note.id}>{note.text}</li>
        ))}
      </ul>
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && void save()}
        placeholder="Add a note"
      />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "notes",
    title: "Notes",
    icon: "EditFile",
    path: "notes",
    component: NotesPanel,
  });
});
```

Load and use it:

```sh
bb plugin add /path/to/notes     # id "notes": the package name without "bb-plugin-"
bb notes add remember the milk
bb notes list
```

The server entry resolves `@bb/plugin` and `zod` from the plugin's own `node_modules` (or a parent
directory's), so an external plugin needs those two installed.

## Moving to this build

1. `pnpm install`, then `pnpm build:cli` for the fast `bb` binary (`apps/cli/bin/bb` runs from
   source without it).
2. `bb import-legacy --from <a copy of the old data dir> --dry-run`, then without `--dry-run`.
   Point `--from` at a copy: SQLite touches the `-shm` file of any database it opens. Do not
   continue the same thread from both installs; imported threads share provider sessions.
3. `bb server`. Other machines: `bb machine reconnect <name>` prints the join command.
4. The user's own path plugins need porting to the API above. Those built on composer customisation
   or file openers lose that surface.
