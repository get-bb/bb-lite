import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { WorktreeResult } from "../workspace-types.js";
import {
  fail,
  isInside,
  openRepo,
  pathExists,
  requireAbsolute,
  requireBranchName,
  type Ctx,
  type Method,
  type Repo,
} from "./exec.js";
import * as git from "./git.js";

const WORKTREES_DIR = "worktrees";
const WORKSPACES_DIR = "workspaces";
const INCLUDE_FILE_NAME = ".worktreeinclude";
const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u;
const BASE_FETCH_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 2_000;
const KILL_ROUNDS = 5;

function requireSegment(value: string, label: string): string {
  return SAFE_SEGMENT.test(value)
    ? value
    : fail("invalid_path", `${label} must be a single safe path segment`);
}

function repoDirName(sourcePath: string): string {
  const name = path.basename(sourcePath).replace(/\.git$/u, "");
  if (SAFE_SEGMENT.test(name) && !name.endsWith(".") && name.length <= 200) {
    return name;
  }
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 16);
  return `repo-${hash}`;
}

function realOrResolved(target: string): Promise<string> {
  return fs.realpath(target).catch(() => path.resolve(target));
}

async function isStrictlyInside(
  root: string,
  target: string,
): Promise<boolean> {
  const [realRoot, realTarget] = await Promise.all([
    realOrResolved(root),
    realOrResolved(target),
  ]);
  return realRoot !== realTarget && isInside(realRoot, realTarget);
}

async function processCwds(): Promise<[pid: number, cwd: string][]> {
  if (process.platform === "linux") {
    const pids = (await fs.readdir("/proc")).map(Number).filter(Boolean);
    const cwds = await Promise.all(
      pids.map((pid) => fs.readlink(`/proc/${pid}/cwd`).catch(() => "")),
    );
    return pids.map((pid, index) => [pid, cwds[index] ?? ""]);
  }
  if (process.platform !== "darwin") {
    return [];
  }
  const listing = await new Promise<string>((resolve) => {
    const args = ["-a", "-d", "cwd", "-F", "pn", "-w", "-n"];
    const options = { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 } as const;
    execFile("lsof", args, options, (_error, stdout) => resolve(stdout));
  });
  return [...listing.matchAll(/^p(\d+)\n(?:f.*\n)?n(.*)$/gmu)].map((match) => [
    Number(match[1]),
    match[2] ?? "",
  ]);
}

function signalAll(pids: number[], signal: NodeJS.Signals | 0): number[] {
  return pids.filter((pid) => {
    try {
      return process.kill(pid, signal);
    } catch {
      return false;
    }
  });
}

async function killProcessesWithCwdUnder(directory: string): Promise<void> {
  const root = await realOrResolved(directory);
  const inside = async (): Promise<number[]> =>
    (await processCwds())
      .filter(([pid, cwd]) => pid !== process.pid && cwd && isInside(root, cwd))
      .map(([pid]) => pid);
  for (let round = 0; round < KILL_ROUNDS; round += 1) {
    const targets = await inside();
    if (targets.length === 0) {
      return;
    }
    signalAll(targets, "SIGTERM");
    const deadline = Date.now() + KILL_GRACE_MS;
    while (Date.now() < deadline && signalAll(targets, 0).length > 0) {
      await delay(50);
    }
    signalAll(await inside(), "SIGKILL");
    await delay(50);
  }
}

async function removeManagedPath(ctx: Ctx, target: string): Promise<void> {
  const parent = path.dirname(target);
  await fs.rm(`${target}.completed`, { force: true });
  if (await pathExists(target)) {
    await killProcessesWithCwdUnder(target);
    const relativeCommonDir = await openRepo(ctx, target).line(
      "rev-parse",
      "--git-common-dir",
    );
    if (relativeCommonDir !== null) {
      const commonDir = path.resolve(target, relativeCommonDir);
      const flags = ["worktree", "remove", target, "--force"];
      await ctx.lock(commonDir, () =>
        openRepo(ctx, parent).attempt("--git-dir", commonDir, ...flags),
      );
    }
    await fs.rm(target, { recursive: true, force: true });
  }
  await fs.rmdir(parent).catch(() => undefined);
}

