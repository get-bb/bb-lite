import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PLUGIN_RUNTIME_GLOBAL,
  PLUGIN_SHARED_MODULES,
  type PluginServerEntry,
} from "@bb/plugin";
import { build, type BuildOptions, type Plugin } from "esbuild";

export interface AppBundle {
  js: string;
  css: string | null;
  hash: string;
}

const hostRequire = createRequire(import.meta.url);
const HOST_NODE_MODULES = fileURLToPath(
  new URL("../../node_modules", import.meta.url),
);
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

function sharedModuleSource(specifier: string): string {
  return [
    `const shared = globalThis.${PLUGIN_RUNTIME_GLOBAL}[${JSON.stringify(specifier)}];`,
    "const main = shared.default;",
    'const base = typeof main === "function" ? (...args) => main(...args) : {};',
    "module.exports = main == null ? shared : Object.assign(base, main, shared);",
  ].join("\n");
}

const sharedModules: Plugin = {
  name: "bb-shared-modules",
  setup(esbuild) {
    const shared: readonly string[] = PLUGIN_SHARED_MODULES;
    esbuild.onResolve({ filter: /^[^./]/ }, ({ path }) =>
      shared.includes(path) ? { path, namespace: SHARED_NAMESPACE } : null,
    );
    esbuild.onLoad({ filter: /.*/, namespace: SHARED_NAMESPACE }, (args) => ({
      contents: sharedModuleSource(args.path),
      loader: "js",
    }));
  },
};

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export async function importServerEntry(
  entry: string,
  cacheDir: string,
): Promise<PluginServerEntry> {
  const result = await build({
    ...COMMON,
    entryPoints: [entry],
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: REQUIRE_BANNER },
    plugins: [hostNativeModules],
  });
  const code = result.outputFiles?.[0]?.text ?? "";
  const file = join(cacheDir, `server.${contentHash(code)}.mjs`);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(file, code);
  importCount += 1;
  const url = `${pathToFileURL(file).href}?load=${importCount}`;
  const module: { default?: unknown } = await import(url);
  if (typeof module.default !== "function") {
    throw new Error("The server entry must default-export a function");
  }
  return module.default as PluginServerEntry;
}

export async function bundleApp(entry: string): Promise<AppBundle> {
  const result = await build({
    ...COMMON,
    entryPoints: [entry],
    outdir: "/",
    entryNames: "app",
    platform: "browser",
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [sharedModules],
  });
  const output = (extension: string): string | null =>
    result.outputFiles?.find((file) => file.path.endsWith(extension))?.text ??
    null;
  const js = output(".js") ?? "";
  const css = output(".css");
  return { js, css, hash: contentHash(js + (css ?? "")) };
}
