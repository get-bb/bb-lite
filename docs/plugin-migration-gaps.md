# Can the original bb's plugins move to this API?

An audit made on 8 October 2026 of every plugin written for the original bb against the plugin API
in this repository, the port of the original's built-in plugins that followed on 8 and 9 October,
what was closed as a result, and what is still missing. `docs/plugin-api.md` is the reference for
the API itself.

## What was read

| Set                                                    | Plugins                                                      | How                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Bundled with the original bb (`~/projects/bb/plugins`) | 42                                                           | Source read against `packages/plugin-sdk` there and `packages/plugin` here |
| Marketplace (`get-bb/marketplace`)                     | 341 entries, all fetched (256 repositories, 13 npm packages) | Static tally of SDK calls over each plugin's import graph; nothing was run |

The audit itself ported nothing; its verdicts came from comparing what each plugin calls with what
exists here. Since then 39 of the 42 bundled plugins have been ported or rebuilt here (see "Built-in
plugins: port status"), and every gap a port ran into was either closed in the API or is listed
under "Still missing". No marketplace plugin has been ported. Counts are from a pattern match over
each plugin's source and are close, not exact.

## Where it stands

`bb dev port <dir>` holds the comparison: for each of the 579 calls and manifest fields of the
original SDK that any of these plugins uses, it names what that call is here. At the audit, the
worst answer each plugin got was:

| Worst answer for the plugin                                   | Marketplace (341) | Bundled (41 that use the SDK) |
| ------------------------------------------------------------- | ----------------- | ----------------------------- |
| Renamed only                                                  | 29                | 3                             |
| Works differently (a rewrite of those calls, nothing missing) | 276               | 31                            |
| Needs a feature this bb does not have                         | 35                | 7                             |
| No counterpart                                                | 1                 | 0                             |

Before the additions listed under "Closed", 262 marketplace plugins used something with no
counterpart. The tally above has not been rerun since; most of the features in the next table now
exist, so the "needs a feature" rows are smaller than shown; rerun `bb dev port` for current
numbers.

No original plugin loads unmodified: the package name (`@get-bb/plugin-sdk`) and the RPC style
(`rpc.register`, `useRpc`) are both replaced, so every plugin is at least "works differently" unless
it has no server calls at all. A theme-only plugin is the exception that needs almost nothing: its
manifest is read as written.

### Needs a feature this bb does not have

These are not gaps in the plugin API. The original bb has the feature in its core and this
repository did not, so a plugin that leans on it has nothing to call until the feature exists. Each
could itself be written as a plugin that publishes a contract. Rows that are now closed moved to
"Closed": the skills browser, message editing, port sharing from other machines and queue group
boundaries.

| Feature                             | Marketplace plugins | Bundled plugins   | Why it is still open                                                                                    |
| ----------------------------------- | ------------------- | ----------------- | ------------------------------------------------------------------------------------------------------- |
| An in-app browser; desktop browsers | 2                   | agent-annotations | No desktop app and no `desktop` contract; browser-automation refuses its desktop backend                |
| Changing experiments                | part of 3           |                   | `server.experiments` reads the flags; nothing sets them (`system.updateExperiments` has no counterpart) |

### No counterpart

Nothing left. The one call in this group, `threads.paneAction` (used by the marketplace plugin
`handsfree`), is now an event of the same name the app acts on.

### The larger rewrites

"Works differently" covers a wide range. The two heaviest:

- **Providers.** The original runs a bridge subprocess that speaks JSON-RPC; here a provider is a
  `ProviderAdapter` object in a runner part. The translation is written again, not moved. The
  original SDK also shipped an ACP client and a bridge test harness; neither exists here, so an ACP
  plugin adds `@agentclientprotocol/sdk` to its runner part. Nine plugins are affected.
  provider-pi was ported this way, and provider-acp shows the ACP case.
- **Composer popups.** The original host placed popups for the plugin. Here a plugin fills the
  `composer.popup` slot and opens it from the composer handle; the host places it above the composer
  and closes it on Escape. The calls are renamed rather than missing.

## Closed

| Need                                                                                                         | Who needed it                                  | Now                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server-side client (`bb.sdk`)                                                                                | 196 marketplace plugins; most bundled ones     | every client method is an operation: `bb.call(op, input)`, attributed to the caller                                                                                                              |
| Run something at app start without a component (content scripts)                                             | 81                                             | `bb.onStart`                                                                                                                                                                                     |
| A component in the thread header                                                                             | 52                                             | `threadView.header`                                                                                                                                                                              |
| Sidebar footer entries                                                                                       | 26                                             | `shell.sidebarFooter`                                                                                                                                                                            |
| Cron                                                                                                         | 21, automations, modal                         | `bb.background.schedule`                                                                                                                                                                         |
| Queue and thread-event notifications                                                                         | 17, retry                                      | `threads.appended`, `messageQueued`, `messageDispatched`, `messageDeleted`; `thread.failed` carries the failure                                                                                  |
| Machine part reporting to the server                                                                         | 15, keep-awake, browser-automation             | `bb.signal` to `machines.signaled`; `machines.connected` and `disconnected`                                                                                                                      |
| Home screen sections                                                                                         | 12                                             | `composer.homeSection`                                                                                                                                                                           |
| Per-thread skills                                                                                            | part of `agents.configure` (52)                | hook `sessions.skillDirs`                                                                                                                                                                        |
| Rows of a plugin's own kind in the timeline                                                                  | requested                                      | `threads.addRow`, `threadView.pluginRow`                                                                                                                                                         |
| Tables other plugins can join                                                                                | requested                                      | `bb.storage.tables`, `table()` in a contract                                                                                                                                                     |
| Creating machines                                                                                            | environment-modal-sandbox                      | `machines.provider`, `enroll`, `waitConnected`, `suspend`, `resume`, `delete`, `reconcile`                                                                                                       |
| Environment inputs, validation, progress, stored state, choosing the machine                                 | all environment plugins                        | `EnvironmentDefinition` (`validate`, richer `create` and `remove`, `log`), `composer.environmentInputs`                                                                                          |
| Environment and provider reads                                                                               | modal, project-checkout, acp, many marketplace | `environments.get`, `environments.list`, `sessions.providers`, `sessions.executionOptions` and the rest of the core operations                                                                   |
| Provider declaration limits                                                                                  | acp, pi                                        | `permissionModes`, `modelCatalogScope` on the declaration                                                                                                                                        |
| Provider compaction, native skill roots, instruction mode, checkpoint fork                                   | pi                                             | `ProviderSession.compact`, `nativeSkillRoots`, `SessionSpec.instructionMode`, `SessionSpec.forkFrom`                                                                                             |
| `select` and `number` settings                                                                               | retry, modal, acp                              | added                                                                                                                                                                                            |
| Model, permission and branch pickers for add-ons                                                             | 25 and 6                                       | parts in `bb-plugin-composer/contract`                                                                                                                                                           |
| Themes in the manifest                                                                                       | 14                                             | `bb.themes` is read as written; slot `appearance.theme`                                                                                                                                          |
| Code themes from a file                                                                                      | 4 of the 8 that set one                        | `codeTheme` files in a plugin theme are served; `appearance.themeCss`; `server.config` announced on plugin changes                                                                               |
| Composer: draft, pickers, banners, text effects, submit state                                                | 58; drafts, scheduled-send, prompt-library     | `useComposer()` handle (`setDraft`, `mentions`, `submit({ sendAt })`), `composer.banner`, `composer.textEffect`                                                                                  |
| Host-placed composer popups                                                                                  | 2                                              | slot `composer.popup`; the handle opens and closes it                                                                                                                                            |
| File viewers by extension, opening a file                                                                    | 11; monaco-editor, pdf-preview, docs           | `sidePanel.fileViewer`, `useBbNavigate().openFile` with a `source`, `files.url`                                                                                                                  |
| Message actions                                                                                              | 12; side-chat                                  | `threadView.messageAction`, with selected text, sequence and `openPanel` in its context                                                                                                          |
| Holding a message and rechecking                                                                             | concurrency-limit, drafts                      | hook `threads.hold` (told the machine and the message); `threads.release`, with no thread releasing all                                                                                          |
| Choosing a session's tools                                                                                   | part of `agents.configure` (52)                | hook `sessions.tools`                                                                                                                                                                            |
| Thread storage, file changes, terminal size                                                                  | several                                        | `threads.storageLocation`; `files.list`, `mkdir`, `delete`, `move`; `terminals.resize`                                                                                                           |
| Sidebar row statuses, icons, footer components, navigation split                                             | 13 and more                                    | `shell.threadRowStatus`, `app.icon`, `shell.sidebarFooter` views, `useSidebarNavigationSplit`                                                                                                    |
| `host.deleted` and `terminal.input` events                                                                   | modal                                          | `machines.deleted`, `terminals.inputReceived`                                                                                                                                                    |
| The original manifest names                                                                                  | all                                            | `bb.branding.icon` and `bb.host` are accepted                                                                                                                                                    |
| Installing from the marketplace: ranges, tag prefixes, subdirectories, engine check; the catalog and updates | all; 5 marketplace, plugin-api-docs            | `bb dev install --version --tag-prefix`, `git:url#ref:subdir`, `engine_mismatch`, `plugin-dev.install`; the `marketplace` plugin                                                                 |
| Pull-request status and actions                                                                              | 11; github, tasks                              | the `github` plugin's `pullRequests` contract (`get`, `list`, `create`, `details`, `forThread`, `createComment`, `createReview`, `update({ environmentId, draft })` for ready or draft, `merge`) |
| Voice input                                                                                                  | 3; plugin-api-docs                             | slot `sessions.transcription`, operation `sessions.transcribe` (bb-ai fills it); the `voice-input` plugin                                                                                        |
| Fork                                                                                                         | 3; side-chat, provider-pi                      | `threads.fork`: copies the source timeline and forks the provider session at a checkpoint when it can                                                                                            |
| A stored order for projects                                                                                  | 2                                              | `projects.order`, `projects.updateOrder` (per user)                                                                                                                                              |
| Health of a provider's environment                                                                           | 1; account-pool                                | operation `sessions.environmentHealth`, which a plugin hooks with `bb.on`                                                                                                                        |
| Install status of a provider's command-line tool                                                             | part of 3                                      | `sessions.providerStatus` (with `minimumVersion`, `installAction`), shown as a badge in settings                                                                                                 |
| Reordering queued messages                                                                                   | part of 3                                      | `threads.reorderQueuedMessages`                                                                                                                                                                  |
| Reading experiments                                                                                          | part of 3                                      | `server.experiments`                                                                                                                                                                             |
| Acting on a thread's pane from the server                                                                    | 1 (`handsfree`)                                | event `threads.paneAction`                                                                                                                                                                       |
| Per-project settings                                                                                         | several; github                                | setting scope `"project"`, and a `project` field type                                                                                                                                            |
| Per-user delivery and per-user settings                                                                      | push-notifications                             | an `Audience` (`userId`) on changes, events and live values; `settings.get({ userId })`                                                                                                          |
| Errors a caller can act on                                                                                   | all                                            | `fail(code, message, { hint })` with `not_found`, `conflict`, `unavailable`, `invalid`; `deny(reason)`; hints reach every door                                                                   |
| CLI doors that match the original commands                                                                   | memory, workflows, modal, browser-automation   | aliases, durations, split values, min and max, constraints, `from` (cwd, project, thread, machine), `exitCode`, `description`                                                                    |
| Agent tools offered only to some callers                                                                     | workflows                                      | `bb.implement(op, fn, { offered })`                                                                                                                                                              |
| Cancelling a machine call                                                                                    | browser-automation, modal                      | `signal` on `bb.runners.call`                                                                                                                                                                    |
| Transcription and commit messages from inference                                                             | bb-ai                                          | `sessions.transcription`; `environments.commitMessage`                                                                                                                                           |
| A skills browser and registry                                                                                | 7                                              | the `skills` plugin: `skills.list`, `get`, `install`, `uninstall`, `enable`, `disable`, `search` and the `skills.source` slot                                                                    |
| Message editing                                                                                              | part of 3; provider-pi                         | `threads.updateMessage` restarts the session at the previous turn's checkpoint; Codex, Claude Code, Pi and echo declare `capabilities.fork: "checkpoint"`                                        |
| Port sharing from machines other than the server's                                                           | 1; connect                                     | `connect.expose({ port, hostId })`, relayed through `connect.shareRequest`, `shareChunk`, `shareClose`. HTTP only: no WebSockets from other machines, and one machine per port number            |
| Logging in with a code                                                                                       | bb-account                                     | `bb account login --code` calls `connect.redeem`                                                                                                                                                 |
| Managing catalogs; `bb plugin search`, `install`, `outdated`, `update`                                       | marketplace                                    | `marketplace.catalogs`, `addCatalog`, `removeCatalog`, `refresh`; door aliases under another first word                                                                                          |
| Group boundaries in the message queue                                                                        | part of 3                                      | `threads.setQueuedMessageBoundary`; a group is sent as one turn                                                                                                                                  |
| Writing files outside the workspace                                                                          | docs                                           | `source` (`FileSource`) on every `files` operation                                                                                                                                               |
| Web workers in a plugin's app bundle                                                                         | monaco-editor                                  | `new Worker(new URL("./w.ts", import.meta.url))` in a forked or installed app part is bundled and inlined as a `blob:` URL                                                                       |
| Compact JSON and positional names in CLI doors                                                               | browser-automation, workflows                  | `json(output, input)`, `compactJson` and `{ field, name }` positionals on `CliDoor`                                                                                                              |
| Prompt history across threads                                                                                | prompt-library                                 | `threads.recentPrompts`                                                                                                                                                                          |

## The plugins asked about

**environment-modal-sandbox.** Ported. Was blocked on four things: no way to create a machine, no
public enrolment, an environment could not choose its machine, and no machine lifecycle events. All
four exist now, and the port enrols and connects its own machine, stores state, suspends, resumes,
reconciles and removes it. The image must already contain `bb`: `machines.enroll` returns a join
script that fetches `/install.sh` from the server, and the server does not serve that file yet.

**environment-git-worktree, project-checkout, personal-workspace.** These are built-in plugins here,
on the same `EnvironmentDefinition` any plugin uses. A plugin can replace one by id. Restoring a
retired environment (`restoring`), adopting an existing path (a `checkout` placement with a `path`)
and the merge-base branch (`mergeBaseBranch`) are now on that definition. Core still names the
built-in kind ids in a few defaults.

**provider-pi.** Ported in three stages as a rewrite: the translation layer is an in-process
`ProviderAdapter` in a runner part. Skills, compaction, instruction mode, the version gate and fork at
a checkpoint have counterparts, and so does message editing: Pi declares checkpoint fork, which
`threads.updateMessage` uses.

**provider-acp.** Ported from the original's rebuilt adapter (`provider-acp-next`), not the older
one. The runner part is that adapter with its bridge process removed: the client on
`@agentclientprotocol/sdk`, the session model, the translation, the per-agent dialects and the model
catalog are the original's modules, and `runner/engine.ts` is the original bridge with its stdio
protocol replaced by callbacks an adapter (`runner/adapter.ts`) connects to `ProviderAdapter`. The
original's deltas are applied to the event builder by `runner/thread-delta.ts`. The carried-over
modules still speak the original's vocabulary through `runner/kit.ts`; rewriting them against this
API directly is a planned follow-up. Custom agents are a multiline string setting holding JSON,
since settings have no JSON type. Left out:

- Forks: an ACP fork is at the tip, and a provider here can only declare checkpoint forks.
- The per-agent resolvers for native skill roots; only the static roots are declared.
- The agent's own options and live slash commands are served by `threads.sessionOptions` and
  `threads.providerCommands` and choices are sent with each turn, but the composer does not show
  them yet.
- Raw unhandled agent updates are dropped instead of recorded.

**provider-retry, provider-usage.** Both ported. Retry gets the failure details on `thread.failed`
and queues with a typed `sendAt`. Usage reads the `sessions.usage` sources that provider-codex and
provider-claude-code now fill.

## Built-in plugins: port status

One row per plugin bundled with the original bb. "Imported" plugins came over with the original's UI
before the overnight port and were already on this API.

| Original                       | Status               | Knowingly left out, or why not ported                                                                                           |
| ------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| account-pool                   | Imported             | Per-thread bypass and account reordering; now hooks `sessions.environmentHealth`                                                |
| agent-annotations              | Not ported           | Needs an in-app desktop browser this bb does not have                                                                           |
| ask-user-question              | Imported             | Nothing recorded                                                                                                                |
| automations                    | Ported (3 stages)    | Script editing in the app form, legacy import, overview filters and search, composer pickers, cronstrue text                    |
| bb-account                     | Ported               | `--base-url`; `login --code` now redeems through `connect.redeem`                                                               |
| bb-ai                          | Ported               | Nothing now: transcription and commit messages were added after the port                                                        |
| bb-guide                       | Ported               | Nothing                                                                                                                         |
| browser-automation             | Ported (2 stages)    | The desktop backend (no desktop contract); never run against a real Chrome; installer locking and progress                      |
| concurrency-limit              | Ported               | Nothing                                                                                                                         |
| connect                        | Imported             | Mobile pairing; port shares from other machines came back in `plugins/connect` (HTTP only)                                      |
| custom-instructions            | Imported             | Nothing recorded                                                                                                                |
| docs                           | Ported (3 stages)    | Rich editor, HTML sandbox preview, drag reordering; host and thread-storage files were read-only (`files` now takes a `source`) |
| drafts                         | Ported               | Nothing                                                                                                                         |
| environment-git-worktree       | Built in as a plugin | Rewritten on `EnvironmentDefinition`, not ported from the original's code                                                       |
| environment-modal-sandbox      | Ported (2 stages)    | Installing `bb` in a blank sandbox; `sandbox exec` exits 0 when the command fails; no abort mid-exec                            |
| environment-personal-workspace | Built in as a plugin | Rewritten on `EnvironmentDefinition`, not ported from the original's code                                                       |
| environment-project-checkout   | Built in as a plugin | Rewritten on `EnvironmentDefinition`, not ported from the original's code                                                       |
| github                         | Ported (2 stages)    | Filter suggestion dropdown and avatars; app part not exercised in a running app                                                 |
| inline-vis                     | Ported               | Nothing                                                                                                                         |
| keep-awake                     | Ported               | Nothing                                                                                                                         |
| memory                         | Ported               | Nothing                                                                                                                         |
| monaco-editor                  | Ported (2 stages)    | Toolbar extras, tree resizing, files of a project with no environment                                                           |
| navigation                     | Imported             | Reordering and hiding entries, which its overview still claims                                                                  |
| pdf-preview                    | Ported               | Nothing                                                                                                                         |
| plugin-api-docs                | Ported               | Runtime shapes of `z.custom` outputs and the app kernel's slots are not visible to the server                                   |
| plugin-api-tester              | Ported               | Nothing                                                                                                                         |
| prompt-library                 | Ported               | Nothing                                                                                                                         |
| provider-acp                   | Ported               | Forks, native skill root resolvers, and showing the agent's own options and slash commands in the composer                      |
| provider-claude-code           | Built in as a plugin | Rewritten as a `ProviderAdapter` with the kernel, not ported from the original's bridge                                         |
| provider-codex                 | Built in as a plugin | Rewritten as a `ProviderAdapter` with the kernel, not ported from the original's bridge                                         |
| provider-pi                    | Ported (3 stages)    | In-place model switch, the extension-ui renderer, catalog caching, session relocation                                           |
| provider-retry                 | Ported               | Nothing                                                                                                                         |
| provider-usage                 | Ported               | Nothing                                                                                                                         |
| push-notifications             | Ported               | Nothing                                                                                                                         |
| scheduled-send                 | Ported               | Nothing                                                                                                                         |
| secrets                        | Imported             | Nothing recorded                                                                                                                |
| side-chat                      | Ported               | Nothing; waited for `threads.fork`                                                                                              |
| storage-retention              | Ported (2 stages)    | `~/.bb-dev` developer storage, background cleanup with progress, some report fields, the 30 s archive undo                      |
| t3sidebar                      | Not ported           | Empty directory in the original                                                                                                 |
| tasks                          | Imported             | Board view, folders and the preset dialog; does not yet read `pullRequests`                                                     |
| theme-preview                  | Ported               | Nothing                                                                                                                         |
| thread-list                    | Imported             | Grouping by project or machine and its customizers                                                                              |
| workflows                      | Ported (3 stages)    | QuickJS (runs in `node:vm`), truncation flags and origin model in status, the preview card animation                            |

Plugins here that were not plugins in the original (their features were core there, or new):

| Plugin      | What it is                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| skills      | The skills list, install and registry search, with the `skills.source` slot                            |
| marketplace | Plugin catalogs, install and updates (`bb marketplace`, `bb plugin search\|install\|outdated\|update`) |
| voice-input | The composer's microphone, transcribing through `sessions.transcribe`                                  |

## Still missing

| Gap                                           | Needed by                                | Smallest addition                                                            |
| --------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| Old package name and RPC style                | all 341                                  | A port per plugin; a compatibility package was not built                     |
| An ACP client and a provider test harness     | 8 marketplace                            | A helper package beside `ProviderAdapter`, lifted from provider-acp          |
| An in-app or desktop browser                  | agent-annotations, browser-automation, 2 | A `desktop` contract a desktop app implements                                |
| Setting experiments                           | part of 3 marketplace                    | `server.updateExperiments`                                                   |
| A pinned npm integrity in marketplace updates | marketplace                              | Record the tarball's integrity at install and check it on `update`           |
| Installing `bb` on a blank enrolled machine   | environment-modal-sandbox                | Serve `/install.sh`, which the `machines.enroll` join script already fetches |
| JSON settings                                 | acp                                      | A JSON setting type with validation                                          |

## Things the audit found in existing ports

Comparing the eight plugins already ported here with their originals showed that most differences
are scope cuts, not API gaps: Tasks lost its board view, folders and preset dialog; the thread list
lost grouping by project or machine and its customizers; Account Pool lost per-thread bypass and
reordering; Connect lost mobile pairing (shares from other machines are back, HTTP only); Navigation's overview file
still claims reordering and hiding, which it no longer does. These are carried into the port status
table above.
