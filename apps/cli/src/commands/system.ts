import { createHash } from "node:crypto";
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
  type Remote,
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
  const remote: Remote = c;
  const { projectId, threadId, serverUrl } = c.env;
  const [config, project, thread] = await Promise.all([
    quiet(remote.op(remote.ops.server.config, {})),
    projectId === undefined
      ? null
      : quiet(remote.op(remote.ops.projects.get, { projectId })),
    threadId === undefined
      ? null
      : quiet(remote.op(remote.ops.threads.get, { threadId })),
  ]);
  const environmentId = thread?.environmentId ?? null;
  const parentThreadId = thread?.id;
  const [environment, children, pendingTodos, listed] = await Promise.all([
    environmentId === null
      ? null
      : quiet(remote.op(remote.ops.environments.get, { environmentId })),
    thread && quiet(remote.op(remote.ops.threads.list, { parentThreadId })),
    thread && pendingTodosOf(remote, thread.id),
    config && quiet(remote.op(remote.ops.plugins.list, {})),
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

function tooLarge(error: unknown): boolean {
  const { CallError } = loaded().plugin;
  return error instanceof CallError && error.code === "file_too_large";
}

async function readWhole(c: Call, target: Record<string, unknown>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(target)) {
    if (typeof value === "string") query.set(key, value);
  }
  const response = await c.request(`/api/v1/machines/files/raw?${query}`);
  if (!response.ok || response.body === null) {
    const failure = `Could not read ${c.arg("path")} (${response.status})`;
    throw new CliError(failure, { code: "read_failed" });
  }
  return response;
}

async function streamFile(c: Call, target: Record<string, unknown>) {
  const response = await readWhole(c, target);
  if (!c.json) {
    for await (const chunk of response.body ?? []) process.stdout.write(chunk);
    return;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = new TextDecoder("utf-8", { fatal: true });
  let content: string;
  let contentEncoding: "utf8" | "base64" = "utf8";
  try {
    content = text.decode(bytes);
  } catch {
    content = bytes.toString("base64");
    contentEncoding = "base64";
  }
  const mimeType = response.headers.get("content-type") ?? undefined;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const path = c.arg("path");
  const sizeBytes = bytes.byteLength;
  c.out({ path, content, contentEncoding, mimeType, sizeBytes, sha256 });
}

export const fileRead: Run = async (c) => {
  const target = { ...(await hostPath(c)), rootPath: c.flag("root") };
  const file = await c.op(c.ops.machines.readFile, target).catch((error) => {
    if (tooLarge(error)) return null;
    throw error;
  });
  if (file === null) return streamFile(c, target);
  if (c.json) return c.out(file);
  const trailing = file.contentEncoding === "utf8" ? "" : "\n";
  process.stdout.write(`${file.content}${trailing}`);
};

export const fileWrite: Run = async (c) => {
  const inline = c.flag("content");
  if ((inline === undefined) === !c.on("stdin")) {
    throw usageError("Provide exactly one of --content or --stdin.");
  }
  const result = await c.op(c.ops.machines.writeFile, {
    ...(await hostPath(c)),
    rootPath: c.flag("root"),
    content: inline ?? (await readStdin()).toString("utf8"),
    createParents: c.on("create-parents") || undefined,
    expectedSha256: c.flag("expected-sha256"),
  });
  if (result.outcome === "written") {
    return c.out(result, `Wrote ${c.arg("path")}`);
  }
  const current = result.currentSha256 ?? "none (the file does not exist)";
  throw new CliError(`Write conflict for ${c.arg("path")}`, {
    code: "conflict",
    hint: `The file's current SHA-256 is ${current}.`,
  });
};

export const fileList: Run = async (c) => {
  const result = await c.op(c.ops.machines.listFiles, {
    ...(await hostPath(c)),
    query: c.flag("query"),
    limit: integer(c.flag("limit"), "--limit"),
    includeHidden: c.on("no-hidden") ? false : undefined,
    excludeNames: c.on("exclude") ? c.list("exclude") : undefined,
  });
  const paths = result.files.map((file) => file.path);
  c.out(result, paths);
};

export const filePaths: Run = async (c) => {
  const files = c.on("files");
  const directories = c.on("directories");
  const result = await c.op(c.ops.machines.listPaths, {
    ...(await hostPath(c)),
    query: c.flag("query"),
    limit: integer(c.flag("limit"), "--limit"),
    includeFiles: files || !directories,
    includeDirectories: directories || !files,
    includeHidden: c.on("no-hidden") ? false : undefined,
    excludeNames: c.on("exclude") ? c.list("exclude") : undefined,
  });
  c.out(
    result,
    result.paths.map((entry) => `${entry.kind}\t${entry.path}`),
  );
};

export const fileMkdir: Run = async (c) => {
  const result = await c.op(c.ops.machines.mkdir, {
    ...(await hostPath(c)),
    rootPath: c.flag("root"),
    recursive: c.on("recursive") || undefined,
  });
  c.out(result, `Created directory ${c.arg("path")}`);
};

export const fileMove: Run = async (c) => {
  const result = await c.op(c.ops.machines.movePath, {
    hostId: await machineFlag(c),
    sourcePath: c.arg("source"),
    destinationPath: c.arg("destination"),
    rootPath: c.flag("root"),
  });
  c.out(result, `Moved ${c.arg("source")} to ${c.arg("destination")}`);
};

export const fileRemove: Run = async (c) => {
  await confirm(c, `Remove ${c.arg("path")}?`);
  const result = await c.op(c.ops.machines.removePath, {
    ...(await hostPath(c)),
    rootPath: c.flag("root"),
    recursive: c.on("recursive") || undefined,
  });
  c.out(result, `Removed ${c.arg("path")}`);
};

async function readSettings(c: Call): Promise<Record<string, unknown>> {
  const [config, ui] = await Promise.all([
    c.op(c.ops.server.config, {}),
    c.op(c.ops.settings.uiPreferences, {}),
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
  const { settings } = c.ops;
  const config = await c.op(c.ops.server.config, {});
  if (key === "theme" || key === "theme.faviconColor") {
    const { themeId, faviconColor } = config.appearance;
    const next = raw ?? "default";
    const selection =
      key === "theme"
        ? { themeId: next, faviconColor }
        : { themeId, faviconColor: next };
    const theme = valid(domain.appThemeSchema, selection, key);
    return c.op(settings.updateAppearance, theme);
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
    return c.op(settings.updateKeyboard, { overrides });
  }
  if (key.startsWith(UI)) {
    const name = key.slice(UI.length);
    if (!domain.isUiPreferenceKey(name)) {
      const known = domain.UI_PREFERENCE_KEYS.join(", ");
      throw usageError(`Unknown UI preference '${name}'.`, `Known: ${known}`);
    }
    if (raw === undefined) {
      return c.op(settings.resetUiPreference, { key: name });
    }
    const parsed = domain.parseUiPreferenceValue(name, settingValue(raw));
    if (!parsed.success) throw usageError(parsed.message);
    const { preferences } = await c.op(settings.uiPreferences, {});
    const expectedRevision = preferences[name].revision;
    const { value } = parsed;
    const write = { key: name, value, expectedRevision };
    return c.op(settings.updateUiPreference, write);
  }
  const defaults: Record<string, unknown> = domain.defaultAppSettings;
  if (!Object.hasOwn(defaults, key)) {
    const hint = "Run `bb settings show` for the keys.";
    throw usageError(`Unknown setting '${key}'.`, hint);
  }
  const value = raw === undefined ? defaults[key] : settingValue(raw);
  const changed = { ...config.generalSettings, [key]: value };
  const next = valid(domain.appSettingsSchema, changed, "setting");
  return c.op(settings.updateGeneral, { settings: next });
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
  const result = await c.op(c.ops.plugins.list, {});
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
    const toggled = await c.op(c.ops.plugins[verb], {
      pluginId: c.arg("id"),
    });
    const { plugin } = toggled;
    c.out(plugin, `Plugin ${plugin.id} is ${plugin.status}`);
  };
}

export const pluginEnable = setPluginEnabled("enable");
export const pluginDisable = setPluginEnabled("disable");

export const pluginReload: Run = async (c) => {
  const pluginId = c.args.id;
  const result = await c.op(c.ops.plugins.reload, { id: pluginId });
  c.out(result, `Reloaded ${pluginId ?? `${result.plugins.length} plugins`}`);
};

function pluginSettingValue(
  type: string,
  key: string,
  raw: string,
): string | number | boolean {
  if (type === "number") {
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(value)) {
      throw usageError(`Setting '${key}' needs a number, not '${raw}'.`);
    }
    return value;
  }
  if (type === "boolean") {
    if (raw === "true" || raw === "false") return raw === "true";
    throw usageError(`Setting '${key}' needs true or false, not '${raw}'.`);
  }
  return raw;
}

function settingLine(value: unknown): string {
  if (value === null || value === undefined) return "(unset)";
  if (typeof value === "object" && "set" in value) {
    return value.set === true ? "(secret, set)" : "(secret, unset)";
  }
  return JSON.stringify(value);
}

export const pluginConfig: Run = async (c) => {
  const pluginId = c.arg("id");
  const { action, key, value } = c.args;
  const projectId = c.id("project");
  const scope = projectId === undefined ? {} : { projectId };
  const current = await c.op(c.ops.plugins.settings, { pluginId, ...scope });
  const usage =
    "Usage: bb plugin config <id> [set <key> <value> | unset <key>]";
  let result = current;
  if (action !== undefined) {
    if (action !== "set" && action !== "unset") {
      throw usageError(`Unknown action '${action}'.`, usage);
    }
    const missing = action === "set" ? value === undefined : false;
    if (key === undefined || missing) throw usageError(usage);
    if (action === "unset" && value !== undefined) {
      throw usageError(`Unexpected argument '${value}'.`, usage);
    }
    const descriptor = current.schema[key];
    if (descriptor === undefined) {
      const known = Object.keys(current.schema).join(", ") || "none";
      throw usageError(`Unknown setting '${key}'.`, `Known: ${known}`);
    }
    const next =
      value === undefined
        ? null
        : pluginSettingValue(descriptor.type, key, value);
    const values = { [key]: next };
    result = await c.op(c.ops.plugins.updateSettings, {
      pluginId,
      values,
      ...scope,
    });
  }
  const shown = Object.keys(result.schema).map(
    (name) => `${name} = ${settingLine(result.values[name])}`,
  );
  c.out(result, shown.length === 0 ? `${pluginId} has no settings` : shown);
};

async function editPluginConfig(c: Call, add: boolean): Promise<void> {
  const path = resolve(c.arg("path"));
  const { dataDir } = await c.op(c.ops.server.config, {});
  const file = join(dataDir, "config.json");
  const { z } = await import("zod");
  const entry = z.looseObject({ path: z.string() });
  const schema = z.looseObject({ plugins: z.array(entry).default([]) });
  const text = await readFile(file, "utf8").catch(() => "{}");
  const config = valid(schema, parseJson(text, file), file);
  const others = config.plugins.filter((known) => resolve(known.path) !== path);
  if (!add && others.length === config.plugins.length) {
    const known = config.plugins.map((known) => known.path).join(", ");
    throw usageError(
      `${path} is not a loaded plugin directory.`,
      `Loaded directories: ${known || "none"}`,
    );
  }
  const plugins = add ? [...others, { path, enabled: true }] : others;
  const next = JSON.stringify({ ...config, plugins }, null, 2);
  await writeFile(file, `${next}\n`);
  const result = await c.op(c.ops.plugins.reload, {});
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
  const config = await c.op(c.ops.server.config, {}).catch((error: unknown) => {
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
