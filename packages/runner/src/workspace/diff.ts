import path from "node:path";
import type { WorkspaceDiffTarget } from "@bb/domain";
import type {
  DiffFileEntry,
  EnvironmentDiffFileQuery,
} from "@bb/server-contract";
import { readFileContent } from "../files/read.js";
import {
  DIFF_MAX_FILES,
  DIFF_PATCH_MAX_BYTES_PER_FILE,
  DIFF_PATCH_MAX_PATHS,
  DIFF_RESPONSE_MAX_BYTES,
} from "../workspace-types.js";
import {
  fail,
  requireBranchName,
  requireSafeRef,
  type Ctx,
  type GitResult,
  type Method,
  type Repo,
} from "./exec.js";
import * as git from "./git.js";

const bounded = (maxBytes: number) => ({
  maxBytes: maxBytes + 1,
  allowTruncated: true,
});
const LISTING = bounded(4 * 1024 * 1024);
const PATCH = bounded(DIFF_PATCH_MAX_BYTES_PER_FILE);
const WHOLE_DIFF = bounded(DIFF_RESPONSE_MAX_BYTES);
const FILE_LIST_MAX_BYTES = 64 * 1024;
const ESCAPE_ALLOWANCE = 1.25;
const AUTO_LOAD_MAX_CHANGED_LINES = 500;
const TOO_LARGE_CHANGED_LINES = 20_000;
const INLINE_PATCH_MAX_FILES = 10;
const PATCH_CONCURRENCY = 6;
const DIFF = ["diff", "--no-ext-diff"];
const CHANGE_KINDS: Record<string, DiffFileEntry["changeKind"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type_changed",
};

interface DiffRange {
  args: string[];
  includesUntracked: boolean;
  mergeBaseRef: string | null;
}

interface ChangedFiles {
  repo: Repo;
  range: DiffRange | null;
  files: DiffFileEntry[];
  nameStatus: string[];
  untracked: string[];
  truncated: boolean;
}

async function resolveRange(repo: Repo, target: WorkspaceDiffTarget) {
  const range = (
    args: string[],
    includesUntracked: boolean,
    mergeBaseRef: string | null = null,
  ): DiffRange => ({ args, includesUntracked, mergeBaseRef });
  if (target.type === "uncommitted") {
    return range([...DIFF, await git.headOrEmptyTree(repo)], true);
  }
  if (target.type === "commit") {
    const sha = requireSafeRef(target.sha);
    const show = ["show", "--format=", "--diff-merges=first-parent"];
    return range([...show, "--no-ext-diff", sha], false);
  }
  const branch = requireBranchName(target.mergeBaseBranch);
  const base = await git.mergeBaseRef(repo, branch);
  const all = target.type === "all";
  return base === null
    ? null
    : range([...DIFF, all ? base : `${base}..HEAD`], all, base);
}

function literal(paths: string[]): string[] {
  return paths.map((value) => `:(literal)${value}`);
}

function rangeArgs(range: DiffRange, flags: string[], paths: string[] = []) {
  return [...range.args, ...flags, "--", ...literal(paths)];
}

function completeRecords(result: GitResult): string {
  return result.truncated
    ? result.stdout.slice(0, result.stdout.lastIndexOf("\0") + 1)
    : result.stdout;
}

function truncateUtf8(value: string, maxBytes: number) {
  const buffer = Buffer.from(value, "utf8");
  const encoded = Buffer.byteLength(JSON.stringify(value));
  const inflation = encoded / Math.max(buffer.byteLength, 1) / ESCAPE_ALLOWANCE;
  let cut = Math.floor(Math.max(0, maxBytes) / Math.max(1, inflation));
  if (buffer.byteLength <= cut) return { text: value, truncated: false };
  while (cut > 0 && ((buffer[cut] ?? 0) & 0xc0) === 0x80) {
    cut -= 1;
  }
  return { text: buffer.subarray(0, cut).toString("utf8"), truncated: true };
}

function shortstat(files: DiffFileEntry[]): string {
  const count = (total: number, noun: string, suffix: string) =>
    total > 0 ? [`${total} ${noun}${total === 1 ? "" : "s"}${suffix}`] : [];
  const sum = (key: "additions" | "deletions") =>
    files.reduce((total, file) => total + file[key], 0);
  const parts = [
    ...count(files.length, "file", " changed"),
    ...count(sum("additions"), "insertion", "(+)"),
    ...count(sum("deletions"), "deletion", "(-)"),
  ];
  return files.length === 0 ? "" : `${parts.join(", ")}\n`;
}

