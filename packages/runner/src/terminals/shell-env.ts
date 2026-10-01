import { execFile } from "node:child_process";
import path from "node:path";

export type ChildEnv = () => Promise<NodeJS.ProcessEnv>;

const PROBE_TIMEOUT_MS = 3_000;
const REFRESH_AFTER_MS = 60_000;
const START_MARKER = "__BB_SHELL_ENV_START__";
const END_MARKER = "__BB_SHELL_ENV_END__";
const PROBE_SCRIPT = `printf '%s\\n' ${START_MARKER}; env; printf '%s\\n' ${END_MARKER}`;

export function scrubbedProcessEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || key === "NODE_ENV" || key.startsWith("BB_")) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

function parseProbedPath(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === START_MARKER);
  const end = lines.findIndex(
    (line, index) => index > start && line.trim() === END_MARKER,
  );
  if (start === -1 || end === -1) {
    return null;
  }
  const entry = lines
    .slice(start + 1, end)
    .find((line) => line.startsWith("PATH="));
  const value = entry?.slice("PATH=".length).trim();
  return value ? value : null;
}

function probeShellPath(shell: string, flags: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      shell,
      [flags, PROBE_SCRIPT],
      {
        encoding: "utf8",
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
        timeout: PROBE_TIMEOUT_MS,
      },
      (error, stdout) => resolve(error ? null : parseProbedPath(stdout)),
    );
  });
}

export async function resolveLoginShellPath(): Promise<string | null> {
  const shell =
    process.env.SHELL ||
    (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  const name = path.basename(shell);
  const flagSets = name === "sh" || name === "dash" ? ["-lc"] : ["-ilc", "-lc"];
  for (const flags of flagSets) {
    const value = await probeShellPath(shell, flags);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

export function createLoginShellChildEnv(): ChildEnv {
  let loginPath: string | null = null;
  let resolvedAt = 0;
  let pending: Promise<void> | null = null;
  const refresh = (): Promise<void> => {
    pending ??= resolveLoginShellPath()
      .then((value) => {
        loginPath = value ?? loginPath;
        resolvedAt = Date.now();
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  return async () => {
    if (resolvedAt === 0) {
      await refresh();
    } else if (Date.now() - resolvedAt > REFRESH_AFTER_MS) {
      void refresh();
    }
    const env = scrubbedProcessEnv();
    if (loginPath !== null) {
      env.PATH = loginPath;
    }
    return env;
  };
}
