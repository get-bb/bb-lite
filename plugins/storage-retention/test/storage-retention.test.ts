import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { scratch } from "../../../apps/server/test/helpers.js";
import { createThreadServer } from "../../../apps/server/test/thread-harness.js";
import { storageRetention } from "../contract.js";
import { nodeFs, storageOps } from "../runner.js";

const DAY = 86_400_000;

vi.mock("node:timers/promises", async (original) => ({
  ...(await original<typeof import("node:timers/promises")>()),
  setTimeout: (
    ms: number,
    value: unknown,
    options?: { signal?: AbortSignal },
  ) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(value), ms);
      options?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(options.signal?.reason);
      });
    }),
}));

type Sent = { name: string; input: never };

async function storageServer() {
  const server = await createThreadServer();
  const root = scratch();
  server.ctx.db.run("UPDATE hosts SET thread_storage_root = ?", root);
  const ops = storageOps(nodeFs, async () => undefined);
  const fallback = server.runner.script.callOp;
  server.runner.script.callOp = async (op) => {
    const { name, input } = op as Sent;
    if (name === "storage-retention.measure") return ops.measure(input);
    if (name === "storage-retention.clear") return ops.clear(input);
    if (name === "storage-retention.discardLargeFiles")
      return ops.discardLargeFiles(input);
    return fallback?.(op);
  };
  const cli = async (...argv: string[]) => {
    const { body } = await server.http<{
      exitCode: number;
      stdout?: string;
      stderr?: string;
    }>("POST", "/plugins/storage-retention/cli", { argv });
    return { ...body, json: () => JSON.parse(body.stdout ?? "null") };
  };
  const op = async (name: string, input: object = {}) => {
    const path = `/ops/storage-retention.${name}`;
    const { body } = await server.http<{ result: unknown }>(
      "POST",
      path,
      input,
    );
    return body.result;
  };
  const idle = async (threadId: string) => {
    await server.runTurn(threadId, `turn-${threadId}`);
    return threadId;
  };
  const fill = (threadId: string, bytes: number) => {
    mkdirSync(join(root, threadId), { recursive: true });
    writeFileSync(join(root, threadId, "big.bin"), Buffer.alloc(bytes));
  };
  return { ...server, root, cli, op, idle, fill };
}

it("previews, saves and runs the retention policy", async () => {
  const server = await storageServer();
  const first = await server.idle(await server.spawn());
  const second = await server.idle(await server.spawn());
  server.clock.now += 31 * DAY;

  const empty = await server.cli("retention");
  expect(empty.json()).toEqual({
    policy: {
      archiveAfterDays: null,
      deleteAfterDays: null,
      deleteStorageOnArchive: false,
      deleteDevDataOnCheckoutRemoval: false,
    },
    lastRun: null,
  });
  const preview = await server.cli("retention", "--archive-after", "30");
  expect(preview.json().preview).toEqual({ archiveCount: 2, deleteCount: 0 });
  const unconfirmed = await server.cli(
    "retention",
    "--archive-after",
    "30",
    "--save",
  );
  expect(unconfirmed.exitCode).toBe(1);
  const bad = await server.cli("retention", "--archive-after", "soon");
  expect(bad.stderr).toContain("number of days");

  const saved = await server.cli(
    "retention",
    "--archive-after",
    "30",
    "--delete-after",
    "7",
    "--save",
    "--yes",
  );
  expect(saved.json().policy.archiveAfterDays).toBe(30);

  expect(await server.op("run")).toMatchObject({
    archivedCount: 2,
    deletedCount: 0,
    failedCount: 0,
  });
  expect(server.thread(first)).toMatchObject({ archivedAt: server.clock.now });

  server.clock.now += 8 * DAY;
  expect(await server.op("run")).toMatchObject({ deletedCount: 2 });
  const remaining = server.rows<{ id: string }>(
    "SELECT id FROM threads WHERE id IN (?, ?) AND deleted_at IS NULL",
    first,
    second,
  );
  expect(remaining).toEqual([]);
  const state = await server.cli("retention");
  expect(state.json().lastRun).toMatchObject({ deletedCount: 2 });
});

it("archives and deletes only threads past the policy age", async () => {
  const server = await storageServer();
  const old = await server.idle(await server.spawn());
  const pinned = await server.idle(await server.spawn());
  await server.http("POST", `/threads/${pinned}/pin`, {});
  const parent = await server.idle(await server.spawn());
  const child = await server.idle(
    await server.spawn({ parentThreadId: parent }),
  );
  server.clock.now += 10 * DAY;
  const fresh = await server.idle(await server.spawn());
  await server.cli(
    "retention",
    "--archive-after",
    "7",
    "--delete-after",
    "3",
    "--save",
    "--yes",
  );
  const archivedAt = (id: string) => server.thread(id).archivedAt;

  expect(await server.op("run")).toMatchObject({ failedCount: 0 });
  for (const id of [old, parent, child])
    expect(archivedAt(id)).toBe(server.clock.now);
  for (const id of [pinned, fresh]) expect(archivedAt(id)).toBeNull();

  server.clock.now += 2 * DAY;
  await server.http("POST", `/threads/${fresh}/archive-all`, {});
  expect(await server.op("run")).toMatchObject({ deletedCount: 0 });

  server.clock.now += 2 * DAY;
  await server.op("run");
  const deleted = (id: string) => server.thread(id)?.deletedAt !== null;
  for (const id of [old, parent, child]) expect(deleted(id)).toBe(true);
  for (const id of [pinned, fresh]) expect(deleted(id)).toBe(false);
});

