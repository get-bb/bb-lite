import fs from "node:fs/promises";
import path from "node:path";
import { createDebouncedCallbackScheduler } from "@bb/domain";
import { subscribe, type AsyncSubscription } from "@parcel/watcher";
import type { WorkspaceApi } from "../workspace-types.js";
import { isInside, openRepo, type Ctx } from "./exec.js";
import { splitNul } from "./git.js";

const DEBOUNCE = { debounceMs: 75, maxWaitMs: 500 };
const IGNORE_DISCOVERY = { timeoutMs: 5_000, maxBytes: 10 * 1024 * 1024 };
const WORKSPACE_IGNORED_GLOBS = [
  "*/**/.git/**",
  "**/node_modules/**",
  "**/.cache/**",
  "**/__pycache__/**",
];
const COMMON_DIR_IGNORED = [
  "hooks",
  "info",
  "logs",
  "modules",
  "objects",
  "worktrees",
];
const GIT_DIR_NOISE = /(?:\.lock|^commondir|^gitdir)$/u;
const SHARED_REF = /^(?:packed-refs$|refs\/heads\/|refs\/remotes\/)/u;
const CHANGED = { lane: "live", kind: "workspace.changed" } as const;

type Change = "status" | "refs" | "files";
type WatchKind = "workspace" | "directory";
type Stop = () => Promise<void>;

export interface Watcher {
  setWatchedPaths: WorkspaceApi["setWatchedPaths"];
  dispose(): Promise<void>;
}

async function gitLayout(root: string) {
  const dotGit = path.join(root, ".git");
  const stat = await fs.lstat(dotGit).catch(() => null);
  const pointer = stat?.isFile()
    ? /^gitdir:\s*(.+)$/mu.exec(await fs.readFile(dotGit, "utf8"))?.[1]
    : ".git";
  if (stat === null || pointer === undefined) return null;
  const gitDir = await fs.realpath(path.resolve(root, pointer.trim()));
  const common = await fs
    .readFile(path.join(gitDir, "commondir"), "utf8")
    .catch(() => ".");
  const commonDir = await fs.realpath(path.resolve(gitDir, common.trim()));
  return { gitDir, commonDir };
}

async function ignoredDirectories(ctx: Ctx, root: string) {
  const flags = ["--porcelain=v1", "-z", "--ignored=matching"];
  const status = await openRepo(ctx, root, IGNORE_DISCOVERY)
    .git("status", ...flags, "--untracked-files=normal")
    .catch(() => null);
  return splitNul(status?.stdout ?? "")
    .filter((record) => record.startsWith("!! ") && record.endsWith("/"))
    .map((record) => record.slice("!! ".length, -1));
}

async function watchWorkspace(
  ctx: Ctx,
  workspacePath: string,
  emit: (change: Change) => void,
) {
  const root = await fs.realpath(workspacePath);
  const layout = await gitLayout(root);
  const pending = new Set<Change>();
  const scheduler = createDebouncedCallbackScheduler({
    ...DEBOUNCE,
    onFlush: () => {
      const changes = [...pending];
      pending.clear();
      changes.forEach(emit);
    },
  });
  const note = (...changes: Change[]) => {
    changes.forEach((change) => pending.add(change));
    scheduler.schedule();
  };
  const subscriptions: AsyncSubscription[] = [];
  const stop: Stop = async () => {
    scheduler.dispose();
    await Promise.allSettled(subscriptions.map((sub) => sub.unsubscribe()));
  };
  const watchTree = async (
    directory: string,
    ignore: string[],
    onPath: (relativePath: string) => void,
  ) => {
    const onEvents = (error: Error | null, events: { path: string }[]) => {
      if (error) note("status", "refs");
      for (const event of error ? [] : events) {
        onPath(path.relative(directory, event.path).split(path.sep).join("/"));
      }
    };
    subscriptions.push(await subscribe(directory, onEvents, { ignore }));
  };
  try {
    if (layout === null) {
      const plainIgnored = [".git", ...WORKSPACE_IGNORED_GLOBS];
      await watchTree(root, plainIgnored, () => note("status"));
      return stop;
    }
    const sharedGitDir = layout.gitDir === layout.commonDir;
    const ignored = await ignoredDirectories(ctx, root);
    const workIgnored = [".git", ...WORKSPACE_IGNORED_GLOBS, ...ignored];
    await watchTree(root, workIgnored, () => note("status"));
    const gitIgnored = sharedGitDir ? COMMON_DIR_IGNORED : [];
    await watchTree(layout.gitDir, gitIgnored, (relativePath) => {
      if (GIT_DIR_NOISE.test(relativePath)) return;
      const sharedRef = sharedGitDir && SHARED_REF.test(relativePath);
      if (relativePath === "HEAD" || sharedRef) note("status", "refs");
      else note("status");
    });
    if (sharedGitDir) return stop;
    await watchTree(layout.commonDir, COMMON_DIR_IGNORED, (relativePath) => {
      const lock = relativePath.endsWith(".lock");
      if (SHARED_REF.test(relativePath) && !lock) note("refs");
    });
    return stop;
  } catch (error) {
    await stop();
    throw error;
  }
}

async function watchDirectory(
  ctx: Ctx,
  directory: string,
  emit: (change: Change) => void,
) {
  if (isInside(ctx.dataDir, path.resolve(directory))) {
    await fs.mkdir(directory, { recursive: true });
  }
  const scheduler = createDebouncedCallbackScheduler({
    ...DEBOUNCE,
    onFlush: () => emit("files"),
  });
  const root = await fs.realpath(directory);
  const subscription = await subscribe(root, () => scheduler.schedule());
  return async () => {
    scheduler.dispose();
    await subscription.unsubscribe().catch(() => undefined);
  };
}

export function createWatcher(ctx: Ctx): Watcher {
  const active = new Map<string, Promise<Stop | null>>();
  let latestGeneration = Number.NEGATIVE_INFINITY;
  const locked = (work: () => Promise<void>) => ctx.lock("watched-paths", work);

  const stop = async (key: string) => {
    const watch = active.get(key);
    active.delete(key);
    const stopWatching = await watch;
    await stopWatching?.();
  };

  const start = (key: string, kind: WatchKind, target: string) => {
    const emit = (change: Change) => {
      if (active.has(key)) ctx.sink({ ...CHANGED, path: target, change });
    };
    const watch = (
      kind === "workspace"
        ? watchWorkspace(ctx, target, emit)
        : watchDirectory(ctx, target, emit)
    ).catch(() => null);
    active.set(key, watch);
    void watch.then((started) => {
      if (started === null && active.get(key) === watch) active.delete(key);
    });
  };

  return {
    setWatchedPaths: (args) =>
      locked(async () => {
        if (args.generation <= latestGeneration) return;
        latestGeneration = args.generation;
        const wanted = new Map<string, [WatchKind, string]>();
        const want = (kind: WatchKind, target: string) =>
          wanted.set(`${kind}\0${target}`, [kind, target]);
        for (const target of args.workspaces) want("workspace", target);
        for (const target of args.directories) want("directory", target);
        const stale = [...active.keys()].filter((key) => !wanted.has(key));
        await Promise.all(stale.map(stop));
        for (const [key, [kind, target]] of wanted) {
          if (!active.has(key)) start(key, kind, target);
        }
        await Promise.all(active.values());
      }),
    dispose: () =>
      locked(async () => {
        await Promise.all([...active.keys()].map(stop));
      }),
  };
}
