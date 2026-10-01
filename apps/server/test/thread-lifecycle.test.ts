import type { PendingInteractionPayload } from "@bb/domain";
import { expect, it } from "vitest";
import { openDatabase } from "../src/db/index.js";
import { createServer } from "../src/server.js";
import { FakeRunner } from "./helpers.js";
import {
  createThreadServer,
  events,
  text,
  type ThreadServer,
} from "./thread-harness.js";

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

function noticeTexts(server: ThreadServer, threadId: string): string[] {
  return server
    .eventData(threadId, "client/turn/requested")
    .filter((request) => request.initiator === "system")
    .map((request) => (request.input as { text: string }[])[0].text);
}

it("registers, resolves and refuses provider interactions", async () => {
  const server = await createThreadServer();
  const { callsTo, eventData, http, ingest, rows } = server;
  const id = await server.spawn();
  await ingest(id, events.identity(), events.started("t1"));
  const client = await server.socket();
  await client.subscribe({ kind: "thread-list" });
  for (const requestId of ["req-1", "req-1", "req-2"]) {
    await server.interact(id, requestId, approval);
  }
  const pending = rows<{ id: string; status: string }>(
    "SELECT id, status FROM pending_interactions",
  );
  expect(pending).toEqual([{ id: pending[0].id, status: "pending" }]);
  const denied = { requestId: "req-2", resolution: { decision: "deny" } };
  expect(callsTo("resolveInteraction")).toEqual([{ threadId: id, ...denied }]);
  const flagged = { hasPendingInteraction: true, projectId: "proj_1" };
  const changed = await server.changes(client, "interactions-changed");
  expect(changed).toEqual([["interactions-changed"], flagged]);

  const path = `/threads/${id}/interactions/${pending[0].id}/resolve`;
  const rejected = { decision: "allow_for_session", grantedPermissions: null };
  expect((await http("POST", path, rejected)).status).toBe(400);
  const resolution = { decision: "allow_once", grantedPermissions: null };
  const resolved = await http("POST", path, resolution);
  expect(resolved.body.status).toBe("resolving");
  const accepted = { threadId: id, requestId: "req-1", resolution };
  expect(callsTo("resolveInteraction")[1]).toEqual(accepted);
  const lifecycle = eventData(id, "system/interaction/lifecycle").map(
    (event) => (event.interaction as { status: string }).status,
  );
  expect(lifecycle).toEqual(["pending", "resolving", "resolved"]);
});

it("serves a plugin: attributed spawn, workspace files and requestInput", async () => {
  const server = await createThreadServer();
  const { ctx, http, rows, runner } = server;
  const bb = ctx.plugins.deps("secrets");
  const { id } = await bb.threads.spawn({
    projectId: "proj_1",
    input: text("Rotate the token"),
    model: "gpt-test",
    environment: { type: "project-default" },
  });
  await server.settle();
  const origins = rows("SELECT origin_plugin_id FROM threads");
  expect(origins).toEqual([{ originPluginId: "secrets" }]);
  const file = { content: "aGk=", contentEncoding: "base64", sha256: "s" };
  Object.assign(runner.script, { readFile: async () => file });
  const read = await bb.files.read({ threadId: id, path: "a.txt" });
  const located = [{ path: "a.txt", rootPath: "/repo" }];
  expect([read, server.callsTo("readFile")]).toEqual([
    { content: "hi", sha256: "s" },
    located,
  ]);
  const request = { threadId: id, rendererId: "form" };
  const form = { ...request, title: "Secret", payload: { name: "TOKEN" } };
  const latest = (): string =>
    rows<{ id: string }>(
      "SELECT id FROM pending_interactions ORDER BY rowid DESC",
    )[0].id;
  const first = bb.requestInput(form);
  await server.settle();
  const busy = expect.objectContaining({ status: 409 });
  await expect(bb.requestInput(form)).rejects.toEqual(busy);
  const value = { token: "abc" };
  const base = `/threads/${id}/interactions`;
  const answered = await http("POST", `${base}/${latest()}/respond`, { value });
  const origin = { kind: "plugin", pluginId: "secrets" };
  expect(answered.body).toMatchObject({ status: "resolved", origin });
  expect(await first).toEqual({ outcome: "submitted", value });

  const second = bb.requestInput(form);
  await server.settle();
  await http("POST", `${base}/${latest()}/cancel`);
  expect(await second).toEqual({ outcome: "cancelled", reason: "user" });
});

