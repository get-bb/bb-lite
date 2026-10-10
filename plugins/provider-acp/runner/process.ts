import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI_PROBE_TIMEOUT_MS = 5_000;

export function isPathWithinDirectory(
  directoryPath: string,
  candidatePath: string,
): boolean {
  const relativePath = relative(directoryPath, candidatePath);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

export async function resolveExecutablePath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (isAbsolute(command)) {
    return access(command, fsConstants.X_OK).then(
      () => command,
      () => null,
    );
  }
  const lookup = process.platform === "win32" ? "where" : "which";
  const options = { timeout: CLI_PROBE_TIMEOUT_MS, env };
  try {
    const { stdout } = await execFileAsync(lookup, [command], options);
    return stdout.split(/\r?\n/u).find((line) => line.trim() !== "") ?? null;
  } catch {
    return null;
  }
}

function versionFrom(value: string | null): string | null {
  return value?.match(/\bv?(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/u)?.[1] ?? null;
}

export async function readCliVersion(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(command, ["--version"], {
      timeout: CLI_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env,
    });
    return versionFrom(`${stdout}\n${stderr}`);
  } catch {
    return null;
  }
}

export interface ExecFileOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  timeout?: number;
}

export async function execPortableFile(
  command: string,
  args: string[],
  options: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(command, args, options);
  return { stdout, stderr };
}

export interface ProcessStopResult {
  treeTermination: "confirmed" | "unverified";
}

export interface ManagedProcess {
  child: ChildProcess;
  stop(options?: { gracePeriodMs: number }): Promise<ProcessStopResult>;
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

export function spawnManagedProcess(request: {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): ManagedProcess {
  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: request.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let stopping: Promise<ProcessStopResult> | undefined;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const stop: ManagedProcess["stop"] = (
    { gracePeriodMs } = { gracePeriodMs: 1_000 },
  ) => {
    stopping ??= new Promise<ProcessStopResult>((resolve) => {
      const done = () => resolve({ treeTermination: "confirmed" });
      if (child.pid === undefined || exited()) {
        signalTree(child, "SIGKILL");
        return done();
      }
      child.once("exit", () => {
        clearTimeout(timer);
        signalTree(child, "SIGKILL");
        done();
      });
      const timer = setTimeout(
        () => signalTree(child, "SIGKILL"),
        gracePeriodMs,
      );
      timer.unref();
      signalTree(child, "SIGTERM");
    });
    return stopping;
  };
  return { child, stop };
}

export function isClosedProcessStdinError(error: Error): boolean {
  return (
    "code" in error &&
    (error.code === "EPIPE" ||
      error.code === "EOF" ||
      error.code === "ERR_STREAM_DESTROYED")
  );
}

export function agentProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env };
  delete child.ELECTRON_RUN_AS_NODE;
  return child;
}
