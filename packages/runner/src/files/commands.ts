import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderCommand } from "@bb/server-contract";
import { pathExists, type Ctx, type Method } from "../workspace/exec.js";
import type { WorkspaceApi } from "../workspace-types.js";

const SKILL_FILE_NAME = "SKILL.md";
const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_ENTRIES = 1_000;
const MAX_DESCRIPTION_LENGTH = 300;
const FRONTMATTER_READ_BYTES = 8 * 1024;
const BUILTIN_COMMANDS = [
  ["clear", "Start fresh context in this thread"],
  ["compact", "Compact context"],
].map(([name = "", description = ""]): ProviderCommand => ({
  name,
  source: "command",
  origin: "builtin",
  description,
  argumentHint: null,
}));
const ORIGIN_RANK = { builtin: 2, project: 1, user: 0 };

type Scope = Parameters<WorkspaceApi["listCommands"]>[0];
type Root = [
  directory: string,
  source: ProviderCommand["source"],
  origin: "project" | "user",
];

async function projectAncestors(cwd: string): Promise<string[]> {
  const directories = [cwd];
  for (let directory = cwd; ; directory = path.dirname(directory)) {
    if (await pathExists(path.join(directory, ".git"))) return directories;
    if (path.dirname(directory) === directory) return [cwd];
    directories.unshift(path.dirname(directory));
  }
}

async function scanRoots(ctx: Ctx, scope: Scope): Promise<Root[]> {
  const home = os.homedir();
  const { cwd } = scope;
  const ancestors = cwd === null ? [] : await projectAncestors(cwd);
  const nearest = (relative: string, source: Root[1] = "skill"): Root[] =>
    cwd === null ? [] : [[path.join(cwd, relative), source, "project"]];
  const inherited = (relative: string): Root[] =>
    ancestors.map((directory) => [
      path.join(directory, relative),
      "skill",
      "project",
    ]);
  const user = (directory: string, source: Root[1] = "skill"): Root => [
    directory,
    source,
    "user",
  ];
  const shared = [
    ...nearest(".bb/skills"),
    user(path.join(ctx.dataDir, "skills")),
  ];
  if (scope.providerId === "claude-code") {
    const claude = process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");
    return [
      ...inherited(".claude/skills"),
      ...nearest(".claude/commands", "command"),
      user(path.join(claude, "skills")),
      user(path.join(claude, "commands"), "command"),
      ...shared,
    ];
  }
  if (scope.providerId === "codex") {
    const codex = process.env.CODEX_HOME ?? path.join(home, ".codex");
    return [
      ...nearest(".codex/skills"),
      ...inherited(".agents/skills"),
      user(path.join(codex, "skills")),
      user(path.join(codex, "skills", ".system")),
      user(path.join(home, ".agents", "skills")),
      ...shared,
    ];
  }
  return shared;
}

export function parseFrontmatter(content: string): Record<string, string> {
  const lines = content.trimStart().split(/\r?\n/u);
  const fields: Record<string, string> = {};
  const end = lines.indexOf("---", 1);
  let key = "";
  for (const line of lines[0] === "---" ? lines.slice(1, end) : []) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/u.exec(line);
    if (field !== null) {
      key = field[1] ?? "";
      const value = (field[2] ?? "").trim();
      const quoted = /^(["'])(.*)\1$/u.exec(value)?.[2];
      fields[key] = /^[|>][+-]?$/u.test(value) ? "" : (quoted ?? value);
    } else if (key !== "" && /^\s+\S/u.test(line)) {
      fields[key] = `${fields[key] ?? ""} ${line.trim()}`.trim();
    }
  }
  return fields;
}

async function describe(
  [, source, origin]: Root,
  name: string,
  filePath: string,
): Promise<ProviderCommand | null> {
  const handle = await fs.open(filePath, "r").catch(() => null);
  if (handle === null) return null;
  try {
    const head = Buffer.alloc(FRONTMATTER_READ_BYTES);
    const { bytesRead } = await handle.read(head, 0, head.byteLength, 0);
    const fields = parseFrontmatter(head.subarray(0, bytesRead).toString());
    const description = fields.description?.slice(0, MAX_DESCRIPTION_LENGTH);
    const argumentHint = fields["argument-hint"] || null;
    const about = { description: description || null, argumentHint };
    return { name, source, origin, ...about };
  } finally {
    await handle.close();
  }
}

async function scan(
  root: Root,
  budget: { remaining: number },
  relative = "",
  depth = 0,
): Promise<(ProviderCommand | null)[]> {
  const [rootDirectory, source, origin] = root;
  const directory = path.join(rootDirectory, relative);
  const entries = (
    await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
  )
    .slice(0, Math.max(0, budget.remaining))
    .sort((left, right) => left.name.localeCompare(right.name));
  budget.remaining -= entries.length;
  const found: (ProviderCommand | null)[] = [];
  for (const entry of entries) {
    const entryPath = path.join(relative, entry.name);
    const linked = origin === "user" && entry.isSymbolicLink();
    if (source === "skill" && (entry.isDirectory() || linked)) {
      const skillFile = path.join(directory, entry.name, SKILL_FILE_NAME);
      found.push(await describe(root, entry.name, skillFile));
    } else if (source === "skill") {
      continue;
    } else if (entry.isDirectory() && depth < MAX_SCAN_DEPTH) {
      found.push(...(await scan(root, budget, entryPath, depth + 1)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const name = entryPath.slice(0, -".md".length).split(path.sep).join(":");
      found.push(await describe(root, name, path.join(directory, entry.name)));
    }
  }
  return found;
}

function section(command: ProviderCommand): number {
  const userCommand = command.origin === "project" ? 2 : 3;
  const discovered = command.source === "skill" ? 1 : userCommand;
  return command.origin === "builtin" ? 0 : discovered;
}

export const listCommands: Method<"listCommands"> = async (ctx, args) => {
  const budget = { remaining: MAX_SCAN_ENTRIES };
  const found: (ProviderCommand | null)[] =
    args.providerId === "echo" ? [] : [...BUILTIN_COMMANDS];
  const roots = await scanRoots(ctx, args);
  const scanned = new Set<string>();
  for (const root of roots.filter(([directory]) => !scanned.has(directory))) {
    scanned.add(root[0]);
    found.push(...(await scan(root, budget)));
  }
  const byKey = new Map<string, ProviderCommand>();
  for (const command of found.filter((entry) => entry !== null)) {
    const key = `${command.source} ${command.name}`;
    const known = byKey.get(key);
    if (!known || ORIGIN_RANK[command.origin] > ORIGIN_RANK[known.origin]) {
      byKey.set(key, command);
    }
  }
  const commands = [...byKey.values()].sort(
    (left, right) =>
      section(left) - section(right) || left.name.localeCompare(right.name),
  );
  return { commands };
};
