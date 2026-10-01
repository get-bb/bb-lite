import { expect, it } from "vitest";
import { createThreadServer, events, text } from "./thread-harness.js";

it("creates a thread, records provisioning and submits the first turn", async () => {
  const server = await createThreadServer();
  const { ctx, eventData, hostId, rows, submitted, thread } = server;
  const client = await server.socket();
  await client.subscribe({ kind: "thread-list" });
  ctx.extensions.generateTitle = async () => "  Refactor the  scheduler ";
  const threadId = await server.spawn();

  const types = ["client/turn/requested", "client/thread/start"];
  expect(server.eventTypes(threadId).slice(0, 2)).toEqual(types);
  const steps = eventData(threadId, "system/thread-provisioning").map(
    ({ status, entries }) => [
      status,
      ...(entries as { text: string }[]).map((entry) => entry.text),
    ],
  );
  expect(steps).toEqual([
    ["active", "Preparing workspace"],
    ["active", "Generating title"],
    ["active", "Generated title"],
    ["active", "Using workspace: /repo"],
    ["completed"],
  ]);
  const [request] = eventData(threadId, "client/turn/requested");
  expect(request).toMatchObject({
    source: "spawn",
    initiator: "user",
    target: { kind: "thread-start" },
    request: { method: "thread/start" },
    execution: { model: "gpt-test", permissionMode: "auto" },
  });
  const row = thread(threadId);
  expect(row).toMatchObject({
    status: "active",
    title: "Refactor the scheduler",
    titleFallback: "Please refactor the scheduler module today",
    model: "gpt-test",
    reasoningLevel: "medium",
    startupContext: null,
  });
  const environments = rows("SELECT id, host_id FROM environments");
  expect(environments).toEqual([{ id: row.environmentId, hostId }]);

  expect(submitted).toHaveLength(1);
  const [{ session, options, mode, clientRequestId, input }] = submitted;
  expect(session).toMatchObject({
    threadId,
    providerId: "codex",
    cwd: "/repo",
    providerThreadId: null,
    env: {
      BB_THREAD_ID: threadId,
      BB_PROJECT_ID: "proj_1",
      BB_ENVIRONMENT_ID: row.environmentId,
    },
  });
  expect(session.instructions).toContain("You are working inside bb");
  const tools = session.dynamicTools.map((tool) => tool.name);
  expect(tools).toEqual(["update_environment_directory"]);
  const asks = { permissionEscalation: "ask", planMode: false };
  expect(options).toMatchObject({ model: "gpt-test", ...asks });
  const prompt = text("Please refactor the scheduler module today");
  const sent = [{ kind: "start" }, request.requestId, prompt];
  expect([mode, clientRequestId, input]).toEqual(sent);

  const project = { projectId: "proj_1" };
  const created = await server.changes(client, "thread-created");
  expect(created).toEqual([["thread-created"], project]);
  const [, starting] = await server.changes(client, "status-changed");
  expect(starting).toMatchObject({
    ...project,
    statusChange: {
      status: "starting",
      runtime: { displayStatus: "starting" },
      activity: { activeBackgroundAgentCount: 0 },
    },
  });
  const history = rows("SELECT scope FROM prompt_history_entries");
  expect(history).toEqual([{ scope: "project" }]);
  const defaults = rows("SELECT execution_defaults FROM projects");
  expect(JSON.stringify(defaults)).toContain("gpt-test");
});

it("ingests a turn: sequences, dedupes, pruning, search and status", async () => {
  const server = await createThreadServer();
  const { clock, ingest, rows, thread } = server;
  const threadId = await server.spawn({ providerId: "codex" });
  const client = await server.socket();
  await client.subscribe({ kind: "thread-detail", threadId });
  const before = thread(threadId).latestAttentionAt;
  const base = server.eventTypes(threadId).length;
  clock.now += 5_000;

  await ingest(threadId, events.identity(), events.started("t1"));
  const running = { status: "active", activeTurnId: "t1" };
  expect(thread(threadId)).toMatchObject({
    ...running,
    providerThreadId: "prov-1",
  });
  const message = events.message("t1", "i1", "the scheduler is refactored");
  const { scope } = message[0];
  await ingest(
    threadId,
    events.started("t1"),
    ...message,
    message[message.length - 1],
    { type: "turn/diff/updated", scope, providerThreadId: "prov-1" },
    events.completed("t1"),
    events.completed("t1"),
  );

  expect(server.eventTypes(threadId).slice(base)).toEqual([
    "thread/identity",
    "turn/started",
    "item/started",
    "item/agentMessage/delta",
    "item/completed",
    "turn/completed",
  ]);
  const sequences = rows<{ sequence: number }>(
    "SELECT sequence FROM events WHERE thread_id = ? ORDER BY sequence",
    threadId,
  ).map((row) => row.sequence - base);
  expect(sequences.slice(base)).toEqual([1, 2, 3, 4, 8, 9]);
  const settled = { status: "idle", activeTurnId: null };
  expect(thread(threadId)).toMatchObject({
    ...settled,
    latestAttentionAt: before + 5_000,
  });
  const hits = (term: string): unknown[] =>
    rows(
      `SELECT s.source_kind FROM thread_search_segments_fts f
       JOIN thread_search_segments s ON s.rowid = f.rowid
       WHERE f.text MATCH ?`,
      term,
    );
  expect(hits("refactored")).toEqual([{ sourceKind: "assistant_message" }]);
  expect(hits("scheduler")).toHaveLength(3);

  const [kinds, metadata] = await server.changes(client, "status-changed");
  expect(kinds).toEqual(["status-changed"]);
  expect(metadata).toMatchObject({ statusChange: { status: "idle" } });
  const appended = await client.next((change) =>
    JSON.stringify(change.metadata).includes("turn/completed"),
  );
  expect(appended.changes).toEqual(["events-appended"]);
});
