import type { Call } from "./call.js";

export type Run = (call: Call) => Promise<void>;
export type FlagKind = "boolean" | "string" | "list" | "optional";

export interface FlagSpec {
  names: string[];
  kind: FlagKind;
  placeholder: string;
  help: string;
}

export interface CommandSpec {
  path: string;
  aliases: string[];
  args: string;
  summary: string;
  flags: FlagSpec[];
  examples: string[];
  json: string;
  run: Run;
}

export interface Table {
  commands: CommandSpec[];
  groups: Record<string, string>;
  aliases: Record<string, string>;
}

export interface Invocation {
  args: Record<string, string>;
  rest: string[];
  flags: Map<string, string[]>;
}

export type Resolution =
  | { kind: "command"; spec: CommandSpec; argv: string[] }
  | { kind: "group"; group: string; unknown: string | null }
  | { kind: "other"; name: string | null; argv: string[] };

interface ErrorDetail {
  code?: string;
  hint?: string | null;
  exitCode?: number;
}

export class CliError extends Error {
  readonly code: string;
  readonly hint: string | null;
  readonly exitCode: number;

  constructor(message: string, detail: ErrorDetail = {}) {
    super(message);
    this.code = detail.code ?? "error";
    this.hint = detail.hint ?? null;
    this.exitCode = detail.exitCode ?? 1;
  }
}

export function usageError(message: string, hint?: string): CliError {
  return new CliError(message, { code: "invalid_value", hint });
}

const MAX_PATH_WORDS = 3;
const COMMAND_LINE = /^(\S.*?)\s{2,}(.+)$/u;
const FLAG_LINE = /^ {2}--(\S+)(?: (<[^>]+>(\.\.\.)?|\[[^\]]+\]))?\s{2,}(.+)$/u;
const GLOBAL_FLAGS = `
  --json  Print machine-readable JSON
  --help  Show this help`;
const JSON_FAILURE =
  'With --json a failure prints {"ok": false, "error": {code, message, ' +
  "hint?}} on stdout, the readable message on stderr, and exits non-zero.";

