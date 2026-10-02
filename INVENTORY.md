# Inventory: bb → bb-150k

Source: `~/projects/bb` at `2573ad5e85` (read-only). Target: this repo, at most **150,000 counted lines**.

## The counting rule

`node scripts/count-lines.mjs [root] [--max N]` (also `pnpm check:lines`).

- Counted: physical lines of `ts tsx mts cts js jsx mjs cjs css sql html`, source and tests alike, from
  files git tracks or would track (so `node_modules` and build output never count).
- Not counted: lockfiles, markdown, JSON (which covers migration snapshots), anything under a
  `generated/`, `vendor/`, `dist/` or `build/` directory, `*.gen.*`, `*.min.*`.
- Formatting stays at the original 80 columns, so the baseline and the rewrite are measured alike.

Baseline by this rule: **1,427,083 lines** (710,944 of them tests). The brief's "1.5–2 million" included
snapshot JSON; `packages/db` is 50,640 counted lines, not 520K.

## Usage evidence (read-only queries on `~/.bb/bb.db`, 2026-10-01)

| Fact                                                     | Evidence                                                                                                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Providers                                                | 4,367 threads on Codex, 1,150 on Claude Code, 54 on Pi/ACP (none in the last 14 days)                                                                                                            |
| Multi-machine is in daily use                            | Last 14 days: 272 of 387 environment-bound threads ran on hosts other than the server machine; four remote hosts connected at query time                                                         |
| bb connect is how machines and browsers reach the server | `defaultMachineAccess = "connect"`, server URL `https://bee.getbb.app`; ~85 shared-port entries                                                                                                  |
| Account pool is live                                     | `routing.codex = routing.claude = true`; the running `codex app-server` points at the pool proxy                                                                                                 |
| Child threads through the CLI                            | 1,592 threads have a parent; agents mostly run `bb thread tell/wait/show/spawn/log/output/archive`, `bb status`, `bb terminal *`                                                                 |
| Worktrees                                                | 486 git-worktree environments; `project-checkout` and `personal-workspace` also used                                                                                                             |
| Sidebar                                                  | Custom sections (3), "chronological" organisation, pinned threads (7), thread list from the bundled plugin; navigation and header from the user's own `compact-nav` plugin                       |
| Settings                                                 | Nord theme, teal favicon, steer-on-Enter, custom keybindings, `managedBranchPrefix = "bb/"`                                                                                                      |
| Interactions                                             | 425 provider approvals/questions, 24 ask-user-question, 32 secret requests                                                                                                                       |
| Tasks                                                    | 109 tasks, 881 comments, 106 thread links; last write 2026-09-04                                                                                                                                 |
| Plugins with real traffic that are cut                   | workflows (1,427 hidden threads, 3 in the last 14 days), automations (14 threads in 14 days), browser automation, slopcop (the user's own, 252 threads in 14 days; needs porting to the new API) |

One premise in the brief did not survive checking: the stored event format is **not** the Codex
app-server protocol. It is bb's own `ThreadEvent` dialect (bb item types, bb-minted ids, `scope`,
`presentation`) that borrows Codex method names. Both provider adapters translate into it.

## Decisions taken with the user

1. Keep multi-machine, **including bb connect** (the tunnel client; the hosted service is not rebuilt).
2. Keep account pool, shrunk.
3. Keep secrets and ask-user-question. Cut automations, browser automation, workflows.
4. Cut mobile and push, Modal sandbox hosts, side-chat, GitHub panel, memory, Pi and ACP providers.
5. **150,000 lines at 80 columns, as written.** Copy-and-cut alone leaves the UI at 152–183K, so the UI
   is cut to the visible components and its plumbing (data layer, tab model, plugin host, settings) is
   rewritten smaller. Second-order behaviours are simplified or dropped; the flows in "Done means" are
   verified side by side against the original.
6. Of the expensive plugin surfaces, keep **embedded thread chat**. Cut composer customization, plugin
   file openers and voice input.

## Keep / shrink / cut, with budgets and what was reached

"Original" is non-test lines in the original. "Budget" is the plan after the first full integration;
"Final" is `node scripts/count-lines.mjs` on the finished tree and includes each area's tests.

### Web UI (copied, then cut, then its plumbing rewritten smaller)

