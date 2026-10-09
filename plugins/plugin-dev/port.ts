import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PortFinding, PortStatus } from "./contract.js";
import { SDK_OPS } from "./sdk-ops.js";

export interface PortPath {
  status: PortStatus;
  now: string;
}

type Rule = [match: RegExp, status: PortStatus, now: string];
type Path = [PortStatus, string];

const GITHUB = 'from "bb-plugin-github/contract"';
const PULL_REQUESTS: Path = [
  "feature",
  `pullRequests ${GITHUB} has get, list, create, details and forThread; nothing marks ready, draft or merges`,
];
const MARKETPLACE: Path = [
  "feature",
  'marketplace from "bb-plugin-marketplace/contract" reads its catalogs from its own settings; none are added at run time',
];
const SKILLS: Path = ["feature", "no skills browser"];
const DESKTOP: Path = ["feature", "no desktop app"];
const METADATA: Path = [
  "changed",
  "bb.storage.kv or a shared table keyed by thread id",
];
const MACHINE_ENV: Path = [
  "changed",
  "bb.call(projects.updateMachineEnvironment)",
];

const SDK_PATHS: Record<string, Path> = {
  "plugins.callRpc": [
    "changed",
    "bb.call(op) with the other plugin's contract",
  ],
  "plugins.discoverRpc": ["changed", "a slot in a shared contract"],
  subscribe: [
    "changed",
    "events: bb.on(threads.*), bb.on(machines.*); useChanged in the app",
  ],
  "threads.storageLocation": ["renamed", "bb.call(threads.storageLocation)"],
  "threads.spawn": [
    "changed",
    'threads.create; set origin: "plugin" and originPluginId yourself',
  ],
  "projects.attachments.upload": [
    "changed",
    "POST /api/v1/projects/:projectId/attachments with a multipart file",
  ],
  "threads.storageFiles": [
    "changed",
    "bb.call(threads.storageLocation), then node:fs",
  ],
  "system.usageLimits": ["changed", "read the sessions.usage slot"],
  "threads.getPluginMetadata": METADATA,
  "threads.updatePluginMetadata": METADATA,
  "threads.queue.list": ["renamed", "bb.call(threads.listQueuedMessages)"],
  "threads.retry": [
    "changed",
    "bb.call(threads.createQueuedMessage) with sendAt",
  ],
  "threads.conversationOutline": ["changed", "bb.call(threads.timeline)"],
  "threads.listRunning": [
    "changed",
    "bb.call(threads.list), filtered by status",
  ],
  "threads.count": ["changed", "bb.call(threads.list)"],
  "threads.events.wait": ["changed", "bb.on(threads.appended)"],
  "threads.context": [
    "changed",
    "contextWindowUsage on bb.call(threads.timeline)",
  ],
  "threads.fork": [
    "renamed",
    "bb.call(threads.fork, { sourceThreadId, sourceSeqEnd })",
  ],
  "threads.editMessage": [
    "feature",
    "providers cannot rewind a session; threads.fork up to the message, then send the edit",
  ],
  "threads.paneAction": [
    "changed",
    "bb.emit(threads.paneAction, { threadId, action })",
  ],
  "promptHistory.list": [
    "renamed",
    "bb.call(threads.promptHistory) and bb.call(projects.promptHistory)",
  ],
  "hosts.suspend": ["renamed", "bb.call(machines.suspend)"],
  "hosts.resume": ["renamed", "bb.call(machines.resume)"],
  "hosts.reconcile": [
    "changed",
    "bb.call(machines.reconcile, { hostId }); the provider entry's reconcile runs",
  ],
  "hosts.createJoinCode": ["renamed", "bb.call(machines.enroll)"],
  "hosts.pickFolder": [
    "changed",
    "bb.call(machines.directory) lists folders; draw the picker",
  ],
  "system.providerStates": ["changed", "bb.call(sessions.providers)"],
  "system.reloadConfig": [
    "changed",
    "not needed: nothing is read from a config file",
  ],
  "system.aiServices": ["changed", "bb.entries(sessions.inference)"],
  "system.version": ["changed", "GET /health"],
  "system.transcribeVoice": [
    "renamed",
    "bb.call(sessions.transcribe, { data, mimeType }) with base64 audio",
  ],
  "system.updateExperiments": [
    "changed",
    "bb.call(server.experiments) reads flags; they are set in the environment",
  ],
  "files.mkdir": ["renamed", "bb.call(files.mkdir, { threadId, path })"],
  "files.listPaths": ["renamed", "bb.call(files.list, { threadId, path })"],
  "files.remove": ["renamed", "bb.call(files.delete, { threadId, path })"],
  "files.move": ["renamed", "bb.call(files.move, { threadId, from, to })"],
  "files.createPreview": [
    "changed",
    "bb.call(files.url, { threadId, path }) returns a URL that serves the file",
  ],
  "projects.fileContent": ["changed", "bb.call(files.read)"],
  "projects.files": ["renamed", "bb.call(files.list)"],
  "projects.setMachineEnvironmentVariable": MACHINE_ENV,
  "projects.deleteMachineEnvironmentVariable": MACHINE_ENV,
  "terminals.resize": ["renamed", "bb.call(terminals.resize)"],
  "theme.get": [
    "changed",
    "appearance on bb.call(server.config); bb.call(appearance.themeCss) for its CSS; bb.on(appearance.changed)",
  ],
  "theme.catalog": ["changed", "themes on bb.call(server.config)"],
  "environments.pullRequest": [
    "renamed",
    `bb.call(pullRequests.get, { environmentId }) ${GITHUB}`,
  ],
  "environments.markPullRequestReady": PULL_REQUESTS,
  "environments.markPullRequestDraft": PULL_REQUESTS,
  "environments.mergePullRequest": PULL_REQUESTS,
  "plugins.install": ["changed", "bb.call(plugins.install, { path })"],
  "plugins.applyUpdate": ["renamed", "bb.call(marketplace.update, { id })"],
  "plugins.checkUpdates": ["renamed", "bb.call(marketplace.updates)"],
  "plugins.catalog.install": [
    "renamed",
    "bb.call(marketplace.install, { id })",
  ],
  "plugins.catalog.installPlan": [
    "changed",
    "bb.call(marketplace.catalog) shows each entry's versions; marketplace.install checks the engine range",
  ],
  "plugins.catalog.search": [
    "renamed",
    "bb.call(marketplace.catalog, { query })",
  ],
  "plugins.marketplaces.add": MARKETPLACE,
  "plugins.marketplaces.list": MARKETPLACE,
  "skills.list": SKILLS,
  "skills.getContent": SKILLS,
  "skills.registry.detail": SKILLS,
  "skills.registry.entries": SKILLS,
  "skills.registry.get": SKILLS,
  "skills.registry.repositoryStars": SKILLS,
  "skills.registry.search": SKILLS,
  "terminals.restart": [
    "changed",
    "bb.call(terminals.close), then bb.call(terminals.create)",
  ],
  "threads.queuedMessages.reorder": [
    "renamed",
    "bb.call(threads.reorderQueuedMessages, { threadId, queuedMessageIds })",
  ],
  "threads.queuedMessages.setGroupBoundary": [
    "renamed",
    "bb.call(threads.setQueuedMessageBoundary, { threadId, queuedMessageId })",
  ],
  "projects.reorder": [
    "renamed",
    "bb.call(projects.updateOrder, { projectIds })",
  ],
  "hosts.providerCliStatus": [
    "renamed",
    "bb.call(sessions.providerStatus, { hostId })",
  ],
  "desktopBrowsers.openConnection": DESKTOP,
  "desktopBrowsers.releaseControl": DESKTOP,
  "desktopBrowsers.revealTab": DESKTOP,
};

