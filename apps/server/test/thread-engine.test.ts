import { expect, it } from "vitest";
import { createThreadServer, events, text } from "./thread-harness.js";

it("creates a thread, records provisioning and submits the first turn", async () => {
  const server = await createThreadServer();
  const { ctx, eventData, eventTypes, hostId, submitted, thread } = server;
  const client = await server.socket();
  await client.subscribe({ kind: "thread-list" });
  ctx.extensions.generateTitle = async () => "  Refactor the  scheduler ";
  const threadId = await server.spawn();

  expect(eventTypes(threadId)).toEqual([
    "client/turn/requested",
    "client/thread/start",
    ...Array.from({ length: 5 }, () => "system/thread-provisioning"),
  ]);
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
  const environment = ctx.db.get<{ id: string; hostId: string }>(
    "SELECT id, host_id FROM environments WHERE path = '/repo'",
  );
  expect(environment).toEqual({ id: row.environmentId, hostId });
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
  const toolNames = session.dynamicTools.map((tool) => tool.name);
  expect(toolNames).toEqual(["update_environment_directory"]);
  expect(options).toMatchObject({
    model: "gpt-test",
    permissionEscalation: "ask",
    planMode: false,
  });
  expect([mode, clientRequestId, input]).toEqual([
    { kind: "start" },
    request.requestId,
    text("Please refactor the scheduler module today"),
  ]);

  const created = await client.next((message) =>
    (message.changes as string[]).includes("thread-created"),
  );
  expect(created.metadata).toEqual({ projectId: "proj_1" });
  const starting = await client.next((message) =>
    (message.changes as string[]).includes("status-changed"),
  );
  expect(starting.metadata).toMatchObject({
    projectId: "proj_1",
    statusChange: {
      status: "starting",
      runtime: { displayStatus: "starting" },
      activity: { activeBackgroundAgentCount: 0 },
    },
  });
  const history = ctx.db.all("SELECT scope FROM prompt_history_entries");
  expect(history).toEqual([{ scope: "project" }]);
  const defaults = ctx.db.get("SELECT execution_defaults FROM projects");
  expect(JSON.stringify(defaults)).toContain("gpt-test");
});

it("ingests a turn: sequences, dedupes, pruning, search and status", async () => {
  const server = await createThreadServer();
  const { clock, ctx, eventTypes, ingest, thread } = server;
  const threadId = await server.spawn({ providerId: "codex" });
  const client = await server.socket();
  await client.subscribe({ kind: "thread-detail", threadId });
  const before = thread(threadId).latestAttentionAt;
  clock.now += 5_000;

  await ingest(threadId, events.identity(), events.started("t1"));
  expect(thread(threadId)).toMatchObject({
    status: "active",
    activeTurnId: "t1",
    providerThreadId: "prov-1",
  });
  const orphanUsage = {
    type: "thread/tokenUsage/updated" as const,
    scope: { kind: "turn" as const, turnId: "t-unknown" },
    providerThreadId: "prov-1",
    tokenUsage: {
      total: zeroUsage(),
      last: zeroUsage(),
      modelContextWindow: null,
    },
  };
  const message = events.message("t1", "i1", "the scheduler is refactored");
  await ingest(
    threadId,
    events.started("t1"),
    ...message,
    message.at(-1)!,
    {
      type: "turn/diff/updated",
      scope: message[0].scope,
      providerThreadId: "p",
    },
    orphanUsage,
    events.completed("t1"),
    events.completed("t1"),
  );

  const stored = eventTypes(threadId).slice(7);
  expect(stored).toEqual([
    "thread/identity",
    "turn/started",
    "item/started",
    "item/agentMessage/delta",
    "item/completed",
    "turn/completed",
  ]);
  const sequences = ctx.db
    .all<{ sequence: number }>(
      "SELECT sequence FROM events WHERE thread_id = ? ORDER BY sequence",
      threadId,
    )
    .map((row) => row.sequence);
  expect(sequences.slice(7)).toEqual([8, 9, 10, 11, 15, 16]);
  expect(thread(threadId)).toMatchObject({
    status: "idle",
    activeTurnId: null,
  });
  expect(thread(threadId).latestAttentionAt).toBe(before + 5_000);
  const hits = (term: string): unknown[] =>
    ctx.db.all(
      `SELECT s.source_kind FROM thread_search_segments_fts f
       JOIN thread_search_segments s ON s.rowid = f.rowid
       WHERE f.text MATCH ? ORDER BY s.source_kind`,
      term,
    );
  expect(hits("refactored")).toEqual([{ sourceKind: "assistant_message" }]);
  expect(hits("scheduler")).toHaveLength(3);

  const idle = await client.next(
    (change) =>
      (change.metadata as { statusChange?: { status: string } } | undefined)
        ?.statusChange?.status === "idle",
  );
  expect(idle.changes).toEqual(["status-changed"]);
  const appended = await client.next((change) =>
    JSON.stringify(change.metadata).includes("turn/completed"),
  );
  expect(appended.changes).toEqual(["events-appended"]);
});

function zeroUsage() {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}
