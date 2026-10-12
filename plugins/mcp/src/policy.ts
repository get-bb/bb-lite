export type McpToolMode = "read" | "write";

export const MAX_CLI_ARGUMENTS = 64;
export const MAX_CLI_ARGUMENT_CHARS = 200_000;

export const NATIVE_READ_ONLY_COMMAND_PATHS: readonly string[] = [
  "status",
  "guide",
  "whoami",
  "thread list",
  "thread show",
  "thread log",
  "thread output",
  "thread history",
  "thread search",
  "thread commands",
  "thread wait",
  "thread queue list",
  "thread section list",
  "thread interactions list",
  "thread interactions show",
  "prompt-history list",
  "project list",
  "project show",
  "project history",
  "env list",
  "env show",
  "env status",
  "env branches",
  "env paths",
  "env diff",
  "env diff-files",
  "env diff-file",
  "env diff-patch",
  "env pull-request show",
  "env providers",
  "machine list",
  "machine show",
  "machine env list",
  "user list",
  "provider list",
  "provider models",
  "terminal list",
  "terminal output",
  "terminal wait",
  "file read",
  "file list",
  "file paths",
  "settings show",
  "settings get",
  "plugin list",
  "server status",
];

export const PLUGIN_READ_ONLY_COMMAND_PATHS: readonly string[] = [
  "account status",
  "ai status",
  "ai usage",
  "docs vaults",
  "docs list",
  "docs read",
  "docs status",
  "github repos",
  "github issues",
  "github prs",
  "marketplace list",
  "marketplace search",
  "marketplace plugins",
  "marketplace updates",
  "mcp status",
  "mcp clients",
  "provider-usage show",
  "push-notifications list",
  "push-notifications status",
  "skill list",
  "skill show",
  "skill search",
];

export const READ_ONLY_COMMAND_PATHS: ReadonlySet<string> = new Set([
  ...NATIVE_READ_ONLY_COMMAND_PATHS,
  ...PLUGIN_READ_ONLY_COMMAND_PATHS,
]);

const UNAVAILABLE_COMMAND_PREFIXES: readonly (readonly string[])[] = [
  ["runner", "run"],
  ["dev", "watch"],
];

function runsTheServer(words: readonly string[]): boolean {
  return words[0] === "server" && words[1] !== "status";
}

export type CliAccessDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

function deny(reason: string): CliAccessDecision {
  return { allowed: false, reason };
}

function leadingWords(argv: readonly string[]): string[] {
  const words: string[] = [];
  for (const argument of argv) {
    if (argument.startsWith("-")) break;
    words.push(argument);
  }
  return words;
}

function longestKnownPath(
  words: readonly string[],
  knownPaths: ReadonlySet<string>,
): string | null {
  for (let length = words.length; length > 0; length -= 1) {
    const candidate = words.slice(0, length).join(" ");
    if (knownPaths.has(candidate)) return candidate;
  }
  return null;
}

function startsWithWords(
  words: readonly string[],
  prefix: readonly string[],
): boolean {
  return prefix.every((word, index) => words[index] === word);
}

function isHelpRequest(
  argv: readonly string[],
  knownPaths: ReadonlySet<string>,
): boolean {
  const last = argv.at(-1);
  if (last !== "--help" && last !== "-h") return false;
  const words = argv.slice(0, -1);
  if (words.length === 0) return true;
  const path = words.join(" ");
  if (knownPaths.has(path)) return true;
  for (const known of knownPaths) {
    if (known.startsWith(`${path} `)) return true;
  }
  return false;
}

export function evaluateCliAccess(
  argv: readonly string[],
  mode: McpToolMode,
  knownPaths: ReadonlySet<string>,
): CliAccessDecision {
  if (argv.length === 0) return deny("Pass at least one argument.");
  if (argv.length > MAX_CLI_ARGUMENTS) {
    return deny(`Pass at most ${MAX_CLI_ARGUMENTS} arguments.`);
  }
  let totalChars = 0;
  for (const argument of argv) {
    if (argument.includes("\0")) {
      return deny("Arguments must not contain NUL bytes.");
    }
    totalChars += argument.length;
  }
  if (totalChars > MAX_CLI_ARGUMENT_CHARS) {
    return deny("The arguments are too long; pass long text through stdin.");
  }

  const words = leadingWords(argv);
  if (runsTheServer(words) && !argv.includes("--help")) {
    return deny(
      "`bb server` cannot run over MCP: it starts another bb server and never exits.",
    );
  }
  for (const prefix of UNAVAILABLE_COMMAND_PREFIXES) {
    if (startsWithWords(words, prefix)) {
      return deny(
        `\`bb ${prefix.join(" ")}\` cannot run over MCP: it never exits. Run it in a terminal on the machine.`,
      );
    }
  }

  if (mode === "write") return { allowed: true };

  if (argv.length === 1 && argv[0] === "--version") return { allowed: true };
  if (isHelpRequest(argv, knownPaths)) return { allowed: true };
  const path = longestKnownPath(words, knownPaths);
  if (path !== null && READ_ONLY_COMMAND_PATHS.has(path)) {
    return { allowed: true };
  }
  const shown = path ?? words.slice(0, 3).join(" ");
  return deny(
    `\`bb ${shown}\` is not on the read-only list. The \`read\` tool accepts only the canonical command names that inspect bb (no aliases). Use the \`run\` tool for anything else.`,
  );
}
