import type { PendingInteractionPayload } from "@bb/domain";
import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/index.js";
import { createServer } from "../src/server.js";
import { FakeRunner } from "./helpers.js";
import { createThreadServer, events, text } from "./thread-harness.js";

type Server = Awaited<ReturnType<typeof createThreadServer>>;

const approval: PendingInteractionPayload = {
  kind: "approval",
  subject: {
    kind: "command",
    itemId: "i1",
    command: "rm -rf build",
    cwd: null,
    actions: [],
    sessionGrant: null,
  },
  reason: null,
  availableDecisions: ["allow_once", "deny"],
};
const provider = { providerId: "codex" as const, providerThreadId: "prov-1" };

function requestApproval(server: Server, threadId: string, requestId: string) {
  const request = { threadId, turnId: "t1", requestId, ...provider };
  const kind = "interaction.requested";
  return server.emit({ kind, ...request, payload: approval });
}

function callsTo(server: Server, method: string): unknown[] {
  return server.runner.calls
    .filter((call) => call.method === method)
    .map((call) => call.args[0]);
}

function noticeTexts(server: Server, threadId: string): string[] {
  return server
    .eventData(threadId, "client/turn/requested")
    .filter((request) => request.initiator === "system")
    .map((request) => (request.input as { text: string }[])[0].text);
}

it("registers, resolves and refuses provider interactions", async () => {
  const server = await createThreadServer();
  const { api, ctx, eventData, ingest } = server;
  const id = await server.spawn();
  await ingest(id, events.identity(), events.started("t1"));
  const client = await server.socket();
  await client.subscribe({ kind: "thread-list" });
  await requestApproval(server, id, "req-1");
  await requestApproval(server, id, "req-1");
  await requestApproval(server, id, "req-2");

  const [pending] = ctx.db.all<{ id: string; status: string }>(
    "SELECT id, status FROM pending_interactions",
  );
  expect(pending.status).toBe("pending");
  const refused = { threadId: id, requestId: "req-2" };
  expect(callsTo(server, "resolveInteraction")).toEqual([
    { ...refused, resolution: { decision: "deny" } },
  ]);
  const changed = await client.next((message) =>
    (message.changes as string[]).includes("interactions-changed"),
  );
  const flagged = { hasPendingInteraction: true, projectId: "proj_1" };
  expect(changed.metadata).toEqual(flagged);

  const param = { id, interactionId: pending.id };
  const interaction = api.threads[":id"].interactions[":interactionId"];
  const invalid = await interaction.resolve.$post({
    param,
    json: { decision: "allow_for_session", grantedPermissions: null },
  });
  expect(invalid.status).toBe(400);
  const resolution = {
    decision: "allow_once",
    grantedPermissions: null,
  } as const;
  const resolved = await interaction.resolve.$post({ param, json: resolution });
  expect(await resolved.json()).toMatchObject({ status: "resolving" });
  await server.settle();
  const accepted = { threadId: id, requestId: "req-1", resolution };
  expect(callsTo(server, "resolveInteraction").at(-1)).toEqual(accepted);
  const lifecycle = eventData(id, "system/interaction/lifecycle").map(
    (event) => (event.interaction as { status: string }).status,
  );
  expect(lifecycle).toEqual(["pending", "resolving", "resolved"]);
});

it("answers plugin interactions through requestInput", async () => {
  const server = await createThreadServer();
  const { api, ctx } = server;
  const id = await server.spawn();
  const request = { threadId: id, pluginId: "secrets", rendererId: "form" };
  const form = { ...request, title: "Secret", payload: { name: "TOKEN" } };
  const first = ctx.threads.requestInput(form);
  await server.settle();
  await expect(ctx.threads.requestInput(form)).rejects.toMatchObject({
    status: 409,
  });
  const [row] = ctx.db.all<{ id: string }>(
    "SELECT id FROM pending_interactions",
  );
  const param = { id, interactionId: row.id };
  const interaction = api.threads[":id"].interactions[":interactionId"];
  const answered = await interaction.respond.$post({
    param,
    json: { value: { token: "abc" } },
  });
  expect(await answered.json()).toMatchObject({
    status: "resolved",
    origin: { kind: "plugin", pluginId: "secrets" },
  });
  expect(await first).toEqual({
    outcome: "submitted",
    value: { token: "abc" },
  });

  const second = ctx.threads.requestInput(form);
  await server.settle();
  const [, next] = ctx.db.all<{ id: string }>(
    "SELECT id FROM pending_interactions ORDER BY created_at, rowid",
  );
  await interaction.cancel.$post({ param: { id, interactionId: next.id } });
  expect(await second).toEqual({ outcome: "cancelled", reason: "user" });
});

