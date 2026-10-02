import { execFile, type ExecFileException } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { isValidGitBranchName } from "@bb/domain";
import type { ChildEnv } from "../sessions/agent-env.js";
import { RunnerError, type RunnerErrorCode } from "../types.js";
import type { WorkspaceApi, WorkspaceEventSink } from "../workspace-types.js";

const GIT_MAX_BYTES = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;
const FS_ERROR_CODES: Record<string, RunnerErrorCode> = {
  ENOENT: "path_not_found",
  EACCES: "permission_denied",
  EPERM: "permission_denied",
  ENOTDIR: "invalid_path",
  EISDIR: "invalid_path",
  ELOOP: "invalid_path",
  ENOTEMPTY: "invalid_path",
  EEXIST: "conflict",
};

export interface Ctx {
  dataDir: string;
  sink: WorkspaceEventSink;
  env: ChildEnv;
  lock<T>(key: string, work: () => Promise<T>): Promise<T>;
}

export type Method<K extends keyof WorkspaceApi> = (
  ctx: Ctx,
  ...args: Parameters<WorkspaceApi[K]>
) => ReturnType<WorkspaceApi[K]>;

export interface GitOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  maxBytes?: number;
  allowTruncated?: boolean;
}

interface GitOutput<T> {
  stdout: T;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

export type GitResult = GitOutput<string>;

export interface Repo {
  cwd: string;
  git(...args: string[]): Promise<GitResult>;
  attempt(...args: string[]): Promise<GitResult>;
  line(...args: string[]): Promise<string | null>;
  buffer(...args: string[]): Promise<Buffer>;
  with(options: GitOptions): Repo;
}

export function fail(
  code: RunnerErrorCode,
  message: string,
  retryable = false,
): never {
  throw new RunnerError(code, message, retryable);
}

export function errorCode(error: unknown): string | undefined {
  const code = error instanceof Error && "code" in error ? error.code : null;
  return typeof code === "string" ? code : undefined;
}

export function unlessCode<T>(code: string, fallback: T) {
  return (error: unknown): T => {
    if (errorCode(error) === code) return fallback;
    throw error;
  };
}

export function toRunnerError(error: unknown): RunnerError {
  if (error instanceof RunnerError) return error;
  const code = FS_ERROR_CODES[errorCode(error) ?? ""] ?? "failed";
  const message = error instanceof Error ? error.message : String(error);
  return new RunnerError(code, message);
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  const outside = relative === ".." || relative.startsWith(`..${path.sep}`);
  return !outside && !path.isAbsolute(relative);
}

export function requireAbsolute(value: string, label = "Path"): string {
  if (!path.isAbsolute(value) || value.includes("\0")) {
    fail("invalid_path", `${label} must be an absolute path`);
  }
  return value;
}

export function requireSafeRef(ref: string): string {
  const safe = /^[A-Za-z0-9_./~^@-]+$/u.test(ref) && !ref.includes("..");
  return safe && !ref.startsWith("-")
    ? ref
    : fail("invalid_path", `Invalid git ref: ${ref}`);
}

export function requireBranchName(name: string): string {
  return isValidGitBranchName(name)
    ? name
    : fail("invalid_path", `Invalid git branch name: ${name}`);
}

export function pathExists(target: string, mode?: number): Promise<boolean> {
  return fs.access(target, mode).then(
    () => true,
    () => false,
  );
}

export function createKeyedLock(): Ctx["lock"] {
  const tails = new Map<string, Promise<void>>();
  return (key, work) => {
    const run = (tails.get(key) ?? Promise.resolve()).then(work);
    const settled = () => undefined;
    const tail = run.then(settled, settled);
    tails.set(key, tail);
    void tail.then(() => tails.get(key) === tail && tails.delete(key));
    return run;
  };
}

async function gitFailure(
  error: ExecFileException,
  cwd: string,
  args: string[],
  stderr: string,
): Promise<RunnerError> {
  const command = `git ${args.join(" ")}`;
  if (error.code === "ENOENT" || error.code === "ENOTDIR") {
    const directory = await fs.stat(cwd).catch(() => null);
    return directory?.isDirectory()
      ? new RunnerError("missing_executable", "git is not installed")
      : new RunnerError("path_not_found", `Not a directory: ${cwd}`);
  }
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new RunnerError("file_too_large", `${command} output is too large`);
  }
  if (error.killed === true && typeof error.code !== "number") {
    return new RunnerError("failed", `${command} timed out`, true);
  }
  return /not a git repository/iu.test(stderr)
    ? new RunnerError("not_git_repo", `Path is not a git repository: ${cwd}`)
    : new RunnerError("failed", `${command} failed: ${stderr.trim()}`);
}

async function execGit(
  ctx: Ctx,
  cwd: string,
  args: string[],
  options: GitOptions,
  allowFailure: boolean,
): Promise<GitOutput<Buffer>> {
  const env = { ...(await ctx.env()), GIT_OPTIONAL_LOCKS: "0", ...options.env };
  const execOptions = {
    cwd,
    encoding: "buffer",
    env,
    maxBuffer: options.maxBytes ?? GIT_MAX_BYTES,
    timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
  } as const;
  return new Promise((resolve, reject) => {
    execFile("git", args, execOptions, (error, stdout, stderrBytes) => {
      const stderr = stderrBytes.toString("utf8");
      const truncated =
        error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" &&
        options.allowTruncated === true;
      if (error === null || truncated) {
        resolve({ stdout, stderr, exitCode: 0, truncated });
      } else if (allowFailure && typeof error.code === "number") {
        resolve({ stdout, stderr, exitCode: error.code, truncated });
      } else {
        void gitFailure(error, cwd, args, stderr).then(reject);
      }
    });
  });
}

export function openRepo(
  ctx: Ctx,
  cwd: string,
  options: GitOptions = {},
): Repo {
  const text = async (args: string[], allowFailure: boolean) => {
    const output = await execGit(ctx, cwd, args, options, allowFailure);
    return { ...output, stdout: output.stdout.toString("utf8") };
  };
  return {
    cwd,
    git: (...args) => text(args, false),
    attempt: (...args) => text(args, true),
    line: async (...args) => {
      const { exitCode, stdout } = await text(args, true);
      return (exitCode === 0 && stdout.trim()) || null;
    },
    buffer: async (...args) =>
      (await execGit(ctx, cwd, args, options, false)).stdout,
    with: (extra) => openRepo(ctx, cwd, { ...options, ...extra }),
  };
}
