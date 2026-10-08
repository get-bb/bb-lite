import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import type { Report } from "./contract.js";

const manifestSchema = z.object({
  name: z.string().min(1),
  bb: z.object({
    name: z.string().min(1),
    server: z.string().optional(),
    app: z.string().optional(),
    runner: z.string().optional(),
    requires: z.array(z.string()).default([]),
  }),
});

const SOURCE = /\.(?:ts|tsx|mts|js|jsx|mjs)$/u;
const SKIPPED = new Set(["node_modules", "dist", "test", ".cache", ".bb"]);
const TARGET = String.raw`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)`;
const VERBS = {
  implements: "implement",
  hooks: "on",
  calls: "call",
  emits: "emit",
  adds: "add",
  wraps: "wrap",
  provides: "provide",
} as const;
const LEGACY = new RegExp(
  String.raw`\bbb\.(rpc|events|agents|ui|providers|threads|files|hosts|` +
    String.raw`projects|machines|inference|environments|realtime|sections|` +
    String.raw`users|slots|commands|icons|config|machine)\b`,
  "gu",
);
const REACHES: [what: string, pattern: RegExp][] = [
  ["node built-ins", /from\s+["'](node:[\w/]+)["']/gu],
  ["network requests", /\b(fetch)\(/gu],
  ["environment variables", /\b(process\.env)\b/gu],
];

function pluginId(name: string): string {
  const unscoped = name.replace(/^@[^/]+\//u, "");
  return unscoped.replace(/^bb-plugin-/u, "").toLowerCase();
}

async function sourceFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIPPED.has(entry.name) || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if (SOURCE.test(entry.name)) found.push(path);
  }
  return found;
}

function unique<Entry>(entries: Entry[]): Entry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = JSON.stringify(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function validatePlugin(path: string): Promise<Report> {
  const directory = resolve(path);
  const report: Report = {
    id: null,
    name: null,
    directory,
    parts: [],
    requires: [],
    implements: [],
    hooks: [],
    calls: [],
    emits: [],
    adds: [],
    wraps: [],
    provides: [],
    reaches: [],
    legacy: [],
    problems: [],
  };
  const text = await readFile(join(directory, "package.json"), "utf8").catch(
    () => null,
  );
  if (text === null) {
    report.problems.push("There is no package.json.");
    return report;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    report.problems.push("package.json is not JSON.");
    return report;
  }
  const manifest = manifestSchema.safeParse(parsed);
  if (!manifest.success) {
    const [issue] = manifest.error.issues;
    const where = issue?.path.join(".") ?? "package.json";
    report.problems.push(`package.json: ${where}: ${issue?.message}`);
    return report;
  }
  const { name, bb } = manifest.data;
  report.id = pluginId(name);
  report.name = bb.name;
  report.requires = bb.requires;
  for (const part of ["server", "app", "runner"] as const) {
    const entry = bb[part];
    if (entry === undefined) continue;
    const file = resolve(directory, entry);
    const inside = file.startsWith(`${directory}/`);
    const exists = inside && (await stat(file).catch(() => null)) !== null;
    if (exists) report.parts.push(part);
    else report.problems.push(`The ${part} entry ${entry} does not exist.`);
  }
  if (report.parts.length === 0 && report.problems.length === 0) {
    report.problems.push("The plugin has no server, app or runner part.");
  }
  for (const path of await sourceFiles(directory)) {
    const file = relative(directory, path);
    const source = await readFile(path, "utf8");
    for (const [field, verb] of Object.entries(VERBS)) {
      const pattern = new RegExp(
        String.raw`\b\w+\.${verb}\(\s*${TARGET}`,
        "gu",
      );
      for (const match of source.matchAll(pattern)) {
        const target = match[1] ?? "";
        report[field as keyof typeof VERBS].push({ target, file });
      }
    }
    for (const match of source.matchAll(LEGACY)) {
      report.legacy.push({ what: `bb.${match[1]}`, file });
    }
    for (const [what, pattern] of REACHES) {
      for (const match of source.matchAll(pattern)) {
        const detail = match[1] === "fetch" ? what : `${what}: ${match[1]}`;
        report.reaches.push({ what: detail, file });
      }
    }
  }
  for (const field of Object.keys(VERBS) as (keyof typeof VERBS)[]) {
    report[field] = unique(report[field]);
  }
  report.reaches = unique(report.reaches);
  report.legacy = unique(report.legacy);
  return report;
}
