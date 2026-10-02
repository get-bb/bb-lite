import { readFile } from "node:fs/promises";
import {
  Call,
  errorMessage,
  loadModules,
  readEnv,
  type CliEnv,
} from "./call.js";
import {
  CliError,
  commandHelp,
  groupHelp,
  parseInvocation,
  resolveCommand,
  rootHelp,
  unknownCommand,
} from "./engine.js";
import { packageJsonPath } from "./paths.js";
import { findPluginCommand, runPluginCommand } from "./plugin-proxy.js";
import { table } from "./table.js";

interface Failure {
  code: string;
  message: string;
  hint: string | null;
  exitCode: number;
}

const SERVERLESS_COMMANDS = ["guide", "server", "runner join", "runner run"];
const CONNECTION_FAILURES = ["Cannot connect to BB server", "fetch failed"];
const ROOT_HELP_FLAGS = [undefined, "--help", "-h"];

function wantsJson(argv: string[]): boolean {
  const end = argv.indexOf("--");
  const scanned = end < 0 ? argv : argv.slice(0, end);
  return scanned.some(
    (token, at) =>
      token === "--json" ||
      token === "--format=json" ||
      (token === "--format" && scanned[at + 1] === "json"),
  );
}

function describeFailure(error: unknown, env: CliEnv): Failure {
  if (error instanceof CliError) {
    const { code, message, hint, exitCode } = error;
    return { code, message, hint, exitCode };
  }
  const message = errorMessage(error);
  if (error instanceof Error && "status" in error && "code" in error) {
    const { code, status } = error;
    const known = typeof code === "string" ? code : `http_${String(status)}`;
    return { code: known, message, hint: null, exitCode: 1 };
  }
  if (CONNECTION_FAILURES.some((text) => message.includes(text))) {
    return {
      code: "server_unreachable",
      message: `Cannot reach the bb server at ${env.serverUrl}.`,
      hint: "Start it with `bb server`, or point BB_SERVER_URL at it.",
      exitCode: 1,
    };
  }
  return { code: "error", message, hint: null, exitCode: 1 };
}

function report(failure: Failure, envelope: boolean): number {
  console.error(`Error: ${failure.message}`);
  if (failure.hint !== null) console.error(failure.hint);
  if (envelope) {
    const { code, message, hint } = failure;
    const error = { code, message, ...(hint === null ? {} : { hint }) };
    console.log(JSON.stringify({ ok: false, error }, null, 2));
  }
  return failure.exitCode;
}

async function version(): Promise<string> {
  const manifest: unknown = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const known =
    typeof manifest === "object" && manifest !== null && "version" in manifest;
  return known ? String(manifest.version) : "unknown";
}

async function dispatch(argv: string[], env: CliEnv): Promise<number> {
  const asksHelp = argv[0] === "help";
  const found = resolveCommand(table, asksHelp ? argv.slice(1) : argv);
  if (found.kind === "command") {
    const { spec } = found;
    const invocation = asksHelp ? null : parseInvocation(spec, found.argv);
    if (invocation === null || invocation.flags.has("help")) {
      console.log(commandHelp(spec));
      return 0;
    }
    const call = new Call(table, spec, invocation, env);
    try {
      if (!SERVERLESS_COMMANDS.includes(spec.path)) await loadModules();
      await spec.run(call);
    } catch (error) {
      const envelope = wantsJson(found.argv) && !call.wroteJson;
      return report(describeFailure(error, env), envelope);
    }
    return 0;
  }
  if (found.kind === "group" && found.unknown === null) {
    console.log(groupHelp(table, found.group));
    return 0;
  }
  if (found.kind === "group") throw unknownCommand(table, found);
  const [first, ...rest] = found.argv;
  if (first === "--version" || first === "-V") {
    console.log(await version());
    return 0;
  }
  if (found.name === null) {
    console.log(rootHelp(table));
    return ROOT_HELP_FLAGS.includes(first) ? 0 : 1;
  }
  const pluginId = await findPluginCommand(env, found.name);
  if (pluginId === null) throw unknownCommand(table, found);
  return runPluginCommand(env, pluginId, rest);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  try {
    const env = readEnv();
    process.exitCode = await dispatch(argv, env).catch((error: unknown) =>
      report(describeFailure(error, env), wantsJson(argv)),
    );
  } catch (error) {
    const failure = describeFailure(error, { serverUrl: "" });
    process.exitCode = report(failure, wantsJson(argv));
  }
}

await main();
