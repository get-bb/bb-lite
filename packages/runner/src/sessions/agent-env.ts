import { execFile } from "node:child_process";
import { basename, delimiter, dirname } from "node:path";
import { promisify } from "node:util";
import type { RunnerThreadEvent } from "../types.js";

type EnvResolved = Extract<
  RunnerThreadEvent,
  { type: "provider.env-resolved" }
>;
export type EnvEntry = EnvResolved["entries"][number];

export type ChildEnv = () => Promise<NodeJS.ProcessEnv>;

const START = "__BB_SHELL_ENV_START__";
const END = "__BB_SHELL_ENV_END__";
const PROBE = `printf '%s\\n' ${START}; env; printf '%s\\n' ${END}`;
const PROBE_TIMEOUT_MS = 3_000;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/i;

export function scrubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const scrubbed: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key === "NODE_ENV" || key.startsWith("BB_")) {
      continue;
    }
    scrubbed[key] = value;
  }
  return scrubbed;
}

export function parseShellPath(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/u).map((line) => line.trim());
  const start = lines.indexOf(START);
  const end = lines.indexOf(END, start + 1);
  if (start === -1 || end === -1) return null;
  const entry = lines.slice(start + 1, end).find((l) => l.startsWith("PATH="));
  return entry?.slice("PATH=".length) || null;
}

async function probeShell(shell: string, flag: string, env: NodeJS.ProcessEnv) {
  const options = { env, timeout: PROBE_TIMEOUT_MS };
  const run = promisify(execFile)(shell, [flag, PROBE], options);
  return run.then(({ stdout }) => parseShellPath(stdout)).catch(() => null);
}

async function resolveLoginShellPath() {
  if (process.platform === "win32") return null;
  const fallback = process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
  const shell = process.env.SHELL?.trim() || fallback;
  const plain = ["sh", "dash"].includes(basename(shell));
  for (const flag of plain ? ["-lc"] : ["-ilc", "-lc"]) {
    const path = await probeShell(shell, flag, scrubEnv(process.env));
    if (path !== null) return path;
  }
  return null;
}

let cachedLoginPath: Promise<string | null> | undefined;

export function loginShellPath(): Promise<string | null> {
  cachedLoginPath ??= resolveLoginShellPath();
  return cachedLoginPath;
}

export function loginShellEnv(extra: Record<string, string> = {}, bin = "") {
  return async () => {
    const env = scrubEnv(process.env);
    const inherited = (await loginShellPath()) ?? env.PATH ?? "";
    return { ...env, ...extra, PATH: bin ? `${bin}:${inherited}` : inherited };
  };
}

export function buildAgentEnv(args: {
  loginPath: string | null;
  bbCliPath: string;
  serverUrl: string;
  threadStorageDir: string;
  specEnv: Record<string, string>;
  baseEnv?: NodeJS.ProcessEnv;
}) {
  const base = scrubEnv(args.baseEnv ?? process.env);
  const inherited = args.loginPath ?? base.PATH;
  const bbDir = dirname(args.bbCliPath);
  const own: Record<string, string> = {
    PATH: inherited ? `${bbDir}${delimiter}${inherited}` : bbDir,
    BB_CLI: args.bbCliPath,
    BB_SERVER_URL: args.serverUrl,
    BB_THREAD_STORAGE: args.threadStorageDir,
  };
  const contributed = Object.entries(args.specEnv).filter(([name]) =>
    ENV_NAME.test(name),
  );
  const shown = (name: string) => name in own || name.startsWith("BB_");
  const agent = { ...own, ...Object.fromEntries(contributed) };
  const entries = Object.entries(agent).map(([name, value]): EnvEntry =>
    shown(name)
      ? { name, source: "shell", value }
      : {
          name,
          source: { core: "machine-environment" },
          value: { masked: true },
        },
  );
  return { agent, process: { ...base, PATH: own.PATH }, entries };
}
