export interface CliContext {
  cwd?: string;
  threadId?: string;
  projectId?: string;
  signal: AbortSignal;
}

export interface CliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface CliRegistration {
  name: string;
  summary: string;
  commands?: { name: string; summary: string }[];
  run(argv: string[], context: CliContext): CliResult | Promise<CliResult>;
}

export interface CliOption {
  type: "boolean" | "string" | "integer" | "enum";
  description: string;
  values?: readonly string[];
  aliases?: readonly string[];
  placeholder?: string;
  required?: boolean;
  repeatable?: boolean;
  default?: string | number;
}

export interface CliPositional {
  name: string;
  description: string;
  required?: boolean;
  variadic?: boolean;
}

type Options = Record<string, CliOption>;
type Positionals = readonly CliPositional[];
type OptionValue<O> = O extends { values: readonly (infer Value)[] }
  ? Value
  : O extends { type: "integer" }
    ? number
    : string;
type ResolvedOption<O> = O extends { type: "boolean" }
  ? boolean
  : O extends { repeatable: true }
    ? OptionValue<O>[]
    : O extends { required: true } | { default: string | number }
      ? OptionValue<O>
      : OptionValue<O> | undefined;
type ResolvedPositional<P> = P extends { variadic: true }
  ? string[]
  : P extends { required: true }
    ? string
    : string | undefined;

export interface CliInput<O extends Options, P extends Positionals> {
  options: { [Name in keyof O]: ResolvedOption<O[Name]> };
  positionals: { [E in P[number] as E["name"]]: ResolvedPositional<E> };
  help: string;
}

type ParsedOption = string | number | boolean | (string | number)[] | undefined;
interface ParsedInput {
  options: Record<string, ParsedOption>;
  positionals: Record<string, string | string[] | undefined>;
  help: string;
}

interface CommandShape<O, P, Input> {
  summary: string;
  description?: string;
  aliases?: readonly string[];
  options?: O;
  positionals?: P;
  run(input: Input, context: CliContext): CliResult | Promise<CliResult>;
}
export type CliCommand = CommandShape<Options, Positionals, ParsedInput>;

export interface CliSpec {
  name: string;
  summary: string;
  root?: CliCommand;
  commands: Record<string, CliCommand>;
}

export class PluginCliError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly exitCode: number;

  constructor(
    message: string,
    options: { code?: string; hint?: string; exitCode?: number } = {},
  ) {
    super(message);
    this.name = "PluginCliError";
    this.code = options.code ?? "command_failed";
    this.hint = options.hint;
    this.exitCode = options.exitCode ?? 1;
  }
}

class UsageError extends PluginCliError {}

function fail(message: string): never {
  throw new UsageError(message, { code: "usage" });
}

export function cliCommand<
  const O extends Options = Record<string, never>,
  const P extends Positionals = readonly [],
>(command: CommandShape<O, P, CliInput<O, P>>): CliCommand {
  return command;
}

function signature(name: string, option: CliOption): string {
  if (option.type === "boolean") return `--${name}`;
  const fallback = option.values?.join("|") ?? "value";
  return `--${name} <${option.placeholder ?? fallback}>`;
}

function usage(scope: string, command: CliCommand): string {
  const positionals = (command.positionals ?? []).map((entry) => {
    const token = `<${entry.name}${entry.variadic ? "..." : ""}>`;
    return entry.required ? token : `[${token}]`;
  });
  const options = Object.entries(command.options ?? {}).map(([name, option]) =>
    option.required ? signature(name, option) : `[${signature(name, option)}]`,
  );
  return `Usage:\n  ${[scope, ...positionals, ...options].join(" ")}`;
}

function section(title: string, rows: string[][]): string[] {
  const width = Math.max(0, ...rows.map(([left = ""]) => left.length));
  const lines = rows.map(
    ([left = "", text]) => `  ${left.padEnd(width)}  ${text}`,
  );
  return rows.length === 0 ? [] : ["", title, ...lines];
}

function commandHelp(scope: string, command: CliCommand): string {
  const { summary, description, positionals = [], options = {} } = command;
  const args = positionals.map((entry) => [
    `<${entry.name}>`,
    entry.description,
  ]);
  const flags = Object.entries(options).map(([name, option]) => [
    signature(name, option),
    option.description,
  ]);
  const about = description === undefined ? [] : ["", description];
  const head = [`${scope} — ${summary}`, "", usage(scope, command), ...about];
  const body = [...section("Arguments:", args), ...section("Options:", flags)];
  return [...head, ...body, ""].join("\n");
}

function listHelp(spec: CliSpec, words: readonly string[]): string {
  const prefix = words.map((word) => `${word} `).join("");
  const scope = ["bb", spec.name, ...words].join(" ");
  const commands = Object.entries(spec.commands)
    .filter(([path]) => path.startsWith(prefix))
    .map(([path, command]) => [`bb ${spec.name} ${path}`, command.summary]);
  return [
    `${scope} — ${words.length === 0 ? spec.summary : "commands"}`,
    "",
    `Usage:\n  ${scope} <command> [options]`,
    ...section("Commands:", commands),
    "",
    `Run \`${scope} <command> --help\` for arguments and options.`,
    "",
  ].join("\n");
}

