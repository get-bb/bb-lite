import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  DefaultBranchRelation,
  GitCheckoutRef,
  GitSourceInspection,
  WorkspaceFileStatus,
  WorkspaceFileStatusKind,
  WorkspaceGitOperation,
} from "@bb/domain";
import { STATUS_MAX_FILES, type PathInspection } from "../workspace-types.js";
import {
  fail,
  openRepo,
  pathExists,
  requireAbsolute,
  requireBranchName,
  type Ctx,
  type Method,
  type Repo,
} from "./exec.js";

const STATUS = { timeoutMs: 15_000 };
const STATUS_MAX_COMMITS = "--max-count=200";
const UNTRACKED_STAT_MAX_FILES = 50;
const UNTRACKED_STAT_MAX_BYTES = 8 * 1024 * 1024;
const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const OPERATION_MARKERS = [
  ["rebase", "rebase-merge"],
  ["rebase", "rebase-apply"],
  ["merge", "MERGE_HEAD"],
  ["cherry-pick", "CHERRY_PICK_HEAD"],
  ["revert", "REVERT_HEAD"],
] as const;
const NOT_A_REPO: PathInspection = {
  exists: true,
  isGitRepo: false,
  isWorktree: false,
  branchName: null,
  defaultBranch: null,
  remoteUrl: null,
  dirty: false,
};
const NOT_A_SOURCE: GitSourceInspection = {
  checkout: { kind: "unknown", reason: "Path is not a git repository" },
  defaultBranch: null,
  defaultBranchRelation: null,
  isWorktree: false,
  hasUncommittedChanges: false,
  operation: { kind: "none" },
  originDefaultBranch: null,
};

export type RepoKind = "work-tree" | "bare" | "none";

export interface NameStatusEntry {
  path: string;
  previousPath: string | null;
  status: string;
}

export interface NumstatEntry {
  path: string;
  insertions: number | null;
  deletions: number | null;
}

interface BranchRefs {
  local: string[];
  remote: string[];
  defaultBranch: string | null;
  originDefaultBranch: string | null;
}

export function splitNul(output: string): string[] {
  return output.split("\0").filter((value) => value.length > 0);
}

function parsePorcelainZ(output: string): { path: string; code: string }[] {
  const tokens = output.split("\0");
  const entries: { path: string; code: string }[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const code = token.slice(0, 2);
    if (token.length > 3) {
      entries.push({ path: token.slice(3), code });
      index += code.includes("R") || code.includes("C") ? 1 : 0;
    }
  }
  return entries;
}

export function parseNameStatusZ(output: string): NameStatusEntry[] {
  const tokens = output.split("\0");
  const entries: NameStatusEntry[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index]?.[0] ?? "";
    const renamed = status === "R" || status === "C";
    const target = tokens[index + (renamed ? 2 : 1)];
    if (status && target) {
      const previousPath = renamed ? (tokens[index + 1] ?? null) : null;
      entries.push({ path: target, previousPath, status });
    }
    index += status ? (renamed ? 3 : 2) : 1;
  }
  return entries;
}

function parseCount(text: string): number | null {
  const value = Number.parseInt(text, 10);
  return Number.isFinite(value) ? value : null;
}

export function parseNumstatZ(output: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  for (let cursor = 0; cursor < output.length;) {
    const firstTab = output.indexOf("\t", cursor);
    const secondTab = output.indexOf("\t", firstTab + 1);
    const renamed = output[secondTab + 1] === "\0";
    const pathStart = renamed
      ? output.indexOf("\0", secondTab + 2) + 1
      : secondTab + 1;
    const pathEnd = output.indexOf("\0", pathStart);
    if (firstTab < 0 || secondTab < 0 || pathStart === 0 || pathEnd < 0) break;
    entries.push({
      path: output.slice(pathStart, pathEnd),
      insertions: parseCount(output.slice(cursor, firstTab)),
      deletions: parseCount(output.slice(firstTab + 1, secondTab)),
    });
    cursor = pathEnd + 1;
  }
  return entries;
}

export function sumLineStats(entries: readonly NumstatEntry[]) {
  const sum = (key: "insertions" | "deletions") =>
    entries.reduce((total, entry) => total + (entry[key] ?? 0), 0);
  return { insertions: sum("insertions"), deletions: sum("deletions") };
}

