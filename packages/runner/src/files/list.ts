import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fuzzyMatchPaths } from "@bb/fuzzy-match";
import type {
  HostDirectoryListing,
  WorkspacePathEntry,
} from "@bb/server-contract";
import {
  errorCode,
  fail,
  openRepo,
  requireAbsolute,
  unlessCode,
  type Ctx,
  type Method,
} from "../workspace/exec.js";
import { repoKind, splitNul } from "../workspace/git.js";
import {
  PATH_LIST_MAX_ENTRIES,
  PATHS_EXIST_MAX_PATHS,
} from "../workspace-types.js";
import { resolveRoot } from "./read.js";

const GIT_LISTING = { maxBytes: 128 * 1024 * 1024, timeoutMs: 10_000 };
const LISTING_REUSE_MS = 2_000;
const WALK_MAX_ENTRIES = 100_000;
const BROWSE_SKIPPED_NAMES = new Set(["node_modules"]);

type ListedPath = Pick<WorkspacePathEntry, "kind" | "path" | "name">;

const recentListings = new Map<
  string,
  { at: number; listing: Promise<ListedPath[]> }
>();

async function gitFiles(ctx: Ctx, root: string): Promise<string[] | null> {
  const repo = openRepo(ctx, root, GIT_LISTING);
  if ((await repoKind(repo)) !== "work-tree") return null;
  const [present, deleted] = await Promise.all([
    repo.git("ls-files", "-z", "--cached", "--others", "--exclude-standard"),
    repo.git("ls-files", "-z", "--deleted"),
  ]);
  const gone = new Set(splitNul(deleted.stdout));
  const files = new Set(splitNul(present.stdout));
  return [...files].filter((file) => !gone.has(file)).sort();
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [""];
  for (let visited = 0; pending.length > 0 && visited < WALK_MAX_ENTRIES;) {
    const directory = pending.pop() ?? "";
    const entries = await fs
      .readdir(path.join(root, directory), { withFileTypes: true })
      .catch(() => []);
    visited += entries.length;
    for (const entry of entries) {
      const relativePath = path.posix.join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== ".git") {
        pending.push(relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }
  return files.sort();
}

function withDirectories(
  files: string[],
  isExcluded: (segment: string) => boolean,
): ListedPath[] {
  const listed: ListedPath[] = [];
  const directories = new Set<string>();
  for (const file of files) {
    const segments = file.split("/");
    if (isExcluded(file) || segments.some(isExcluded)) continue;
    segments.forEach((name, index) => {
      const entryPath = segments.slice(0, index + 1).join("/");
      if (index === segments.length - 1) {
        listed.push({ kind: "file", path: entryPath, name });
      } else if (!directories.has(entryPath)) {
        directories.add(entryPath);
        listed.push({ kind: "directory", path: entryPath, name });
      }
    });
  }
  return listed;
}

export const listPaths: Method<"listPaths"> = async (ctx, args) => {
  const root = await resolveRoot(requireAbsolute(args.rootPath)).catch(
    unlessCode("ENOENT", null),
  );
  if (root === null) return { paths: [], truncated: false };
  const excluded = new Set(args.excludeNames);
  const skipHidden = args.includeHidden !== true;
  const key = JSON.stringify([root, skipHidden, [...excluded].sort()]);
  let recent = recentListings.get(key);
  if (recent === undefined || Date.now() - recent.at > LISTING_REUSE_MS) {
    const isExcluded = (segment: string) =>
      excluded.has(segment) || (skipHidden && segment.startsWith("."));
    const tracked = gitFiles(ctx, root).catch(() => null);
    const listing = tracked.then(async (files) =>
      withDirectories(files ?? (await walkFiles(root)), isExcluded),
    );
    recent = { at: Date.now(), listing };
    recentListings.set(key, recent);
    setTimeout(() => recentListings.delete(key), LISTING_REUSE_MS).unref();
  }
  const limit = Math.max(0, Math.min(args.limit, PATH_LIST_MAX_ENTRIES));
  const ranked = fuzzyMatchPaths({
    items: (await recent.listing).filter((entry) =>
      entry.kind === "file" ? args.includeFiles : args.includeDirectories,
    ),
    query: args.query ?? "",
    getPath: (entry) => entry.path,
    limit: limit + 1,
  });
  return {
    paths: ranked.slice(0, limit).map(({ item, score, positions }) => ({
      ...item,
      score,
      positions,
    })),
    truncated: ranked.length > limit,
  };
};

export const browseDirectory: Method<"browseDirectory"> = async (
  _ctx,
  args,
) => {
  const requested = requireAbsolute(args.path ?? os.homedir());
  if (!(await fs.stat(requested)).isDirectory()) {
    fail("invalid_path", `Path "${requested}" is not a directory`);
  }
  const directory = await fs.realpath(requested);
  const entries: HostDirectoryListing["entries"] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const stat =
      entry.name.startsWith(".") || BROWSE_SKIPPED_NAMES.has(entry.name)
        ? null
        : await fs.stat(entryPath).catch(() => null);
    if (stat?.isDirectory() || stat?.isFile()) {
      const kind = stat.isDirectory() ? "directory" : "file";
      entries.push({ kind, name: entry.name, path: entryPath });
    }
  }
  entries.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
  const above = path.dirname(directory);
  const parent = above === directory ? null : above;
  return {
    directory,
    parent,
    entries: entries.slice(0, PATH_LIST_MAX_ENTRIES),
  };
};

export const pathsExist: Method<"pathsExist"> = async (_ctx, args) => {
  if (args.paths.length > PATHS_EXIST_MAX_PATHS) {
    fail("failed", `At most ${PATHS_EXIST_MAX_PATHS} paths per request`);
  }
  const exists = async (target: string) => {
    const failure = await fs.stat(target).then(() => null, errorCode);
    return failure !== "ENOENT" && failure !== "ENOTDIR";
  };
  const found = await Promise.all(args.paths.map(exists));
  const pairs = args.paths.map((target, at) => [target, found[at] === true]);
  return { existence: Object.fromEntries(pairs) };
};
