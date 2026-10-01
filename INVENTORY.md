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

| Fact | Evidence |
|---|---|
| Providers | 4,367 threads on Codex, 1,150 on Claude Code, 54 on Pi/ACP (none in the last 14 days) |
| Multi-machine is in daily use | Last 14 days: 272 of 387 environment-bound threads ran on hosts other than the server machine; four remote hosts connected at query time |
| bb connect is how machines and browsers reach the server | `defaultMachineAccess = "connect"`, server URL `https://bee.getbb.app`; ~85 shared-port entries |
| Account pool is live | `routing.codex = routing.claude = true`; the running `codex app-server` points at the pool proxy |
| Child threads through the CLI | 1,592 threads have a parent; agents mostly run `bb thread tell/wait/show/spawn/log/output/archive`, `bb status`, `bb terminal *` |
| Worktrees | 486 git-worktree environments; `project-checkout` and `personal-workspace` also used |
| Sidebar | Custom sections (3), "chronological" organisation, pinned threads (7), thread list from the bundled plugin; navigation and header from the user's own `compact-nav` plugin |
| Settings | Nord theme, teal favicon, steer-on-Enter, custom keybindings, `managedBranchPrefix = "bb/"` |
| Interactions | 425 provider approvals/questions, 24 ask-user-question, 32 secret requests |
| Tasks | 109 tasks, 881 comments, 106 thread links; last write 2026-09-04 |
| Plugins with real traffic that are cut | workflows (1,427 hidden threads, 3 in the last 14 days), automations (14 threads in 14 days), browser automation, slopcop (the user's own, 252 threads in 14 days; needs porting to the new API) |

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

## Keep / shrink / cut, with budgets

"Now" is non-test lines in the original. Budgets include that area's own tests unless a test line is shown.

### Web UI (copied, then cut)

| Area | Now | Decision | Budget |
|---|---:|---|---:|
| `apps/app` | 183,931 | Shrink hard. Keep the visible components of the thread screen, composer, right panel, sidebar shell, split panes, command palette, settings the user has touched. Rewrite the data layer, tab model and plugin host smaller. Cut mobile, desktop shell, marketplace, updates, server-move, in-app browser, voice, PR UI, skills pages, cloud machines, stories | 54,000 |
| `plugins/thread-list` | 17,642 | Shrink. Keep "Custom" sections mode, pinned, drag and drop, row actions; cut by-project and by-machine modes, touch code, forked helper copies | 9,000 |
| `packages/thread-view` | 16,497 | Shrink. Timeline projection runs on the server and the view helpers in the browser; drop legacy converters | 11,500 |
| `packages/shared-ui` | 12,254 | Shrink to the components still imported | 4,500 |
| `packages/client-core`, `core-ui`, `text-utils`, `fuzzy-match` | 8,402 | Shrink | 5,000 |
| `plugins/navigation` | 1,313 | Replace with an in-repo port of the user's `compact-nav` (what they actually see) | 300 |

### Shared contracts

| Area | Now | Decision | Budget |
|---|---:|---|---:|
| `packages/domain` | 11,182 | Shrink to kept features; the event and row schemas stay as they are (UI contract) | 6,500 |
| `packages/server-contract`, `hono-typed-routes` | 8,010 | Shrink to about 110 routes; free to change shape where that deletes client code | 4,800 |
| `packages/sdk` | 7,176 | Rewrite as one small typed client for app, CLI and plugins | 2,200 |

### Server, runtime, CLI (redesigned)

| Area | Now | Decision | Budget |
|---|---:|---|---:|
| `apps/server` + `packages/db` + `server-archive` + `logger` + `config` + `secret-storage` | 117,527 | Rewrite: one process, about 18 tables in one schema file, thread engine, queue, interactions, timeline glue, environments, runner hub, files, terminals, settings, search, plugin host | 15,500 |
| `apps/host-daemon`, `agent-runtime`, `provider-bridge-protocol`, `provider-codex`, `provider-claude-code`, `host-daemon-contract`, `host-workspace`, `host-watcher`, `local-open-targets`, `process-utils`, the three environment plugins | 82,807 | Rewrite as `packages/runner`: one `Runner` interface, in-process on the server machine and over one WebSocket for other machines. Two in-process provider adapters plus a scripted echo provider; no bridge process | 9,000 |
| `apps/cli` + `packages/bb-app` | 26,113 | Rewrite: about 70 commands from one declarative table; plugin commands dispatched by the server | 3,300 |
| `packages/plugin-sdk`, `plugin-build`, `plugin-registry`, `bundled-plugins`, `templates`, server plugin services | 49,000 | Redesign as `packages/plugin` plus about 1,500 lines of host code inside the server and app budgets | 900 |

### Kept plugins

| Area | Now | Decision | Budget |
|---|---:|---|---:|
| `plugins/tasks` | 21,109 | Shrink: list, detail, comments, attachments, thread links, dispatch, `bb tasks` | 7,000 |
| `plugins/account-pool` | 9,269 | Shrink: proxy hub, token refresh, threshold switching, `bb pool`, one settings card | 3,600 |
| `plugins/connect` + `bb-account` + `tunnel-client` + `tunnel-contract` + `connect-client` + daemon share tunnel | 10,100 | Shrink: tunnel (wire format verbatim), account link, machine credentials, port shares | 2,100 |
| `plugins/secrets`, `plugins/ask-user-question` | 1,324 | Keep, ported | 700 |

### Tests, scripts

| Area | Now | Decision | Budget |
|---|---:|---|---:|
| Tests (all packages) | 710,944 | A small suite per layer: server engine against the echo provider, provider adapters against recorded wire sessions, projection, tunnel codec, CLI, a few pure UI modules | 6,500 |
| `scripts/`, root config | 5,701 | Line counter, build, QA drivers | 600 |

**Planned total: 147,000**, leaving about 3,000 in reserve.

### Cut entirely

| Area | Now | Why |
|---|---:|---|
| `apps/mobile`, `packages/mobile-bridge`, mobile branches in the UI | ~25,000 | Desktop browser user; push disabled in settings |
| `apps/desktop`, `packages/desktop-contract`, desktop branches in the UI | ~22,000 | Brief; the user runs the web app |
| `apps/web`, `apps/connect`, `packages/connect-db` | 21,118 | Hosted services; not rebuilt |
| `apps/ai-gateway`, `apps/demo-server` | 2,382 | Brief |
| Auth (better-auth users, API keys), telemetry, server-move, auto-update, app version checks | — | Brief. Replaced by: loopback is the owner, gate-authenticated requests are the owner, each machine holds one hashed token |
| Plugin marketplace, installer, updater, artifacts, safe mode, SDK version gating, CSS scoping | — | Brief. A plugin is a directory and an enabled flag |
| Provider bridge process, conformance and parity tooling, `provider-bridge-acp`, `provider-parity` | 20,947 | Brief |
| Legacy event converters, event pruning, retained outputs, outline cache, cursors | — | Brief. Deltas are dropped when their item completes |
| Pi and ACP providers | 13,409 | No threads in 14 days |
| automations, workflows, browser-automation, side-chat, github, memory, docs, provider-usage, provider-retry, scheduled-send, concurrency-limit, keep-awake, inline-vis, pdf-preview, monaco-editor, agent-annotations, push-notifications, theme-preview, bb-ai, plugin-api-docs, plugin-api-tester, environment-modal-sandbox, drafts | ~60,000 | Decided with the user, or no usage evidence |
| In the UI: voice input, in-app browser, PR status, skills pages, composer customization, plugin file openers, right-panel splitting, by-project and by-machine sidebar modes, rich-text composer mode | — | Budget; see decision 5 |

## What the main user will notice

- Their thirteen path plugins need porting to the new plugin API. `compact-nav` is ported in this repo.
  Plugins built on composer customization (magic-compose) or file openers (better-notes) lose that surface.
- No automations, workflows, browser automation, GitHub PR status, voice input, mobile app.
- Existing data is not migrated in place. `bb import-legacy` copies projects, sections, settings and
  chosen threads from an old data directory.
- bb connect cannot be exercised against production from this build while the live server holds the
  tunnel for the same label (one tunnel per label), so that path is tested against a local fake gate.