it("runs the retention policy on its hourly schedule", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date(2026, 0, 1, 10, 0, 30));
  try {
    const server = await storageServer();
    const old = await server.idle(await server.spawn());
    server.clock.now += 31 * DAY;
    await server.cli("retention", "--archive-after", "30", "--save", "--yes");
    await vi.advanceTimersByTimeAsync(58 * 60_000);
    expect(server.thread(old).archivedAt).toBeNull();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await server.settle();
    expect(server.thread(old).archivedAt).toBe(server.clock.now);
    const state = await server.cli("retention");
    expect(state.json().lastRun).toMatchObject({ archivedCount: 1 });
  } finally {
    vi.useRealTimers();
  }
});

it("scans thread storage and clears orphans and archived files", async () => {
  const server = await storageServer();
  const kept = await server.idle(await server.spawn());
  const archived = await server.idle(await server.spawn());
  server.fill(kept, 1000);
  server.fill(archived, 2000);
  server.fill("orphan-dir", 500);
  await server.http("POST", `/threads/${archived}/archive-all`, {});

  const scanned = await server.cli(
    "usage",
    "--machine",
    server.hostId,
    "--rescan",
  );
  const [report] = scanned.json();
  expect(report.threadStorageBytes).toBe(3500);
  expect(report.orphans).toEqual([{ name: "orphan-dir", sizeBytes: 500 }]);
  expect(report.threads).toContainEqual({
    threadId: archived,
    title: server.thread(archived).title,
    sizeBytes: 2000,
    archived: true,
    clearable: true,
  });
  expect((await server.cli("usage")).json()).toHaveLength(1);

  const orphans = await server.cli(
    "remove-orphans",
    "--machine",
    server.hostId,
    "--yes",
  );
  expect(orphans.json()).toEqual({ removedCount: 1, removedBytes: 500 });
  const cleared = await server.cli(
    "clear-archived-files",
    "--machine",
    server.hostId,
    "--yes",
  );
  expect(cleared.json()).toEqual({ clearedThreads: 1, clearedBytes: 2000 });
  expect(readdirSync(server.root).sort()).toEqual([archived, kept].sort());
  expect(readdirSync(join(server.root, archived))).toEqual([]);

  const thread = await server.cli("clear-thread", "--thread", kept);
  expect(thread.exitCode).toBe(1);
  await server.cli("clear-thread", "--thread", kept, "--yes");
  expect(readdirSync(join(server.root, kept))).toEqual([]);

  const retry = await server.cli(
    "retry-worktree-cleanup",
    "--machine",
    server.hostId,
  );
  expect(retry.json()).toEqual({ retriedCount: 0 });
  expect((await server.cli("retry-worktree-cleanup")).exitCode).toBe(1);
  await expect(
    server.ctx.kernel.call(storageRetention.removeOrphans, {
      hostId: "host_missing",
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(
    server.ctx.kernel.call(storageRetention.retryWorktreeCleanup, {
      hostId: "host_missing",
    }),
  ).rejects.toMatchObject({ code: "not_found" });
  const machine = ["--machine", server.hostId, "--yes"];
  const cleanup = await server.cli(
    "cleanup",
    "--kind",
    "worktrees",
    ...machine,
  );
  expect(cleanup.json()).toEqual({ retriedCount: 0 });
  const dev = await server.cli("cleanup", "--kind", "development", ...machine);
  expect(dev.stderr).toContain("orphans or worktrees");
});

it("clears thread storage on archive when the policy asks for it", async () => {
  const server = await storageServer();
  const threadId = await server.idle(await server.spawn());
  server.fill(threadId, 100);
  await server.cli(
    "retention",
    "--delete-storage-on-archive",
    "true",
    "--save",
    "--yes",
  );
  await server.http("POST", `/threads/${threadId}/archive-all`, {});
  await expect.poll(() => readdirSync(join(server.root, threadId))).toEqual([]);
});

it("deletes large files from archived threads only", async () => {
  const server = await storageServer();
  const active = await server.idle(await server.spawn());
  const archived = await server.idle(await server.spawn());
  const big = 10 * 1024 * 1024;
  server.fill(active, big);
  server.fill(archived, big);
  writeFileSync(join(server.root, archived, "small.txt"), "keep");
  await server.http("POST", `/threads/${archived}/archive-all`, {});

  const unscanned = await server.cli("clear-large-files", "--yes");
  expect(unscanned.json()).toEqual({
    clearedThreads: 0,
    clearedFiles: 0,
    clearedBytes: 0,
  });
  await server.cli("usage", "--rescan");
  expect((await server.cli("clear-large-files")).exitCode).toBe(1);
  const cleared = await server.cli(
    "clear-large-files",
    "--machine",
    server.hostId,
    "--yes",
  );
  expect(cleared.json()).toEqual({
    clearedThreads: 1,
    clearedFiles: 1,
    clearedBytes: big,
  });
  expect(readdirSync(join(server.root, archived))).toEqual(["small.txt"]);
  expect(readdirSync(join(server.root, active))).toEqual(["big.bin"]);
  const [report] = (await server.cli("usage")).json();
  expect(report.threadStorageBytes).toBe(big + 4);
});