it("runs core and extension tools for the provider", async () => {
  const server = await createThreadServer();
  const { ctx, thread } = server;
  const id = await server.spawn();
  const before = thread(id).environmentId;
  ctx.plugins.callTool = async (name, args, { threadId }) => {
    const reply = `${name} ${JSON.stringify(args)} ${threadId}`;
    const contentItems = [{ type: "inputText" as const, text: reply }];
    return { success: name === "Echo", contentItems };
  };
  const invoke = async (tool: string, args: unknown, requestId: string) => {
    const call = { threadId: id, turnId: "t1", requestId, callId: "c1" };
    const kind = "toolCall.requested";
    await server.emit({ kind, ...call, tool, arguments: args });
    const calls = server.callsTo("resolveToolCall");
    const resolved = calls[calls.length - 1] as {
      requestId: string;
      result: { success: boolean; contentItems: { text: string }[] };
    };
    const { success, contentItems } = resolved.result;
    return [resolved.requestId, success, contentItems[0].text];
  };
  const echoed = ["r1", true, `Echo {"a":1} ${id}`];
  expect(await invoke("Echo", { a: 1 }, "r1")).toEqual(echoed);
  expect((await invoke("Nope", {}, "r2")).slice(0, 2)).toEqual(["r2", false]);
  const move = "update_environment_directory";
  expect((await invoke(move, { path: "relative" }, "r3"))[1]).toBe(false);
  const moved = await invoke(move, { path: "/other/checkout/" }, "r4");
  expect(moved[2]).toContain("updated to /other/checkout.");
  expect(thread(id).environmentId).not.toBe(before);
});

it("tells a parent about its children in batches", async () => {
  const server = await createThreadServer();
  const { ingest, runTurn, submitted, thread } = server;
  const parent = await server.spawn({ title: "Parent" });
  await runTurn(parent, "p1");
  const child = (title: string) =>
    server.spawn({ title, parentThreadId: parent, origin: "cli" });
  const [one, two] = [await child("One"), await child("Two")];
  await runTurn(one, "a1", "all green");
  await ingest(two, events.identity(), events.started("b1"));
  await ingest(two, events.completed("b1", "failed"));
  expect(noticeTexts(server, parent)).toEqual([]);
  await server.advance(2_000);
  expect(noticeTexts(server, parent)).toEqual([
    `[bb system]\n\nChild thread updates:\n\n- @thread:${one} completed.\n` +
      `- @thread:${two} failed.`,
  ]);
  expect(thread(parent).status).toBe("active");
  expect(thread(one).latestAttentionAt).toBe(thread(one).createdAt);
  const requests = server.eventData(parent, "client/turn/requested");
  expect(requests[requests.length - 1]).toMatchObject({
    systemMessageKind: "child-outcome-batch",
    systemMessageSubject: { kind: "thread-batch", count: 2 },
    target: { kind: "new-turn" },
  });

  await ingest(parent, events.started("p2"));
  await ingest(one, events.started("a2"));
  await server.interact(one, "child-req", approval);
  const blocked = `@thread:${one} needs help.\nBlocked on command:\nCommand: rm`;
  expect(noticeTexts(server, parent)[1]).toContain(blocked);
  expect(submitted[submitted.length - 1].mode).toEqual({ kind: "auto" });

  await server.interact(parent, "parent-req", approval);
  await ingest(one, events.completed("a2"));
  await server.advance(2_000);
  expect(server.queued(parent)).toEqual(["interaction"]);
  const notices = server.rows(
    "SELECT system_notice FROM queued_thread_messages",
  );
  expect(JSON.stringify(notices)).toContain("child-completed");
  const settled = { threadId: parent, requestId: "parent-req", reason: "gone" };
  await server.emit({ kind: "interaction.cancelled", ...settled });
  const completed = `[bb system]\n\n@thread:${one} completed:\n\nall green`;
  expect(noticeTexts(server, parent)[2]).toBe(completed);
});