it("runs core and extension tools for the provider", async () => {
  const server = await createThreadServer();
  const { ctx, emit, thread } = server;
  const id = await server.spawn();
  const before = thread(id).environmentId;
  ctx.extensions.callAgentTool = async (name, args, call) =>
    name === "Echo"
      ? {
          success: true,
          contentItems: [
            {
              type: "inputText",
              text: `${JSON.stringify(args)} ${call.callId}`,
            },
          ],
        }
      : null;
  const call = {
    kind: "toolCall.requested" as const,
    threadId: id,
    turnId: "t1",
  };
  const invoke = async (tool: string, args: unknown, requestId: string) => {
    await emit({
      ...call,
      requestId,
      callId: `call-${requestId}`,
      tool,
      arguments: args,
    });
    const resolved = callsTo(server, "resolveToolCall").at(-1) as {
      requestId: string;
      result: { success: boolean; contentItems: { text: string }[] };
    };
    expect(resolved.requestId).toBe(requestId);
    return [resolved.result.success, resolved.result.contentItems[0].text];
  };
  expect(await invoke("Echo", { a: 1 }, "r1")).toEqual([
    true,
    '{"a":1} call-r1',
  ]);
  expect(await invoke("Nope", {}, "r2")).toEqual([
    false,
    "Unsupported tool: Nope",
  ]);
  const move = "update_environment_directory";
  expect((await invoke(move, { path: "relative" }, "r3"))[0]).toBe(false);
  const moved = await invoke(move, { path: "/other/checkout/" }, "r4");
  expect(moved[1]).toContain("updated to /other/checkout");
  expect(thread(id).environmentId).not.toBe(before);
});

it("tells a parent about its children in batches", async () => {
  const server = await createThreadServer();
  const { clock, ctx, ingest, queued, runTurn, thread } = server;
  const parent = await server.spawn({ title: "Parent" });
  await runTurn(parent, "p1");
  const child = (title: string) =>
    server.spawn({ title, parentThreadId: parent, origin: "cli" });
  const flush = async (): Promise<void> => {
    clock.now += 2_000;
    ctx.threads.sweep();
    await server.settle();
  };
  const [one, two] = [await child("One"), await child("Two")];
  await runTurn(one, "a1", "all green");
  await ingest(two, events.identity(), events.started("b1"));
  await ingest(two, events.completed("b1", "failed"));
  expect(noticeTexts(server, parent)).toEqual([]);
  await flush();
  expect(noticeTexts(server, parent)).toEqual([
    `[bb system]\n\nChild thread updates:\n\n- @thread:${one} completed.\n` +
      `- @thread:${two} failed.`,
  ]);
  expect(thread(parent).status).toBe("active");
  expect(thread(one).latestAttentionAt).toBe(thread(one).createdAt);
  const [batch] = server
    .eventData(parent, "client/turn/requested")
    .filter((request) => request.initiator === "system");
  expect(batch).toMatchObject({
    systemMessageKind: "child-outcome-batch",
    systemMessageSubject: { kind: "thread-batch", count: 2 },
    target: { kind: "new-turn" },
  });

  await ingest(parent, events.started("p2"));
  await ingest(one, events.started("a2"));
  await requestApproval(server, one, "child-req");
  expect(noticeTexts(server, parent).at(-1)).toContain(
    `@thread:${one} needs help.\nBlocked on command:\nCommand: rm -rf build`,
  );
  expect(server.submitted.at(-1)?.mode).toEqual({ kind: "auto" });

  await requestApproval(server, parent, "parent-req");
  await ingest(one, events.completed("a2"));
  await flush();
  expect(queued(parent)).toEqual(["interaction"]);
  const [notice] = ctx.db.all(
    "SELECT system_notice FROM queued_thread_messages",
  );
  expect(JSON.stringify(notice)).toContain("child-completed");
  await ingest(parent, events.completed("p2"));
  expect(noticeTexts(server, parent).at(-1)).toBe(
    `[bb system]\n\n@thread:${one} completed:\n\nall green`,
  );
});

