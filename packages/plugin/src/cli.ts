export interface CliContext {
  cwd?: string;
  threadId?: string;
  projectId?: string;
  hostId?: string;
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

export type CliDurationUnit = "ms" | "s" | "m" | "h" | "d";

export interface CliOption {
  type: "boolean" | "string" | "integer" | "enum" | "duration";
  description: string;
  values?: readonly string[];
  aliases?: readonly string[];
  placeholder?: string;
  required?: boolean;
  repeatable?: boolean;
  split?: string;
  min?: number;
  max?: number;
  units?: readonly CliDurationUnit[];
  default?: string | number;
}

export type CliConstraint =
  | { kind: "exactly-one"; options: readonly string[] }
  | { kind: "at-most-one"; options: readonly string[] }
  | { kind: "at-least-one"; options: readonly string[] }
  | { kind: "requires"; option: string; needs: readonly string[] };

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
  : O extends { type: "integer" | "duration" }
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
  passthrough: string[];
  help: string;
}

type ParsedOption = string | number | boolean | (string | number)[] | undefined;
interface ParsedInput {
  options: Record<string, ParsedOption>;
  positionals: Record<string, string | string[] | undefined>;
  passthrough: string[];
  help: string;
}

interface CommandShape<O, P, Input> {
  summary: string;
  description?: string;
  aliases?: readonly string[];
  options?: O;
  positionals?: P;
  constraints?: readonly CliConstraint[];
  passthrough?: boolean;
  unexpectedPositionalHint?: string;
  run(input: Input, context: CliContext): CliResult | Promise<CliResult>;
}
export type CliCommand = CommandShape<Options, Positionals, ParsedInput>;

export interface CliSpec {
  name: string;
  summary: string;
  description?: string;
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

function fail(message: string, hint?: string): never {
  throw new UsageError(message, { code: "usage", hint });
}

const UNIT_MS: Record<CliDurationUnit, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};
const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/u;

function within({ min, max }: CliOption, value: number): boolean {
  return (
    (min === undefined || value >= min) && (max === undefined || value <= max)
  );
}

function durationOf(option: CliOption, raw: string): number | null {
  const [, amount, unit] = DURATION.exec(raw.trim().toLowerCase()) ?? [];
  if (amount === undefined) return null;
  const candidates = unit === undefined ? (option.units ?? ["s"]) : [unit];
  const values = candidates.map((each) =>
    Math.round(Number(amount) * UNIT_MS[each as CliDurationUnit]),
  );
  return values.find((value) => within(option, value)) ?? null;
}

export function cliCommand<
  const O extends Options = Record<string, never>,
  const P extends Positionals = readonly [],
>(command: CommandShape<O, P, CliInput<O, P>>): CliCommand {
  return command;
}

function signature(name: string, option: CliOption): string {
  if (option.type === "boolean") return `--${name}`;
  const named = option.type === "duration" ? "duration" : "value";
  const fallback = option.values?.join("|") ?? named;
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
  const about =
    words.length === 0 && spec.description !== undefined
      ? ["", spec.description]
      : [];
  return [
    `${scope} — ${words.length === 0 ? spec.summary : "commands"}`,
    ...about,
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
  const wrong = (expected: string) =>
    fail(`invalid value '${raw}' for --${name}: expected ${expected}`);
  if (option.type === "duration") {
    return (
      durationOf(option, raw) ??
      wrong("a duration with a unit (1500ms, 90s, 5m, 2h) in range")
    );
  }
  if (option.type === "enum") {
    const values = option.values ?? [];
    return values.includes(raw) ? raw : wrong(values.join(", "));
  }
  if (option.type !== "integer") return raw;
  const { min, max } = option;
  const range =
    min === undefined && max === undefined
      ? "an integer"
      : `an integer from ${min ?? "any"} to ${max ?? "any"}`;
  const valid = /^-?\d+$/u.test(raw) && within(option, Number(raw));
  return valid ? Number(raw) : wrong(range);
}

function checkConstraints(
  command: CliCommand,
  given: ReadonlyMap<string, string[]>,
): void {
  const has = (name: string) => given.has(name);
  const flags = (names: readonly string[]) =>
    names.map((name) => `--${name}`).join(", ");
  for (const constraint of command.constraints ?? []) {
    if (constraint.kind === "requires") {
      const absent = constraint.needs.filter((need) => !has(need));
      if (has(constraint.option) && absent.length > 0) {
        fail(`--${constraint.option} requires ${flags(absent)}`);
      }
      continue;
    }
    const { kind, options } = constraint;
    const present = options.filter(has);
    if (present.length > 1 && kind !== "at-least-one") {
      const most = kind === "exactly-one" ? "exactly" : "at most";
      fail(
        `${flags(present).replaceAll(", ", " and ")} cannot be combined`,
        `Pass ${most} one of: ${flags(options)}`,
      );
    }
    if (present.length === 0 && kind !== "at-most-one") {
      fail(`missing required options: one of ${flags(options)}`);
    }
  }
}

function parseArguments(command: CliCommand, argv: readonly string[]) {
  const declared = Object.entries(command.options ?? {});
  const given = new Map<string, string[]>();
  const words: string[] = [];
  const passthrough: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") {
      const rest = argv.slice(index + 1);
      (command.passthrough ? passthrough : words).push(...rest);
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
    const split = option.repeatable ? option.split : undefined;
    const values =
      split === undefined
        ? [value]
        : value.split(split).flatMap((part) => part.trim() || []);
    given.set(name, [...(given.get(name) ?? []), ...values]);
  }
  checkConstraints(command, given);

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
  if (words.length > 0) {
    fail(`unexpected argument '${words[0]}'`, command.unexpectedPositionalHint);
  }
  if (missing.length > 0) fail(`missing ${missing.join(", ")}`);
  return { options, positionals, passthrough };
}

function failure(error: PluginCliError, json: boolean, hint: string) {
  const { code, message, exitCode } = error;
  const usageHint = [error.hint, hint].filter(Boolean).join("\n\n");
  const detail = error instanceof UsageError ? usageHint : error.hint;
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
