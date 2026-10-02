import type { ThreadListEntry } from "@bb/domain";
import {
  applyTimelineDelta,
  type ThreadSearchResponse,
  type ThreadTimelineResponse as Timeline,
  type TimelineTurnSummaryDetailsResponse,
} from "@bb/server-contract";
import { expect, test } from "vitest";
import { createTestServer } from "./helpers.js";
import {
  agentTurn,
  appendEvents,
  insertRow,
  seedThread,
  seedWorkspace,
  userRequest,
} from "./thread-seed.js";

async function setup(threadOverrides: Record<string, unknown>) {
  const server = await createTestServer();
  const { db } = server.ctx;
  seedWorkspace(db, server.ctx.config.hostId);
  seedThread(db, "thr_1", threadOverrides);
  return { ...server, db, get: server.read };
}

function exchange(n: number, status: "completed" | "open" = "completed") {
  const id = `creq_aaaaaaaaa${n + 1}`;
  const request = userRequest(id, `question ${n}`);
  return [request, ...agentTurn(`t${n}`, id, `answer ${n}`, status)];
}

function said(timeline: Pick<Timeline, "rows">): string[] {
  return timeline.rows.flatMap((row) =>
    row.kind === "conversation" ? [row.text] : [],
  );
}

test("pages by user message, follows cursors, expands turns", async () => {
  const { db, get, request } = await setup({ provider_id: "codex" });
  const exchanges = [1, 2, 3].flatMap((n) => exchange(n));
  appendEvents(db, "thr_1", exchanges);
  const base = "/threads/thr_1/timeline";
  const latest = await get<Timeline>(`${base}?segmentLimit=2`);
  expect(said(latest)).toEqual([
    "question 2",
    "answer 2",
    "question 3",
    "answer 3",
  ]);
  expect(latest.maxSeq).toBe(27);
  const { olderCursor, ...page } = latest.timelinePage;
  expect(page).toMatchObject({ returnedSegmentCount: 2, hasOlderRows: true });
  const anchor = `segmentLimit=2&beforeAnchorSeq=${olderCursor?.anchorSeq}`;
  const cursor = `${anchor}&beforeAnchorId=${olderCursor?.anchorId}`;
  const older = await get<Timeline>(`${base}?${cursor}`);
  expect(said(older)).toEqual(["question 1", "answer 1"]);
  expect(older.timelinePage).toMatchObject({
    kind: "older",
    hasOlderRows: false,
  });
  const stale = await request(`${base}?${anchor}&beforeAnchorId=window:10`);
  expect(stale.status).toBe(400);
  const turn = older.rows.find((row) => row.kind === "turn");
  expect(turn).toMatchObject({ turnId: "t1", children: null });
  const range = `${turn?.sourceSeqStart}&sourceSeqEnd=${turn?.sourceSeqEnd}`;
  const details = await get<TimelineTurnSummaryDetailsResponse>(
    `${base}/turn-summary-details?turnId=t1&sourceSeqStart=${range}`,
  );
  expect(details.rows).toMatchObject([
    { workKind: "command", output: "a.txt\n" },
  ]);
});

test("answers afterSequence with a delta of the rows it served", async () => {
  const { ctx, db, get } = await setup({ provider_id: "claude-code" });
  db.run("UPDATE threads SET status = 'active'");
  appendEvents(db, "thr_1", exchange(1, "open"));
  const path = "/threads/thr_1/timeline";
  const first = await get<Timeline>(path);
  const data = { providerThreadId: "p", itemId: "t1-i1", delta: "\nmore\n" };
  const delta = { type: "item/agentMessage/delta", turnId: "t1", data };
  appendEvents(db, "thr_1", [delta]);
  const after = `${path}?afterSequence=${first.maxSeq}`;
  const second = await get<Timeline>(after);
  const full = await get<Timeline>(path);
  expect(said(first)).toEqual(["question 1"]);
  expect(said(full)).toEqual(["question 1", "answer 1\nmore\n"]);
  expect(second.rows).toEqual([]);
  const upserts = second.delta?.upsertRows ?? [];
  expect(upserts.map((row) => row.kind)).toEqual(["conversation"]);
  expect(
    applyTimelineDelta(first.rows, { upsertRows: [], ...second.delta }),
  ).toEqual(full.rows);
  ctx.hub.thread("thr_1", ["history-rewritten"]);
  const rewritten = await get<Timeline>(after);
  expect(rewritten.delta).toBeUndefined();
  expect(rewritten.rows).toEqual(full.rows);
});

test("starts after the last completed context clear", async () => {
  const { db, get } = await setup({ provider_id: "claude-code" });
  const operation = { operation: "context_clear", status: "completed" };
  const data = {
    ...operation,
    message: "Context cleared",
    operationId: "op_1",
  };
  const cleared = { type: "system/operation", data };
  appendEvents(db, "thr_1", [...exchange(1), cleared, ...exchange(2)]);
  const timeline = await get<Timeline>("/threads/thr_1/timeline");
  expect(timeline.contextBoundarySeq).toBe(10);
  expect(said(timeline)).toEqual(["question 2", "answer 2"]);
  const outline = await get<{ items: { preview: string }[] }>(
    "/threads/thr_1/conversation-outline",
  );
  const previews = outline.items.map((item) => item.preview);
  expect(previews).toEqual(["question 2", "answer 2"]);
});