export const removeWorktree: Method<"removeWorktree"> = async (ctx, args) => {
  const target = path.resolve(requireAbsolute(args.path));
  const managed = await Promise.all(
    [WORKTREES_DIR, WORKSPACES_DIR].map((name) =>
      isStrictlyInside(path.join(ctx.dataDir, name), target),
    ),
  );
  if (!managed.includes(true)) {
    fail("invalid_path", `Refusing to remove an unmanaged path: ${args.path}`);
  }
  await removeManagedPath(ctx, target);
};

export const ensurePersonalWorkspace: Method<
  "ensurePersonalWorkspace"
> = async (ctx, args) => {
  const key = requireSegment(args.key, "key");
  const target = path.join(ctx.dataDir, WORKSPACES_DIR, key);
  await fs.mkdir(target, { recursive: true });
  return { path: target };
};

async function copyIncludedFiles(
  source: Repo,
  targetPath: string,
): Promise<WorktreeResult["worktreeInclude"]> {
  const patterns = await fs
    .readFile(path.join(source.cwd, INCLUDE_FILE_NAME), "utf8")
    .catch(() => "");
  if (!/^\s*[^#\s]/mu.test(patterns)) {
    return null;
  }
  const exclude = `--exclude-from=${INCLUDE_FILE_NAME}`;
  const matches = await source
    .git("ls-files", "--others", "--ignored", exclude, "-z")
    .then((result) => git.splitNul(result.stdout))
    .catch(() => []);
  const realTarget = await fs.realpath(targetPath);
  const report = { copied: 0, skipped: 0 };
  for (const relativePath of matches) {
    const from = path.join(source.cwd, relativePath);
    const to = path.join(realTarget, relativePath);
    const copied = await (async () => {
      if ((await fs.lstat(from)).isSymbolicLink() || (await pathExists(to))) {
        return false;
      }
      await fs.mkdir(path.dirname(to), { recursive: true });
      if (!isInside(realTarget, await fs.realpath(path.dirname(to)))) {
        return false;
      }
      await fs.copyFile(from, to, constants.COPYFILE_EXCL);
      return true;
    })().catch(() => false);
    report[copied ? "copied" : "skipped"] += 1;
  }
  return report;
}

async function worktreeHoldingBranch(
  source: Repo,
  branchName: string,
): Promise<string | null> {
  const list = await source.git("worktree", "list", "--porcelain", "-z");
  const fields = git.splitNul(list.stdout);
  const branchIndex = fields.indexOf(`branch refs/heads/${branchName}`);
  const holder = fields
    .slice(0, Math.max(branchIndex, 0))
    .reverse()
    .find((field) => field.startsWith("worktree "));
  return holder?.slice("worktree ".length) ?? null;
}

async function fetchRemoteBase(
  source: Repo,
  baseBranch: string,
): Promise<void> {
  const remotes = (await source.git("remote")).stdout.split("\n");
  const remote = remotes
    .filter((name) => name && baseBranch.startsWith(`${name}/`))
    .sort((left, right) => right.length - left.length)[0];
  if (remote === undefined) {
    return;
  }
  const branch = baseBranch.slice(remote.length + 1);
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  const fetched = await source
    .with({
      env: { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      timeoutMs: BASE_FETCH_TIMEOUT_MS,
    })
    .git("fetch", "--quiet", remote, `+refs/heads/${branch}:${remoteRef}`)
    .then(
      () => null,
      (error: unknown) => error,
    );
  if (fetched !== null && !(await git.hasRef(source, remoteRef))) {
    throw fetched;
  }
}

export const createWorktree: Method<"createWorktree"> = async (ctx, args) => {
  const source = openRepo(ctx, requireAbsolute(args.sourcePath, "sourcePath"));
  const branchName = requireBranchName(args.branchName);
  const root = path.join(ctx.dataDir, WORKTREES_DIR);
  const key = requireSegment(args.key, "key");
  const target = path.join(root, key, repoDirName(source.cwd));
  const marker = `${target}.completed`;
  return ctx.lock(`worktree:${target}`, async () => {
    const completed = await fs.readFile(marker, "utf8").catch(() => "");
    const [completedBranch, completedBase] = completed.split("\n");
    const checkedOut =
      (await pathExists(target)) &&
      (await git.currentBranch(openRepo(ctx, target))) === branchName;
    if (checkedOut && completedBranch === branchName && completedBase) {
      const mergeBaseBranch = completedBase;
      return {
        path: target,
        branchName,
        mergeBaseBranch,
        worktreeInclude: null,
      };
    }
    await removeManagedPath(ctx, target);
    if ((await git.repoKind(source)) === "none") {
      fail(
        "not_git_repo",
        `Cannot create a worktree because the source is not a Git repository: ${source.cwd}. Initialize it and create at least one commit, then try again.`,
      );
    }
    if ((await git.revision(source, "HEAD")) === null) {
      fail(
        "failed",
        `Cannot create a worktree because the repository has no commits: ${source.cwd}. Create an initial commit, then try again.`,
      );
    }
    const baseBranch =
      args.baseBranch === null
        ? await git.defaultWorktreeBase(source)
        : requireBranchName(args.baseBranch);
    if (baseBranch === null) {
      fail("failed", `Cannot resolve default branch for ${source.cwd}`);
    }
    const holder = await worktreeHoldingBranch(source, branchName);
    if (holder !== null && (await isStrictlyInside(root, holder))) {
      if (await git.isDirty(openRepo(ctx, holder))) {
        fail(
          "conflict",
          `Branch ${branchName} is still checked out at ${holder} by an earlier attempt, and that worktree has uncommitted changes, so it was left alone. Remove it to retry.`,
        );
      }
      await removeManagedPath(ctx, holder);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const branchExists = await git.hasRef(source, `refs/heads/${branchName}`);
    if (!branchExists) {
      await fetchRemoteBase(source, baseBranch);
    }
    const { commonDir } = await git.gitDirs(source);
    const added = branchExists
      ? [target, branchName]
      : ["-B", branchName, target, baseBranch];
    try {
      await ctx.lock(commonDir, async () => {
        await source.git("worktree", "prune");
        await source.git("worktree", "add", ...added);
      });
      const worktreeInclude = await copyIncludedFiles(source, target);
      await fs.writeFile(marker, `${branchName}\n${baseBranch}\n`, "utf8");
      const mergeBaseBranch = baseBranch;
      return { path: target, branchName, mergeBaseBranch, worktreeInclude };
    } catch (error) {
      await removeManagedPath(ctx, target);
      throw error;
    }
  });
};

export const switchBranch: Method<"switchBranch"> = async (ctx, args) => {
  const repo = await git.requireRepo(ctx, args.path);
  const branchName = requireBranchName(args.branchName);
  const refuse = (reason: string): never =>
    fail("conflict", `Cannot checkout branch ${reason}`);
  return ctx.lock((await git.gitDirs(repo)).gitDir, async () => {
    const ref = await git.checkoutRef(repo);
    if (ref.kind === "detached") {
      return refuse("while the workspace is on a detached HEAD");
    }
    if (ref.kind === "unknown") {
      return refuse(`because the checkout is unreadable: ${ref.reason}`);
    }
    if (ref.branchName === branchName) {
      return { branchName };
    }
    if (ref.kind === "unborn") {
      return refuse("before the current branch has an initial commit");
    }
    const creating = args.createFrom !== null;
    if (!creating && !(await git.localBranches(repo)).includes(branchName)) {
      return refuse(`${branchName} because it does not exist`);
    }
    const operation = await git.gitOperation(repo);
    if (operation.kind !== "none") {
      const state = operation.hasConflicts
        ? "has unresolved conflicts"
        : "is in progress";
      return refuse(`while ${operation.kind} ${state}`);
    }
    if (await git.isDirty(repo)) {
      return refuse("while the workspace has uncommitted changes");
    }
    const from =
      args.createFrom === null
        ? [branchName]
        : ["-C", branchName, requireBranchName(args.createFrom)];
    await repo.git("switch", ...from);
    return { branchName };
  });
};
