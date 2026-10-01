import path from "node:path";
import type { WorkspaceDiffTarget } from "@bb/domain";
import type {
  DiffFileEntry,
  DiffPatchEntry,
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
import {
  headOrEmptyTree,
  mergeBaseRef,
  parseNameStatusZ,
  parseNumstatZ,
  requireRepo,
  splitNul,
  withUntrackedIndex,
  type NameStatusEntry,
  type NumstatEntry,
} from "./git.js";

const LISTING = { maxBytes: 4 * 1024 * 1024, allowTruncated: true };
const PATCH = {
  maxBytes: DIFF_PATCH_MAX_BYTES_PER_FILE + 1,
  allowTruncated: true,
};
const WHOLE_DIFF = {
  maxBytes: DIFF_RESPONSE_MAX_BYTES + 1,
  allowTruncated: true,
};
const FILE_LIST_MAX_BYTES = 64 * 1024;
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
  command: string[];
  revisions: string[];
  includesUntracked: boolean;
  mergeBaseRef: string | null;
}

interface ChangedFiles {
  repo: Repo;
  range: DiffRange | null;
  files: DiffFileEntry[];
  nameStatus: string;
  untracked: string[];
  truncated: boolean;
}

async function resolveRange(
  repo: Repo,
  target: WorkspaceDiffTarget,
): Promise<DiffRange | null> {
  if (target.type === "uncommitted") {
    const revisions = [await headOrEmptyTree(repo)];
    return {
      command: DIFF,
      revisions,
      includesUntracked: true,
      mergeBaseRef: null,
    };
  }
  if (target.type === "commit") {
    return {
      command: ["show", "--format=", "--no-ext-diff"],
      revisions: [requireSafeRef(target.sha)],
      includesUntracked: false,
      mergeBaseRef: null,
    };
  }
  const base = await mergeBaseRef(
    repo,
    requireBranchName(target.mergeBaseBranch),
  );
  const all = target.type === "all";
  return base === null
    ? null
    : {
        command: DIFF,
        revisions: [all ? base : `${base}..HEAD`],
        includesUntracked: all,
        mergeBaseRef: base,
      };
}

function literal(paths: string[]): string[] {
  return paths.map((value) => `:(literal)${value}`);
}

function rangeArgs(range: DiffRange, flags: string[], paths: string[] = []) {
  return [
    ...range.command,
    ...flags,
    ...range.revisions,
    "--",
    ...literal(paths),
  ];
}

function completeRecords(result: GitResult): string {
  return result.truncated
    ? result.stdout.slice(0, result.stdout.lastIndexOf("\0") + 1)
    : result.stdout;
}

function truncateUtf8(value: string, maxBytes: number) {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return { text: value, truncated: false };
  }
  let cut = Math.max(0, maxBytes);
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
  entry: NameStatusEntry,
  stat: NumstatEntry | undefined,
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
    paths: splitNul(completeRecords(result)),
    truncated: result.truncated,
  };
}