test("list entries carry display status and queue state", async () => {
  const { db, get } = await setup({ status: "active" });
  const at = { created_at: 1, updated_at: 1 };
  insertRow(db, "hosts", { id: "host_away", name: "away", ...at });
  const away = { project_id: "proj_demo", host_id: "host_away", ...at };
  const building = { id: "env_new", path: "/new", status: "provisioning" };
  insertRow(db, "environments", { ...away, id: "env_away", status: "ready" });
  insertRow(db, "environments", { ...away, ...building });
  seedThread(db, "thr_2", { status: "active", environment_id: "env_away" });
  seedThread(db, "thr_3", { status: "starting", environment_id: "env_new" });
  seedThread(db, "thr_4", {});
  const execution = {
    model: "m",
    reasoning_level: "low",
    service_tier: "fast",
  };
  insertRow(db, "queued_thread_messages", {
    ...execution,
    id: "qmsg_1",
    thread_id: "thr_4",
    content: JSON.stringify([{ type: "text", text: "later", mentions: [] }]),
    permission_mode: "auto",
    failure_reason: "host went away",
    sort_key: "a",
    ...at,
  });
  const pending = { id: "pint_1", thread_id: "thr_1", status: "pending" };
  insertRow(db, "pending_interactions", { ...pending, payload: "{}", ...at });
  const entries = await get<ThreadListEntry[]>("/threads");
  const shown = entries.map((entry) => {
    const { id, runtime, queuedWork, hasPendingInteraction } = entry;
    return [id, runtime.displayStatus, queuedWork, hasPendingInteraction];
  });
  expect(shown.sort()).toEqual([
    ["thr_1", "active", "none", true],
    ["thr_2", "waiting-for-host", "none", false],
    ["thr_3", "provisioning", "none", false],
    ["thr_4", "idle", "failed", false],
  ]);
  expect(await get("/threads/count?groupBy=host")).toMatchObject({ total: 4 });
});

test("search ranks threads and returns highlight ranges", async () => {
  const { db, get, request } = await setup({ title: "Deploy pipeline" });
  seedThread(db, "thr_2", { title: "Notes", archived_at: 5 });
  const filler = "lorem ipsum dolor sit amet ".repeat(8);
  const long = `${filler}fix the déploy pipeline today ${filler}`;
  const segments = [
    { thread_id: "thr_1", source_kind: "title", text: "Deploy pipeline" },
    { thread_id: "thr_1", source_kind: "user_message", text: long },
    {
      thread_id: "thr_2",
      source_kind: "assistant_message",
      text: "deploy notes",
    },
  ];
  segments.forEach((segment, index) => {
    const key = {
      id: `seg_${index}`,
      source_key: `k${index}`,
      source_seq: index,
    };
    const row = { ...segment, ...key, created_at: 1, updated_at: 1 };
    insertRow(db, "thread_search_segments", row);
  });
  const search = "/threads/search?query=";
  const found = await get<ThreadSearchResponse>(`${search}deploy%20pipe`);
  expect(found.archived).toEqual({ total: 0, results: [] });
  expect(found.active.total).toBe(1);
  const [title, message] = found.active.results[0]?.matches ?? [];
  const titleRanges = title?.highlightRanges.map(({ start, end }) => [
    start,
    end,
  ]);
  expect(titleRanges).toEqual([
    [0, 6],
    [7, 11],
  ]);
  const marked = message?.highlightRanges.map((range) =>
    message.text.slice(range.start, range.end),
  );
  expect(marked).toEqual(["déploy", "pipe"]);
  expect(message?.text).toMatch(/^….{1,160}…$/u);
  const broad = await get<ThreadSearchResponse>(`${search}deploy`);
  const archived = broad.archived.results.map((result) => result.thread.id);
  expect(archived).toEqual(["thr_2"]);
  expect((await request(`${search}d`)).status).toBe(400);
});

test("default execution falls back to project, parent and host", async () => {
  const { db, get } = await setup({ provider_id: "codex" });
  const path = "/threads/thr_1/default-execution-options";
  expect(await get(path)).toBeNull();
  const project = {
    model: "gpt-p",
    reasoningLevel: "high",
    serviceTier: "fast",
  };
  const defaults = { ...project, providerId: "codex", permissionMode: "full" };
  const stored = JSON.stringify(defaults);
  db.run("UPDATE projects SET execution_defaults = ?", stored);
  db.run("UPDATE hosts SET max_permission_mode = 'auto'");
  const source = "client/turn/requested";
  const inherited = { ...project, permissionMode: "auto", source };
  expect(await get(path)).toEqual(inherited);
  seedThread(db, "thr_parent", { permission_mode: "accept-edits" });
  db.run(
    `UPDATE threads SET parent_thread_id = 'thr_parent', reasoning_level = 'low',
       model_override = 'gpt-o', provider_id = 'claude-code'
     WHERE id = 'thr_1'`,
  );
  const own = { model: "gpt-o", reasoningLevel: "low" };
  const parented = { ...own, permissionMode: "accept-edits" };
  expect(await get(path)).toMatchObject(parented);
  db.run("UPDATE threads SET model_override = NULL WHERE id = 'thr_1'");
  expect(await get(path)).toBeNull();
});