function toFileEntry(
  entry: git.NameStatusEntry,
  stat: git.NumstatEntry | undefined,
  origin: DiffFileEntry["origin"],
): DiffFileEntry {
  const binary = stat?.insertions === null && stat.deletions === null;
  const additions = stat?.insertions ?? 0;
  const deletions = stat?.deletions ?? 0;
  const changedLines = additions + deletions;
  return {
    path: entry.path,
    previousPath: entry.previousPath,
    changeKind: CHANGE_KINDS[entry.status] ?? "modified",
    additions,
    deletions,
    binary,
    origin,
    loadMode:
      changedLines > TOO_LARGE_CHANGED_LINES
        ? "too_large"
        : binary || changedLines > AUTO_LOAD_MAX_CHANGED_LINES
          ? "on_demand"
          : "auto",
  };
}

async function listUntracked(repo: Repo, paths: string[] = []) {
  const flags = ["--others", "--exclude-standard", "-z", "--"];
  const listed = repo.with(LISTING);
  const result = await listed.git("ls-files", ...flags, ...literal(paths));
  return {
    paths: git.splitNul(completeRecords(result)),
    truncated: result.truncated,
  };
}

async function listChangedFiles(
  ctx: Ctx,
  args: { path: string; target: WorkspaceDiffTarget },
): Promise<ChangedFiles> {
  const repo = await git.requireRepo(ctx, args.path);
  const range = await resolveRange(repo, args.target);
  const changed: ChangedFiles = {
    repo,
    range,
    files: [],
    nameStatus: [],
    untracked: [],
    truncated: false,
  };
  if (range === null) return changed;
  const listed = repo.with(LISTING);
  const [names, numstat] = await Promise.all([
    listed.git(...rangeArgs(range, ["--name-status", "-M", "-z"])),
    listed.git(...rangeArgs(range, ["--numstat", "-M", "-z"])),
  ]);
  const stats = git.parseNumstatZ(completeRecords(numstat));
  const tracked = git.parseNameStatusZ(completeRecords(names));
  const statFor = (file: string, among: git.NumstatEntry[]) =>
    among.find((entry) => entry.path === file);
  for (const entry of tracked.slice(0, DIFF_MAX_FILES)) {
    const stat = statFor(entry.path, stats);
    const fields = [entry.status, entry.previousPath, entry.path];
    changed.files.push(toFileEntry(entry, stat, "tracked"));
    changed.nameStatus.push(fields.filter((part) => part !== null).join("\t"));
  }
  changed.truncated = names.truncated || tracked.length > DIFF_MAX_FILES;
  if (!range.includesUntracked || changed.truncated) return changed;
  const others = await listUntracked(repo);
  const room = DIFF_MAX_FILES - changed.files.length;
  changed.untracked = others.paths.slice(0, room);
  changed.truncated = others.truncated || others.paths.length > room;
  const untrackedStats =
    changed.untracked.length === 0
      ? []
      : await git.withUntrackedIndex(repo, changed.untracked, async (index) => {
          const added = await index.git(...DIFF, "--numstat", "-z");
          return git.parseNumstatZ(added.stdout);
        });
  for (const file of changed.untracked) {
    const entry = { path: file, previousPath: null, status: "A" };
    const stat = statFor(file, untrackedStats);
    changed.files.push(toFileEntry(entry, stat, "untracked"));
    changed.nameStatus.push(`A\t${file}`);
  }
  return changed;
}

async function mapLimited<T>(
  items: readonly T[],
  work: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: PATCH_CONCURRENCY }, worker));
}