export async function repoKind(repo: Repo): Promise<RepoKind> {
  const flags = ["--is-inside-work-tree", "--is-bare-repository"];
  const shown = (await repo.line("rev-parse", ...flags)) ?? "";
  const [inside, bare] = shown.split("\n");
  return inside === "true" ? "work-tree" : bare === "true" ? "bare" : "none";
}

export async function requireRepo(ctx: Ctx, cwd: string): Promise<Repo> {
  const repo = openRepo(ctx, requireAbsolute(cwd));
  const topLevel = await repo.line("rev-parse", "--show-toplevel");
  return topLevel === null
    ? fail("not_git_repo", `Path is not a git repository: ${cwd}`)
    : openRepo(ctx, topLevel);
}

async function probe(ctx: Ctx, cwd: string) {
  const repo = openRepo(ctx, requireAbsolute(cwd), STATUS);
  const stat = await fs.stat(cwd).catch(() => null);
  return { repo, kind: stat?.isDirectory() ? await repoKind(repo) : "none" };
}

export function revision(repo: Repo, ref: string): Promise<string | null> {
  return repo.line("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
}

export async function currentBranch(repo: Repo): Promise<string | null> {
  const prefix = "refs/heads/";
  const ref = await repo.line("symbolic-ref", "--quiet", "HEAD");
  return ref?.startsWith(prefix) ? ref.slice(prefix.length) : null;
}

export function mergeBaseRef(repo: Repo, ref: string): Promise<string | null> {
  return repo.line("merge-base", ref, "HEAD");
}

export async function hasRef(repo: Repo, ref: string): Promise<boolean> {
  const shown = await repo.attempt("show-ref", "--verify", "--quiet", ref);
  return shown.exitCode === 0;
}

export async function checkoutRef(repo: Repo): Promise<GitCheckoutRef> {
  const [branchName, headSha] = await Promise.all([
    currentBranch(repo),
    revision(repo, "HEAD"),
  ]);
  if (branchName !== null) {
    return headSha === null
      ? { kind: "unborn", branchName }
      : { kind: "branch", branchName, headSha };
  }
  const reason = "HEAD is not symbolic and no commit is checked out";
  return headSha === null
    ? { kind: "unknown", reason }
    : { kind: "detached", headSha };
}

export async function headOrEmptyTree(repo: Repo): Promise<string> {
  if ((await revision(repo, "HEAD")) !== null) return "HEAD";
  const tree = await repo.git("hash-object", "-t", "tree", os.devNull);
  return tree.stdout.trim();
}

export async function gitDirs(repo: Repo) {
  const flags = ["--absolute-git-dir", "--git-common-dir"];
  const { stdout } = await repo.git("rev-parse", ...flags);
  const [gitDir = "", common = ""] = stdout.trim().split("\n");
  const commonDir = path.resolve(repo.cwd, common);
  return { gitDir: path.resolve(gitDir), commonDir };
}

async function isLinkedWorktree(repo: Repo): Promise<boolean> {
  const { gitDir, commonDir } = await gitDirs(repo);
  return gitDir !== commonDir;
}

async function branchNames(repo: Repo, namespace: string): Promise<string[]> {
  const format = "--format=%(refname:lstrip=2)%09%(symref)";
  const { stdout } = await repo.git("for-each-ref", format, namespace);
  return stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([name, symref]) => name && !symref)
    .map(([name = ""]) => name);
}

export function localBranches(repo: Repo): Promise<string[]> {
  return branchNames(repo, "refs/heads");
}

async function originHead(repo: Repo): Promise<string | null> {
  const prefix = "refs/remotes/origin/";
  const ref = await repo.line("symbolic-ref", "--quiet", `${prefix}HEAD`);
  return ref?.startsWith(prefix) ? ref.slice(prefix.length) : null;
}

function preferredLocal(local: string[], origin: string | null): string | null {
  const preferred = [origin, "main", "master"].find(
    (name) => name !== null && local.includes(name),
  );
  return preferred ?? local[0] ?? null;
}

export async function defaultBranch(repo: Repo): Promise<string | null> {
  const head = await originHead(repo);
  return head ?? preferredLocal(await localBranches(repo), null);
}

async function branchRefs(repo: Repo, kind: RepoKind): Promise<BranchRefs> {
  const [head, local, remote] =
    kind === "none"
      ? [null, [], []]
      : await Promise.all([
          originHead(repo),
          localBranches(repo),
          branchNames(repo, "refs/remotes"),
        ]);
  const defaultBranch = preferredLocal(local, head);
  const originDefaultBranch = [head, defaultBranch]
    .filter((name) => name !== null)
    .map((name) => `origin/${name}`)
    .find((name) => remote.includes(name));
  const origin = originDefaultBranch ?? null;
  return { local, remote, defaultBranch, originDefaultBranch: origin };
}

