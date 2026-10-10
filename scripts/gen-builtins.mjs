import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = join(ROOT, "profiles", "default");
const SOURCES = join(ROOT, "packages/app-kit/components/ui/plugin-sources.css");

function manifests() {
  const found = [];
  for (const directory of readdirSync(join(ROOT, "plugins")).sort()) {
    const file = join(ROOT, "plugins", directory, "package.json");
    if (!existsSync(file)) continue;
    const { name, bb } = JSON.parse(readFileSync(file, "utf8"));
    if (bb === undefined) continue;
    const id = name.replace(/^@[^/]+\//u, "").replace(/^bb-plugin-/u, "");
    found.push({ id, directory, ...bb, runner: bb.runner ?? bb.host });
  }
  return found;
}

function binding(id) {
  return id.replace(/-(\w)/gu, (_dash, letter) => letter.toUpperCase());
}

function target(directory, entry, extension) {
  const path = entry.replace(/^\.\//u, "").replace(/\.tsx?$/u, extension);
  return `../../plugins/${directory}/${path}`;
}

function staticTable({ part, type, from, name, nullable }) {
  const all = manifests();
  const present = all.filter((plugin) => plugin[part] !== undefined);
  const imports = present.map(
    ({ id, directory, [part]: entry }) =>
      `import ${binding(id)} from "${target(directory, entry, ".js")}";`,
  );
  const listed = nullable ? all : present;
  const rows = listed.map(({ id, [part]: entry }) => {
    return `  "${id}": ${entry === undefined ? "null" : binding(id)},`;
  });
  const value = nullable ? `${type} | null` : type;
  return [
    `import type { ${type} } from "${from}";`,
    ...imports,
    "",
    `export const ${name}: Record<string, ${value}> = {`,
    ...rows,
    "};",
    "",
  ].join("\n");
}

function appTable() {
  const rows = manifests()
    .filter(({ app }) => app !== undefined)
    .map(({ id, directory, app }) => {
      return `  "${id}": () => import("${target(directory, app, "")}"),`;
    });
  return [
    'import type { PluginAppEntry } from "@bb/plugin/app";',
    "",
    "type Load = () => Promise<{ default: PluginAppEntry }>;",
    "",
    "export const appLoaders: Record<string, Load> = {",
    ...rows,
    "};",
    "",
  ].join("\n");
}

function sources() {
  const rows = manifests()
    .filter(({ app }) => app !== undefined)
    .map(({ directory }) => `@source "../../../../plugins/${directory}";`);
  return `${rows.join("\n")}\n`;
}

const server = {
  part: "server",
  type: "PluginServerEntry",
  from: "@bb/plugin",
  name: "serverEntries",
  nullable: true,
};
const runner = {
  part: "runner",
  type: "PluginRunnerEntry",
  from: "@bb/runner",
  name: "runnerEntries",
  nullable: false,
};
const outputs = [
  [join(PROFILE, "builtins.server.ts"), staticTable(server)],
  [join(PROFILE, "builtins.runner.ts"), staticTable(runner)],
  [join(PROFILE, "builtins.app.ts"), appTable()],
  [SOURCES, sources()],
];

const check = process.argv.includes("--check");
const stale = [];
for (const [file, text] of outputs) {
  const scratch = file.replace(/(\.\w+)$/u, ".next$1");
  writeFileSync(scratch, text);
  execFileSync("pnpm", ["exec", "oxfmt", scratch], { cwd: ROOT });
  const next = readFileSync(scratch, "utf8");
  rmSync(scratch);
  const current = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (current === next) continue;
  stale.push(file.slice(ROOT.length + 1));
  if (!check) writeFileSync(file, next);
}
if (check && stale.length > 0) {
  console.error(`Out of date: ${stale.join(", ")}. Run \`pnpm gen:builtins\`.`);
  process.exit(1);
}
console.log(
  stale.length === 0 ? "Built-in tables are current" : stale.join("\n"),
);