it("archives a tree, keeps turns through the undo grace and unarchives", async () => {
  const server = await createThreadServer();
  const { ctx, http, ingest, thread } = server;
  const parent = await server.spawn();
  const child = await server.spawn({ parentThreadId: parent });
  await ingest(child, events.identity(), events.started("c1"));
  const terminal = server.openTerminal(parent);
  const client = await server.socket();
  await client.subscribe({ kind: "thread-detail", threadId: child });

  const archived = await http("POST", `/threads/${parent}/archive-all`);
  expect(archived.body).toEqual({
    ok: true,
    archivedThreadIds: [child, parent],
  });
  const change = [["archived-changed"], { projectId: "proj_1" }];
  expect(await server.changes(client)).toEqual(change);
  await server.advance(29_000);
  expect(thread(child).status).toBe("active");
  expect(server.callsTo("closeTerminal")).toEqual([]);
  const refused = await ctx.threads
    .send(child, { input: text("hello"), mode: "auto" })
    .catch((error: { body: unknown }) => error.body);
  expect(refused).toMatchObject({ details: { reason: "archived" } });

  await server.advance(1_000);
  expect(thread(child).status).toBe("stopping");
  expect(server.callsTo("closeTerminal")).toEqual([terminal]);
  await ingest(child, events.completed("c1", "interrupted"));
  await http("POST", `/threads/${child}/unarchive`);
  expect(thread(child)).toMatchObject({ status: "idle", archivedAt: null });
  expect(thread(parent).archivedAt).not.toBeNull();
});

it("deletes a thread once its storage is gone, retrying from the sweep", async () => {
  const server = await createThreadServer();
  const { http, rows, runner } = server;
  const parent = await server.spawn();
  const child = await server.spawn({ parentThreadId: parent });
  const remove = (childThreadsConfirmed: boolean) =>
    http("DELETE", `/threads/${parent}`, { childThreadsConfirmed });
  expect((await remove(false)).status).toBe(409);
  const terminal = server.openTerminal(parent);
  let attempts = 0;
  runner.script.deleteThreadStorage = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("disk busy");
  };
  const client = await server.socket();
  await client.subscribe({ kind: "thread-list" });
  expect((await remove(true)).status).toBe(200);
  const tombstones = rows(
    "SELECT id FROM threads WHERE deleted_at IS NOT NULL",
  );
  expect(tombstones).toEqual([{ id: parent }]);
  expect((await server.changes(client))[0]).toEqual(["thread-deleted"]);
  await server.advance(10_000);
  const remaining = rows("SELECT id, parent_thread_id FROM threads");
  const orphan = [{ id: child, parentThreadId: null }];
  expect([attempts, remaining]).toEqual([2, orphan]);
  await http("DELETE", "/projects/proj_1");
  const released = server.callsTo("deleteThreadStorage")[2];
  expect([released, rows("SELECT id FROM threads")]).toEqual([
    { threadId: child },
    [],
  ]);
  expect(server.callsTo("closeTerminal")).toEqual([terminal]);
});

it("reconciles threads when a runner reconnects", async () => {
  const server = await createThreadServer();
  const { eventData, ingest, runner, thread } = server;
  const [kept, lost] = [await server.spawn(), await server.spawn()];
  await ingest(kept, events.identity(), events.started("k1"));
  await ingest(lost, events.identity(), events.started("l1"));
  const session = { providerId: "codex" as const, providerThreadId: "prov-1" };
  const sessions = [{ ...session, threadId: kept, activeTurnId: "k1" }];
  const idle = { pendingRequestIds: [], terminalIds: [], lastEventSeq: 0 };
  runner.script.snapshot = async () => ({ sessions, ...idle });
  await server.reconnect();
  const statuses = (): string[] => [thread(kept).status, thread(lost).status];
  expect(statuses()).toEqual(["active", "error"]);
  const restarted = { reason: "host-daemon-restarted" };
  const cause = "host-connection-lost";
  const interrupted = "system/thread/interrupted";
  expect(eventData(lost, interrupted)).toEqual([{ ...restarted, cause }]);
  const closed = [{ status: "interrupted" }];
  expect(eventData(lost, "turn/completed")).toMatchObject(closed);

  const next = { instanceId: "inst-2", homeDir: "/home/me" };
  Object.assign(runner.script, { describe: async () => next });
  await server.reconnect();
  expect(thread(kept)).toMatchObject({ status: "error", activeTurnId: null });
  expect(eventData(kept, interrupted)).toEqual([restarted]);
});