async function listChangedFiles(
  ctx: Ctx,
  args: { path: string; target: WorkspaceDiffTarget },
): Promise<ChangedFiles> {
  const repo = await requireRepo(ctx, args.path);
  const range = await resolveRange(repo, args.target);
  const none = { files: [], nameStatus: "", untracked: [], truncated: false };
  if (range === null) {
    return { repo, range, ...none };
  }
  const listed = repo.with(LISTING);
  const [names, numstat] = await Promise.all([
    listed.git(...rangeArgs(range, ["--name-status", "-M", "-z"])),
    listed.git(...rangeArgs(range, ["--numstat", "-M", "-z"])),
  ]);
  const stats = new Map(
    parseNumstatZ(completeRecords(numstat)).map((entry) => [entry.path, entry]),
  );
  const tracked = parseNameStatusZ(completeRecords(names));
  const shown = tracked.slice(0, DIFF_MAX_FILES);
  const files = shown.map((entry) =>
    toFileEntry(entry, stats.get(entry.path), "tracked"),
  );
  const nameStatus = shown.map((entry) =>
    [entry.status, entry.previousPath, entry.path]
      .filter((part) => part !== null)
      .join("\t"),
  );
  const truncated = names.truncated || tracked.length > DIFF_MAX_FILES;
  if (!range.includesUntracked || truncated) {
    return {
      ...none,
      repo,
      range,
      files,
      nameStatus: nameStatus.join("\n"),
      truncated,
    };
  }
  const others = await listUntracked(repo);
  const untracked = others.paths.slice(0, DIFF_MAX_FILES - files.length);
  const untrackedStats =
    untracked.length === 0
      ? []
      : await withUntrackedIndex(repo, untracked, async (index) =>
          parseNumstatZ((await index.git(...DIFF, "--numstat", "-z")).stdout),
        );
  for (const file of untracked) {
    const stat = untrackedStats.find((entry) => entry.path === file);
    const entry = { path: file, previousPath: null, status: "A" };
    files.push(toFileEntry(entry, stat, "untracked"));
    nameStatus.push(`A\t${file}`);
  }
  return {
    repo,
    range,
    files,
    nameStatus: nameStatus.join("\n"),
    untracked,
    truncated: others.truncated || untracked.length < others.paths.length,
  };
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

async function readPatches(
  repo: Repo,
  range: DiffRange,
  requested: string[],
): Promise<DiffPatchEntry[]> {
  const paths = [...new Set(requested)];
  const untracked = range.includesUntracked
    ? (await listUntracked(repo, paths)).paths
    : [];
  const names = await repo
    .with(LISTING)
    .git(...rangeArgs(range, ["--name-status", "-M", "-z"]));
  const renamedFrom = new Map(
    parseNameStatusZ(completeRecords(names)).map((entry) => [
      entry.path,
      entry.previousPath,
    ]),
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
    await withUntrackedIndex(repo, untracked, (index, indexed) =>
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
  const inline =
    files.length > INLINE_PATCH_MAX_FILES
      ? []
      : files.filter((file) => file.loadMode === "auto");
  return {
    files,
    truncated,
    shortstat: shortstat(files),
    mergeBaseRef: range?.mergeBaseRef ?? null,
    initialPatches:
      range === null || inline.length === 0
        ? []
        : await readPatches(
            repo,
            range,
            inline.map((file) => file.path),
          ),
  };
};

export const gitDiffPatch: Method<"gitDiffPatch"> = async (ctx, args) => {
  if (args.paths.length > DIFF_PATCH_MAX_PATHS) {
    fail("failed", `At most ${DIFF_PATCH_MAX_PATHS} paths per request`);
  }
  const repo = await requireRepo(ctx, args.path);
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
    range === null
      ? []
      : [(await whole.git(...rangeArgs(range, ["--binary"]))).stdout];
  if (untracked.length > 0) {
    patches.push(
      await withUntrackedIndex(repo, untracked, async (index) => {
        const added = await index.with(WHOLE_DIFF).git(...DIFF, "--binary");
        return added.stdout;
      }),
    );
  }
  const joined = patches
    .map((patch) => patch.trimEnd())
    .filter((patch) => patch.length > 0)
    .join("\n");
  const diff = truncateUtf8(
    joined.length > 0 ? `${joined}\n` : "",
    DIFF_RESPONSE_MAX_BYTES,
  );
  const fileList = truncateUtf8(
    files.length > 0 ? `${changed.nameStatus}\n` : "",
    FILE_LIST_MAX_BYTES,
  );
  return {
    diff: diff.text,
    truncated: changed.truncated || diff.truncated || fileList.truncated,
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
  const {
    sha256: _sha256,
    modifiedAtMs: _modifiedAtMs,
    ...file
  } = await readFileContent(ctx, {
    path: path.join(args.path, relativePath),
    rootPath: args.path,
    gitRef: diffFileRef(args.file),
  });
  return file;
};
