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
from tests of the new primitives, not from a working port of each plugin. Marketplace counts are from
a pattern match and are close, not exact; they were taken before the additions below and were not
recomputed.

## Before the additions

Of the 341 marketplace plugins, 22 needed only mechanical changes, 57 needed changes, and 262 used
at least one capability that had no counterpart. No original plugin loads unmodified in any case:
the package name (`@get-bb/plugin-sdk`) and the RPC style (`rpc.register`, `useRpc`) are both
replaced, as the table at the end of `docs/plugin-api.md` describes.

## Closed

| Need                                                                         | Who needed it                                  | Now                                                                                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Server-side client (`bb.sdk`)                                                | 196 marketplace plugins; most bundled ones     | `bb.sdk`, in-process, attributed to the caller                                                                    |
| Run something at app start without a component (content scripts)             | 81                                             | `bb.onMount`                                                                                                      |
| A component in the thread header                                             | 52                                             | `shell.threadHeader`                                                                                              |
| Sidebar footer entries                                                       | 26                                             | `shell.sidebarFooter`                                                                                             |
| Cron                                                                         | 21, automations, modal                         | `bb.background.schedule`                                                                                          |
| Queue and thread-event notifications                                         | 17, retry                                      | `threads.appended`, `messageQueued`, `messageDispatched`, `messageCancelled`; `thread.failed` carries the failure |
| Machine part reporting to the server                                         | 15, keep-awake, browser-automation             | `bb.signal` to `machines.signal`; `machines.connected` and `disconnected`                                         |
| Home screen sections                                                         | 12                                             | `shell.homeSection`                                                                                               |
| Per-thread skills                                                            | part of `agents.configure` (52)                | hook `sessions.skillDirs`                                                                                         |
| Rows of a plugin's own kind in the timeline                                  | requested                                      | `threads.addRow`, `threadView.pluginRow`                                                                          |
| Tables other plugins can join                                                | requested                                      | `bb.storage.tables`, `table()` in a contract                                                                      |
| Creating machines                                                            | environment-modal-sandbox                      | `machines.provider`, `enroll`, `waitConnected`, `suspend`, `resume`, `remove`                                     |
| Environment inputs, validation, progress, stored state, choosing the machine | all environment plugins                        | `EnvironmentDefinition` (`validate`, richer `create` and `remove`), `composer.environmentInputs`                  |
| Environment and provider reads                                               | modal, project-checkout, acp, many marketplace | `environments.get`, `environments.list`, `sessions.providers`, `sessions.executionOptions`, and `bb.sdk`          |
| Provider declaration limits                                                  | acp, pi                                        | `permissionModes`, `modelCatalogScope` on the declaration                                                         |
| `select` and `number` settings                                               | retry, modal, acp                              | added                                                                                                             |
| Model, permission and branch pickers for add-ons                             | 25 and 6                                       | parts in `bb-plugin-composer/contract`                                                                            |

## The plugins asked about

**environment-modal-sandbox.** Was blocked on four things: no way to create a machine, no public
enrolment, an environment could not choose its machine, and no machine lifecycle events. All four
exist now, and a test runs a thread in an environment kind that enrols and connects its own
machine, stores state, suspends, resumes and removes it. Differences a port must handle: the
original installed the daemon into the sandbox through the plugin's exec channel, while here the
plugin runs the returned `bb runner join` command itself and `bb` must already be in the image;
there is no terminal-input event to drive idle hibernation, so idleness has to come from
`threads.idle`, `threads.appended` and a schedule.

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

Ordered by how many plugins need each.

| Gap                                                                                                                                                                       | Needed by                                                    | Smallest addition                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Old package name and RPC style                                                                                                                                            | all 341                                                      | A port per plugin; a compatibility package was not built                                                              |
| Install from the marketplace: semver ranges, tag prefixes, subdirectories, an engine version check                                                                        | all 341                                                      | `bb dev install` takes `git:url#ref`, `npm:` or a directory only; add `#ref:subdir`, range resolution and `bb.engine` |
| Icon files and `branding.logo` in the manifest                                                                                                                            | 164                                                          | The manifest has one `icon` string                                                                                    |
| Composer access: read and change the draft, submit with options, banners, popups                                                                                          | 58; drafts, scheduled-send, prompt-library, automations      | A typed draft handle on `ComposerContext` and a `composer.banner` slot                                                |
| Choosing other plugins' tools per thread                                                                                                                                  | part of 52                                                   | Only a plugin's own tools (`enabledFor`) and skills can be chosen                                                     |
| App client methods for features that do not exist here: pull-request status, usage limits, file previews, plugin metadata on threads, voice transcription, plugin updates | 72                                                           | These are product features, not API                                                                                   |
| File openers by extension                                                                                                                                                 | 11; monaco-editor, pdf-preview, docs                         | `sidePanel.fileViewer` and a way to open a file from a plugin                                                         |
| Message actions                                                                                                                                                           | 12; side-chat                                                | `threadView.messageAction`                                                                                            |
| Holding a message ("not yet", then recheck)                                                                                                                               | some of the 13 that hook dispatch; concurrency-limit, drafts | A hook on dispatch that can answer "wait"                                                                             |
| Themes in the manifest, theme catalog                                                                                                                                     | 14                                                           | `bb.themes` and theme operations                                                                                      |
| New-thread panel actions, provider icons, an icon registry                                                                                                                | 9, 6, 13                                                     | Slots                                                                                                                 |
| Fork, message editing, rewind                                                                                                                                             | side-chat, pi, acp, codex                                    | Not in this repository at all                                                                                         |
| Provider installation, native roots, an ACP library                                                                                                                       | acp, pi                                                      | Optional adapter methods; a helper package                                                                            |
| Sidebar navigation: reorder, hide, accessories, split                                                                                                                     | navigation                                                   | Actions on `SidebarNavigationActions`                                                                                 |
| Port tunnels from enrolled machines; "setup required" for server access                                                                                                   | connect                                                      | Runner part work                                                                                                      |
| Transcription and status on inference services                                                                                                                            | bb-ai                                                        | Optional methods                                                                                                      |
| Per-project settings                                                                                                                                                      | several                                                      | A third scope                                                                                                         |
| In-app browser toolbar, desktop browsers                                                                                                                                  | agent-annotations, browser-automation                        | No in-app browser exists here                                                                                         |

## Things the audit found in existing ports

Comparing the eight plugins already ported here with their originals showed that most differences
are scope cuts, not API gaps: Tasks lost its board view, folders and preset dialog; the thread list
lost grouping by project or machine and its customizers; Account Pool lost per-thread bypass and
reordering; Connect lost mobile pairing and shares from other machines; Navigation's overview file
still claims reordering and hiding, which it no longer does.
