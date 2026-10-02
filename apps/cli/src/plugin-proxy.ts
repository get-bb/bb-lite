import { loadModules, readStdin, type CliEnv } from "./call.js";
import { usageError } from "./engine.js";

const STDIN_FLAG = /^--([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)-stdin$/u;
const STDIN_MAX_BYTES = 16 * 1024;

async function materializeStdinFlag(argv: string[]): Promise<string[]> {
  const end = argv.indexOf("--");
  const scanned = end < 0 ? argv : argv.slice(0, end);
  const found = scanned.filter((token) => STDIN_FLAG.test(token));
  const [flag] = found;
  if (flag === undefined) return argv;
  const valueFlag = flag.slice(0, -"-stdin".length);
  if (found.length > 1 || scanned.includes(valueFlag)) {
    throw usageError(`Choose only one of ${flag} and ${valueFlag}.`);
  }
  if (process.stdin.isTTY) throw usageError(`${flag} requires piped stdin.`);
  const input = await readStdin();
  const value = input.toString("utf8").replace(/\r?\n$/u, "");
  const oneLine = value !== "" && !/[\r\n]/u.test(value);
  if (!oneLine || input.byteLength > STDIN_MAX_BYTES) {
    throw usageError(
      `${flag} needs one non-empty stdin line of at most 16 KiB.`,
    );
  }
  const at = argv.indexOf(flag);
  return [...argv.slice(0, at), valueFlag, value, ...argv.slice(at + 1)];
}

export async function findPluginCommand(
  env: CliEnv,
  name: string,
): Promise<string | null> {
  const { sdk } = await loadModules();
  const { plugins } = sdk.createNodeBbSdk({ baseUrl: env.serverUrl });
  const { cliCommands } = await plugins.contributions();
  return cliCommands.find((command) => command.name === name)?.pluginId ?? null;
}

export async function runPluginCommand(
  env: CliEnv,
  pluginId: string,
  args: string[],
): Promise<number> {
  const argv = await materializeStdinFlag(args);
  const { threadId, projectId } = env;
  const url = `${env.serverUrl}/api/v1/plugins/${pluginId}/cli`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ argv, cwd: process.cwd(), threadId, projectId }),
  });
  const { pluginCliResponseSchema } = await import("@bb/server-contract");
  const body: unknown = JSON.parse((await response.text()).trim() || "null");
  const result = pluginCliResponseSchema.safeParse(body);
  if (!result.success) {
    const status = `HTTP ${response.status}`;
    throw new Error(`The plugin command endpoint answered ${status}`);
  }
  const line = (text: string): string =>
    text === "" || text.endsWith("\n") ? text : `${text}\n`;
  process.stdout.write(line(result.data.stdout));
  process.stderr.write(line(result.data.stderr));
  return result.data.exitCode;
}