async function readPatches(repo: Repo, range: DiffRange, requested: string[]) {
  const paths = [...new Set(requested)];
  const untracked = range.includesUntracked
    ? (await listUntracked(repo, paths)).paths
    : [];
  const names = await repo
    .with(LISTING)
    .git(...rangeArgs(range, ["--name-status", "-M", "-z"]));
  const renamedFrom = new Map(
    git
      .parseNameStatusZ(completeRecords(names))
      .map((entry) => [entry.path, entry.previousPath]),
  );
  const patches = new Map<string, string>();
  const bounded = repo.with(PATCH);
  await mapLimited(
    paths.filter((file) => !untracked.includes(file)),
    async (file) => {
      const previous = renamedFrom.get(file);
      const pathspec = previous ? [previous, file] : [file];
      const flags = ["--binary", "-M"];
      const patch = await bounded.git(...rangeArgs(range, flags, pathspec));
      patches.set(file, patch.stdout);
    },
  );
  if (untracked.length > 0) {
    await git.withUntrackedIndex(repo, untracked, (index, indexed) =>
      mapLimited(indexed, async (file) => {
        const args = [...DIFF, "--binary", "--", ...literal([file])];
        patches.set(file, (await index.with(PATCH).git(...args)).stdout);
      }),
    );
  }
  let remainingBytes = DIFF_RESPONSE_MAX_BYTES;
  return paths.map((file) => {
    const limit = Math.min(DIFF_PATCH_MAX_BYTES_PER_FILE, remainingBytes);
    const { text, truncated } = truncateUtf8(patches.get(file) ?? "", limit);
    remainingBytes -= Buffer.byteLength(text, "utf8");
    return { path: file, patch: text, truncated };
  });
}

export const gitDiffFiles: Method<"gitDiffFiles"> = async (ctx, args) => {
  const { repo, range, files, truncated } = await listChangedFiles(ctx, args);
  const inline = files
    .filter((file) => file.loadMode === "auto")
    .map((file) => file.path);
  const tooMany = files.length > INLINE_PATCH_MAX_FILES || inline.length === 0;
  return {
    files,
    truncated,
    shortstat: shortstat(files),
    mergeBaseRef: range?.mergeBaseRef ?? null,
    initialPatches:
      range === null || tooMany ? [] : await readPatches(repo, range, inline),
  };
};

export const gitDiffPatch: Method<"gitDiffPatch"> = async (ctx, args) => {
  if (args.paths.length > DIFF_PATCH_MAX_PATHS) {
    fail("failed", `At most ${DIFF_PATCH_MAX_PATHS} paths per request`);
  }
  const repo = await git.requireRepo(ctx, args.path);
  const range = await resolveRange(repo, args.target);
  const empty = (file: string) => ({ path: file, patch: "", truncated: false });
  return {
    patches:
      range === null
        ? args.paths.map(empty)
        : await readPatches(repo, range, args.paths),
  };
};

export const gitDiff: Method<"gitDiff"> = async (ctx, args) => {
  const changed = await listChangedFiles(ctx, args);
  const { repo, range, files, untracked } = changed;
  const whole = repo.with(WHOLE_DIFF);
  const patches =
    range === null ? [] : [await whole.git(...rangeArgs(range, ["--binary"]))];
  if (untracked.length > 0) {
    const added = git.withUntrackedIndex(repo, untracked, (index) =>
      index.with(WHOLE_DIFF).git(...DIFF, "--binary"),
    );
    patches.push(await added);
  }
  const cut = patches.some((patch) => patch.truncated);
  const joined = patches
    .map((patch) => patch.stdout)
    .map((patch) => patch.trimEnd())
    .filter((patch) => patch.length > 0)
    .join("\n");
  const diff = truncateUtf8(
    joined.length > 0 ? `${joined}\n` : "",
    DIFF_RESPONSE_MAX_BYTES,
  );
  const fileList = truncateUtf8(
    changed.nameStatus.map((line) => `${line}\n`).join(""),
    FILE_LIST_MAX_BYTES,
  );
  return {
    diff: diff.text,
    truncated: changed.truncated || cut || diff.truncated || fileList.truncated,
    shortstat: shortstat(files),
    files: fileList.text,
    mergeBaseRef: range?.mergeBaseRef ?? null,
  };
};

function diffFileRef(file: EnvironmentDiffFileQuery): string | undefined {
  const old = file.side === "old";
  switch (file.target) {
    case "uncommitted":
      return old ? "HEAD" : undefined;
    case "branch_committed":
      return old ? file.mergeBaseRef : "HEAD";
    case "all":
      return old ? file.mergeBaseRef : undefined;
    case "commit":
      return old ? `${file.sha}^` : file.sha;
  }
}

export const gitDiffFile: Method<"gitDiffFile"> = async (ctx, args) => {
  const relativePath = args.file.path.replace(/^\/+/u, "");
  if (relativePath.length === 0 || relativePath.split("/").includes("..")) {
    fail("invalid_path", "Invalid diff file path");
  }
  const rootPath = (await git.requireRepo(ctx, args.path)).cwd;
  const gitRef = diffFileRef(args.file);
  const file = path.join(rootPath, relativePath);
  return readFileContent(ctx, { path: file, rootPath, gitRef });
};
