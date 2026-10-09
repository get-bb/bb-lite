# Can the original bb's plugins move to this API?

An audit made on 8 October 2026 of every plugin written for the original bb against the plugin API
in this repository, what was closed as a result, and what is still missing. `docs/plugin-api.md` is
the reference for the API itself.

## What was read

| Set                                                    | Plugins                                                      | How                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Bundled with the original bb (`~/projects/bb/plugins`) | 42                                                           | Source read against `packages/plugin-sdk` there and `packages/plugin` here |
| Marketplace (`get-bb/marketplace`)                     | 341 entries, all fetched (256 repositories, 13 npm packages) | Static tally of SDK calls over each plugin's import graph; nothing was run |

Nothing was ported. Verdicts come from comparing what each plugin calls with what exists here, and
from tests of the new primitives, not from a working port of each plugin. Counts are from a pattern
match over each plugin's source and are close, not exact.

## Where it stands

`bb dev port <dir>` holds the comparison: for each of the 579 calls and manifest fields of the
original SDK that any of these plugins uses, it names what that call is here. Run over every plugin,
the worst answer each one gets is:

| Worst answer for the plugin                                   | Marketplace (341) | Bundled (41 that use the SDK) |
| ------------------------------------------------------------- | ----------------- | ----------------------------- |
| Renamed only                                                  | 29                | 3                             |
| Works differently (a rewrite of those calls, nothing missing) | 276               | 31                            |
| Needs a feature this bb does not have                         | 35                | 7                             |
| No counterpart                                                | 1                 | 0                             |

Before the additions listed under "Closed", 262 marketplace plugins used something with no
counterpart.

No original plugin loads unmodified: the package name (`@get-bb/plugin-sdk`) and the RPC style
(`rpc.register`, `useRpc`) are both replaced, so every plugin is at least "works differently" unless
it has no server calls at all. A theme-only plugin is the exception that needs almost nothing: its
manifest is read as written.

### Needs a feature this bb does not have

These are not gaps in the plugin API. The original bb has the feature in its core and this
repository does not, so a plugin that leans on it has nothing to call until the feature exists. Each
could itself be written as a plugin that publishes a contract.

| Feature                                                              | Marketplace plugins | Bundled plugins   |
| -------------------------------------------------------------------- | ------------------- | ----------------- |
| Pull-request status and actions                                      | 11                  | github, tasks     |
| A skills browser and registry                                        | 7                   |                   |
| Voice input                                                          | 3                   | plugin-api-docs   |
| Fork and message editing (providers here cannot rewind)              | 3                   | side-chat         |
| A stored order for projects                                          | 2                   |                   |
| Health of a provider's environment                                   | 1                   | account-pool      |
| Port sharing from machines other than the server's                   | 1                   | connect           |
| An in-app browser; desktop browsers                                  | 2                   | agent-annotations |
| Reordering queued messages; provider CLI install status; experiments | 3                   |                   |

### No counterpart

One call: `threads.paneAction`, which lets a server plugin act on the pane a thread is shown in.
One marketplace plugin (`handsfree`) uses it.

### The larger rewrites

"Works differently" covers a wide range. The two heaviest:

- **Providers.** The original runs a bridge subprocess that speaks JSON-RPC; here a provider is a
  `ProviderAdapter` object in a runner part. The translation is written again, not moved. The
  original SDK also shipped an ACP client and a bridge test harness; neither exists here, so an ACP
  plugin adds `@agentclientprotocol/sdk` to its runner part. Nine plugins are affected.
- **Composer popups.** The original host placed popups for the plugin. Here a plugin draws its own
  from a banner or footer control.

## Closed