async function defaultBranchRelation(
  repo: Repo,
  refs: BranchRefs,
): Promise<DefaultBranchRelation | null> {
  if (refs.defaultBranch === null || refs.originDefaultBranch === null) {
    return null;
  }
  const local = `refs/heads/${refs.defaultBranch}`;
  const range = `${local}...refs/remotes/${refs.originDefaultBranch}`;
  const counts = await repo.line("rev-list", "--left-right", "--count", range);
  const [ahead, behind] = (counts ?? "").split(/\s+/u).map(Number);
  if (ahead === undefined || behind === undefined) return "unknown";
  const whenLevel = behind === 0 ? "equal" : "local-behind";
  const whenAhead = behind === 0 ? "local-ahead" : "diverged";
  return ahead === 0 ? whenLevel : whenAhead;
}

export async function defaultWorktreeBase(repo: Repo): Promise<string | null> {
  const refs = await branchRefs(repo, "work-tree");
  const relation = await defaultBranchRelation(repo, refs);
  const upToDate = relation === "equal" || relation === "local-behind";
  const preferOrigin = refs.defaultBranch === null || upToDate;
  return refs.originDefaultBranch !== null && preferOrigin
    ? refs.originDefaultBranch
    : refs.defaultBranch;
}

async function porcelain(repo: Repo, untracked: "all" | "normal") {
  const flags = ["--porcelain=v1", "-z", `--untracked-files=${untracked}`];
  return parsePorcelainZ((await repo.git("status", ...flags)).stdout);
}

export async function isDirty(repo: Repo): Promise<boolean> {
  return (await porcelain(repo, "normal")).length > 0;
}

export async function gitOperation(repo: Repo): Promise<WorkspaceGitOperation> {
  const { gitDir } = await gitDirs(repo);
  for (const [kind, marker] of OPERATION_MARKERS) {
    if (await pathExists(path.join(gitDir, marker))) {
      const entries = await porcelain(repo, "normal");
      const hasConflicts = entries.some(
        ({ code }) => code.includes("U") || CONFLICT_CODES.has(code),
      );
      return { kind, hasConflicts };
    }
  }
  return { kind: "none" };
}

export const inspectPath: Method<"inspectPath"> = async (ctx, args) => {
  const { repo, kind } = await probe(ctx, args.path);
  if (kind !== "work-tree") {
    return { ...NOT_A_REPO, exists: await pathExists(args.path) };
  }
  const [branchName, fallback, isWorktree, remoteUrl, dirty] =
    await Promise.all([
      currentBranch(repo),
      defaultBranch(repo),
      isLinkedWorktree(repo),
      repo.line("remote", "get-url", "origin"),
      isDirty(repo),
    ]);
  const defaultBranchName = fallback ?? branchName;
  const found = { ...NOT_A_REPO, isGitRepo: true, isWorktree, branchName };
  return { ...found, defaultBranch: defaultBranchName, remoteUrl, dirty };
};

export const inspectGitSource: Method<"inspectGitSource"> = async (
  ctx,
  args,
) => {
  const { repo, kind } = await probe(ctx, args.path);
  if (kind === "none") return NOT_A_SOURCE;
  const workTree = kind === "work-tree";
  const refs = await branchRefs(repo, kind);
  const [checkout, relation, dirty, operation, isWorktree] = await Promise.all([
    checkoutRef(repo),
    defaultBranchRelation(repo, refs),
    workTree && isDirty(repo),
    workTree ? gitOperation(repo) : NOT_A_SOURCE.operation,
    workTree && isLinkedWorktree(repo),
  ]);
  return {
    checkout,
    defaultBranch: refs.defaultBranch,
    defaultBranchRelation: relation,
    isWorktree,
    hasUncommittedChanges: dirty,
    operation,
    originDefaultBranch: refs.originDefaultBranch,
  };
};

