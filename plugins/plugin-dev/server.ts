import { execFile } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  API_VERSION,
  fail,
  isNewer,
  plugins,
  satisfies,
  type KernelInspection,
  type PluginServerApi,
} from "@bb/plugin";
import { pluginDev } from "./contract.js";
import { portReport } from "./port.js";
import { templates } from "./templates.js";
import { validatePlugin } from "./validate.js";

const run = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PLUGIN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const FETCH_TIMEOUT_MS = 5 * 60_000;

function describe(inspection: KernelInspection, name: string): string {
  const wanted = (candidate: string) => candidate.startsWith(name);
  const lines: string[] = [];
  if (name === "") {
    const ids = inspection.plugins.map(({ id }) => id).join(", ");
    lines.push(`plugins: ${ids}`);
  }
  for (const op of inspection.ops.filter((entry) => wanted(entry.name))) {
    const owner = op.owner ?? "nobody";
    const doors = op.doors.join(", ");
    lines.push(`op ${op.name}  ${op.kind}, hooks may ${op.hooks}`);
    lines.push(`  implemented by ${owner}; doors: ${doors}`);
    for (const { plugin, tier, failClosed } of op.chain) {
      const guard = failClosed ? ", fails closed" : "";
      lines.push(`  hooked by ${plugin} (${tier}${guard})`);
    }
  }
  for (const event of inspection.events.filter((e) => wanted(e.name))) {
    lines.push(`event ${event.name}`);
    lines.push(`  heard by ${event.listeners.join(", ") || "nobody"}`);
  }
  for (const slot of inspection.slots.filter((entry) => wanted(entry.name))) {
    const pick = slot.pick === "one" ? ", one winner" : "";
    lines.push(`slot ${slot.name}${pick}`);
    lines.push(`  filled by ${slot.entries.join(", ") || "nobody"}`);
  }
  for (const live of inspection.live.filter((entry) => wanted(entry.name))) {
    lines.push(`live ${live.name}  provided by ${live.owner}`);
  }
  return lines.length === 0 ? `Nothing is named ${name}*` : lines.join("\n");
}

const NOT_COPIED = new Set(["node_modules", "test", "dist", ".cache", ".bb"]);

const VITE_TYPES = join(REPO, "apps", "app", "src", "vite-env.d.ts");
const HOST_PACKAGES = [
  join(REPO, "apps", "app", "node_modules"),
  join(REPO, "apps", "server", "node_modules"),
];
const TSCONFIG = {
  compilerOptions: {
    strict: true,
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    lib: ["ES2022", "DOM", "DOM.Iterable"],
    jsx: "react-jsx",
    noEmit: true,
    skipLibCheck: true,
    customConditions: ["source"],
    types: ["node"],
  },
  files: [VITE_TYPES],
};

async function packagesIn(root: string): Promise<string[]> {
  const listed = await readdir(root).catch(() => []);
  const names: string[] = [];
  for (const name of listed) {
    if (name.startsWith(".")) continue;
    if (!name.startsWith("@")) names.push(name);
    else {
      const scoped = await readdir(join(root, name)).catch(() => []);
      names.push(...scoped.map((inner) => `${name}/${inner}`));
    }
  }
  return names;
}

async function linkPackages(
  directory: string,
  original: string | null,
): Promise<void> {
  const own = original === null ? [] : [join(original, "node_modules")];
  for (const root of [...own, ...HOST_PACKAGES]) {
    for (const name of await packagesIn(root)) {
      const link = join(directory, "node_modules", name);
      if ((await lstat(link).catch(() => null)) !== null) continue;
      const target = await realpath(join(root, name)).catch(() => null);
      if (target === null) continue;
      await mkdir(dirname(link), { recursive: true });
      await symlink(target, link, "dir");
    }
  }
}

