import { z } from "zod";
import type { CliRunner } from "./cli-runner.js";
import { READ_ONLY_COMMAND_PATHS } from "./policy.js";

const COMMAND_INDEX_TTL_MS = 60 * 1000;
const COMMAND_INDEX_TIMEOUT_MS = 15_000;
export const SEARCH_DEFAULT_LIMIT = 12;
export const SEARCH_MAX_LIMIT = 40;

export interface IndexedCommand {
  path: string;
  aliases: string[];
  arguments: string;
  description: string;
  options: string[];
  json?: string;
  kind?: "read" | "write";
}

export interface CommandIndex {
  commands: readonly IndexedCommand[];
  paths: ReadonlySet<string>;
}

export interface CommandSearchMatch {
  usage: string;
  description: string;
  options: string[];
  aliases: string[];
  json?: string;
  readOnly: boolean;
}

export interface PluginCliGroup {
  name: string;
  summary: string;
  commands: readonly { name: string; summary: string }[];
}

export interface DescribedMembers {
  members: Record<string, unknown>;
}

const USAGE_PREFIX = "Usage: bb ";
const ALIASES_PREFIX = "Aliases: ";
const JSON_PREFIX = "JSON (--json): ";
const OPTIONS_HEADING = "Options:";

const doorMemberSchema = z.object({
  kind: z.enum(["read", "write"]),
  doors: z.object({
    cli: z.object({
      path: z.string().min(1),
      summary: z.string(),
      positionals: z.array(z.string()).default([]),
      aliases: z.array(z.string()).default([]),
    }),
  }),
});

export class CommandIndexUnavailableError extends Error {
  constructor() {
    super(
      "The bb CLI on this bb server did not print its command reference (`bb guide commands`), so the `read` and `search` tools are unavailable. Update bb on that machine.",
    );
    this.name = "CommandIndexUnavailableError";
  }
}