const RULES: Rule[] = [
  [
    /^manifest\.(name|description|server|app|skills)$/u,
    "same",
    "the same field under bb in package.json",
  ],
  [
    /^manifest\.branding\.icon$/u,
    "same",
    "accepted as written; bb.icon is the new name",
  ],
  [
    /^manifest\.host$/u,
    "same",
    "accepted as written; bb.runner is the new name",
  ],
  [
    /^manifest\.engines\./u,
    "changed",
    "engines.bb is a range of the plugin API version (now 1.x) and is enforced at load",
  ],
  [
    /^manifest\.branding\.(logo|icons)/u,
    "changed",
    "bb.add(app.icon) in the app part; a provider's logo goes on its declaration",
  ],
  [
    /^manifest\.themes/u,
    "same",
    "the same field; codeTheme takes theme names, not files",
  ],
  [
    /^manifest\.providers$/u,
    "changed",
    "declare at run time: bb.add(sessions.provider, declaration)",
  ],
  [/^entry\.root$/u, "renamed", 'import from "@bb/plugin"'],
  [/^entry\.app$/u, "renamed", 'import from "@bb/plugin/app"'],
  [/^entry\.host$/u, "renamed", 'a runner part: import from "@bb/runner"'],
  [
    /^app\.definePluginApp$/u,
    "changed",
    "a plain function: export default function (bb: PluginAppApi) { … }",
  ],
  [
    /^server\.rpc\.register$|^server\.export\.defineRpcContract$/u,
    "changed",
    "operations: contract() with op(), then bb.implement",
  ],
  [
    /^app\.hook\.useRpc$/u,
    "changed",
    "useOp for reads, useCall or callOp for writes",
  ],
  [
    /^server\.realtime\.publish$/u,
    "changed",
    "bb.changed(op), or a live value with bb.provide",
  ],
  [
    /^app\.hook\.useRealtime$/u,
    "changed",
    "useOp refetches on bb.changed; useLive; useChanged",
  ],
  [
    /^server\.export\.(defineCli|cliCommand|PluginCliError)$|^server\.cli\.register$/u,
    "same",
    "the same names; most commands are doors.cli on an operation (flags, from, print, exitCode), and fail(code, message, { hint }) reports errors",
  ],
  [
    /^server\.export\.PLUGIN_CLI_OUTPUT_MAX_BYTES$/u,
    "changed",
    "command output has no cap; drop the check",
  ],
  [
    /^server\.export\.defineHostEntry$|^host\.defineHostEntry$|^host\.entry\./u,
    "changed",
    "a runner part: export default (bb: PluginRunnerApi) => { bb.implement(op, run) }",
  ],
  [
    /^server\.(log\.|pluginId$|settings\.define$|storage\.|http\.route$|background\.|status\.needsConfiguration$|onDispose$)/u,
    "same",
    "the same name on bb",
  ],
  [
    /^server\.onInstall$/u,
    "changed",
    "bb.onStart with a flag in bb.storage.kv",
  ],
  [
    /^server\.agents\.registerTool$/u,
    "changed",
    "an operation with doors.agent",
  ],
  [
    /^server\.agents\.contributeInstructions$/u,
    "changed",
    "bb.on(sessions.instructions, (context, next) => …)",
  ],
  [
    /^server\.agents\.configure$/u,
    "changed",
    "hooks on sessions.tools, sessions.skillDirs and sessions.instructions",
  ],
  [
    /^server\.aiServices\.register$/u,
    "changed",
    "bb.add(sessions.inference, service); bb.add(sessions.transcription, { id, label, available, transcribe })",
  ],
  [
    /^server\.environments\.register$|^environmentProvider\.import$/u,
    "changed",
    "bb.add(environments.kind, { create, delete, validate, inputs })",
  ],
  [
    /^server\.machines\.getResource$/u,
    "renamed",
    "bb.call(machines.resource, { hostId })",
  ],
  [
    /^server\.machines\.|^machineProvider\.import$/u,
    "changed",
    "bb.add(machines.provider) with machines.enroll, waitConnected, suspend, resume, delete",
  ],
  [
    /^server\.providers\.register$/u,
    "changed",
    "a ProviderAdapter in a runner part plus bb.add(sessions.provider, declaration)",
  ],
  [
    /^server\.providers\.contributeEnv$/u,
    "changed",
    "bb.on(sessions.env, { providerId }, (context, next) => …)",
  ],
  [
    /^server\.providers\.contributeEnvHealth$/u,
    "changed",
    "bb.on(sessions.environmentHealth, { providerId }, (input, next) => …)",
  ],
  [/^server\.events\.thread\.events$/u, "renamed", "bb.on(threads.appended)"],
  [/^server\.events\.thread\./u, "renamed", "bb.on(threads.<name>)"],
  [
    /^server\.events\.message\./u,
    "renamed",
    "bb.on(threads.messageQueued | messageDispatched | messageDeleted)",
  ],
  [
    /^server\.events\.turn\.failed$/u,
    "changed",
    "bb.on(threads.failed); the payload has failure { code, message, detail }",
  ],
  [
    /^server\.events\.interaction\.pending$/u,
    "renamed",
    "bb.on(interactions.pending)",
  ],
  [/^server\.events\.host\.deleted$/u, "renamed", "bb.on(machines.deleted)"],
  [
    /^server\.events\.terminal\.input$/u,
    "renamed",
    "bb.on(terminals.inputReceived)",
  ],
  [
    /^server\.hooks\.message\.dispatch$/u,
    "changed",
    "bb.on(threads.send) to change or refuse; bb.on(threads.hold) to keep it queued",
  ],
  [
    /^server\.hooks\.recheck$/u,
    "renamed",
    "bb.call(threads.release, { threadId })",
  ],
  [
    /^server\.hosts\.client\.onSignal$/u,
    "changed",
    "bb.on(machines.signaled); the runner part calls bb.signal",
  ],
  [
    /^server\.hosts\.client\.onWorkerExit$/u,
    "changed",
    "bb.on(machines.disconnected)",
  ],
  [
    /^server\.hosts\.client/u,
    "changed",
    "bb.runners.call(hostId, op, input, { timeoutMs, signal })",
  ],
  [
    /^server\.hosts\.(declareSharedPorts|ensureSharedPortTunnel)$/u,
    "feature",
    "ports are shared from the server's machine only",
  ],
  [/^server\.server\.appUrl$/u, "changed", "bb.pick(server.publicUrl)"],
  [/^server\.server\.loopbackBaseUrl$/u, "renamed", "bb.server.url"],
  [/^server\.server\./u, "same", "the same name on bb.server"],
  [
    /^server\.serverAccess\./u,
    "changed",
    "bb.add(machines.access, { grant, revoke })",
  ],
  [
    /^server\.ui\.registerMentionProvider$/u,
    "changed",
    "bb.add(sessions.mention, provider)",
  ],
  [
    /^server\.http\.experimental_websocket$/u,
    "renamed",
    "bb.http.socket((request) => (socket) => …)",
  ],
  [
    /^server\.ui\.requestInput$/u,
    "changed",
    "bb.call(interactions.ask, request)",
  ],
  [
    /^app\.slots\.(navPanel|settingsSection|appOverlay|pendingInteraction|messageDirective|threadList|sidebarNavigation|sidebarHeader)$/u,
    "renamed",
    "bb.add(shell.navPanel | settings.section | shell.overlay | threadView.interaction | threadView.messageDirective | shell.threadList | shell.sidebarNavigation | shell.sidebarHeader, { id, view, … }); the component field is now view",
  ],
  [
    /^app\.slots\.threadPanelAction$/u,
    "renamed",
    "bb.add(sidePanel.panel, { id, title, view, run })",
  ],
  [
    /^app\.slots\.commandPaletteAction$|^app\.commands\.register$/u,
    "renamed",
    "bb.add(shell.command, { id, title, run })",
  ],
  [
    /^app\.slots\.threadHeaderAction$/u,
    "renamed",
    "bb.add(threadView.header, { id, view })",
  ],
  [
    /^app\.slots\.homepageSection$/u,
    "renamed",
    "bb.add(composer.homeSection, { id, view })",
  ],
  [
    /^app\.slots\.messageAction$/u,
    "renamed",
    "bb.add(threadView.messageAction, { id, label, icon, run })",
  ],
  [
    /^app\.slots\.fileOpener$/u,
    "renamed",
    "bb.add(sidePanel.fileViewer, { id, extensions, view })",
  ],
  [
    /^app\.slots\.sidebarFooterAction$|^app\.sidebarFooter\.register$/u,
    "renamed",
    "bb.add(shell.sidebarFooter, { id, label, icon, run } or { view })",
  ],
  [
    /^app\.slots\.(environmentProviderInputs|machineProviderInputs)$/u,
    "renamed",
    "bb.add(composer.environmentInputs, { kind, view })",
  ],
  [
    /^app\.slots\.timelineRenderer$/u,
    "changed",
    "bb.add(threadView.row) for a row kind, or threadView.pluginRow for your own rows",
  ],
  [
    /^app\.slots\.newThreadPanelAction$/u,
    "changed",
    "bb.add(composer.footerControl) limited to the new-thread surface",
  ],
  [
    /^app\.slots\.providerIcon$/u,
    "changed",
    "the logo on the provider's declaration, or bb.add(app.icon)",
  ],
  [
    /^app\.slots\.browserToolbarAction$/u,
    "feature",
    "there is no in-app browser",
  ],
  [
    /^app\.contentScripts\.register$/u,
    "renamed",
    "bb.onStart(() => cleanup); bb.add(shell.threadRowStatus, { threadId, icon, label }) for row statuses",
  ],
  [/^app\.icons\.register$/u, "renamed", "bb.add(app.icon, { name, view })"],
  [
    /^app\.composer\.customize(\.id)?$/u,
    "changed",
    "one slot per part: composer.banner, footerControl, menuItem, sendMenuItem, textEffect",
  ],
  [
    /^app\.composer\.customize\.actions$/u,
    "renamed",
    "bb.add(composer.footerControl, { id, side, view })",
  ],
  [
    /^app\.composer\.customize\.banners$/u,
    "renamed",
    "bb.add(composer.banner, { id, view })",
  ],
  [
    /^app\.composer\.customize\.plusMenu$/u,
    "renamed",
    "bb.add(composer.menuItem, { id, label, icon, run })",
  ],
  [
    /^app\.composer\.customize\.sendMenu$/u,
    "renamed",
    "bb.add(composer.sendMenuItem, …)",
  ],
  [
    /^app\.composer\.customize\.scopes$/u,
    "changed",
    "isAvailable(context) on the item, reading context.surface",
  ],
  [
    /^app\.composer\.customize\.popups$/u,
    "renamed",
    "bb.add(composer.popup, { id, label, view }); handle.openPopup(id) shows it",
  ],
  [
    /^app\.composer\.customize\.richText\.onDraftChange$/u,
    "changed",
    "useComposer().text",
  ],
  [
    /^app\.composer\.customize\.richText/u,
    "renamed",
    "bb.add(composer.textEffect, { id, className, match })",
  ],
  [
    /^app\.composer\.(commands|registerCommand)$/u,
    "changed",
    "bb.commands.register, or a composer.menuItem",
  ],
  [
    /^app\.hook\.useComposerView$|^app\.hook\.useComposers?$/u,
    "renamed",
    "useComposer() and useComposers()",
  ],
  [
    /^app\.useComposer\.(text|isEmpty|focus|insert|setText|updateText|submit|key|isRunning|insertMention|addQuote|onSubmitted|setInputLock|selection|setSelection|setTextEffect|openPopup|closePopup|openPopupId|layout|attachmentCount|isSubmittingBlocked|submittingBlockedReason)$/u,
    "same",
    "the same member on the composer handle",
  ],
  [
    /^app\.useComposer\.(draft|draft\.text|replace|removeMention)$/u,
    "changed",
    "handle.text and handle.setText",
  ],
  [
    /^app\.useComposer\.scope$|^app\.useComposerView\.scope$/u,
    "changed",
    "handle.surface, handle.threadId, handle.projectId",
  ],
  [
    /^app\.useComposerView\.draft(\.text|\.isEmpty|\.attachmentCount)?$/u,
    "changed",
    "handle.text, handle.isEmpty and handle.attachmentCount",
  ],
  [
    /^app\.useComposerView\.run(\.isRunning|\.isSubmitting)?$/u,
    "changed",
    "handle.isRunning; handle.onSubmitted",
  ],
  [/^app\.useComposer(View)?\./u, "none", "not on the composer handle"],
  [
    /^app\.hook\.useSdk$/u,
    "changed",
    "callOp(op, input), or useOp and useCall, with the core contracts",
  ],
  [
    /^app\.hook\.(useBbContext|useBbNavigate|usePluginId|useProviders|useEnvironmentProviders|useRealtimeConnectionState|useSettings|useSidebarNavigation|useSidebarNavigationSplit|useSidebarSplitLayout|useSidebarThreadActions|useSidebarThreadDraft|useSidebarThreadDraftIds|useSidebarThreadRowStatus|useSidebarThreadRowStatuses|useSidebarThreadShortcut|useSidebarThreadSplit|useSidebarThreads)$/u,
    "same",
    'the same hook from "@bb/plugin/app"',
  ],
  [
    /^app\.hook\.(useAppPanel|useFixedTabTarget)$|^app\.appPanel\./u,
    "changed",
    "useBbNavigate().openThreadPanel",
  ],
  [
    /^app\.hook\.(useBranches|useCheckoutState)$/u,
    "changed",
    'BranchPicker from "bb-plugin-composer/contract"',
  ],
  [
    /^app\.hook\.useCodeTheme$/u,
    "changed",
    'useResolvedCodeThemePair from "@bb/app-kit/lib/code-theme"',
  ],
  [
    /^app\.hook\.useSidebarThreadPullRequest$/u,
    "changed",
    `useOp(pullRequests.forThread, { threadId }) ${GITHUB}`,
  ],
  [/^app\.context\./u, "same", "useBbContext()"],
  [
    /^app\.navigate\.openFilePreview$/u,
    "renamed",
    "useBbNavigate().openFile({ threadId, path })",
  ],
  [
    /^app\.navigate\.openFileExternally$/u,
    "changed",
    "the workspace.openPreferred command, or openUrl",
  ],
  [/^app\.navigate\./u, "same", "the same method on useBbNavigate()"],
  [
    /^app\.sidebarThreadActions\./u,
    "same",
    "the same method on useSidebarThreadActions()",
  ],
  [
    /^app\.component\.(Icon|Markdown|ThreadChat|ThreadTitle|UrlLink|ProviderIcon|SidebarNavigationIcon|Diff|FileLink)$/u,
    "same",
    'the same component from "@bb/plugin/app"',
  ],
  [
    /^app\.component\.ProviderModelPicker$/u,
    "renamed",
    'ModelReasoningPicker from "bb-plugin-composer/contract"',
  ],
  [
    /^app\.component\.(PermissionModePicker|BranchPicker)$/u,
    "renamed",
    'the same name from "bb-plugin-composer/contract"',
  ],
  [
    /^app\.component\.NewThreadComposer$/u,
    "changed",
    'useNewThreadComposer from "bb-plugin-composer/contract"',
  ],

  [
    /^app\.component\.SourceCode$/u,
    "renamed",
    'BbSourceCode from "@bb/app-kit/components/code/BbSourceCode"',
  ],
  [
    /^app\.component\.VoiceInputTextarea$/u,
    "changed",
    "the voice-input plugin adds a composer.footerControl; bb.call(sessions.transcribe) for your own",
  ],
  [/^app\.component\./u, "none", "no such component"],
  [
    /^host\.(emitSignal|signal)$/u,
    "renamed",
    "bb.signal(name, payload); the server hears machines.signaled",
  ],
  [/^host\.paths\.dataDir$|^host\.paths$/u, "renamed", "bb.dataDir"],
  [/^host\.paths\.tempDir$/u, "changed", "os.tmpdir()"],
  [
    /^host\.(lifecycle|retainWorker)$/u,
    "changed",
    "not needed: a runner part lives as long as the runner",
  ],
  [
    /^host\.watch$/u,
    "changed",
    "node:fs watch in the runner part, reporting with bb.signal",
  ],
  [
    /^host\.killProcessesWithCwdUnder$/u,
    "same",
    'the same function from "@bb/runner"',
  ],
  [
    /^host\.nativeRoots/u,
    "changed",
    "a contract of the plugin's own that its runner part implements",
  ],
  [
    /^host\./u,
    "changed",
    "no longer shipped; the helper is plain Node, copy it into the runner part",
  ],
  [
    /^providerBridge\.acp\./u,
    "changed",
    "no ACP helper: add @agentclientprotocol/sdk to the runner part and translate to a ProviderAdapter",
  ],
  [
    /^providerBridge\.testing\./u,
    "changed",
    "no harness needed: the adapter runs in-process, so a test calls it directly",
  ],
  [
    /^providerBridge\./u,
    "changed",
    "the bridge process becomes a ProviderAdapter (packages/runner/src/providers/provider.ts)",
  ],
];