export const listBranches: Method<"listBranches"> = async (ctx, args) => {
  const { repo, kind } = await probe(ctx, args.path);
  const refs = await branchRefs(repo, kind);
  const query = args.query?.trim().toLowerCase() ?? "";
  const { limit } = args;
  const page = (branches: string[], pinned: string | null) => {
    const first = (name: string): number => Number(name !== pinned);
    const matching = branches
      .filter((branch) => branch.toLowerCase().includes(query))
      .sort((left, right) => first(left) - first(right));
    return [matching.slice(0, limit), matching.length > limit] as const;
  };
  const [branches, branchesTruncated] = page(refs.local, refs.defaultBranch);
  const [remoteBranches, remoteBranchesTruncated] = page(
    refs.remote,
    refs.originDefaultBranch,
  );
  const name = args.selectedBranch;
  const found = refs.remote.includes(name ?? "") ? "remote" : "missing";
  const selectedKind = refs.local.includes(name ?? "") ? "local" : found;
  return {
    branches,
    branchesTruncated,
    remoteBranches,
    remoteBranchesTruncated,
    selectedBranch: name ? { name, kind: selectedKind } : null,
  };
};

export async function withUntrackedIndex<T>(
  repo: Repo,
  paths: string[],
  work: (indexed: Repo, indexedPaths: string[]) => Promise<T>,
): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bb-index-"));
  const pathspecFile = path.join(directory, "pathspec");
  const indexFile = path.join(directory, "index");
  const indexed = repo.with({ env: { GIT_INDEX_FILE: indexFile } });
  try {
    const stats = await Promise.all(
      paths.map((file) =>
        fs.lstat(path.join(repo.cwd, file)).catch(() => null),
      ),
    );
    const present = paths.filter(
      (_file, at) => stats[at]?.isFile() || stats[at]?.isSymbolicLink(),
    );
    const pathspecs = present.map((file) => `:(literal)${file}\0`);
    await fs.writeFile(pathspecFile, pathspecs.join(""));
    await indexed.git("read-tree", "--empty");
    if (present.length > 0) {
      const source = `--pathspec-from-file=${pathspecFile}`;
      const flags = ["--sparse", "--intent-to-add", "--pathspec-file-nul"];
      await indexed.git("add", ...flags, source);
    }
    return await work(indexed, present);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function untrackedLineStats(repo: Repo, paths: string[]) {
  if (paths.length === 0 || paths.length > UNTRACKED_STAT_MAX_FILES) {
    return { entries: [], complete: paths.length === 0 };
  }
  try {
    const sizeOf = async (file: string) => {
      const stat = await fs.lstat(path.join(repo.cwd, file)).catch(() => null);
      return stat?.size ?? 0;
    };
    const sizes = await Promise.all(paths.map(sizeOf));
    const total = sizes.reduce((sum, size) => sum + size, 0);
    if (total > UNTRACKED_STAT_MAX_BYTES)
      return { entries: [], complete: false };
    return await withUntrackedIndex(repo, paths, async (index, indexed) => {
      const numstat = await index.git("diff", "--numstat", "-z");
      const entries = parseNumstatZ(numstat.stdout);
      return { entries, complete: indexed.length === paths.length };
    });
  } catch {
    return { entries: [], complete: false };
  }
}

function porcelainKind(code: string): WorkspaceFileStatusKind {
  const kinds = ["U", "R", "C", "A", "D"] as const;
  const kind = CONFLICT_CODES.has(code)
    ? "U"
    : kinds.find((k) => code.includes(k));
  return code === "??" ? "??" : (kind ?? "M");
}

function nameStatusKind(status: string): WorkspaceFileStatusKind {
  const kinds = ["A", "D", "R", "C", "U", "M"] as const;
  return kinds.find((kind) => kind === status) ?? (status === "T" ? "M" : "?");
}

function withLineStats(
  files: { path: string; status: WorkspaceFileStatusKind }[],
  numstat: readonly NumstatEntry[],
): WorkspaceFileStatus[] {
  const byPath = new Map(numstat.map((entry) => [entry.path, entry]));
  return files.slice(0, STATUS_MAX_FILES).map((file) => ({
    ...file,
    insertions: byPath.get(file.path)?.insertions ?? null,
    deletions: byPath.get(file.path)?.deletions ?? null,
  }));
}

async function mergeBaseStatus(repo: Repo, mergeBaseBranch: string) {
  const range = `${requireBranchName(mergeBaseBranch)}...HEAD`;
  const cherry = ["--cherry-pick", "--right-only", "--reverse"];
  const format = "--format=%H%x1f%h%x1f%s%x1f%an%x1f%at";
  const [baseRef, counts, log, nameStatus, numstat] = await Promise.all([
    mergeBaseRef(repo, mergeBaseBranch),
    repo.line("rev-list", "--cherry-pick", "--left-right", "--count", range),
    repo.attempt("log", ...cherry, STATUS_MAX_COMMITS, format, range),
    repo.attempt("diff", "--no-ext-diff", "--name-status", "-z", range),
    repo.attempt("diff", "--no-ext-diff", "--numstat", "-z", range),
  ]);
  const sides = (counts ?? "").split(/\s+/u).map(Number);
  const [behindCount = 0, aheadCount = 0] = sides;
  const commits = splitNul(log.stdout.replaceAll("\n", "\0")).map((line) => {
    const [sha = "", shortSha = "", subject = "", authorName = "", at = "0"] =
      line.split("\u001f");
    const authoredAt = Number.parseInt(at, 10) * 1000;
    return { sha, shortSha, subject, authorName, authoredAt };
  });
  const hasCommits = commits.length > 0;
  const stats = hasCommits ? parseNumstatZ(numstat.stdout) : [];
  const changed = hasCommits ? parseNameStatusZ(nameStatus.stdout) : [];
  const files = changed.map((entry) => ({
    path: entry.path,
    status: nameStatusKind(entry.status),
  }));
  return {
    mergeBaseBranch,
    baseRef,
    aheadCount,
    behindCount,
    hasCommittedUnmergedChanges: aheadCount > 0,
    commits,
    files: withLineStats(files, stats),
    ...sumLineStats(stats),
    lineStatsComplete:
      numstat.exitCode === 0 && files.length <= STATUS_MAX_FILES,
  };
}

export const gitStatus: Method<"gitStatus"> = async (ctx, args) => {
  const base = await requireRepo(ctx, args.path);
  const repo = base.with(STATUS);
  const head = await headOrEmptyTree(repo);
  const [entries, tracked, checkout, fallback, mergeBase] = await Promise.all([
    porcelain(repo, "all"),
    repo.git("diff", "--numstat", "-z", head, "--"),
    checkoutRef(repo),
    defaultBranch(repo),
    args.mergeBaseBranch ? mergeBaseStatus(repo, args.mergeBaseBranch) : null,
  ]);
  const untrackedPaths = entries
    .filter((entry) => entry.code === "??")
    .map((entry) => entry.path);
  const untracked = await untrackedLineStats(repo, untrackedPaths);
  const stats = [...parseNumstatZ(tracked.stdout), ...untracked.entries];
  const hasUntracked = untrackedPaths.length > 0;
  const hasTracked = entries.length > untrackedPaths.length;
  const committed = mergeBase?.hasCommittedUnmergedChanges ?? false;
  const uncommitted = hasTracked ? "dirty_uncommitted" : "untracked";
  const dirtyState = committed ? "dirty_and_committed_unmerged" : uncommitted;
  const cleanState = committed ? "committed_unmerged" : "clean";
  const branchName = "branchName" in checkout ? checkout.branchName : null;
  const files = entries.map((entry) => ({
    path: entry.path,
    status: porcelainKind(entry.code),
  }));
  return {
    workingTree: {
      hasUncommittedChanges: entries.length > 0,
      state: entries.length === 0 ? cleanState : dirtyState,
      ...sumLineStats(stats),
      lineStatsComplete:
        entries.length <= STATUS_MAX_FILES &&
        (!hasUntracked || untracked.complete),
      files: withLineStats(files, stats),
    },
    checkout,
    branch: {
      currentBranch: branchName,
      defaultBranch: fallback ?? branchName ?? "",
    },
    mergeBase,
  };
};

export const gitCommit: Method<"gitCommit"> = async (ctx, args) => {
  const repo = await requireRepo(ctx, args.path);
  const { gitDir } = await gitDirs(repo);
  return ctx.lock(gitDir, async () => {
    await repo.git("add", "-A");
    const staged = await repo.attempt("diff", "--cached", "--quiet");
    if (staged.exitCode === 0) fail("no_changes", "No changes to commit");
    await repo.git("commit", "-m", args.message, "--no-verify");
    const [commitSha, subject] = await Promise.all([
      repo.git("rev-parse", "HEAD"),
      repo.git("log", "-1", "--pretty=%s"),
    ]);
    const commitSubject = subject.stdout.trim();
    return { commitSha: commitSha.stdout.trim(), commitSubject };
  });
};
