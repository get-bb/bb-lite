import { threads } from "@bb/plugin";
import type { PendingInteractionPayload } from "@bb/domain";
import type { ThreadTimelineResponse as Timeline } from "@bb/server-contract";
import { expect, it } from "vitest";
import { insertRow, openDatabase } from "@bb/server-kit/db/index";
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

function noticeTexts(server: ThreadServer, threadId: string) {
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
  const swept = { ok: true, archivedThreadIds: [child, parent] };
  expect(archived.body).toEqual(swept);
  const change = [["archived-changed"], { projectId: "proj_1" }];
  expect(await server.changes(client)).toEqual(change);
  await server.matches("/sidebar-bootstrap", { projects: [{ threads: [] }] });
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
  const at = { createdAt: 1, updatedAt: 1 };
  const place = { projectId: "p", hostId, path: "/repo", status: "ready" };
  insertRow(db, "hosts", { id: hostId, name: "h", ...at });
  insertRow(db, "projects", { id: "p", name: "P", ...at });
  insertRow(db, "environments", { id: "env_1", ...place, ...at });
  const insert = (id: string, status: string, environmentId: string | null) => {
    const turn = { status, activeTurnId: status === "active" ? "t1" : null };
    const thread = { id, projectId: "p", environmentId, providerId: "codex" };
    const row = { ...thread, ...turn, latestAttentionAt: 1, ...at };
    insertRow(db, "threads", row);
  };
  insert("thr_active", "active", "env_1");
  insert("thr_idle", "idle", "env_1");
  insert("thr_starting", "starting", null);
  const runner = new FakeRunner();
  const server = createServer({ config, db, localRunner: () => runner.api });
  await server.listen();
  await server.ctx.kernel.call(threads.settled, {});
  const column = <Row>(sql: string, pick: (row: Row) => string) =>
    db.all<Row>(sql).map(pick);
  const statuses = "SELECT status FROM threads ORDER BY id";
  const settled = column<{ status: string }>(statuses, (row) => row.status);
  expect(settled).toEqual(["error", "idle", "error"]);
  const stored = "SELECT type FROM events ORDER BY rowid";
  const types = column<{ type: string }>(stored, (row) => row.type);
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
  type Row = { id: string; updatedAt: number };
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
  const byKey = `SELECT thread_id AS id FROM thread_user_state
    WHERE pinned_at IS NOT NULL ORDER BY pin_sort_key`;
  const stored = ctx.db.all<{ id: string }>(byKey).map((row) => row.id);
  expect(stored).toEqual([other, id]);
  const order = { previousThreadId: null, nextThreadId: other };
  const [reordered, entries] = await change("PATCH", "/pin-order", order);
  const pinnedIds = entries.map((entry) => entry.id);
  expect([reordered, pinnedIds]).toEqual([["pin-state-changed"], [id, other]]);

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
  const listed = await http<Row[]>("GET", `${base}${queue}`);
  const ids = listed.body.map((row) => row.id);
  expect(ids).toEqual([first.id, second.id]);
  const removed = await change("DELETE", `${queue}/${first.id}`);
  expect(removed).toEqual([["queue-changed"], { ok: true }]);
  await server.ingest(id, events.identity(), events.started("t1"));
  const now = { mode: "steer" };
  const sent = await http("POST", `${base}${queue}/${second.id}/send`, now);
  expect(sent.body).toMatchObject({ delivery: "sent" });
  expect([server.lastSubmit(), server.queued(id)]).toEqual([
    ["second", "steer"],
    [],
  ]);

  const opened = await http("POST", `${base}/open`, { file: null });
  expect(opened.body).toEqual({ delivered: 1 });
  const signal = await client.next((message) => message.type === "thread-open");
  expect(signal).toMatchObject({ threadId: id, split: "replace" });
});

it("serves a kept timeline until something it shows changes", async () => {
  const server = await createThreadServer();
  const { http, ingest } = server;
  const id = await server.spawn();
  await server.runTurn(id, "t1", "first reply");
  const timeline = async (query = "") => {
    const path = `/threads/${id}/timeline${query}`;
    return (await http<Timeline>("GET", path)).body;
  };
  const first = await timeline();
  expect(await timeline()).toEqual(first);
  const idle = await timeline(`?afterSequence=${first.maxSeq}`);
  expect([idle.rows, idle.delta]).toEqual([[], { upsertRows: [] }]);
  await server.runTurn(id, "t2", "second reply");
  const second = await timeline();
  expect(JSON.stringify(second.rows)).toContain("second reply");
  const delta = await timeline(`?afterSequence=${first.maxSeq}`);
  expect(JSON.stringify(delta.delta?.upsertRows)).toContain("second reply");
  await ingest(id, events.started("t3"));
  await server.interact(id, "req-1", approval, "t3");
  const asked = await timeline();
  const [{ id: pending }] = server.rows<{ id: string }>(
    "SELECT id FROM pending_interactions",
  );
  const path = `/threads/${id}/interactions/${pending}/resolve`;
  await http("POST", path, { decision: "deny", grantedPermissions: null });
  const answered = await timeline();
  const sequences = [second, asked, answered].map(({ maxSeq }) => maxSeq);
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  expect(new Set(sequences).size).toBe(3);
  await http("PATCH", `/threads/${id}`, { title: "Renamed" });
  const renamed = (await timeline()).timelinePage.historySnapshot;
  expect(renamed).toContain("Renamed");
});
