import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PortFinding, PortStatus } from "./contract.js";

export interface PortPath {
  status: PortStatus;
  now: string;
}

type Rule = [match: RegExp, status: PortStatus, now: string];
type Path = [PortStatus, string];

const PULL_REQUESTS: Path = [
  "feature",
  "pull requests are not built in; a plugin can provide them with gh in a runner part",
];
const MARKETPLACE: Path = [
  "feature",
  "no marketplace or updates; bb.call(plugins.install, { path }) installs a directory",
];
const SKILLS: Path = ["feature", "no skills browser"];
const DESKTOP: Path = ["feature", "no desktop app"];
const REWIND: Path = [
  "feature",
  "no fork or message editing; providers here cannot rewind a session",
];
const METADATA: Path = [
  "changed",
  "bb.storage.kv or a shared table keyed by thread id",
];
const MACHINE_ENV: Path = [
  "changed",
  "bb.sdk.projects.replaceMachineEnvironment",
];

const QUEUE_ORDER: Path = [
  "feature",
  "queued messages keep the order they were added in",
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
  "threads.storageFiles": [
    "changed",
    "bb.call(threads.storageLocation), then node:fs",
  ],
  "system.usageLimits": ["changed", "read the sessions.usage slot"],
  "threads.getPluginMetadata": METADATA,
  "threads.updatePluginMetadata": METADATA,
  "threads.queue.list": ["renamed", "bb.sdk.threads.queuedMessages.list"],
  "threads.retry": [
    "changed",
    "bb.sdk.threads.queuedMessages.create with sendAt",
  ],
  "threads.conversationOutline": ["changed", "bb.sdk.threads.timeline"],
  "threads.listRunning": ["changed", "bb.sdk.threads.list, filtered by status"],
  "threads.count": ["changed", "bb.sdk.threads.list"],
  "threads.events.wait": ["changed", "bb.on(threads.appended)"],
  "threads.context": [
    "changed",
    "contextWindowUsage on bb.sdk.threads.timeline",
  ],
  "threads.fork": REWIND,
  "threads.editMessage": REWIND,
  "promptHistory.list": [
    "renamed",
    "bb.sdk.threads.promptHistory and bb.sdk.projects.promptHistory",
  ],
  "hosts.suspend": ["renamed", "bb.call(machines.suspend)"],
  "hosts.resume": ["renamed", "bb.call(machines.resume)"],
  "hosts.reconcile": [
    "changed",
    "bb.call(machines.update) and the machines.provider entry",
  ],
  "hosts.createJoinCode": ["renamed", "bb.call(machines.enroll)"],
  "hosts.pickFolder": [
    "changed",
    "bb.sdk.hosts.directory lists folders; draw the picker",
  ],
  "system.providerStates": ["changed", "bb.call(sessions.providers)"],
  "system.reloadConfig": [
    "changed",
    "not needed: nothing is read from a config file",
  ],
  "system.aiServices": ["changed", "bb.entries(sessions.inference)"],
  "system.version": ["changed", "GET /health"],
  "system.transcribeVoice": ["feature", "no voice input"],
  "system.updateExperiments": ["feature", "no experiments"],
  "files.mkdir": ["renamed", "bb.call(files.mkdir, { threadId, path })"],
  "files.listPaths": ["renamed", "bb.call(files.list, { threadId, path })"],
  "files.remove": ["renamed", "bb.call(files.remove, { threadId, path })"],
  "files.move": ["renamed", "bb.call(files.move, { threadId, from, to })"],
  "files.createPreview": [
    "changed",
    "a URL that already serves files: /api/v1/threads/<id>/host-files/<path>",
  ],
  "projects.fileContent": ["changed", "bb.call(files.read)"],
  "projects.files": ["renamed", "bb.call(files.list)"],
  "projects.setMachineEnvironmentVariable": MACHINE_ENV,
  "projects.deleteMachineEnvironmentVariable": MACHINE_ENV,
  "terminals.resize": ["renamed", "bb.call(terminals.resize)"],
  "theme.get": ["changed", "appearance on bb.sdk.system.config"],
  "theme.catalog": ["changed", "themes on bb.sdk.system.config"],
  "environments.pullRequest": PULL_REQUESTS,
  "environments.markPullRequestReady": PULL_REQUESTS,
  "environments.markPullRequestDraft": PULL_REQUESTS,
  "environments.mergePullRequest": PULL_REQUESTS,
  "plugins.install": ["changed", "bb.call(plugins.install, { path })"],
  "plugins.applyUpdate": MARKETPLACE,
  "plugins.checkUpdates": MARKETPLACE,
  "plugins.catalog.install": MARKETPLACE,
  "plugins.catalog.installPlan": MARKETPLACE,
  "plugins.catalog.search": MARKETPLACE,
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
    "bb.sdk.terminals.close, then bb.sdk.terminals.create",
  ],
  "threads.queuedMessages.reorder": QUEUE_ORDER,
  "threads.queuedMessages.setGroupBoundary": QUEUE_ORDER,
  "projects.reorder": ["feature", "projects have no stored order"],
  "hosts.providerCliStatus": [
    "feature",
    "no install status for provider command-line tools",
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
  [/^manifest\.engines\./u, "same", "ignored; no version gate yet"],
  [
    /^manifest\.branding\.(logo|icons)/u,
    "changed",
    "bb.icons.register in the app part; a provider's logo goes on its declaration",
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
  [/^app\.definePluginApp$/u, "same", "definePluginApp, or plugin"],
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
    "the same names; simple commands can be doors.cli instead",
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
    "bb.add(sessions.inference, service); transcription has no slot",
  ],
  [
    /^server\.environments\.register$|^environmentProvider\.import$/u,
    "changed",
    "bb.add(environments.kind, { create, remove, validate, inputs })",
  ],
  [
    /^server\.machines\.|^machineProvider\.import$/u,
    "changed",
    "bb.add(machines.provider) with machines.enroll, waitConnected, suspend, resume, remove",
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
    "feature",
    "provider environments report no health",
  ],
  [/^server\.events\.thread\.events$/u, "renamed", "bb.on(threads.appended)"],
  [/^server\.events\.thread\./u, "renamed", "bb.on(threads.<name>)"],
  [
    /^server\.events\.message\./u,
    "renamed",
    "bb.on(threads.messageQueued | messageDispatched | messageCancelled)",
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
  [/^server\.events\.host\.deleted$/u, "renamed", "bb.on(machines.removed)"],
  [/^server\.events\.terminal\.input$/u, "renamed", "bb.on(terminals.input)"],
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
    "bb.on(machines.signal); the runner part calls bb.signal",
  ],
  [
    /^server\.hosts\.client\.onWorkerExit$/u,
    "changed",
    "bb.on(machines.disconnected)",
  ],
  [/^server\.hosts\.client/u, "changed", "bb.machine(hostId).call(op, input)"],
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
    /^server\.ui\.requestInput$/u,
    "changed",
    "bb.call(interactions.ask, request)",
  ],
  [
    /^app\.slots\.(navPanel|settingsSection|appOverlay|pendingInteraction|messageDirective|threadList|sidebarNavigation|sidebarHeader)$/u,
    "same",
    "bb.slots.<name>",
  ],
  [/^app\.slots\.threadPanelAction$/u, "renamed", "bb.slots.threadPanel"],
  [
    /^app\.slots\.commandPaletteAction$|^app\.commands\.register$/u,
    "renamed",
    "bb.commands.register",
  ],
  [
    /^app\.slots\.threadHeaderAction$/u,
    "renamed",
    "bb.add(shell.threadHeader, { id, view })",
  ],
  [
    /^app\.slots\.homepageSection$/u,
    "renamed",
    "bb.add(shell.homeSection, { id, view })",
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
    "the logo on the provider's declaration, or bb.icons.register",
  ],
  [
    /^app\.slots\.browserToolbarAction$/u,
    "feature",
    "there is no in-app browser",
  ],
  [
    /^app\.contentScripts\.register$/u,
    "renamed",
    "bb.onMount(({ signal }) => cleanup); bb.setThreadRowStatus for row statuses",
  ],
  [/^app\.icons\.register$/u, "renamed", "bb.icons.register"],
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
    /^app\.composer\.customize\.popups$|^app\.useComposer\.(openPopup|closePopup)$/u,
    "changed",
    "render the popup yourself from a composer.banner or footerControl",
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
    /^app\.useComposer\.(text|isEmpty|focus|insert|setText|updateText|submit|key|isRunning|insertMention|addQuote|onSubmitted|setInputLock|selection|setSelection|setTextEffect|layout|attachmentCount|isSubmittingBlocked|submittingBlockedReason)$/u,
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
    /^app\.hook\.(useBbContext|useBbNavigate|usePluginId|useProviders|useEnvironmentProviders|useRealtimeConnectionState|useSdk|useSettings|useSidebarNavigation|useSidebarNavigationSplit|useSidebarSplitLayout|useSidebarThreadActions|useSidebarThreadDraft|useSidebarThreadDraftIds|useSidebarThreadRowStatus|useSidebarThreadRowStatuses|useSidebarThreadShortcut|useSidebarThreadSplit|useSidebarThreads)$/u,
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
    "feature",
    "pull requests are not built in",
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
    /^app\.component\.(Icon|Markdown|ThreadChat|ThreadTitle|UrlLink|ProviderIcon|SidebarNavigationIcon)$/u,
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
    /^app\.component\.Diff$/u,
    "renamed",
    'BbDiff from "@bb/app-kit/components/code/BbDiff"',
  ],
  [
    /^app\.component\.SourceCode$/u,
    "renamed",
    'BbSourceCode from "@bb/app-kit/components/code/BbSourceCode"',
  ],
  [
    /^app\.component\.FileLink$/u,
    "changed",
    "a button that calls useBbNavigate().openFile",
  ],
  [/^app\.component\.VoiceInputTextarea$/u, "feature", "no voice input"],
  [/^app\.component\./u, "none", "no such component"],
  [
    /^host\.(emitSignal|signal)$/u,
    "renamed",
    "bb.signal(name, payload); the server hears machines.signal",
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

export function methodsOf(client: object, prefix = ""): Set<string> {
  const names = new Set<string>();
  for (const [key, member] of Object.entries(client)) {
    if (typeof member === "function") names.add(`${prefix}${key}`);
    else if (typeof member === "object" && member !== null) {
      for (const name of methodsOf(member, `${prefix}${key}.`)) names.add(name);
    }
  }
  return names;
}

export function pathFor(id: string, sdkMethods: ReadonlySet<string>): PortPath {
  const sdk = /^(server|app)\.sdk\.(.+)$/u.exec(id);
  if (sdk !== null) {
    const [, tier = "", method = ""] = sdk;
    const client = tier === "server" ? "bb.sdk" : "useSdk()";
    if (sdkMethods.has(method)) {
      return { status: "same", now: `${client}.${method}` };
    }
    const known = SDK_PATHS[method];
    if (known !== undefined) return { status: known[0], now: known[1] };
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

export async function portReport(
  directory: string,
  sdkMethods: ReadonlySet<string>,
): Promise<PortFinding[]> {
  const surface = JSON.parse(
    await readFile(SURFACE, "utf8"),
  ) as OldCapability[];
  const sources = await sourcesOf(directory);
  const manifest = await manifestOf(directory).catch(() => "");
  const findings: PortFinding[] = [];
  for (const { id, pattern, manifest: declared } of surface) {
    const test = compile(pattern);
    const used = declared ? test(manifest) : sources.some(test);
    if (used) findings.push({ id, ...pathFor(id, sdkMethods) });
  }
  return findings;
}