| Need                                                                                                         | Who needed it                                  | Now                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Server-side client (`bb.sdk`)                                                                                | 196 marketplace plugins; most bundled ones     | every client method is an operation: `bb.call(op, input)`, attributed to the caller                                            |
| Run something at app start without a component (content scripts)                                             | 81                                             | `bb.onStart`                                                                                                                   |
| A component in the thread header                                                                             | 52                                             | `threadView.header`                                                                                                            |
| Sidebar footer entries                                                                                       | 26                                             | `shell.sidebarFooter`                                                                                                          |
| Cron                                                                                                         | 21, automations, modal                         | `bb.background.schedule`                                                                                                       |
| Queue and thread-event notifications                                                                         | 17, retry                                      | `threads.appended`, `messageQueued`, `messageDispatched`, `messageDeleted`; `thread.failed` carries the failure                |
| Machine part reporting to the server                                                                         | 15, keep-awake, browser-automation             | `bb.signal` to `machines.signaled`; `machines.connected` and `disconnected`                                                    |
| Home screen sections                                                                                         | 12                                             | `composer.homeSection`                                                                                                         |
| Per-thread skills                                                                                            | part of `agents.configure` (52)                | hook `sessions.skillDirs`                                                                                                      |
| Rows of a plugin's own kind in the timeline                                                                  | requested                                      | `threads.addRow`, `threadView.pluginRow`                                                                                       |
| Tables other plugins can join                                                                                | requested                                      | `bb.storage.tables`, `table()` in a contract                                                                                   |
| Creating machines                                                                                            | environment-modal-sandbox                      | `machines.provider`, `enroll`, `waitConnected`, `suspend`, `resume`, `delete`                                                  |
| Environment inputs, validation, progress, stored state, choosing the machine                                 | all environment plugins                        | `EnvironmentDefinition` (`validate`, richer `create` and `remove`), `composer.environmentInputs`                               |
| Environment and provider reads                                                                               | modal, project-checkout, acp, many marketplace | `environments.get`, `environments.list`, `sessions.providers`, `sessions.executionOptions` and the rest of the core operations |
| Provider declaration limits                                                                                  | acp, pi                                        | `permissionModes`, `modelCatalogScope` on the declaration                                                                      |
| `select` and `number` settings                                                                               | retry, modal, acp                              | added                                                                                                                          |
| Model, permission and branch pickers for add-ons                                                             | 25 and 6                                       | parts in `bb-plugin-composer/contract`                                                                                         |
| Themes in the manifest                                                                                       | 14                                             | `bb.themes` is read as written; slot `appearance.theme`                                                                        |
| Composer: draft, pickers, banners, text effects, submit state                                                | 58; drafts, scheduled-send, prompt-library     | `useComposer()` handle, `composer.banner`, `composer.textEffect`                                                               |
| File viewers by extension, opening a file                                                                    | 11; monaco-editor, pdf-preview, docs           | `sidePanel.fileViewer`, `useBbNavigate().openFile`                                                                             |
| Message actions                                                                                              | 12; side-chat                                  | `threadView.messageAction`                                                                                                     |
| Holding a message and rechecking                                                                             | concurrency-limit, drafts                      | hook `threads.hold`; `threads.release`                                                                                         |
| Choosing a session's tools                                                                                   | part of `agents.configure` (52)                | hook `sessions.tools`                                                                                                          |
| Thread storage, file changes, terminal size                                                                  | several                                        | `threads.storageLocation`; `files.list`, `mkdir`, `remove`, `move`; `terminals.resize`                                         |
| Sidebar row statuses, icons, footer components, navigation split                                             | 13 and more                                    | `shell.threadRowStatus`, `app.icon`, `shell.sidebarFooter` views, `useSidebarNavigationSplit`                                  |
| `host.deleted` and `terminal.input` events                                                                   | modal                                          | `machines.deleted`, `terminals.inputReceived`                                                                                  |
| The original manifest names                                                                                  | all                                            | `bb.branding.icon` and `bb.host` are accepted                                                                                  |
| Installing from the marketplace: ranges, tag prefixes, subdirectories, engine check; the catalog and updates | all; 5 marketplace, plugin-api-docs            | `bb dev install --version --tag-prefix`, `git:url#ref:subdir`, `engine_mismatch`; the `marketplace` plugin                     |

## The plugins asked about

**environment-modal-sandbox.** Was blocked on four things: no way to create a machine, no public
enrolment, an environment could not choose its machine, and no machine lifecycle events. All four
exist now, and a test runs a thread in an environment kind that enrols and connects its own
machine, stores state, suspends, resumes and removes it. Differences a port must handle: the
original installed the daemon into the sandbox through the plugin's exec channel, while here the
plugin runs the returned `bb runner join` command itself and `bb` must already be in the image.
Idle hibernation can use `terminals.inputReceived` with `threads.idle` and a schedule.

**environment-git-worktree, project-checkout, personal-workspace.** These are built in here. A
plugin can replace one by id, and now gets inputs, validation, progress and state. Still private to
the built-ins: restoring a retired environment, adopting an existing path, sharing a checkout
between threads, and the merge-base branch.

**provider-pi.** Portable as a rewrite. The original speaks to a bridge subprocess over JSON-RPC;
here a provider is an in-process `ProviderAdapter` in a runner part, so the translation layer is
written again rather than moved. Skills and compaction have counterparts. Message editing and fork
do not exist anywhere in this repository, so that part of Pi has nothing to attach to.

**provider-acp.** Portable with more work. Registering and removing a provider per agent works,
probing a machine is a runner operation, and configuration reaches the runner part by calling it on
`machines.connected`. Missing: an ACP client. The original SDK shipped one
(`experimental_acpProviderBridge`); here the plugin must bundle its own into its runner part. Custom
agents were a JSON setting with validation; settings have no JSON type, so that becomes a multiline
string the plugin parses.

**provider-retry, provider-usage.** Retry has the failure details and the queue to work with, though
queueing with a send time goes through an operation that takes untyped arguments. Usage has a slot
for sources (`sessions.usage`) but core shows nothing from it yet.

## Still missing

| Gap                                       | Needed by                 | Smallest addition                                        |
| ----------------------------------------- | ------------------------- | -------------------------------------------------------- |
| Old package name and RPC style            | all 341                   | A port per plugin; a compatibility package was not built |
| An ACP client and a provider test harness | acp and 8 marketplace     | A helper package beside `ProviderAdapter`                |
| Host-placed composer popups               | 2                         | A `composer.popup` slot                                  |
| Acting on a thread's pane from the server | 1                         | An event the app listens to                              |
| Code themes from a file                   | 4 of the 8 that set one   | Load a theme file named by `codeTheme`                   |
| Per-project settings                      | several                   | A third scope                                            |
| The features in the table above           | 35 marketplace, 7 bundled | Product work, each possible as a plugin                  |

## Things the audit found in existing ports

Comparing the eight plugins already ported here with their originals showed that most differences
are scope cuts, not API gaps: Tasks lost its board view, folders and preset dialog; the thread list
lost grouping by project or machine and its customizers; Account Pool lost per-thread bypass and
reordering; Connect lost mobile pairing and shares from other machines; Navigation's overview file
still claims reordering and hiding, which it no longer does.