it("interrupts threads that were running when the server stopped", async () => {
  const { config } = (await createThreadServer()).ctx;
  const db = openDatabase({ path: ":memory:" });
  const { hostId } = config;
  const at = "created_at, updated_at";
  db.run(`INSERT INTO hosts (id, name, ${at}) VALUES (?, 'h', 1, 1)`, hostId);
  db.run(`INSERT INTO projects (id, name, ${at}) VALUES ('p', 'P', 1, 1)`);
  db.run(
    `INSERT INTO environments (id, project_id, host_id, path, status, ${at})
     VALUES ('env_1', 'p', ?, '/repo', 'ready', 1, 1)`,
    hostId,
  );
  const insert = (id: string, status: string, environmentId: string | null) =>
    db.run(
      `INSERT INTO threads (id, project_id, environment_id, provider_id,
         status, active_turn_id, latest_attention_at, ${at})
       VALUES (?, 'p', ?, 'codex', ?, ?, 1, 1, 1)`,
      id,
      environmentId,
      status,
      status === "active" ? "t1" : null,
    );
  insert("thr_active", "active", "env_1");
  insert("thr_idle", "idle", "env_1");
  insert("thr_starting", "starting", null);
  const runner = new FakeRunner();
  const server = createServer({ config, db, localRunner: () => runner.api });
  await server.listen();
  await server.ctx.threads.settled();
  const statuses = db
    .all<{ status: string }>("SELECT status FROM threads ORDER BY id")
    .map((row) => row.status);
  expect(statuses).toEqual(["error", "idle", "error"]);
  const types = db
    .all<{ type: string }>("SELECT type FROM events ORDER BY rowid")
    .map((row) => row.type);
  const interrupted = "system/thread/interrupted";
  expect(types).toEqual(["turn/completed", interrupted, interrupted]);
  await server.close();
});

it("announces every mutation to subscribers", async () => {
  const server = await createThreadServer();
  const { ctx, http } = server;
  const [id, other] = [await server.spawn(), await server.spawn()];
  const client = await server.socket();
  await client.subscribe({ kind: "thread-detail", threadId: id });
  const base = `/threads/${id}`;
  type Row = { id: string; updatedAt: number; groupWithNext: boolean };
  const change = async (method: string, path: string, json?: unknown) => {
    const { body } = await http<Row[] & Row>(method, `${base}${path}`, json);
    return [(await server.changes(client))[0], body] as const;
  };

  const renamed = await change("PATCH", "", { title: "Renamed" });
  expect(renamed).toMatchObject([["title-changed"], { title: "Renamed" }]);
  const pinned = await change("POST", "/pin");
  const pin = { pinnedAt: ctx.now() };
  expect(pinned).toMatchObject([["pin-state-changed"], pin]);
  await http("POST", `/threads/${other}/pin`);
  const order = { previousThreadId: other, nextThreadId: null };
  const [reordered, entries] = await change("PATCH", "/pin-order", order);
  const pinnedIds = entries.map((entry) => entry.id);
  expect([reordered, pinnedIds]).toEqual([["pin-state-changed"], [other, id]]);

  const parent = { parentThreadId: other };
  expect((await change("PATCH", "", parent))[0]).toEqual(["parent-changed"]);
  const loop = { parentThreadId: id };
  const cycle = await http("PATCH", `/threads/${other}`, loop);
  expect(cycle.body).toMatchObject({ details: { reason: "cycle" } });
  const unread = ["read-state-changed"];
  expect((await change("POST", "/unread"))[0]).toEqual(unread);
  const read = { lastReadAt: ctx.now() };
  expect((await change("POST", "/read"))[1]).toMatchObject(read);

  const queue = "/queued-messages";
  const add = async (message: string) => {
    const queued = await change("POST", queue, { input: text(message) });
    expect(queued[0]).toEqual(["queue-changed"]);
    return queued[1];
  };
  const [first, second] = [await add("first"), await add("second")];
  const input = text("first, edited");
  const edit = async (expectedUpdatedAt: number) => {
    const edited = { expectedUpdatedAt, input };
    return (await http("PATCH", `${base}${queue}/${first.id}`, edited)).status;
  };
  const edits = [await edit(first.updatedAt - 1), await edit(first.updatedAt)];
  expect(edits).toEqual([409, 200]);
  const move = { previousQueuedMessageId: null, nextQueuedMessageId: first.id };
  const moved = await change("PATCH", `${queue}/${second.id}/order`, move);
  const ids = moved[1].map((row) => row.id);
  expect(ids).toEqual([second.id, first.id]);
  const boundary = {
    expectedGroupedPrefixQueuedMessageIds: ids,
    groupBoundaryQueuedMessageId: first.id,
  };
  const grouped = await change("PATCH", `${queue}/group-boundary`, boundary);
  const flags = grouped[1].map((row) => row.groupWithNext);
  expect(flags).toEqual([true, false]);
  const removed = await change("DELETE", `${queue}/${second.id}`);
  expect(removed).toEqual([["queue-changed"], { ok: true }]);

  const opened = await http("POST", `${base}/open`, { file: null });
  expect(opened.body).toEqual({ delivered: 1 });
  const signal = await client.next((message) => message.type === "thread-open");
  expect(signal).toMatchObject({ threadId: id, split: "replace" });
});
