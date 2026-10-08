import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  confirm,
  errorMessage,
  integer,
  loaded,
  machineFlag,
  parseJson,
  readStdin,
  valid,
  type Call,
} from "../call.js";
import { CliError, commandReference, usageError, type Run } from "../engine.js";
import { bbCliPath, cliDir, guideDir } from "../paths.js";
import { pendingTodosOf, threadLines, todoLines } from "../render.js";

const GENERATED_TOPIC = "commands";
const DEFAULT_TOPIC = "concepts";
const KEYBINDING = "keybinding.";
const UI = "ui.";
const UNBOUND = "none";
const MODIFIERS = ["mod", "meta", "control", "alt", "shift"] as const;

function quiet<Value>(request: Promise<Value>): Promise<Value | null> {
  return request.catch(() => null);
}

export const status: Run = async (c) => {
  const { sdk } = c;
  const { projectId, threadId, serverUrl } = c.env;
  const [config, project, thread] = await Promise.all([
    quiet(sdk.system.config()),
    projectId === undefined ? null : quiet(sdk.projects.get({ projectId })),
    threadId === undefined ? null : quiet(sdk.threads.get({ threadId })),
  ]);
  const environmentId = thread?.environmentId ?? null;
  const parentThreadId = thread?.id;
  const [environment, children, pendingTodos, listed] = await Promise.all([
    environmentId === null
      ? null
      : quiet(sdk.environments.get({ environmentId })),
    thread && quiet(sdk.threads.list({ parentThreadId })),
    thread && pendingTodosOf(sdk, thread.id),
    config && quiet(sdk.plugins.list()),
  ]);
  const childThreads =
    children?.map(({ id, status, title }) => ({ id, status, title })) ?? null;
  const pluginsNeedingAttention = (listed?.plugins ?? [])
    .filter((plugin) => plugin.enabled && plugin.status !== "running")
    .map((plugin) => ({ id: plugin.id, status: plugin.status }));
  const data = {
    project: project && { id: project.id, name: project.name },
    thread: thread && { ...thread, environment },
    childThreads,
    pendingTodos,
    pluginsNeedingAttention,
    dataDir: config?.dataDir ?? null,
    serverUrl,
  };
  const childLines = (childThreads ?? []).map(
    (child) => `  ${child.id}  ${child.status}  ${child.title ?? ""}`,
  );
  c.out(data, [
    project === null
      ? `Project: ${projectId ?? "(not set)"}`
      : `Project: ${project.name} (${project.id})`,
    "",
    ...(thread === null
      ? [`Thread: ${threadId ?? "(not set)"}`]
      : threadLines(thread, environment)),
    ...(childLines.length === 0 ? [] : ["", "Child threads:", ...childLines]),
    ...todoLines(pendingTodos),
    "",
    config === null
      ? `Server: ${serverUrl} is not reachable`
      : `Server: ${serverUrl} (data in ${config.dataDir})`,
    ...pluginsNeedingAttention.map(
      (plugin) => `Plugin ${plugin.id} is not running (${plugin.status}).`,
    ),
  ]);
};

export const guide: Run = async (c) => {
  const files = await readdir(guideDir);
  const written = files.map((file) => file.replace(/\.md$/u, ""));
  const topics = [...written, GENERATED_TOPIC];
  const topic = c.args.topic ?? DEFAULT_TOPIC;
  if (!topics.includes(topic)) {
    const known = topics.join(", ");
    throw usageError(`Unknown guide topic '${topic}'.`, `Topics: ${known}`);
  }
  const text =
    topic === GENERATED_TOPIC
      ? commandReference(c.table, c.args.group)
      : await readFile(join(guideDir, `${topic}.md`), "utf8");
  c.out({ topic, topics, text }, text.trimEnd());
};

async function hostPath(c: Call) {
  return { hostId: await machineFlag(c), path: c.arg("path") };
}

export const fileRead: Run = async (c) => {
  const target = { ...(await hostPath(c)), rootPath: c.flag("root") };
  const file = await c.sdk.files.read(target);
  if (c.json) return c.out(file);
  const trailing = file.contentEncoding === "utf8" ? "" : "\n";
  process.stdout.write(`${file.content}${trailing}`);
};

export const fileWrite: Run = async (c) => {
  const inline = c.flag("content");
  if ((inline === undefined) === !c.on("stdin")) {
    throw usageError("Provide exactly one of --content or --stdin.");
  }
  const result = await c.sdk.files.write({
    ...(await hostPath(c)),
    rootPath: c.flag("root"),
    content: inline ?? (await readStdin()).toString("utf8"),
    createParents: c.on("create-parents") || undefined,
    expectedSha256: c.flag("expected-sha256"),
  });
  const written = result.outcome === "written";
  const outcome = written ? "Wrote" : "Write conflict for";
  c.out(result, `${outcome} ${c.arg("path")}`);
};

export const fileList: Run = async (c) => {
  const result = await c.sdk.files.list({
    ...(await hostPath(c)),
    query: c.flag("query"),
    limit: integer(c.flag("limit"), "--limit"),
  });
  const paths = result.files.map((file) => file.path);
  c.out(result, paths);
};