| Area                                                                               | Original | Decision                                                                                                                                                                                                                                                                                                                     | Budget |                                                                                Final |
| ---------------------------------------------------------------------------------- | -------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: | -----------------------------------------------------------------------------------: |
| `apps/app`                                                                         |  183,931 | Two passes. A: delete whole features (mobile, desktop shell, marketplace, updates, server-move, in-app browser, voice, PR UI, skills pages, cloud machines, stories, tests). B: per area, keep the visible components and rewrite containers and data plumbing smaller, dropping second-order behaviours from a written list | 58,000 |                                                                               59,705 |
| — conversation timeline and markdown                                               |          | Every row kind, streaming, approvals and questions kept                                                                                                                                                                                                                                                                      | 10,000 |                                                                                9,619 |
| — composer and pickers                                                             |          | Editor, mentions, slash commands, attachments, all pickers, queue, steer, banners kept                                                                                                                                                                                                                                       | 11,500 |                                                                               12,317 |
| — right panel                                                                      |          | Thread info, git diff, file preview, terminal, new-tab file search kept                                                                                                                                                                                                                                                      |  9,000 |                                                                                7,274 |
| — settings, dialogs, machines, plugin host UI, embedded chat                       |          | The sections the user has touched kept                                                                                                                                                                                                                                                                                       |  7,500 |                                                                                7,533 |
| — shell: layout, sidebar chrome, thread page, split panes, palette, thread actions |          | Kept                                                                                                                                                                                                                                                                                                                         |  6,500 |                                                                          about 7,700 |
| — data layer and helpers (`hooks`, `lib`)                                          |          | Rewritten: one key factory, a signal-to-invalidation table, optimistic paths only where felt                                                                                                                                                                                                                                 |  8,000 | 11,210 (hooks 6,134, lib 5,076; includes the composer's and right panel's own hooks) |
| — UI kit, styles, entry                                                            |          | The components still imported                                                                                                                                                                                                                                                                                                |  5,500 |                                                                          about 4,300 |
| `plugins/thread-list`                                                              |   17,642 | Sections, pinned, drag and drop, row actions, sort and filter kept                                                                                                                                                                                                                                                           |  9,000 |                                                                                7,217 |
| `plugins/navigation`                                                               |    1,313 | Stock navigation bundled                                                                                                                                                                                                                                                                                                     |    850 |                                                                                  499 |
| `packages/thread-view`                                                             |   16,497 | Projection kept byte-identical; dead paths and duplication removed                                                                                                                                                                                                                                                           | 10,500 |                                                                                8,049 |
| `packages/shared-ui`                                                               |   12,254 | Components still imported                                                                                                                                                                                                                                                                                                    |  4,300 |                                                                                3,622 |
| `packages/client-core`, `core-ui`, `text-utils`, `fuzzy-match`                     |    8,402 | Shrunk                                                                                                                                                                                                                                                                                                                       |  5,500 |                                                                                3,861 |

### Shared contracts

| Area                                            | Original | Decision                                                           | Budget | Final |
| ----------------------------------------------- | -------: | ------------------------------------------------------------------ | -----: | ----: |
| `packages/domain`                               |   11,182 | Kept features only; every stored event and item shape still parses |  6,000 | 5,520 |
| `packages/server-contract`, `hono-typed-routes` |    8,010 | 116 routes, each with a handler and a caller                       |  5,000 | 4,513 |
| `packages/sdk`                                  |    7,176 | One typed client for app, CLI and plugins                          |  2,500 | 1,817 |

### Server, runtime, CLI (redesigned)

| Area                                                                                                                                                                                                                                      | Original | Decision                                                                                                                                                                                            | Budget |                               Final |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: | ----------------------------------: |
| `apps/server` + `packages/db` + `server-archive` + `logger` + `config` + `secret-storage`                                                                                                                                                 |  117,527 | Rewritten: one process, one schema file, thread engine, queue, interactions, timeline glue, environments, runner hub, files, terminals, settings, search, plugin host, title service, legacy import | 18,100 | 19,113 (source 15,137, tests 3,627) |
| `apps/host-daemon`, `agent-runtime`, `provider-bridge-protocol`, `provider-codex`, `provider-claude-code`, `host-daemon-contract`, `host-workspace`, `host-watcher`, `local-open-targets`, `process-utils`, the three environment plugins |   82,807 | Rewritten as `packages/runner`: one `Runner` interface, in-process on the server machine and over one WebSocket for other machines; Codex and Claude Code adapters plus a scripted echo provider    | 10,700 |  11,345 (source 9,345, tests 2,000) |
| `apps/cli` + `packages/bb-app`                                                                                                                                                                                                            |   26,113 | Rewritten: 84 commands from one table; plugin commands dispatched by the server                                                                                                                     |  3,400 |                               3,285 |
| `packages/plugin-sdk`, `plugin-build`, `plugin-registry`, `bundled-plugins`, `templates`, server plugin services                                                                                                                          |   49,000 | Redesigned as `packages/plugin`; host code sits inside the server and app numbers                                                                                                                   |  1,350 |                               1,231 |

### Kept plugins

