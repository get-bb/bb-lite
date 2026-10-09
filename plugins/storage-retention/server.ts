import { basename, dirname } from "node:path";
import {
  environments,
  machines,
  threads,
  type PluginServerApi,
} from "@bb/plugin";
import {
  policySchema,
  runSchema,
  storageRetention,
  usageSchema,
  type Policy,
  type Run,
  type Usage,
} from "./contract.js";
import { registerCli } from "./cli.js";
import { selectCandidates, type RetentionThread } from "./policy.js";

const DEFAULT_POLICY: Policy = {
  archiveAfterDays: null,
  deleteAfterDays: null,
  deleteStorageOnArchive: false,
  deleteDevDataOnCheckoutRemoval: false,
};
const BATCH_LIMIT = 50;
const PAGE = 500;
const PENDING_KEY = "pendingArchives";
const RETIRE_GRACE_MS = 10 * 60_000;
const LARGE_FILE_MIN_BYTES = 10 * 1024 * 1024;

type Listed = RetentionThread & {
  hostId?: string | null;
  title: string | null;
};

const stopped = (thread: { status: string }) =>
  thread.status === "idle" || thread.status === "error";

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default function storageRetentionServer(bb: PluginServerApi): void {
  let running = false;
  const clearing = new Set<string>();

  const readPolicy = async () => {
    const stored = policySchema.safeParse(await bb.storage.kv.get("policy"));
    return stored.success ? stored.data : DEFAULT_POLICY;
  };

  const state = async () => {
    const lastRun = runSchema.safeParse(await bb.storage.kv.get("lastRun"));
    return {
      policy: await readPolicy(),
      lastRun: lastRun.success ? lastRun.data : null,
    };
  };

  const listThreads = async (filter: { hostId?: string } = {}) => {
    const rows: Listed[] = [];
    for (const archived of [false, true]) {
      for (let offset = 0; ; offset += PAGE) {
        const page = await bb.call(threads.list, {
          ...filter,
          archived,
          includeHidden: true,
          limit: PAGE,
          offset,
        });
        rows.push(...page);
        if (page.length < PAGE) break;
      }
    }
    return rows;
  };

  const candidates = async (policy: Policy) =>
    selectCandidates(await listThreads(), policy, bb.now());

  const preview = async (policy: Policy) => {
    const result = await candidates(policy);
    const total = (groups: typeof result.archive) =>
      new Set(groups.flatMap((group) => group.memberIds)).size;
    return {
      archiveCount: total(result.archive),
      deleteCount: total(result.delete),
    };
  };

  const sweep = async (): Promise<Run | null> => {
    if (running) return null;
    running = true;
    try {
      const policy = await readPolicy();
      if (policy.archiveAfterDays === null && policy.deleteAfterDays === null)
        return null;
      const selected = await candidates(policy);
      const run: Run = {
        ranAt: bb.now(),
        archivedCount: 0,
        deletedCount: 0,
        failedCount: 0,
      };
      for (const action of ["archive", "delete"] as const) {
        for (const candidate of selected[action].slice(0, BATCH_LIMIT)) {
          const current = await readPolicy();
          if (
            current.archiveAfterDays !== policy.archiveAfterDays ||
            current.deleteAfterDays !== policy.deleteAfterDays
          )
            break;
          try {
            const fresh = (await candidates(current))[action].find(
              (entry) => entry.rootId === candidate.rootId,
            );
            if (fresh === undefined) continue;
            const threadId = candidate.rootId;
            if (action === "archive") {
              const result = await bb.call(threads.archive, { threadId });
              run.archivedCount += result.archivedThreadIds.length;
            } else {
              await bb.call(threads.delete, {
                threadId,
                childThreadsConfirmed: true,
              });
              run.deletedCount += fresh.memberIds.length;
            }
          } catch (error) {
            run.failedCount++;
            bb.log.warn(
              `Could not ${action} ${candidate.rootId}: ${messageOf(error)}`,
            );
          }
        }
      }
      await bb.storage.kv.set("lastRun", run);
      bb.changed(storageRetention.state);
      return run;
    } finally {
      running = false;
    }
  };

  const machine = async (hostId: string) => {
    const host = (await bb.call(machines.list, {})).find(
      (entry) => entry.id === hostId,
    );
    if (host === undefined) throw new Error(`Unknown machine ${hostId}.`);
    return host;
  };

  const rootOf = async (hostId: string, known: readonly Listed[]) => {
    for (const thread of known) {
      const location = await bb.call(threads.storageLocation, {
        threadId: thread.id,
      });
      if (location?.hostId === hostId) return dirname(location.path);
    }
    throw new Error(`No thread storage is known on machine ${hostId}.`);
  };

  const cached = async (hostId: string) => {
    const stored = usageSchema.safeParse(
      await bb.storage.kv.get(`usage:${hostId}`),
    );
    return stored.success ? stored.data : null;
  };

  const scanHost = async (hostId: string): Promise<Usage> => {
    const host = await machine(hostId);
    if (host.status !== "connected")
      throw new Error(`Machine ${hostId} is offline.`);
    const known = await listThreads({ hostId });
    const rootPath = await rootOf(hostId, known);
    const measured = await bb.runners.call(hostId, storageRetention.measure, {
      rootPath,
    });
    const byId = new Map(known.map((thread) => [thread.id, thread]));
    const usage: Usage = {
      hostId,
      name: host.name,
      scannedAt: bb.now(),
      rootPath,
      disk: measured.disk,
      threadStorageBytes: measured.entries.reduce(
        (sum, entry) => sum + entry.sizeBytes,
        0,
      ),
      threads: [],
      orphans: [],
    };
    for (const entry of measured.entries) {
      const thread = byId.get(entry.name);
      if (thread === undefined) {
        usage.orphans.push(entry);
        continue;
      }
      const archived = thread.archivedAt !== null;
      usage.threads.push({
        threadId: thread.id,
        title: thread.title,
        sizeBytes: entry.sizeBytes,
        archived,
        clearable: archived && thread.pinnedAt === null && stopped(thread),
      });
    }
    await bb.storage.kv.set(`usage:${hostId}`, usage);
    bb.changed(storageRetention.usage);
    return usage;
  };

  const usage = async ({ hostId }: { hostId?: string }) => {
    const ids =
      hostId === undefined
        ? (await bb.call(machines.list, {})).map((host) => host.id)
        : [hostId];
    const reports = await Promise.all(ids.map(cached));
    return reports.filter((report) => report !== null);
  };

  const scan = async ({ hostId }: { hostId?: string }) => {
    if (hostId !== undefined) return [await scanHost(hostId)];
    const hosts = await bb.call(machines.list, {});
    const results = await Promise.allSettled(
      hosts
        .filter((host) => host.status === "connected")
        .map((host) => scanHost(host.id)),
    );
    return results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
  };

  const requireScan = async (hostId: string) => {
    const report = await cached(hostId);
    if (report === null)
      throw new Error(`Scan machine ${hostId} first with storage usage.`);
    return report;
  };

  const removeOrphans = async ({ hostId }: { hostId: string }) => {
    const before = await requireScan(hostId);
    const fresh = await scanHost(hostId);
    const names = new Set(before.orphans.map((entry) => entry.name));
    const orphans = fresh.orphans.filter((entry) => names.has(entry.name));
    if (orphans.length === 0) return { removedCount: 0, removedBytes: 0 };
    const { removed } = await bb.runners.call(hostId, storageRetention.clear, {
      rootPath: fresh.rootPath,
      names: orphans.map((entry) => entry.name),
      recreate: false,
    });
    await scanHost(hostId);
    return {
      removedCount: removed.length,
      removedBytes: removed.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    };
  };

  const retryWorktreeCleanup = async ({ hostId }: { hostId: string }) => {
    const host = await machine(hostId);
    if (host.status !== "connected")
      throw new Error(`Machine ${hostId} is offline.`);
    const [all, known] = await Promise.all([
      bb.call(environments.list, { hostId }),
      listThreads(),
    ]);
    const occupied = new Set(
      known
        .filter(
          (thread) =>
            thread.archivedAt === null ||
            thread.status === "active" ||
            thread.status === "stopping",
        )
        .map((thread) => thread.environmentId),
    );
    const cutoff = bb.now() - RETIRE_GRACE_MS;
    const leftovers = all.filter(
      ({ id, isWorktree, path, status, lifecycle }) =>
        isWorktree &&
        path !== null &&
        status !== "destroyed" &&
        lifecycle.teardown?.status !== "removed" &&
        !occupied.has(id) &&
        (lifecycle.teardown?.status === "failed" ||
          (lifecycle.retireAt !== null && lifecycle.retireAt < cutoff)),
    );
    let retriedCount = 0;
    for (const { id } of leftovers) {
      await bb.call(environments.delete, { environmentId: id });
      retriedCount++;
    }
    return { retriedCount };
  };

  const clearThread = async ({ threadId }: { threadId: string }) => {
    if (clearing.has(threadId))
      throw new Error(`Thread ${threadId} is already being cleared.`);
    clearing.add(threadId);
    try {
      const thread = await bb.call(threads.get, { threadId });
      if (!stopped(thread))
        throw new Error("Stop the thread before clearing its storage.");
      const location = await bb.call(threads.storageLocation, { threadId });
      if (location === null)
        throw new Error(`Thread ${threadId} has no storage machine.`);
      await bb.runners.call(location.hostId, storageRetention.clear, {
        rootPath: dirname(location.path),
        names: [basename(location.path)],
        recreate: true,
      });
      const report = await cached(location.hostId);
      const entry = report?.threads.find((row) => row.threadId === threadId);
      if (report !== null && entry !== undefined) {
        report.threadStorageBytes -= entry.sizeBytes;
        entry.sizeBytes = 0;
        await bb.storage.kv.set(`usage:${location.hostId}`, report);
        bb.changed(storageRetention.usage);
      }
      return { ok: true as const };
    } finally {
      clearing.delete(threadId);
    }
  };

  const archivedNames = async (report: Usage) => {
    const names: string[] = [];
    for (const entry of report.threads) {
      if (!entry.clearable || entry.sizeBytes === 0) continue;
      const thread = await bb.call(threads.get, { threadId: entry.threadId });
      if (
        thread.archivedAt !== null &&
        thread.pinnedAt === null &&
        stopped(thread)
      )
        names.push(thread.id);
    }
    return names;
  };

  const clearArchivedFiles = async ({ hostId }: { hostId: string }) => {
    const report = await requireScan(hostId);
    const names = await archivedNames(report);
    if (names.length === 0) return { clearedThreads: 0, clearedBytes: 0 };
    const { removed } = await bb.runners.call(hostId, storageRetention.clear, {
      rootPath: report.rootPath,
      names,
      recreate: true,
    });
    await scanHost(hostId);
    return {
      clearedThreads: removed.length,
      clearedBytes: removed.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    };
  };

  const clearLargeFiles = async ({ hostId }: { hostId?: string }) => {
    const reports =
      hostId === undefined ? await usage({}) : [await requireScan(hostId)];
    const online = new Set(
      (await bb.call(machines.list, {}))
        .filter((host) => host.status === "connected")
        .map((host) => host.id),
    );
    const total = { clearedThreads: 0, clearedFiles: 0, clearedBytes: 0 };
    for (const report of reports) {
      if (!online.has(report.hostId)) {
        if (hostId === undefined) continue;
        throw new Error(`Machine ${report.hostId} is offline.`);
      }
      const names = await archivedNames(report);
      if (names.length === 0) continue;
      const { removed } = await bb.runners.call(
        report.hostId,
        storageRetention.discardLargeFiles,
        { rootPath: report.rootPath, names, minBytes: LARGE_FILE_MIN_BYTES },
      );
      for (const entry of removed) {
        if (entry.count === 0) continue;
        total.clearedThreads++;
        total.clearedFiles += entry.count;
        total.clearedBytes += entry.sizeBytes;
      }
      await scanHost(report.hostId);
    }
    return total;
  };

  const pending = async () => {
    const stored = await bb.storage.kv.get<unknown>(PENDING_KEY);
    return Array.isArray(stored)
      ? stored.filter((id): id is string => typeof id === "string")
      : [];
  };
  const setPending = (ids: string[]) =>
    bb.storage.kv.set(PENDING_KEY, [...new Set(ids)]);

  const clearPendingArchives = async () => {
    const ids = await pending();
    if (ids.length === 0) return;
    if (!(await readPolicy()).deleteStorageOnArchive) return setPending([]);
    const left: string[] = [];
    for (const threadId of ids) {
      try {
        const thread = await bb.call(threads.get, { threadId });
        if (thread.archivedAt === null || thread.pinnedAt !== null) continue;
        if (!stopped(thread)) left.push(threadId);
        else await clearThread({ threadId });
      } catch (error) {
        left.push(threadId);
        bb.log.warn(`Could not clear ${threadId}: ${messageOf(error)}`);
      }
    }
    await setPending(left);
  };

  bb.on(threads.archived, async ({ thread }) => {
    if (thread.pinnedAt !== null) return;
    if (!(await readPolicy()).deleteStorageOnArchive) return;
    await setPending([...(await pending()), thread.id]);
    await clearPendingArchives();
  });
  for (const event of [threads.unarchived, threads.deleted])
    bb.on(event, async ({ thread }) =>
      setPending((await pending()).filter((id) => id !== thread.id)),
    );
  bb.on(threads.idle, () => clearPendingArchives());

  bb.implement(storageRetention.state, state);
  bb.implement(storageRetention.preview, preview);
  bb.implement(storageRetention.configure, async (policy) => {
    await bb.storage.kv.set("policy", policy);
    bb.changed(storageRetention.state);
    return state();
  });
  bb.implement(storageRetention.run, sweep);
  bb.implement(storageRetention.usage, usage);
  bb.implement(storageRetention.scan, scan);
  bb.implement(storageRetention.removeOrphans, removeOrphans);
  bb.implement(storageRetention.clearThread, clearThread);
  bb.implement(storageRetention.retryWorktreeCleanup, retryWorktreeCleanup);
  bb.implement(storageRetention.clearArchivedFiles, clearArchivedFiles);
  bb.implement(storageRetention.clearLargeFiles, clearLargeFiles);

  bb.background.schedule("retention", "0 * * * *", async () => {
    await sweep();
  });
  bb.background.schedule(
    "archive-storage-cleanup",
    "* * * * *",
    clearPendingArchives,
  );
  registerCli(bb);
}
