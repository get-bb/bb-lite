import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isHostModule,
  PLUGIN_RUNTIME_GLOBAL,
  type PluginServerEntry,
} from "@bb/plugin";
import {
  RUNNER_RUNTIME_GLOBAL,
  RUNNER_SHARED_MODULES,
  type RunnerPartBundle,
} from "@bb/runner";
import { build, type BuildOptions, type Loader, type Plugin } from "esbuild";
import { SERVER_RUNTIME_GLOBAL, SERVER_RUNTIME_MODULES } from "./runtime.js";

export interface AppBundle {
  js: string;
  css: string | null;
  hash: string;
  shared: string[];
  classes: string[];
}

const hostRequire = createRequire(import.meta.url);
const HOST_NODE_MODULES = fileURLToPath(
  new URL("../../node_modules", import.meta.url),
);
const APP_NODE_MODULES = fileURLToPath(
  new URL("../../../app/node_modules", import.meta.url),
);
const APP_THEME = fileURLToPath(
  new URL("../../../app/src/components/ui/theme.css", import.meta.url),
);
const STYLED_SOURCES = "**/*.{ts,tsx,js,jsx,mts,mjs}";
const SHARED_NAMESPACE = "bb-shared";
const REQUIRE_BANNER =
  'import { createRequire as bbCreateRequire } from "node:module";\n' +
  "const require = bbCreateRequire(import.meta.url);";
const COMMON: BuildOptions = {
  bundle: true,
  write: false,
  logLevel: "silent",
  alias: { "@bb/plugin": hostRequire.resolve("@bb/plugin") },
  nodePaths: [HOST_NODE_MODULES],
};
let importCount = 0;

const hostNativeModules: Plugin = {
  name: "bb-host-native-modules",
  setup(esbuild) {
    esbuild.onResolve({ filter: /^better-sqlite3$/ }, ({ path }) => ({
      path: hostRequire.resolve(path),
      external: true,
    }));
  },
};

function sharedModuleSource(specifier: string) {
  return [
    `const shared = globalThis.${PLUGIN_RUNTIME_GLOBAL}[${JSON.stringify(specifier)}];`,
    "const main = shared.default;",
    'const base = typeof main === "function" ? (...args) => main(...args) : {};',
    "module.exports = main == null ? shared : Object.assign(base, main, shared);",
  ].join("\n");
}

function hostModules(used: Set<string>): Plugin {
  return {
    name: "bb-host-modules",
    setup(esbuild) {
      esbuild.onResolve({ filter: /^[^./]/ }, ({ path }) => {
        if (!isHostModule(path)) return null;
        used.add(path);
        return { path, namespace: SHARED_NAMESPACE };
      });
      esbuild.onLoad({ filter: /.*/, namespace: SHARED_NAMESPACE }, (args) => ({
        contents: sharedModuleSource(args.path),
        loader: "js",
      }));
    },
  };
}

interface StyleSource {
  base: string;
  pattern: string;
  negated: boolean;
}

interface Stylist {
  compile(
    css: string,
    options: { base: string; onDependency(path: string): void },
  ): Promise<{ build(candidates: string[]): string; sources: StyleSource[] }>;
  Scanner: new (options: { sources: StyleSource[] }) => { scan(): string[] };
}

let stylist: Promise<Stylist | null> | undefined;

function loadStylist(): Promise<Stylist | null> {
  stylist ??= (async () => {
    if (!existsSync(APP_THEME)) return null;
    try {
      const { compile } = await import("@tailwindcss/node");
      const { Scanner } = await import("@tailwindcss/oxide");
      return { compile, Scanner } as Stylist;
    } catch {
      return null;
    }
  })();
  return stylist;
}

let hostClasses: Promise<Set<string>> | undefined;

function classesOfHost(tailwind: Stylist): Promise<Set<string>> {
  hostClasses ??= (async () => {
    const theme = await tailwind.compile(
      `@import ${JSON.stringify(APP_THEME)};`,
      { base: dirname(APP_THEME), onDependency() {} },
    );
    return new Set(new tailwind.Scanner({ sources: theme.sources }).scan());
  })();
  return hostClasses;
}

const UTILITIES_SHEET = [
  "@layer theme, base, components, utilities;",
  `@reference ${JSON.stringify(APP_THEME)};`,
  "@layer utilities { @tailwind utilities; }",
].join("\n");

async function ownClasses(directory: string): Promise<string[]> {
  const tailwind = await loadStylist();
  if (tailwind === null) return [];
  const provided = await classesOfHost(tailwind);
  const sources = [
    { base: directory, pattern: STYLED_SOURCES, negated: false },
    { base: directory, pattern: "**/node_modules/**", negated: true },
  ];
  const scanned = new tailwind.Scanner({ sources }).scan();
  return scanned.filter((candidate) => !provided.has(candidate)).sort();
}