it("archives a tree, keeps turns through the undo grace and unarchives", async () => {
  const server = await createThreadServer();
  const { api, clock, ctx, ingest, thread } = server;
  const parent = await server.spawn();
  const child = await server.spawn({ parentThreadId: parent });
  await ingest(child, events.identity(), events.started("c1"));
  const client = await server.socket();
  await client.subscribe({ kind: "thread-detail", threadId: child });

  const archived = await api.threads[":id"]["archive-all"].$post({
    param: { id: parent },
  });
  expect(await archived.json()).toEqual({
    ok: true,
    archivedThreadIds: [child, parent],
  });
  const change = await client.next();
  expect(change).toMatchObject({
    changes: ["archived-changed"],
    metadata: { projectId: "proj_1" },
  });
  ctx.threads.sweep();
  await server.settle();
  expect(thread(child).status).toBe("active");
  const refused = await ctx.threads
    .send(child, { input: text("hello"), mode: "auto" })
    .catch((error: { body: unknown }) => error.body);
  expect(refused).toMatchObject({ details: { reason: "archived" } });

  clock.now += 30_000;
  ctx.threads.sweep();
  await server.settle();
  expect(thread(child).status).toBe("stopping");
  await ingest(child, events.completed("c1", "interrupted"));
  await api.threads[":id"].unarchive.$post({ param: { id: child } });
  expect(thread(child)).toMatchObject({ status: "idle", archivedAt: null });
  expect(thread(parent).archivedAt).not.toBeNull();
});

it("deletes a thread once its storage is gone, retrying from the sweep", async () => {
  const server = await createThreadServer();
  const { api, ctx, runner } = server;
  const parent = await server.spawn();
  const child = await server.spawn({ parentThreadId: parent });
  const remove = (childThreadsConfirmed: boolean) =>
    api.threads[":id"].$delete({
      param: { id: parent },
      json: { childThreadsConfirmed },
    });
  expect((await remove(false)).status).toBe(409);
  let attempts = 0;
  runner.script.deleteThreadStorage = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("disk busy");
  };
  const client = await server.socket();
  await client.subscribe({ kind: "thread-list" });
  expect((await remove(true)).status).toBe(200);
  await server.settle();
  const tombstone = ctx.db.get<{ deletedAt: number | null }>(
    "SELECT deleted_at FROM threads WHERE id = ?",
    parent,
  );
  expect(tombstone?.deletedAt).not.toBeNull();
  expect((await client.next()).changes).toEqual(["thread-deleted"]);
  ctx.threads.sweep();
  await server.settle();
  const remaining = ctx.db.all<{ id: string; parentThreadId: string | null }>(
    "SELECT id, parent_thread_id FROM threads",
  );
  expect([attempts, remaining]).toEqual([
    2,
    [{ id: child, parentThreadId: null }],
  ]);
});

it("reconciles threads when a runner reconnects", async () => {
  const server = await createThreadServer();
  const { ctx, eventData, hostId, ingest, runner, thread } = server;
  const [kept, lost] = [await server.spawn(), await server.spawn()];
  await ingest(kept, events.identity(), events.started("k1"));
  await ingest(lost, events.identity(), events.started("l1"));
  const session = { providerId: "codex" as const, providerThreadId: "prov-1" };
  const live = { ...session, threadId: kept, activeTurnId: "k1" };
  runner.script.snapshot = async () => ({
    sessions: [live],
    pendingRequestIds: [],
    terminalIds: [],
    lastEventSeq: 0,
  });
  const reconnect = async (): Promise<void> => {
    ctx.runners.connect(hostId, (sink) => {
      runner.emit = sink;
      return runner.api;
    });
    await server.settle();
  };
  await reconnect();
  expect([thread(kept).status, thread(lost).status]).toEqual([
    "active",
    "error",
  ]);
  expect(eventData(lost, "system/thread/interrupted")).toEqual([
    { reason: "host-daemon-restarted", cause: "host-connection-lost" },
  ]);
  expect(eventData(lost, "turn/completed")).toMatchObject([
    { status: "interrupted" },
  ]);

  Object.assign(runner.script, {
    describe: async () => ({ instanceId: "inst-2", homeDir: "/home/me" }),
  });
  await reconnect();
  expect(thread(kept)).toMatchObject({ status: "error", activeTurnId: null });
  expect(eventData(kept, "system/thread/interrupted")).toEqual([
    { reason: "host-daemon-restarted" },
  ]);
});