async function readSettings(c: Call): Promise<Record<string, unknown>> {
  const { system } = c.sdk;
  const [config, ui] = await Promise.all([
    system.config(),
    system.uiPreferences.list(),
  ]);
  const keybindings = config.keybindingOverrides.map(
    ({ command, shortcut }): [string, unknown] => {
      const held = MODIFIERS.filter((name) => shortcut?.[name]);
      const keys =
        shortcut === null ? UNBOUND : [...held, shortcut.key].join("+");
      return [`${KEYBINDING}${command}`, keys];
    },
  );
  const preferences = Object.entries(ui.preferences).map(
    ([key, entry]): [string, unknown] => [`${UI}${key}`, entry.value],
  );
  return {
    ...config.generalSettings,
    theme: config.appearance.themeId,
    "theme.faviconColor": config.appearance.faviconColor,
    ...Object.fromEntries([...keybindings, ...preferences]),
  };
}

function settingValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function writeSetting(c: Call, key: string, raw?: string) {
  const { domain } = loaded();
  const { system, theme } = c.sdk;
  const config = await system.config();
  if (key === "theme" || key === "theme.faviconColor") {
    const { themeId, faviconColor } = config.appearance;
    const next = raw ?? "default";
    const selection =
      key === "theme"
        ? { themeId: next, faviconColor }
        : { themeId, faviconColor: next };
    return theme.set(valid(domain.appThemeSchema, selection, key));
  }
  if (key.startsWith(KEYBINDING)) {
    const command = key.slice(KEYBINDING.length);
    const kept = config.keybindingOverrides.filter(
      (override) => override.command !== command,
    );
    const held = (raw ?? "")
      .toLowerCase()
      .replace("ctrl", "control")
      .split("+");
    const pressed = MODIFIERS.map((name) => [name, held.includes(name)]);
    const combination = { key: held.at(-1), ...Object.fromEntries(pressed) };
    const shortcut = raw === UNBOUND ? null : combination;
    const added = raw === undefined ? [] : [{ command, shortcut }];
    const schema = domain.appKeybindingOverridesSchema;
    const overrides = valid(schema, [...kept, ...added], "keybinding");
    return system.updateKeyboardSettings(overrides);
  }
  if (key.startsWith(UI)) {
    const name = key.slice(UI.length);
    if (!domain.isUiPreferenceKey(name)) {
      const known = domain.UI_PREFERENCE_KEYS.join(", ");
      throw usageError(`Unknown UI preference '${name}'.`, `Known: ${known}`);
    }
    if (raw === undefined) return system.uiPreferences.reset({ key: name });
    const parsed = domain.parseUiPreferenceValue(name, settingValue(raw));
    if (!parsed.success) throw usageError(parsed.message);
    const { preferences } = await system.uiPreferences.list();
    const expectedRevision = preferences[name].revision;
    const { value } = parsed;
    return system.uiPreferences.set({ key: name, value, expectedRevision });
  }
  const defaults: Record<string, unknown> = domain.defaultAppSettings;
  if (!Object.hasOwn(defaults, key)) {
    const hint = "Run `bb settings show` for the keys.";
    throw usageError(`Unknown setting '${key}'.`, hint);
  }
  const value = raw === undefined ? defaults[key] : settingValue(raw);
  const changed = { ...config.generalSettings, [key]: value };
  const next = valid(domain.appSettingsSchema, changed, "setting");
  return system.updateGeneralSettings(next);
}

function changeSetting(reset: boolean): Run {
  return async (c) => {
    const key = c.arg("key");
    await writeSetting(c, key, reset ? undefined : c.arg("value"));
    const value = (await readSettings(c))[key] ?? null;
    c.out({ key, value }, `${key} = ${JSON.stringify(value)}`);
  };
}

export const settingsSet = changeSetting(false);
export const settingsReset = changeSetting(true);

export const settingsShow: Run = async (c) => {
  const settings = await readSettings(c);
  const { key } = c.args;
  const all = Object.entries(settings);
  const shown = all.filter(([name]) => key === undefined || name === key);
  if (shown.length === 0) throw usageError(`Unknown setting '${key}'.`);
  const lines = shown.map(([name, value]) => {
    const json = JSON.stringify(value);
    if (key === undefined) return `${name} = ${json}`;
    return typeof value === "string" ? value : json;
  });
  c.out(key === undefined ? settings : { key, value: settings[key] }, lines);
};

export const settingsGet = settingsShow;

export const pluginList: Run = async (c) => {
  const result = await c.sdk.plugins.list();
  const rows = result.plugins.map((plugin) => ({
    id: plugin.id,
    status: plugin.status,
    commands: plugin.cliCommands.map(({ name }) => `bb ${name}`).join(", "),
    about: plugin.statusMessage ?? plugin.description,
  }));
  c.rows(rows, ["id", "status", "commands", "about"], result);
};