export async function utilitiesWith(
  classes: readonly string[],
): Promise<string | null> {
  const tailwind = await loadStylist();
  if (tailwind === null || classes.length === 0) return null;
  const options = { base: dirname(APP_THEME), onDependency() {} };
  const added = await tailwind.compile(UTILITIES_SHEET, options);
  if (!added.build([...classes]).includes("{")) return null;
  const provided = await classesOfHost(tailwind);
  const whole = await tailwind.compile(UTILITIES_SHEET, options);
  return whole.build([...provided, ...classes]);
}

const RUNNER_NAMESPACE = "bb-runner-shared";

const runnerSharedModules: Plugin = {
  name: "bb-runner-shared-modules",
  setup(esbuild) {
    const shared: readonly string[] = RUNNER_SHARED_MODULES;
    esbuild.onResolve({ filter: /^@bb\// }, ({ path }) =>
      shared.includes(path) ? { path, namespace: RUNNER_NAMESPACE } : null,
    );
    esbuild.onLoad({ filter: /.*/, namespace: RUNNER_NAMESPACE }, (args) => ({
      contents: `module.exports = globalThis.${RUNNER_RUNTIME_GLOBAL}[${JSON.stringify(args.path)}];`,
      loader: "js",
    }));
  },
};

export async function bundleRunnerPart(
  id: string,
  entry: string,
  fallbacks: readonly string[] = [],
): Promise<RunnerPartBundle> {
  const { alias: _alias, ...common } = COMMON;
  const result = await build({
    ...common,
    nodePaths: [...fallbacks, HOST_NODE_MODULES],
    entryPoints: [entry],
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: REQUIRE_BANNER },
    plugins: [runnerSharedModules],
  });
  const code = result.outputFiles?.[0]?.text ?? "";
  const hash = createHash("sha256").update(code).digest("hex");
  return { id, hash, code };
}

const MODULE_URL = "__bbModuleUrl";
const SOURCE_FILE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;

const ownLocation: Plugin = {
  name: "bb-own-location",
  setup(esbuild) {
    esbuild.onLoad({ filter: SOURCE_FILE }, async ({ path }) => {
      if (path.includes(`${sep}node_modules${sep}`)) return undefined;
      const source = await readFile(path, "utf8");
      if (!source.includes("import.meta.url")) return undefined;
      const location = JSON.stringify(pathToFileURL(path).href);
      const prelude = `const ${MODULE_URL} = ${location};`;
      const loader = extname(path).replace(/^\.[cm]?/u, "") as Loader;
      return { contents: `${prelude}\n${source}`, loader };
    });
  },
};

const SERVER_NAMESPACE = "bb-server-shared";

const hostServerModules: Plugin = {
  name: "bb-host-server-modules",
  setup(esbuild) {
    esbuild.onResolve({ filter: /^@bb\// }, ({ path }) =>
      path in SERVER_RUNTIME_MODULES
        ? { path, namespace: SERVER_NAMESPACE }
        : null,
    );
    esbuild.onLoad({ filter: /.*/, namespace: SERVER_NAMESPACE }, (args) => ({
      contents: `module.exports = globalThis.${SERVER_RUNTIME_GLOBAL}[${JSON.stringify(args.path)}];`,
      loader: "js",
    }));
  },
};

export function contentHash(text: string) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export async function importServerEntry(
  entry: string,
  cacheDir: string,
  fallbacks: readonly string[] = [],
): Promise<PluginServerEntry> {
  const result = await build({
    ...COMMON,
    nodePaths: [...fallbacks, HOST_NODE_MODULES],
    entryPoints: [entry],
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: REQUIRE_BANNER },
    define: { "import.meta.url": MODULE_URL },
    plugins: [hostNativeModules, hostServerModules, ownLocation],
  });
  const code = result.outputFiles?.[0]?.text ?? "";
  const file = join(cacheDir, `server.${contentHash(code)}.mjs`);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(file, code);
  importCount += 1;
  Object.assign(globalThis, {
    [SERVER_RUNTIME_GLOBAL]: SERVER_RUNTIME_MODULES,
  });
  const url = `${pathToFileURL(file).href}?load=${importCount}`;
  const module: { default?: unknown } = await import(url);
  if (typeof module.default !== "function") {
    throw new Error("The server entry must default-export a function");
  }
  return module.default as PluginServerEntry;
}

export async function bundleApp(
  entry: string,
  directory: string,
  fallbacks: readonly string[] = [],
): Promise<AppBundle> {
  const used = new Set<string>();
  const result = await build({
    ...COMMON,
    nodePaths: [...fallbacks, APP_NODE_MODULES, HOST_NODE_MODULES],
    entryPoints: [entry],
    outdir: "/",
    entryNames: "app",
    platform: "browser",
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [hostModules(used)],
  });
  const output = (extension: string) =>
    result.outputFiles?.find((file) => file.path.endsWith(extension))?.text ??
    null;
  const js = output(".js") ?? "";
  const css = output(".css");
  const hash = contentHash(js + (css ?? ""));
  const classes = await ownClasses(directory);
  return { js, css, hash, shared: [...used].sort(), classes };
}
