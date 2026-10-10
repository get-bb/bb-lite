import { readFile, rm } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = resolve(root, "apps/cli/dist");
const KEPT_PACKAGES = [
  "better-sqlite3",
  "node-pty",
  "@parcel/watcher",
  "esbuild",
  "@anthropic-ai/claude-agent-sdk",
  "@tailwindcss/node",
  "@tailwindcss/oxide",
];
const KEPT_IN_NODE_MODULES = new RegExp(`^(${KEPT_PACKAGES.join("|")})([/]|$)`);
const SOURCE_FILE = /[.](ts|tsx|mts|js|mjs)$/;
const MODULE_URL = "__bbModuleUrl";
const REQUIRE_BANNER =
  'import { createRequire as __bbCreateRequire } from "node:module";\n' +
  "const require = __bbCreateRequire(import.meta.url);";

function fromOutdir(path) {
  const target = relative(outdir, path).split("\\").join("/");
  return target.startsWith(".") ? target : `./${target}`;
}

const repositoryLayout = {
  name: "repository-layout",
  setup({ onLoad, onResolve, resolve: resolveImport }) {
    onResolve({ filter: KEPT_IN_NODE_MODULES }, async (args) => {
      if (args.pluginData === "kept") return undefined;
      const { resolveDir, kind } = args;
      const options = { resolveDir, kind, pluginData: "kept" };
      const found = await resolveImport(args.path, options);
      if (found.errors.length > 0) return { errors: found.errors };
      return { path: fromOutdir(found.path), external: true };
    });
    onLoad({ filter: SOURCE_FILE }, async ({ path }) => {
      const source = await readFile(path, "utf8");
      if (!source.includes("import.meta.url")) return undefined;
      const location = JSON.stringify(fromOutdir(path));
      const prelude = `const ${MODULE_URL} = import.meta.resolve(${location});`;
      const loader = extname(path) === ".tsx" ? "tsx" : "ts";
      return { contents: `${prelude}\n${source}`, loader };
    });
  },
};

await rm(outdir, { recursive: true, force: true });
const result = await build({
  entryPoints: { bb: resolve(root, "apps/cli/src/index.ts") },
  outdir,
  outExtension: { ".js": ".mjs" },
  chunkNames: "chunk-[hash]",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  conditions: ["source"],
  define: { "import.meta.url": MODULE_URL },
  banner: { js: REQUIRE_BANNER },
  plugins: [repositoryLayout],
  metafile: true,
  logLevel: "warning",
});
const outputs = Object.entries(result.metafile.outputs);
const bytes = outputs.reduce((total, [, output]) => total + output.bytes, 0);
const megabytes = (bytes / 1024 / 1024).toFixed(1);
console.log(`apps/cli/dist: ${outputs.length} files, ${megabytes} MB`);