export function pathFor(id: string): PortPath {
  const sdk = /^(server|app)\.sdk\.(.+)$/u.exec(id);
  if (sdk !== null) {
    const [, tier = "", method = ""] = sdk;
    const call = tier === "server" ? "bb.call" : "callOp";
    const known = SDK_PATHS[method];
    if (known !== undefined) {
      return {
        status: known[0],
        now: known[1].replaceAll("bb.call(", `${call}(`),
      };
    }
    const op = SDK_OPS[method];
    if (op !== undefined) return { status: "renamed", now: `${call}(${op})` };
    return { status: "none", now: "the feature behind it does not exist here" };
  }
  for (const [match, status, now] of RULES) {
    if (match.test(id)) return { status, now };
  }
  return { status: "none", now: "no counterpart" };
}

interface OldCapability {
  id: string;
  pattern: string;
  manifest: boolean;
}

const SURFACE = fileURLToPath(new URL("./old-sdk.json", import.meta.url));
const SOURCE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const SKIPPED = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  "test",
  "tests",
]);
const GATED =
  /^\^\(\?([=!])\[\\s\\S\]\*(.+?)\)\[\\s\\S\]\*\?\(\?:([\s\S]+)\)$/u;
const MAX_SOURCE_BYTES = 1_500_000;

