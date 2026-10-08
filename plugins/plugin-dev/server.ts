import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
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

function tsconfigFor(): object {
  const at = (...parts: string[]) => join(REPO, ...parts);
  const types = at("apps", "app", "node_modules", "@types");
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
        zod: [at("apps", "server", "node_modules", "zod")],
        react: [join(types, "react")],
        "react/jsx-runtime": [join(types, "react", "jsx-runtime")],
      },
    },
  };
}

async function writeTypes(directory: string): Promise<string> {
  const file = join(directory, ".bb", "tsconfig.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(tsconfigFor(), null, 2)}\n`);
  return file;
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