it("interrupts threads that were running when the server stopped", async () => {
  const dataDir = process.env.TMPDIR ?? "/tmp";
  const env = { BB_DATA_DIR: `${dataDir}/bb-boot-${process.pid}` };
  const config = { ...loadConfig(env), logLevel: "silent" as const, port: 0 };
  const db = openDatabase({ path: ":memory:" });
  const { hostId } = config;
  db.run(
    "INSERT INTO hosts (id, name, created_at, updated_at) VALUES (?, 'h', 1, 1)",
    hostId,
  );
  db.run(
    "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p', 'P', 1, 1)",
  );
  db.run(
    `INSERT INTO environments (id, project_id, host_id, path, status, created_at, updated_at)
     VALUES ('env_1', 'p', ?, '/repo', 'ready', 1, 1)`,
    hostId,
  );
  const insert = (id: string, status: string, environmentId: string | null) =>
    db.run(
      `INSERT INTO threads (id, project_id, environment_id, provider_id, status,
         active_turn_id, latest_attention_at, created_at, updated_at)
       VALUES (?, 'p', ?, 'codex', ?, ?, 1, 1, 1)`,
      id,
      environmentId,
      status,
      status === "active" ? "t1" : null,
    );
  insert("thr_active", "active", "env_1");
  insert("thr_starting", "starting", null);
  insert("thr_idle", "idle", "env_1");
  const runner = new FakeRunner();
  const server = createServer({ config, db, localRunner: () => runner.api });
  await server.listen();
  await server.ctx.threads.settled();
  const statuses = db.all("SELECT id, status FROM threads ORDER BY id");
  expect(statuses).toEqual([
    { id: "thr_active", status: "error" },
    { id: "thr_idle", status: "idle" },
    { id: "thr_starting", status: "error" },
  ]);
  const types = db
    .all<{ type: string }>(
      "SELECT type FROM events WHERE thread_id = 'thr_active' ORDER BY sequence",
    )
    .map((row) => row.type);
  expect(types).toEqual(["turn/completed", "system/thread/interrupted"]);
  await server.close();
});

it("announces every mutation to subscribers", async () => {
  const server = await createThreadServer();
  const { api, ctx } = server;
  const id = await server.spawn();
  const other = await server.spawn();
  const client = await server.socket();
  await client.subscribe({ kind: "thread-detail", threadId: id });
  const param = { id };
  const thread = api.threads[":id"];
  const changes = async (): Promise<unknown> => (await client.next()).changes;

  const renamed = await thread.$patch({ param, json: { title: "Renamed" } });
  expect(await renamed.json()).toMatchObject({ title: "Renamed" });
  expect(await changes()).toEqual(["title-changed"]);
  const pinned = await thread.pin.$post({ param });
  expect((await pinned.json()).pinnedAt).not.toBeNull();
  expect(await changes()).toEqual(["pin-state-changed"]);
  await api.threads[":id"].pin.$post({ param: { id: other } });
  const order = await thread["pin-order"].$patch({
    param,
    json: { previousThreadId: other, nextThreadId: null },
  });
  const entries = await order.json();
  expect(entries.map((entry) => entry.id)).toEqual([other, id]);
  expect(await changes()).toEqual(["pin-state-changed"]);

  await thread.$patch({ param, json: { parentThreadId: other } });
  expect(await changes()).toEqual(["parent-changed"]);
  const cycle = await api.threads[":id"].$patch({
    param: { id: other },
    json: { parentThreadId: id },
  });
  expect(await cycle.json()).toMatchObject({ details: { reason: "cycle" } });

  await thread.unread.$post({ param });
  expect(await changes()).toEqual(["read-state-changed"]);
  const read = await thread.read.$post({ param });
  expect((await read.json()).lastReadAt).toBe(ctx.now());
  expect(await changes()).toEqual(["read-state-changed"]);

  const queuedMessages = thread["queued-messages"];
  const add = async (message: string) => {
    const response = await queuedMessages.$post({
      param,
      json: { input: text(message) },
    });
    expect(await changes()).toEqual(["queue-changed"]);
    return response.json();
  };
  const [first, second] = [await add("first"), await add("second")];
  const edit = (expectedUpdatedAt: number) =>
    queuedMessages[":queuedMessageId"].$patch({
      param: { id, queuedMessageId: first.id },
      json: { expectedUpdatedAt, input: text("first, edited") },
    });
  expect((await edit(first.updatedAt - 1)).status).toBe(409);
  expect((await edit(first.updatedAt)).status).toBe(200);
  expect(await changes()).toEqual(["queue-changed"]);
  const reordered = await queuedMessages[":queuedMessageId"].order.$patch({
    param: { id, queuedMessageId: second.id },
    json: { previousQueuedMessageId: null, nextQueuedMessageId: first.id },
  });
  const ids = (await reordered.json()).map((row) => row.id);
  expect(ids).toEqual([second.id, first.id]);
  const grouped = await queuedMessages["group-boundary"].$patch({
    param,
    json: {
      expectedGroupedPrefixQueuedMessageIds: ids,
      groupBoundaryQueuedMessageId: first.id,
    },
  });
  const flags = (await grouped.json()).map((row) => row.groupWithNext);
  expect(flags).toEqual([true, false]);
  await queuedMessages[":queuedMessageId"].$delete({
    param: { id, queuedMessageId: second.id },
  });

  const opened = await thread.open.$post({ param, json: { file: null } });
  expect(await opened.json()).toEqual({ delivered: 1 });
  const signal = await client.next((message) => message.type === "thread-open");
  expect(signal).toMatchObject({ threadId: id, split: "replace" });
});