type Test = (text: string) => boolean;

function compile(pattern: string): Test {
  const gated = GATED.exec(pattern);
  if (gated === null) {
    const whole = new RegExp(pattern);
    return (text) => whole.test(text);
  }
  const [, sign, gate = "", body = ""] = gated;
  const needs = new RegExp(gate);
  const use = new RegExp(body);
  return (text) => needs.test(text) === (sign === "=") && use.test(text);
}

async function sourcesOf(directory: string): Promise<string[]> {
  const texts: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name)) texts.push(...(await sourcesOf(path)));
    } else if (entry.isFile() && SOURCE.has(extname(entry.name))) {
      const { size } = await stat(path);
      if (size <= MAX_SOURCE_BYTES) texts.push(await readFile(path, "utf8"));
    }
  }
  return texts;
}

function flatten(value: unknown, path: string, lines: string[]): void {
  if (Array.isArray(value)) {
    if (value.length === 0) lines.push(`${path}[]=`);
    for (const item of value) flatten(item, `${path}[]`, lines);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      flatten(item, `${path}.${key}`, lines);
    }
  } else {
    lines.push(`${path}=${String(value)}`);
  }
}

async function manifestOf(directory: string): Promise<string> {
  const text = await readFile(join(directory, "package.json"), "utf8");
  const manifest = JSON.parse(text) as Record<string, unknown>;
  const lines: string[] = [];
  for (const key of ["engines", "bb"]) {
    if (manifest[key] !== undefined) flatten(manifest[key], key, lines);
  }
  return lines.join("\n");
}

export async function portReport(directory: string): Promise<PortFinding[]> {
  const surface = JSON.parse(
    await readFile(SURFACE, "utf8"),
  ) as OldCapability[];
  const sources = await sourcesOf(directory);
  const manifest = await manifestOf(directory).catch(() => "");
  const findings: PortFinding[] = [];
  for (const { id, pattern, manifest: declared } of surface) {
    const test = compile(pattern);
    const used = declared ? test(manifest) : sources.some(test);
    if (used) findings.push({ id, ...pathFor(id) });
  }
  return findings;
}
