import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { scratch } from "../../../apps/server/test/helpers.js";
import { createThreadServer } from "../../../apps/server/test/thread-harness.js";
import { nodeFs, storageOps } from "../runner.js";

const DAY = 86_400_000;

type Sent = { name: string; input: never };

async function storageServer() {
  const server = await createThreadServer();
  const root = scratch();
  server.ctx.db.run("UPDATE hosts SET thread_storage_root = ?", root);
  const ops = storageOps(nodeFs);
  const fallback = server.runner.script.callOp;
  server.runner.script.callOp = async (op) => {
    const { name, input } = op as Sent;
    if (name === "storage-retention.measure") return ops.measure(input);
    if (name === "storage-retention.clear") return ops.clear(input);
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
