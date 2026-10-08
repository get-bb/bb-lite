import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  plugins,
  type KernelInspection,
  type PluginServerApi,
} from "@bb/plugin";
import { pluginDev } from "./contract.js";
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

function tsconfigFor(original: string | null = null): object {
  const at = (...parts: string[]) => join(REPO, ...parts);
  const types = at("apps", "app", "node_modules", "@types");
  const roots = [
    ...(original === null ? [] : [join(original, "node_modules")]),
    at("apps", "app", "node_modules"),
    at("apps", "server", "node_modules"),
  ];
  return {
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      lib: ["ES2022", "DOM"],
      jsx: "react-jsx",
      noEmit: true,
      skipLibCheck: true,
      customConditions: ["source"],
      typeRoots: [types, at("apps", "server", "node_modules", "@types")],
      types: ["node"],
      paths: {
        "@bb/plugin": [at("packages", "plugin", "src", "index.ts")],
        "@bb/plugin/app": [at("packages", "plugin", "src", "app.ts")],
        "@bb/runner": [at("packages", "runner", "src", "index.ts")],
        "@bb/server-kit/*": [at("packages", "server-kit", "src", "*")],
        "@bb/app-kit/*": [at("packages", "app-kit", "*")],
        zod: [at("apps", "server", "node_modules", "zod")],
        react: [join(types, "react")],
        "react/jsx-runtime": [join(types, "react", "jsx-runtime")],
        "*": roots.map((root) => join(root, "*")),
      },
    },
  };
}

async function writeTypes(
  directory: string,
  original: string | null = null,
): Promise<string> {
  const file = join(directory, ".bb", "tsconfig.json");
  await mkdir(dirname(file), { recursive: true });
  const config = tsconfigFor(original);
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

interface Manifest {
  name?: string;
  bb?: Record<string, unknown>;
  scripts?: unknown;
  devDependencies?: unknown;
  dependencies?: Record<string, string>;
}

async function copyPlugin(
  id: string,
  source: string,
  target: string,
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
  const forked = {
    ...kept,
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
  await writeTypes(target, source);
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

async function fetchSource(
  source: string,
  root: string,
  cwd: string,
): Promise<string> {
  const options = { timeout: FETCH_TIMEOUT_MS };
  if (source.startsWith("git:")) {
    const [url = "", ref] = source.slice("git:".length).split("#");
    const name = basename(url).replace(/\.git$/u, "") || "plugin";
    const target = join(root, name);
    if (await exists(target)) {
      throw new Error(`${target} already exists; remove it to install again`);
    }
    const branch = ref === undefined ? [] : ["--branch", ref];
    const clone = ["clone", "--depth", "1", ...branch, url, target];
    await run("git", clone, options);
    const text = await readFile(join(target, "package.json"), "utf8");
    const { dependencies = {} } = JSON.parse(text) as {
      dependencies?: Record<string, string>;
    };
    if (Object.keys(dependencies).length > 0) {
      const install = ["install", "--omit=dev", "--ignore-scripts"];
      await run("npm", install, { ...options, cwd: target });
    }
    return target;
  }
  if (source.startsWith("npm:")) {
    const spec = source.slice("npm:".length);
    const prefix = join(root, "npm");
    await mkdir(prefix, { recursive: true });
    const install = ["install", "--prefix", prefix, "--ignore-scripts", spec];
    await run("npm", install, options);
    const name = spec.replace(/(?<=.)@[^/@]*$/u, "");
    return join(prefix, "node_modules", name);
  }
  return resolve(cwd, source);
}

export default function plugin(bb: PluginServerApi): void {
  const located = (input: { path: string; cwd?: string }) =>
    resolve(input.cwd ?? process.cwd(), input.path);

  bb.implement(pluginDev.inspect, async ({ name = "" }) =>
    describe(await bb.call(plugins.inspect, {}), name),
  );

  bb.implement(pluginDev.validate, (input) => validatePlugin(located(input)));

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

  bb.implement(pluginDev.fork, async ({ id, path, cwd }) => {
    const found = await bb.call(plugins.describe, { id });
    const source = found?.original ?? null;
    if (source === null) {
      const known = found === null ? "is not a plugin" : "is not built in";
      throw new Error(`"${id}" ${known}, so there is nothing to fork`);
    }
    const target = resolve(cwd ?? process.cwd(), path ?? id);
    if (await exists(target)) {
      throw new Error(`${target} already exists`);
    }
    try {
      await copyPlugin(id, source, target);
      return await bb.call(plugins.install, { path: target, watch: true });
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

  bb.implement(pluginDev.install, async ({ source, cwd }) => {
    const root = join(bb.server.dataDir, "plugins-src");
    await mkdir(root, { recursive: true });
    const path = await fetchSource(source, root, cwd ?? process.cwd());
    const report = await validatePlugin(path);
    if (report.problems.length > 0) {
      throw new Error(`Not a loadable plugin: ${report.problems.join(" ")}`);
    }
    return bb.call(plugins.install, { path, watch: false });
  });
}