function camelCase(path: string): string {
  return path.replace(/[ -](\w)/gu, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

function parseFlag(line: string): FlagSpec {
  const [, names, value, repeat, help] = FLAG_LINE.exec(line) ?? [];
  if (names === undefined || help === undefined) {
    throw new Error(`Malformed flag line '${line.trim()}'`);
  }
  const kind: FlagKind =
    value === undefined
      ? "boolean"
      : repeat !== undefined
        ? "list"
        : value.startsWith("[")
          ? "optional"
          : "string";
  const placeholder = (value ?? "").replace("...", "");
  return { names: names.split("|"), kind, placeholder, help };
}

function parseCommand(block: string, handlers: Record<string, Run>) {
  const lines = block.replace(/\n {4,}/gu, " ").split("\n");
  const [, usage = "", summary = ""] = COMMAND_LINE.exec(lines[0] ?? "") ?? [];
  const words = usage.split(" ");
  const argsAt = words.findIndex((word) => /^[<[]/u.test(word));
  const args = argsAt < 0 ? [] : words.splice(argsAt);
  const [leaf = "", ...aliases] = (words.pop() ?? "").split("|");
  const path = [...words, leaf].join(" ");
  const run = handlers[camelCase(path)];
  if (run === undefined) throw new Error(`'bb ${path}' has no handler`);
  const marked = (mark: string): string[] =>
    lines.flatMap((line) => (line.startsWith(mark) ? [line.slice(4)] : []));
  const spec: CommandSpec = {
    path,
    aliases,
    args: args.join(" "),
    summary,
    flags: lines.filter((line) => line.startsWith("  --")).map(parseFlag),
    examples: marked("  $ "),
    json: marked("  > ").join(" "),
    run,
  };
  return spec;
}

export function parseCommands(
  text: string,
  handlers: Record<string, Run>,
): CommandSpec[] {
  const blocks = text.split(/\n(?=\S)/u).filter((block) => block.trim());
  return blocks.map((block) =>
    parseCommand(block.trimEnd() + GLOBAL_FLAGS, handlers),
  );
}

export function commandPaths(spec: CommandSpec): string[] {
  const words = spec.path.split(" ");
  const leaves = [words.pop() ?? "", ...spec.aliases];
  return leaves.map((leaf) => [...words, leaf].join(" "));
}

export function resolveCommand(table: Table, input: string[]): Resolution {
  const [first = "", ...others] = input;
  const alias = Object.hasOwn(table.aliases, first) ? table.aliases[first] : "";
  const argv = alias ? [...alias.split(" "), ...others] : input;
  const flagAt = argv.findIndex((token) => token.startsWith("-"));
  const words = flagAt < 0 ? argv : argv.slice(0, flagAt);
  const index = new Map(
    table.commands.flatMap((spec) =>
      commandPaths(spec).map((path) => [path, spec] as const),
    ),
  );
  for (let size = Math.min(words.length, MAX_PATH_WORDS); size > 0; size--) {
    const spec = index.get(words.slice(0, size).join(" "));
    if (spec !== undefined) {
      return { kind: "command", spec, argv: argv.slice(size) };
    }
  }
  for (let size = Math.min(words.length, MAX_PATH_WORDS); size > 0; size--) {
    const group = words.slice(0, size).join(" ");
    if (Object.hasOwn(table.groups, group)) {
      return { kind: "group", group, unknown: words[size] ?? null };
    }
  }
  return { kind: "other", name: words[0] ?? null, argv };
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) {
      const substitution = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(
        (previous[column] ?? 0) + 1,
        (current[column - 1] ?? 0) + 1,
        (previous[column - 1] ?? 0) + substitution,
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

function didYouMean(word: string, candidates: string[], prefix: string) {
  const scored = candidates
    .map((candidate) => ({
      candidate,
      distance: editDistance(word, candidate),
    }))
    .sort((left, right) => left.distance - right.distance);
  const best = scored[0];
  const tolerance = Math.max(2, Math.floor(word.length / 3));
  return best !== undefined && best.distance <= tolerance
    ? ` Did you mean '${prefix}${best.candidate}'?`
    : "";
}

export function usageLine(spec: CommandSpec): string {
  return ["bb", spec.path, spec.args, "[options]"].filter(Boolean).join(" ");
}

function failure(spec: CommandSpec, code: string, message: string): CliError {
  return new CliError(message, { code, hint: `Usage: ${usageLine(spec)}` });
}

export function parseInvocation(spec: CommandSpec, argv: string[]): Invocation {
  const names = spec.flags.flatMap((flag) => flag.names);
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] ?? "";
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--") && token !== "-h") {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const [name = ""] = token === "-h" ? ["help"] : token.slice(2).split("=");
    const flag = spec.flags.find((known) => known.names.includes(name));
    if (flag === undefined) {
      const close = didYouMean(name, names, "--");
      const message = `Unknown option --${name}.${close}`;
      const hint = `Run \`bb ${spec.path} --help\` for its options.`;
      throw new CliError(message, { code: "unknown_option", hint });
    }
    let value = equals < 0 ? undefined : token.slice(equals + 1);
    const next = argv[index + 1];
    const needsValue = flag.kind === "string" || flag.kind === "list";
    const optional =
      flag.kind === "optional" && next?.startsWith("-") === false;
    if (value === undefined && next !== undefined && (needsValue || optional)) {
      value = next;
      index++;
    }
    const missing = value === undefined && needsValue;
    if (missing || (value !== undefined && flag.kind === "boolean")) {
      const problem = missing
        ? `needs a value ${flag.placeholder}`
        : "does not take a value";
      throw failure(spec, "invalid_value", `Option --${name} ${problem}.`);
    }
    const key = flag.names[0] ?? "";
    const values = value === undefined ? [] : [value];
    flags.set(key, [...(flags.get(key) ?? []), ...values]);
  }
  const invocation: Invocation = { args: {}, rest: [], flags };
  if (flags.has("help")) return invocation;
  const expected = spec.args.split(" ").filter(Boolean);
  for (const [index, token] of expected.entries()) {
    const name = token.replace(/[<>[\].]/gu, "");
    const value = positionals[index];
    if (token.includes("...")) invocation.rest = positionals.slice(index);
    else if (value !== undefined) invocation.args[name] = value;
    else if (token.startsWith("<")) {
      throw failure(spec, "missing_required", `Missing ${token}.`);
    }
  }
  const extra = positionals[expected.length];
  if (extra !== undefined && !spec.args.includes("...")) {
    const message = `Unexpected argument '${extra}'.`;
    throw failure(spec, "unexpected_argument", message);
  }
  return invocation;
}

function columns(rows: [string, string][]): string[] {
  const width = Math.max(0, ...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`);
}

function flagRows(spec: CommandSpec, own: boolean): string[] {
  const shown = own ? spec.flags.slice(0, -2) : spec.flags;
  return columns(
    shown.map((flag) => {
      const [name, ...aliases] = flag.names;
      const repeat = flag.kind === "list" ? " (repeatable)" : "";
      const also = aliases.map((alias) => ` (alias --${alias})`).join("");
      const label = `--${name} ${flag.placeholder}`.trimEnd();
      return [label, `${flag.help}${repeat}${also}`];
    }),
  );
}

export function commandHelp(spec: CommandSpec): string {
  const examples = spec.examples.map((example) => `  ${example}`);
  const sections = [
    `Usage: ${usageLine(spec)}`,
    spec.summary,
    spec.aliases.length === 0 ? "" : `Aliases: ${spec.aliases.join(", ")}`,
    ["Options:", ...flagRows(spec, false)].join("\n"),
    examples.length === 0 ? "" : ["Examples:", ...examples].join("\n"),
    spec.json === "" ? "" : `JSON (--json): ${spec.json}`,
    JSON_FAILURE,
  ];
  return sections.filter(Boolean).join("\n\n");
}

function commandsUnder(table: Table, group: string): CommandSpec[] {
  const prefix = `${group} `;
  return table.commands.filter((spec) => spec.path.startsWith(prefix));
}

export function groupHelp(table: Table, group: string): string {
  const rows = commandsUnder(table, group).map((spec): [string, string] => [
    spec.path.slice(group.length + 1),
    spec.summary,
  ]);
  return [
    `Usage: bb ${group} <command> [options]`,
    table.groups[group] ?? "",
    ["Commands:", ...columns(rows)].join("\n"),
    `Run \`bb ${group} <command> --help\` for arguments and flags.`,
  ].join("\n\n");
}

export function rootHelp(table: Table): string {
  const rows = new Map<string, string>();
  for (const spec of table.commands) {
    const [word = ""] = spec.path.split(" ");
    if (!rows.has(word)) rows.set(word, table.groups[word] ?? spec.summary);
  }
  return [
    "Usage: bb <command> [options]",
    ["Commands:", ...columns([...rows])].join("\n"),
    "Run `bb <command> --help` for details and `bb guide` for concepts. " +
      "Enabled plugins add commands such as `bb tasks`; `bb plugin list` " +
      "shows them.",
    JSON_FAILURE,
  ].join("\n\n");
}

export function unknownCommand(
  table: Table,
  found: Exclude<Resolution, { kind: "command" }>,
): CliError {
  const code = "unknown_command";
  if (found.kind === "group" && found.unknown !== null) {
    const leaves = commandsUnder(table, found.group).flatMap((spec) =>
      commandPaths(spec).map((path) => path.slice(found.group.length + 1)),
    );
    const close = didYouMean(found.unknown, leaves, "");
    const message = `Unknown command 'bb ${found.group} ${found.unknown}'.`;
    const hint = `Run \`bb ${found.group} --help\` for its commands.`;
    return new CliError(`${message}${close}`, { code, hint });
  }
  const name = found.kind === "other" ? (found.name ?? "") : found.group;
  const words = table.commands.map((spec) => spec.path.split(" ")[0] ?? "");
  const known = [...new Set([...words, ...Object.keys(table.aliases)])];
  const close = didYouMean(name, known, "bb ");
  const hint = "Run `bb --help` for commands and `bb plugin list` for plugins.";
  return new CliError(`Unknown command 'bb ${name}'.${close}`, { code, hint });
}

export function commandReference(table: Table, group?: string): string {
  const selected = table.commands.filter(
    (spec) =>
      group === undefined ||
      spec.path === group ||
      spec.path.startsWith(`${group} `),
  );
  const entries = selected.map((spec) => {
    const also = spec.aliases.join(", ");
    const aliases = also === "" ? "" : ` (aliases: ${also})`;
    const shape = spec.json === "" ? [] : [`  JSON: ${spec.json}`];
    const head = `${usageLine(spec)}\n  ${spec.summary}${aliases}`;
    return [head, ...flagRows(spec, true), ...shape].join("\n");
  });
  const footer = `Every command takes --json. ${JSON_FAILURE}`;
  return [...entries, footer].join("\n\n");
}