async function writeTypes(
  directory: string,
  original: string | null = null,
): Promise<string> {
  const file = join(directory, ".bb", "tsconfig.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(TSCONFIG, null, 2)}\n`);
  await linkPackages(directory, original);
  return file;
}

interface Manifest {
  name?: string;
  bb?: Record<string, unknown>;
  scripts?: unknown;
  devDependencies?: unknown;
  dependencies?: Record<string, string>;
}

const SOURCE_FILE = /\.(?:ts|tsx)$/u;
const CONTRACT_FILE = /(?:^|[\\/])contracts?\.ts$/u;
const AGENT_TOOL = /(agent:\s*\{\s*name:\s*")([A-Za-z0-9_]+)(")/gu;

function pascal(id: string): string {
  const words = id.split("-").filter((word) => word !== "");
  return words.map((word) => word[0]?.toUpperCase() + word.slice(1)).join("");
}

function renamed(text: string, file: string, from: string, to: string): string {
  const literal = JSON.stringify(from);
  const quoted = literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const own = [
    new RegExp(`(\\bcontract\\(\\s*)${quoted}`, "gu"),
    new RegExp(`(>\\(\\s*)${quoted}(?=\\s*,)`, "gu"),
    new RegExp(`(\\bplugin:\\s*)${quoted}`, "gu"),
  ];
  let next = text;
  for (const pattern of own) next = next.replace(pattern, `$1"${to}"`);
  next = next.replace(/(defineCli\(\s*\{\s*name:\s*")[^"]+(")/gu, `$1${to}$2`);
  if (!CONTRACT_FILE.test(file)) return next;
  next = next.replace(/(cli:\s*\{\s*path:\s*")[^" ]+/gu, `$1${to}`);
  const tools = [...next.matchAll(AGENT_TOOL)].map((match) => match[2] ?? "");
  for (const tool of new Set(tools)) {
    const word = new RegExp(`\\b${tool}\\b`, "gu");
    next = next.replace(word, `${pascal(to)}${tool}`);
  }
  return next;
}

async function renamePlugin(
  directory: string,
  from: string,
  to: string,
): Promise<void> {
  const entries = await readdir(directory, { recursive: true });
  for (const entry of entries) {
    if (!SOURCE_FILE.test(entry) || entry.split(sep).includes(".bb")) continue;
    const file = join(directory, entry);
    const text = await readFile(file, "utf8");
    const next = renamed(text, entry, from, to);
    if (next !== text) await writeFile(file, next);
  }
}

async function copyPlugin(
  id: string,
  source: string,
  target: string,
  as: string | null = null,
): Promise<void> {
  const copied = (path: string) => {
    const parts = relative(source, path).split(sep);
    return !parts.some((part) => NOT_COPIED.has(part));
  };
  await cp(source, target, { recursive: true, filter: copied });
  const file = join(target, "package.json");
  const manifest = JSON.parse(await readFile(file, "utf8")) as Manifest;
  const { scripts: _scripts, devDependencies: _dev, ...kept } = manifest;
  const own = Object.entries(manifest.dependencies ?? {}).filter(
    ([, range]) => !range.startsWith("workspace:"),
  );
  const identity = as === null ? {} : { name: `bb-plugin-${as}` };
  const forked = {
    ...kept,
    ...identity,
    bb: { ...manifest.bb, forkOf: id },
    dependencies: Object.fromEntries(own),
  };
  await writeFile(file, `${JSON.stringify(forked, null, 2)}\n`);
  const tsconfig = {
    extends: "./.bb/tsconfig.json",
    include: ["**/*.ts", "**/*.tsx"],
    exclude: ["node_modules"],
  };
  const text = `${JSON.stringify(tsconfig, null, 2)}\n`;
  await writeFile(join(target, "tsconfig.json"), text);
  if (as !== null) await renamePlugin(target, id, as);
  await writeTypes(target, source);
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

type Fetched = { path: string; version: string | null; ref: string | null };
type Wanted = { version?: string; tagPrefix?: string; replace?: boolean };

async function packageOf(path: string): Promise<{
  version?: string;
  engines?: { bb?: string };
  dependencies?: Record<string, string>;
}> {
  return JSON.parse(await readFile(join(path, "package.json"), "utf8"));
}

async function tagFor(
  url: string,
  range: string,
  prefix: string,
): Promise<{ tag: string; version: string }> {
  const { stdout } = await run("git", ["ls-remote", "--tags", url], {
    timeout: FETCH_TIMEOUT_MS,
  });
  let best: { tag: string; version: string } | null = null;
  for (const line of stdout.split("\n")) {
    const tag = line.split("refs/tags/")[1]?.replace(/\^\{\}$/u, "");
    if (tag === undefined || !tag.startsWith(prefix)) continue;
    const version = tag.slice(prefix.length).replace(/^v/u, "");
    if (!/^\d+\.\d+\.\d+$/u.test(version)) continue;
    if (!satisfies(version, range)) continue;
    if (best === null || isNewer(version, best.version)) {
      best = { tag, version };
    }
  }
  if (best === null) {
    fail("not_found", `No tag of ${url} matches ${prefix}${range}`);
  }
  return best;
}

async function place(
  from: string,
  target: string,
  replace: boolean,
): Promise<void> {
  if (await exists(target)) {
    if (!replace) {
      throw new Error(`${target} already exists; remove it to install again`);
    }
    await rm(target, { recursive: true, force: true });
  }
  await rename(from, target);
}

async function fetchGit(
  spec: string,
  root: string,
  wanted: Wanted,
): Promise<Fetched> {
  const [url = "", after] = spec.split("#");
  const [given, subdir = ""] = (after ?? "").split(":");
  const options = { timeout: FETCH_TIMEOUT_MS };
  const found =
    wanted.version === undefined
      ? null
      : await tagFor(url, wanted.version, wanted.tagPrefix ?? "");
  const ref = found?.tag ?? (given === "" ? null : (given ?? null));
  const name =
    basename(subdir) || basename(url).replace(/\.git$/u, "") || "plugin";
  const target = join(root, name);
  if ((await exists(target)) && wanted.replace !== true) {
    throw new Error(`${target} already exists; remove it to install again`);
  }
  const scratch = await mkdtemp(join(root, ".fetch-"));
  try {
    const branch = ref === null ? [] : ["--branch", ref];
    const clone = ["clone", "--depth", "1", ...branch, url, scratch];
    await run("git", clone, options);
    const inside = resolve(scratch, subdir);
    if (relative(scratch, inside).startsWith("..")) {
      fail("invalid", `${subdir} is outside the repository`);
    }
    if (!(await exists(join(inside, "package.json")))) {
      fail("invalid", `${subdir || url} has no package.json`);
    }
    const manifest = await packageOf(inside);
    checkEngine(manifest.engines?.bb);
    if (Object.keys(manifest.dependencies ?? {}).length > 0) {
      const install = ["install", "--omit=dev", "--ignore-scripts"];
      await run("npm", install, { ...options, cwd: inside });
    }
    await place(inside, target, wanted.replace === true);
    return {
      path: target,
      version: found?.version ?? manifest.version ?? null,
      ref,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function fetchNpm(
  spec: string,
  root: string,
  wanted: Wanted,
): Promise<Fetched> {
  const name = spec.replace(/(?<=.)@[^/@]*$/u, "");
  const range = wanted.version ?? spec.slice(name.length + 1);
  const scratch = await mkdtemp(join(root, ".fetch-"));
  try {
    const exact = range === "" ? name : `${name}@${range}`;
    const install = ["install", "--prefix", scratch, "--ignore-scripts", exact];
    await run("npm", install, { timeout: FETCH_TIMEOUT_MS });
    const inside = join(scratch, "node_modules", name);
    const manifest = await packageOf(inside);
    checkEngine(manifest.engines?.bb);
    const target = join(root, "npm", name);
    await mkdir(dirname(target), { recursive: true });
    await place(scratch, target, wanted.replace === true);
    const path = join(target, "node_modules", name);
    return { path, version: manifest.version ?? null, ref: null };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function checkEngine(range: string | undefined): void {
  if (range === undefined || satisfies(API_VERSION, range)) return;
  fail(
    "invalid",
    `This plugin needs bb API ${range}; this bb has ${API_VERSION}`,
    {
      reason: "engine_mismatch",
      hint: "Install a version of the plugin made for this bb, or update bb",
    },
  );
}

async function fetchSource(
  source: string,
  root: string,
  cwd: string,
  wanted: Wanted,
): Promise<Fetched> {
  if (source.startsWith("git:")) {
    return fetchGit(source.slice("git:".length), root, wanted);
  }
  if (source.startsWith("npm:")) {
    return fetchNpm(source.slice("npm:".length), root, wanted);
  }
  const path = resolve(cwd, source);
  if (await exists(join(path, "package.json"))) {
    checkEngine((await packageOf(path)).engines?.bb);
  }
  return { path, version: null, ref: null };
}

export default function plugin(bb: PluginServerApi): void {
  const located = (input: { path: string; cwd?: string }) =>
    resolve(input.cwd ?? process.cwd(), input.path);

  bb.implement(pluginDev.inspect, async ({ name = "" }) =>
    describe(await bb.call(plugins.inspect, {}), name),
  );

  bb.implement(pluginDev.validate, (input) => validatePlugin(located(input)));

  bb.implement(pluginDev.port, (input) => portReport(located(input)));

  bb.implement(pluginDev.scaffold, async ({ name, path, cwd }) => {
    if (!PLUGIN_ID.test(name)) {
      throw new Error("A plugin id is lower-case letters, digits and dashes");
    }
    const directory = resolve(cwd ?? process.cwd(), path ?? name);
    if (await exists(join(directory, "package.json"))) {
      throw new Error(`${directory} already holds a package.json`);
    }
    await mkdir(directory, { recursive: true });
    const files = Object.entries(templates(name));
    for (const [file, text] of files) {
      await writeFile(join(directory, file), text);
    }
    await writeTypes(directory);
    return { path: directory, files: files.map(([file]) => file) };
  });

  bb.implement(pluginDev.fork, async ({ id, path, cwd, as = null }) => {
    const found = await bb.call(plugins.describe, { id });
    const source = found?.original ?? null;
    if (source === null) {
      const known = found === null ? "is not a plugin" : "is not built in";
      throw new Error(`"${id}" ${known}, so there is nothing to fork`);
    }
    if (as !== null && !PLUGIN_ID.test(as)) {
      throw new Error("A plugin id is lower-case letters, digits and dashes");
    }
    if (as !== null && (await bb.call(plugins.describe, { id: as })) !== null) {
      throw new Error(`A plugin called "${as}" is already installed`);
    }
    const target = resolve(cwd ?? process.cwd(), path ?? as ?? id);
    if (await exists(target)) {
      throw new Error(`${target} already exists`);
    }
    try {
      await copyPlugin(id, source, target, as);
      const install = { path: target, watch: true };
      const installed = await bb.call(plugins.install, install);
      return { ...installed, beside: as === null ? null : id };
    } catch (error) {
      await rm(target, { recursive: true, force: true });
      throw error;
    }
  });

  bb.implement(pluginDev.types, async (input) => {
    return { file: await writeTypes(located(input)) };
  });

  bb.implement(pluginDev.watch, (input) =>
    bb.call(plugins.install, { path: located(input), watch: true }),
  );

  bb.implement(pluginDev.install, async ({ source, cwd, ...wanted }) => {
    const root = join(bb.server.dataDir, "plugins-src");
    await mkdir(root, { recursive: true });
    const fetched = await fetchSource(
      source,
      root,
      cwd ?? process.cwd(),
      wanted,
    );
    const report = await validatePlugin(fetched.path);
    if (report.problems.length > 0) {
      throw new Error(`Not a loadable plugin: ${report.problems.join(" ")}`);
    }
    const installed = await bb.call(plugins.install, {
      path: fetched.path,
      watch: false,
    });
    return { ...installed, version: fetched.version, ref: fetched.ref };
  });
}