function resolveCommand(spec: CliSpec, words: readonly string[]) {
  let best: { path: string; command: CliCommand; length: number } | null = null;
  for (const [path, command] of Object.entries(spec.commands)) {
    for (const spelling of [path, ...(command.aliases ?? [])]) {
      const parts = spelling.split(" ");
      const matches = parts.every((part, index) => words[index] === part);
      if (matches && parts.length > (best?.length ?? 0)) {
        best = { path, command, length: parts.length };
      }
    }
  }
  return best;
}

function optionValue(name: string, option: CliOption, raw: string) {
  const values = option.type === "enum" ? (option.values ?? []) : [raw];
  const valid = option.type === "integer" ? /^-?\d+$/u.test(raw) : true;
  if (!valid || !values.includes(raw)) {
    const expected = option.type === "enum" ? values.join(", ") : "an integer";
    fail(`invalid value '${raw}' for --${name}: expected ${expected}`);
  }
  return option.type === "integer" ? Number(raw) : raw;
}

function parseArguments(command: CliCommand, argv: readonly string[]) {
  const declared = Object.entries(command.options ?? {});
  const given = new Map<string, string[]>();
  const words: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") {
      words.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      words.push(token);
      continue;
    }
    const [spelled = "", inline] = token.slice(2).split(/=(.*)/su);
    const [name, option] =
      declared.find(
        ([key, { aliases }]) => key === spelled || aliases?.includes(spelled),
      ) ?? fail(`unknown option '--${spelled}'`);
    const implied = option.type === "boolean" ? "true" : undefined;
    const value = inline ?? implied ?? argv[(index += 1)];
    if (value === undefined) fail(`--${name} requires a value`);
    given.set(name, [...(given.get(name) ?? []), value]);
  }

  const options: Record<string, ParsedOption> = {};
  const missing: string[] = [];
  for (const [name, option] of declared) {
    const raw = given.get(name) ?? [];
    if (option.type === "boolean") {
      options[name] = raw.length > 0 && raw.at(-1) !== "false";
      continue;
    }
    if (raw.length > 1 && !option.repeatable) {
      fail(`--${name} was given more than once`);
    }
    if (raw.length === 0 && option.required) missing.push(`--${name}`);
    const parsed = raw.map((value) => optionValue(name, option, value));
    options[name] = option.repeatable ? parsed : (parsed[0] ?? option.default);
  }

  const positionals: Record<string, string | string[] | undefined> = {};
  for (const { name, variadic, required } of command.positionals ?? []) {
    const taken = words.splice(0, variadic ? words.length : 1);
    positionals[name] = variadic ? taken : taken[0];
    if (required && taken.length === 0) missing.push(`<${name}>`);
  }
  if (words.length > 0) fail(`unexpected argument '${words[0]}'`);
  if (missing.length > 0) fail(`missing ${missing.join(", ")}`);
  return { options, positionals };
}

function failure(error: PluginCliError, json: boolean, hint: string) {
  const { code, message, exitCode } = error;
  const detail = error instanceof UsageError ? hint : error.hint;
  const stderr = `${[message, ...(detail === undefined ? [] : [detail])].join("\n\n")}\n`;
  if (!json) return { exitCode, stderr };
  const body = { ok: false, error: { code, message, hint: error.hint } };
  return { exitCode, stderr, stdout: `${JSON.stringify(body, null, 2)}\n` };
}

export function defineCli(spec: CliSpec): CliRegistration {
  const commands = Object.entries(spec.commands).map(([name, command]) => ({
    name,
    summary: command.summary,
  }));
  const { name, summary } = spec;
  return {
    name,
    summary,
    commands,
    async run(argv, context) {
      const terminator = argv.indexOf("--");
      const flags = terminator === -1 ? argv : argv.slice(0, terminator);
      const wantsHelp = flags.includes("--help") || flags.includes("-h");
      const firstFlag = argv.findIndex((token) => token.startsWith("-"));
      const words = firstFlag === -1 ? argv : argv.slice(0, firstFlag);
      const resolved = resolveCommand(spec, words);
      const command = resolved?.command ?? spec.root;
      const scope = ["bb", name, resolved?.path ?? []].flat().join(" ");
      let hint = `Run \`bb ${name} --help\` for the command list.`;
      try {
        const prefix = words.map((word) => `${word} `).join("");
        const isGroup = commands.some((entry) => entry.name.startsWith(prefix));
        if (resolved === null && wantsHelp && isGroup) {
          return { exitCode: 0, stdout: listHelp(spec, words) };
        }
        const stray = words.length > 0 && spec.root?.positionals === undefined;
        if (command === undefined || (resolved === null && stray)) {
          const typed = words.join(" ");
          fail(typed === "" ? "missing command" : `unknown command '${typed}'`);
        }
        const help = commandHelp(scope, command);
        if (wantsHelp) return { exitCode: 0, stdout: help };
        hint = usage(scope, command);
        const rest = argv.slice(resolved?.length ?? 0);
        return await command.run(
          { ...parseArguments(command, rest), help },
          context,
        );
      } catch (error) {
        if (!(error instanceof PluginCliError)) throw error;
        return failure(error, flags.includes("--json"), hint);
      }
    },
  };
}