| Area                                                                                                            | Original | Decision                                                                                            | Budget | Final |
| --------------------------------------------------------------------------------------------------------------- | -------: | --------------------------------------------------------------------------------------------------- | -----: | ----: |
| `plugins/tasks`                                                                                                 |   21,109 | List, detail, comments, attachments, thread links, dispatch, `bb tasks`                             |  7,000 | 6,963 |
| `plugins/account-pool`                                                                                          |    9,269 | Proxy hub, token refresh, threshold switching, `bb pool`, one settings card                         |  3,600 | 3,472 |
| `plugins/connect` + `bb-account` + `tunnel-client` + `tunnel-contract` + `connect-client` + daemon share tunnel |   10,100 | Tunnel (wire format verbatim), account link, machine credentials, port shares on the server machine |  2,200 | 1,986 |
| `plugins/secrets`, `plugins/ask-user-question`, `plugins/custom-instructions`                                   |    1,400 | Ported                                                                                              |    800 |   774 |

### Scripts

| Area                    | Original | Decision                                                 | Budget | Final |
| ----------------------- | -------: | -------------------------------------------------------- | -----: | ----: |
| `scripts/`, root config |    5,701 | Line counter, native-module check, CLI bundle, lint rule |    350 |   325 |

Tests are inside the numbers above: 7,429 lines in total (server engine against the echo provider,
provider adapters replayed against recorded wire sessions, tunnel codec, CLI recipes, plugin host).

**Final total: 143,297 of 150,000.** The original measures 1,427,083 by the same rule.

### Cut entirely

| Area                                                                                                                                                                                                                                                                                                                                   |     Now | Why                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------: | ------------------------------------------------------------------------------------------------------------------------- |
| `apps/mobile`, `packages/mobile-bridge`, mobile branches in the UI                                                                                                                                                                                                                                                                     | ~25,000 | Desktop browser user; push disabled in settings                                                                           |
| `apps/desktop`, `packages/desktop-contract`, desktop branches in the UI                                                                                                                                                                                                                                                                | ~22,000 | Brief; the user runs the web app                                                                                          |
| `apps/web`, `apps/connect`, `packages/connect-db`                                                                                                                                                                                                                                                                                      |  21,118 | Hosted services; not rebuilt                                                                                              |
| `apps/ai-gateway`, `apps/demo-server`                                                                                                                                                                                                                                                                                                  |   2,382 | Brief                                                                                                                     |
| Auth (better-auth users, API keys), telemetry, server-move, auto-update, app version checks                                                                                                                                                                                                                                            |       — | Brief. Replaced by: loopback is the owner, gate-authenticated requests are the owner, each machine holds one hashed token |
| Plugin marketplace, installer, updater, artifacts, safe mode, SDK version gating, CSS scoping                                                                                                                                                                                                                                          |       — | Brief. A plugin is a directory and an enabled flag                                                                        |
| Provider bridge process, conformance and parity tooling, `provider-bridge-acp`, `provider-parity`                                                                                                                                                                                                                                      |  20,947 | Brief                                                                                                                     |
| Legacy event converters, event pruning, retained outputs, outline cache, cursors                                                                                                                                                                                                                                                       |       — | Brief. Deltas are dropped when their item completes                                                                       |
| Pi and ACP providers                                                                                                                                                                                                                                                                                                                   |  13,409 | No threads in 14 days                                                                                                     |
| automations, workflows, browser-automation, side-chat, github, memory, docs, provider-usage, provider-retry, scheduled-send, concurrency-limit, keep-awake, inline-vis, pdf-preview, monaco-editor, agent-annotations, push-notifications, theme-preview, bb-ai, plugin-api-docs, plugin-api-tester, environment-modal-sandbox, drafts | ~60,000 | Decided with the user, or no usage evidence                                                                               |
| In the UI: voice input, in-app browser, PR status, skills pages, composer customization, plugin file openers, right-panel splitting, by-project and by-machine sidebar modes, rich-text composer mode                                                                                                                                  |       — | Budget; see decision 5                                                                                                    |

## What the main user will notice

The full list of visible differences, what was cut, what was simplified and what could not be
verified is in `REPORT.md`. In short:

- Their thirteen path plugins need porting to the new plugin API, `compact-nav` included (the stock
  navigation is bundled instead). Plugins built on composer customization (magic-compose) or file
  openers (better-notes) lose that surface.
- No automations, workflows, browser automation, GitHub PR status, voice input, mobile app.
- Existing data is not migrated in place. `bb import-legacy` copies projects, machines, sections,
  settings and chosen threads from an old data directory.
- bb connect cannot be exercised against production from this build while the live server holds the
  tunnel for the same label (one tunnel per label), so that path is tested against a local fake gate.
