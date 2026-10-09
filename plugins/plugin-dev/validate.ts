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
    requires: z
      .union([
        z.array(z.string().min(1)),
        z.record(z.string().min(1), z.string().min(1)),
      ])
      .default([]),
    skills: z.array(z.string().min(1)).default([]),
    themes: z
      .array(
        z.object({
          id: z
            .string()
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u)
            .max(64),
          name: z.string().min(1),
          css: z.string().min(1),
          codeTheme: z
            .object({
              dark: z.string().optional(),
              light: z.string().optional(),
            })
            .optional(),
        }),
      )
      .default([]),
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

const IMPORTS =
  /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']@bb\/plugin(?:\/[\w-]+)?["']/gu;
const CONTRACTS =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\w+\.)?contract\(\s*["']([^"']+)["']/gu;

function contractNames(sources: string[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const source of sources) {
    for (const match of source.matchAll(CONTRACTS)) {
      if (match[1] && match[2]) names.set(match[1], match[2]);
    }
  }
  return names;
}

function importedNames(source: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const match of source.matchAll(IMPORTS)) {
    for (const part of (match[1] ?? "").split(",")) {
      const alias = /^\s*(?:type\s+)?([\w$]+)\s+as\s+([\w$]+)\s*$/u.exec(part);
      if (alias?.[1] && alias[2]) names.set(alias[2], alias[1]);
    }
  }
  return names;
}

function canonical(target: string, names: Map<string, string>): string {
  const dot = target.indexOf(".");
  const head = target.slice(0, dot);
  const name = names.get(head);
  return name === undefined ? target : `${name}${target.slice(dot)}`;
}

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
  report.requires = Array.isArray(bb.requires)
    ? bb.requires
    : Object.keys(bb.requires);
  const present = async (entry: string) => {
    const file = resolve(directory, entry);
    if (!file.startsWith(`${directory}/`)) return false;
    return (await stat(file).catch(() => null)) !== null;
  };
  for (const part of ["server", "app", "runner"] as const) {
    const entry = bb[part];
    if (entry === undefined) continue;
    if (await present(entry)) report.parts.push(part);
    else report.problems.push(`The ${part} entry ${entry} does not exist.`);
  }
  for (const skill of bb.skills) {
    if (!(await present(skill)))
      report.problems.push(`The skill ${skill} does not exist.`);
  }
  for (const { id, css, codeTheme } of bb.themes) {
    if (!(await present(css)))
      report.problems.push(`The CSS ${css} of theme ${id} does not exist.`);
    for (const file of Object.values(codeTheme ?? {})) {
      if (/[/\\]|\.json$/u.test(file) && !(await present(file)))
        report.problems.push(
          `The code theme ${file} of theme ${id} does not exist.`,
        );
    }
  }
  const content = bb.skills.length + bb.themes.length;
  if (
    report.parts.length === 0 &&
    content === 0 &&
    report.problems.length === 0
  ) {
    report.problems.push(
      "The plugin has no server, app or runner part, skill or theme.",
    );
  }
  const files = await sourceFiles(directory);
  const sources = await Promise.all(
    files.map((path) => readFile(path, "utf8")),
  );
  const contracts = contractNames(sources);
  for (const [index, path] of files.entries()) {
    const file = relative(directory, path);
    const source = sources[index] ?? "";
    const names = new Map([...contracts, ...importedNames(source)]);
    for (const [field, verb] of Object.entries(VERBS)) {
      const pattern = new RegExp(
        String.raw`\b\w+\.${verb}\(\s*${TARGET}`,
        "gu",
      );
      for (const match of source.matchAll(pattern)) {
        const target = canonical(match[1] ?? "", names);
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
