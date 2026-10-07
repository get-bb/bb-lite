#!/usr/bin/env node
// Bundles the TypeScript server halves of the built-in plugins that run in the
// Rust server's QuickJS runtime: node scripts/build-plugin-bundles.mjs <outDir> [name=entry...]
// esbuild is found by walking up from the repository root, or under
// BB_NODE_MODULES_ROOT (a checkout that has node_modules).
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGINS = {
  "thread-list": "plugins/thread-list/server.ts",
  secrets: "plugins/secrets/src/server.ts",
  "ask-user-question": "plugins/ask-user-question/src/server.ts",
  "custom-instructions": "plugins/custom-instructions/server.ts",
  tasks: "plugins/tasks/server.ts",
};

function nodeModulesRoots() {
  const roots = [];
  if (process.env.BB_NODE_MODULES_ROOT) roots.push(resolve(process.env.BB_NODE_MODULES_ROOT));
  for (let dir = repo; ; dir = dirname(dir)) {
    roots.push(dir);
    if (dirname(dir) === dir) break;
  }
  return roots.filter((root) => existsSync(join(root, "node_modules", "esbuild")));
}

const [root] = nodeModulesRoots();
if (root === undefined) {
  console.error("esbuild not found: run pnpm install or set BB_NODE_MODULES_ROOT");
  process.exit(2);
}
const esbuild = createRequire(join(root, "package.json"))("esbuild");
const outDir = resolve(process.argv[2] ?? join(repo, "target", "plugin-bundles"));
mkdirSync(outDir, { recursive: true });

// With BB_NODE_MODULES_ROOT, bare imports resolve as if from the same directory
// of that checkout (pnpm keeps per-package node_modules); workspace sources map back.
const borrowModules = {
  name: "borrow-node-modules",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, async (args) => {
      if (args.pluginData?.borrowed || args.path.startsWith("node:") || args.path.startsWith("bb:")) return undefined;
      const inside = relative(repo, args.resolveDir);
      if (inside.startsWith("..")) return undefined;
      const from = (dir) => build.resolve(args.path, { kind: args.kind, resolveDir: dir, pluginData: { borrowed: true } });
      let result = await from(join(root, inside));
      if (result.errors.length > 0 && args.path === "zod") result = await from(join(root, "packages/plugin"));
      if (result.errors.length > 0) return { errors: result.errors };
      const local = relative(root, result.path);
      if (!local.startsWith("..") && !local.split(sep).includes("node_modules")) {
        return { ...result, path: join(repo, local) };
      }
      return result;
    });
  },
};
const extra = process.argv.slice(3).map((arg) => arg.split("="));
const entries = extra.length > 0 ? extra : Object.entries(PLUGINS);
for (const [name, entry] of entries) {
  const contents = [
    `import plugin from ${JSON.stringify(resolve(repo, entry))};`,
    `import { z } from "zod";`,
    `import { start } from "bb:plugin-host";`,
    `export default (config) => start(plugin, z, config);`,
  ].join("\n");
  await esbuild.build({
    stdin: { contents, resolveDir: dirname(join(repo, entry)), sourcefile: `${name}-entry.mjs`, loader: "js" },
    bundle: true,
    outfile: join(outDir, `${name}.mjs`),
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["source"],
    mainFields: ["module", "main"],
    external: ["node:*", "bb:plugin-host"],
    plugins: [borrowModules],
    tsconfigRaw: "{}",
    logLevel: "error",
  });
}