function setPluginEnabled(verb: "enable" | "disable"): Run {
  return async (c) => {
    const plugin = await c.sdk.plugins[verb]({ pluginId: c.arg("id") });
    c.out(plugin, `Plugin ${plugin.id} is ${plugin.status}`);
  };
}

export const pluginEnable = setPluginEnabled("enable");
export const pluginDisable = setPluginEnabled("disable");

export const pluginReload: Run = async (c) => {
  const pluginId = c.args.id;
  const result = await c.sdk.plugins.reload({ pluginId });
  c.out(result, `Reloaded ${pluginId ?? `${result.plugins.length} plugins`}`);
};

async function editPluginConfig(c: Call, add: boolean): Promise<void> {
  const path = resolve(c.arg("path"));
  const { dataDir } = await c.sdk.system.config();
  const file = join(dataDir, "config.json");
  const { z } = await import("zod");
  const entry = z.looseObject({ path: z.string() });
  const schema = z.looseObject({ plugins: z.array(entry).default([]) });
  const text = await readFile(file, "utf8").catch(() => "{}");
  const config = valid(schema, parseJson(text, file), file);
  const others = config.plugins.filter((known) => resolve(known.path) !== path);
  const plugins = add ? [...others, { path, enabled: true }] : others;
  const next = JSON.stringify({ ...config, plugins }, null, 2);
  await writeFile(file, `${next}\n`);
  const result = await c.sdk.plugins.reload();
  const done = add ? "added to" : "removed from";
  c.out(result, `${path} ${done} ${file}; plugins reloaded`);
}

export const pluginAdd: Run = async (c) => {
  const path = resolve(c.arg("path"));
  const found = await stat(join(path, "package.json")).catch(() => null);
  if (found === null) throw usageError(`${path} has no package.json.`);
  await editPluginConfig(c, true);
};

export const pluginRemove: Run = async (c) => {
  await confirm(c, `Stop loading the plugin at ${c.arg("path")}?`);
  await editPluginConfig(c, false);
};

export const server: Run = async () => {
  const { startServer } = await import("@bb/server");
  await startServer({ cliDir });
};

export const importLegacy: Run = async (c) => {
  const server = await import("@bb/server");
  const from = c.flag("from");
  if (from === undefined) throw usageError("Pass --from <old data directory>.");
  const threads = c.choice("threads", ["active", "all", "none"]) ?? "active";
  const options = { from: resolve(from), threads, dryRun: c.on("dry-run") };
  const summary = await server.importLegacy(options);
  c.out(summary, server.importSummaryLines(summary));
};

export const serverStatus: Run = async (c) => {
  const url = c.env.serverUrl;
  const config = await c.sdk.system.config().catch((error: unknown) => {
    const hint = "Start it with `bb server`, or set BB_SERVER_URL.";
    const message = `No bb server at ${url}: ${errorMessage(error)}`;
    throw new CliError(message, { code: "server_unreachable", hint });
  });
  const { dataDir, primaryHostId } = config;
  const text = `bb server at ${url} (data in ${dataDir})`;
  c.out({ running: true, url, dataDir, primaryHostId }, text);
};

export const runnerJoin: Run = async (c) => {
  const runner = await import("@bb/runner");
  const blob = c.arg("blob");
  const { z } = await import("zod");
  const decoded = Buffer.from(blob, "base64url").toString("utf8");
  const schema = z.object({ serverUrl: z.url() });
  const target = valid(schema, settingValue(decoded), "join command");
  const legacyMachineConfigPath = c.on("reuse-connect-credential")
    ? (c.flag("reuse-connect-credential") ??
      runner.defaultLegacyMachineConfigPath(target.serverUrl))
    : undefined;
  const joined = await runner.joinServer({
    blob,
    dataDir: c.flag("data-dir"),
    hostName: c.flag("name"),
    headers: c.list("header"),
    legacyMachineConfigPath,
  });
  const { hostId, serverUrl, dataDir } = joined;
  const next = `Start the runner with: bb runner run --data-dir ${dataDir}`;
  const text = [`Joined ${serverUrl} as ${hostId}.`, next];
  c.out({ hostId, serverUrl, dataDir }, text);
};

export const runnerRun: Run = async (c) => {
  const runner = await import("@bb/runner");
  const root = dirname(runner.defaultRunnerDataDir("http://localhost"));
  const joined = await readdir(root).catch(() => []);
  const [only] = joined;
  const single = joined.length === 1 && only !== undefined;
  const dataDir = c.flag("data-dir") ?? (single ? join(root, only) : undefined);
  if (dataDir === undefined) {
    const found = joined.map((name) => join(root, name)).join(", ") || "none";
    const message = "This machine has not joined exactly one server.";
    throw usageError(message, `Pass --data-dir <dir>. Joined: ${found}`);
  }
  const { runnerParts: parts } = await import("@bb/profile-default/runner");
  const running = await runner.runRunner({ dataDir, bbCliPath, parts });
  console.error(`bb runner started (data in ${dataDir})`);
  await running.stopped;
};