function parseUsage(usage: string): { path: string; arguments: string } {
  const words = usage.split(/\s+/u).filter(Boolean);
  const first = words.findIndex((word) => /^[[<]/u.test(word));
  const split = first === -1 ? words.length : first;
  const rest = words.slice(split).filter((word) => word !== "[options]");
  return { path: words.slice(0, split).join(" "), arguments: rest.join(" ") };
}

function parseCommandBlock(block: string): IndexedCommand | null {
  const [usage = "", ...lines] = block.split("\n");
  if (!usage.startsWith(USAGE_PREFIX)) return null;
  const command: IndexedCommand = {
    ...parseUsage(usage.slice(USAGE_PREFIX.length)),
    aliases: [],
    description: "",
    options: [],
  };
  if (command.path === "") return null;
  let inOptions = false;
  for (const line of lines) {
    if (line.startsWith(ALIASES_PREFIX)) {
      const listed = line.slice(ALIASES_PREFIX.length).split(",");
      command.aliases = listed.map((alias) => alias.trim()).filter(Boolean);
    } else if (line.startsWith(JSON_PREFIX)) {
      command.json = line.slice(JSON_PREFIX.length).trim();
    } else if (line.trim() === OPTIONS_HEADING) {
      inOptions = true;
    } else if (inOptions && line.startsWith("  ")) {
      command.options.push(line.trim().replace(/\s{2,}/gu, "  "));
    } else if (command.description === "") {
      command.description = line.trim();
    }
  }
  return command;
}

export function parseCommandReference(stdout: string): IndexedCommand[] {
  const commands = stdout
    .split(/\n\s*\n/u)
    .map((block) => parseCommandBlock(block.trim()))
    .filter((command) => command !== null);
  if (commands.length === 0) throw new CommandIndexUnavailableError();
  return commands;
}

function kebab(field: string): string {
  return field.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

export function pluginCommandIndex(
  contracts: readonly DescribedMembers[],
  groups: readonly PluginCliGroup[],
): IndexedCommand[] {
  const commands = new Map<string, IndexedCommand>();
  const spellings = new Set<string>();
  for (const { members } of contracts) {
    for (const member of Object.values(members)) {
      const parsed = doorMemberSchema.safeParse(member);
      if (!parsed.success) continue;
      const { kind, doors } = parsed.data;
      const { path, summary, positionals, aliases } = doors.cli;
      for (const alias of aliases) spellings.add(alias);
      commands.set(path, {
        path,
        aliases,
        arguments: positionals.map((name) => `<${kebab(name)}>`).join(" "),
        description: summary,
        options: [],
        kind,
      });
    }
  }
  for (const group of groups) {
    const listed = group.commands.filter(({ name }) => !spellings.has(name));
    const entries =
      group.commands.length === 0
        ? [{ path: group.name, summary: group.summary }]
        : listed.map(({ name, summary }) => {
            return { path: `${group.name} ${name}`, summary };
          });
    for (const { path, summary } of entries) {
      if (commands.has(path)) continue;
      const description = summary;
      const blank = { aliases: [], arguments: "", options: [] };
      commands.set(path, { path, description, ...blank });
    }
  }
  return [...commands.values()];
}

export function mergeCommandIndex(
  native: readonly IndexedCommand[],
  fromPlugins: readonly IndexedCommand[],
): CommandIndex {
  const paths = new Set(native.map((command) => command.path));
  const added = fromPlugins.filter((command) => !paths.has(command.path));
  const commands = [...native, ...added];
  return { commands, paths: new Set(commands.map(({ path }) => path)) };
}

export function createCommandIndexLoader(options: {
  runCli: CliRunner;
  pluginCommands: () => Promise<readonly IndexedCommand[]>;
  now?: () => number;
}): () => Promise<CommandIndex> {
  const { runCli, pluginCommands, now = Date.now } = options;
  let cached: { index: CommandIndex; expiresAt: number } | null = null;
  let loading: Promise<CommandIndex> | null = null;

  return async () => {
    if (cached !== null && cached.expiresAt > now()) return cached.index;
    loading ??= (async () => {
      try {
        const result = await runCli(["guide", "commands"], {
          stdin: null,
          timeoutMs: COMMAND_INDEX_TIMEOUT_MS,
          signal: new AbortController().signal,
        });
        if (result.exitCode !== 0) throw new CommandIndexUnavailableError();
        const native = parseCommandReference(result.stdout);
        const index = mergeCommandIndex(native, await pluginCommands());
        cached = { index, expiresAt: now() + COMMAND_INDEX_TTL_MS };
        return index;
      } finally {
        loading = null;
      }
    })();
    return loading;
  };
}

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((term) => term.length > 1);
}

function scoreCommand(
  command: IndexedCommand,
  terms: readonly string[],
): number {
  const path = command.path.toLowerCase();
  const pathWords = new Set(path.split(/[\s-]+/u));
  const aliases = command.aliases.join(" ").toLowerCase();
  const description = command.description.toLowerCase();
  const options = command.options.join(" ").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (pathWords.has(term)) score += 6;
    else if (path.includes(term)) score += 4;
    if (aliases.includes(term)) score += 3;
    if (description.includes(term)) score += 2;
    if (options.includes(term)) score += 1;
  }
  return score;
}

export function searchCommands(
  index: CommandIndex,
  query: string,
  limit: number,
): CommandSearchMatch[] {
  const terms = queryTerms(query);
  const ranked = index.commands
    .map((command) => ({ command, score: scoreCommand(command, terms) }))
    .filter((entry) => terms.length === 0 || entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.command.path.localeCompare(right.command.path),
    )
    .slice(0, Math.max(1, Math.min(limit, SEARCH_MAX_LIMIT)));
  return ranked.map(({ command }) => ({
    usage: `bb ${command.path}${command.arguments ? ` ${command.arguments}` : ""}`,
    description: command.description,
    options: command.options,
    aliases: command.aliases,
    ...(command.json === undefined ? {} : { json: command.json }),
    readOnly: READ_ONLY_COMMAND_PATHS.has(command.path),
  }));
}
