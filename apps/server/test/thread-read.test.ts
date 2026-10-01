import type { ThreadListEntry } from "@bb/domain";
import {
  applyTimelineDelta,
  type SidebarBootstrapResponse,
  type ThreadSearchResponse,
  type ThreadTimelineResponse,
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

async function setup() {
  const server = await createTestServer();
  const { db } = server.ctx;
  seedWorkspace(db, server.ctx.config.hostId);
  const request = (path: string): Promise<Response> =>
    fetch(`${server.url}/api/v1${path}`);
  const get = async <Body>(path: string): Promise<Body> =>
    (await (await request(path)).json()) as Body;
  return { ...server, db, request, get };
}

function exchange(n: number, status: "completed" | "open" = "completed") {
  const id = `creq_aaaaaaaaa${n + 1}`;
  const request = userRequest(id, `question ${n}`);
  return [request, ...agentTurn(`t${n}`, id, `answer ${n}`, status)];
}

function conversation(timeline: Pick<ThreadTimelineResponse, "rows">) {
  return timeline.rows.flatMap((row) =>
    row.kind === "conversation" ? [`${row.role}: ${row.text}`] : [],
  );
}

test("pages by user message and follows the older cursor", async () => {
  const { db, get, request } = await setup();
  seedThread(db, "thr_1", { provider_id: "claude-code" });
  appendEvents(
    db,
    "thr_1",
    [1, 2, 3].flatMap((n) => exchange(n)),
  );
  const base = "/threads/thr_1/timeline?segmentLimit=2";
  const latest = await get<ThreadTimelineResponse>(base);
  expect(conversation(latest)).toEqual([
    "user: question 2",
    "assistant: answer 2",
    "user: question 3",
    "assistant: answer 3",
  ]);
  expect(latest.maxSeq).toBe(21);
  expect(latest.timelinePage).toMatchObject({
    kind: "latest",
    returnedSegmentCount: 2,
    hasOlderRows: true,
    olderCursor: { anchorSeq: 8 },
  });
  const cursor = latest.timelinePage.olderCursor;
  const anchor = `beforeAnchorSeq=${cursor?.anchorSeq}&beforeAnchorId=`;
  const older = await get<ThreadTimelineResponse>(
    `${base}&${anchor}${cursor?.anchorId}`,
  );
  expect(conversation(older)).toEqual([
    "user: question 1",
    "assistant: answer 1",
  ]);
  expect(older.timelinePage).toMatchObject({
    kind: "older",
    hasOlderRows: false,
  });
  expect((await request(`${base}&${anchor}timeline-window:8`)).status).toBe(
    400,
  );
});

test("answers afterSequence with a delta of the rows it served", async () => {
  const { ctx, db, get } = await setup();
  seedThread(db, "thr_1", { provider_id: "claude-code", status: "active" });
  appendEvents(db, "thr_1", exchange(1, "open"));
  const path = "/threads/thr_1/timeline";
  const first = await get<ThreadTimelineResponse>(path);
  appendEvents(db, "thr_1", [
    {
      type: "item/agentMessage/delta",
      turnId: "t1",
      data: { providerThreadId: "p", itemId: "t1-i1", delta: "\nmore\n" },
    },
  ]);
  const after = `${path}?afterSequence=${first.maxSeq}`;
  const second = await get<ThreadTimelineResponse>(after);
  expect(second.rows).toEqual([]);
  expect(second.delta?.upsertRows.map((row) => row.kind)).toEqual([
    "conversation",
  ]);
  const full = await get<ThreadTimelineResponse>(path);
  expect(conversation(first)).toEqual(["user: question 1"]);
  expect(conversation(full)[1]).toContain("assistant: answer 1\nmore");
  expect(
    applyTimelineDelta(first.rows, second.delta ?? { upsertRows: [] }),
  ).toEqual(full.rows);
  ctx.hub.thread("thr_1", ["history-rewritten"]);
  const rewritten = await get<ThreadTimelineResponse>(after);
  expect(rewritten.delta).toBeUndefined();
  expect(rewritten.rows).toEqual(full.rows);
});

test("starts after the last completed context clear", async () => {
  const { db, get } = await setup();
  seedThread(db, "thr_1", { provider_id: "claude-code" });
  const cleared = {
    type: "system/operation",
    data: {
      operation: "context_clear",
      status: "completed",
      message: "Context cleared",
      operationId: "op_1",
    },
  };
  appendEvents(db, "thr_1", [...exchange(1), cleared, ...exchange(2)]);
  const timeline = await get<ThreadTimelineResponse>("/threads/thr_1/timeline");
  expect(timeline.contextBoundarySeq).toBe(8);
  expect(conversation(timeline)).toEqual([
    "user: question 2",
    "assistant: answer 2",
  ]);
  const outline = await get<{ items: { preview: string }[] }>(
    "/threads/thr_1/conversation-outline",
  );
  expect(outline.items.map((item) => item.preview)).toEqual([
    "question 2",
    "answer 2",
  ]);
});

test("expands a collapsed turn into its work rows", async () => {
  const { db, get } = await setup();
  seedThread(db, "thr_1", { provider_id: "codex" });
  const [request, started, accepted, ...reply] = exchange(1);
  const command = {
    type: "commandExecution",
    id: "t1-i0",
    command: "ls",
    cwd: "/work/demo",
    approvalStatus: null,
  };
  const item = (type: string, extra: object) => ({
    type,
    turnId: "t1",
    data: { providerThreadId: "p", item: { ...command, ...extra } },
  });
  const done = {
    status: "completed",
    aggregatedOutput: "a.txt\n",
    exitCode: 0,
  };
  appendEvents(db, "thr_1", [
    ...[request, started, accepted].flatMap((event) => event ?? []),
    item("item/started", { status: "pending" }),
    item("item/completed", done),
    ...reply,
  ]);
  const timeline = await get<ThreadTimelineResponse>("/threads/thr_1/timeline");
  const turn = timeline.rows.find((row) => row.kind === "turn");
  expect(turn).toMatchObject({ turnId: "t1", children: null });
  const range = `sourceSeqStart=${turn?.sourceSeqStart}&sourceSeqEnd=${turn?.sourceSeqEnd}`;
  const details = await get<TimelineTurnSummaryDetailsResponse>(
    `/threads/thr_1/timeline/turn-summary-details?turnId=t1&${range}`,
  );
  expect(details.rows).toMatchObject([
    { kind: "work", workKind: "command", command: "ls", output: "a.txt\n" },
  ]);
  expect(details.olderCursor).toBeNull();
});

test("list entries carry display status, queue and attention", async () => {
  const { db, get } = await setup();
  const at = { created_at: 1, updated_at: 1 };
  insertRow(db, "hosts", { id: "host_away", name: "away", ...at });
  const environment = { project_id: "proj_demo", host_id: "host_away", ...at };
  for (const [id, status] of [
    ["env_away", "ready"],
    ["env_new", "provisioning"],
  ]) {
    insertRow(db, "environments", { ...environment, id, path: id, status });
  }
  seedThread(db, "thr_run", { status: "active" });
  seedThread(db, "thr_wait", { status: "active", environment_id: "env_away" });
  seedThread(db, "thr_new", { status: "starting", environment_id: "env_new" });
  seedThread(db, "thr_idle", {});
  expect(await get("/system/attention")).toEqual({ hasAttention: false });
  const execution = {
    model: "m",
    reasoning_level: "low",
    service_tier: "default",
  };
  insertRow(db, "queued_thread_messages", {
    ...execution,
    id: "qmsg_1",
    thread_id: "thr_idle",
    content: JSON.stringify([{ type: "text", text: "later", mentions: [] }]),
    permission_mode: "auto",
    failure_reason: "host went away",
    sort_key: "a",
    ...at,
  });
  const pending = { id: "pint_1", thread_id: "thr_run", status: "pending" };
  insertRow(db, "pending_interactions", { ...pending, payload: "{}", ...at });
  const entries = await get<ThreadListEntry[]>("/threads");
  const shown = entries.map((entry) => [
    entry.id,
    entry.runtime.displayStatus,
    entry.queuedWork,
    entry.hasPendingInteraction,
  ]);
  expect(shown.sort()).toEqual([
    ["thr_idle", "idle", "failed", false],
    ["thr_new", "provisioning", "none", false],
    ["thr_run", "active", "none", true],
    ["thr_wait", "waiting-for-host", "none", false],
  ]);
  expect(await get("/system/attention")).toEqual({ hasAttention: true });
  expect(await get("/threads/count?groupBy=host")).toMatchObject({ total: 4 });
});

test("search ranks threads and returns highlight ranges", async () => {
  const { db, get, request } = await setup();
  seedThread(db, "thr_a", { title: "Deploy pipeline" });
  seedThread(db, "thr_b", { title: "Notes", archived_at: 5 });
  const filler = "lorem ipsum dolor sit amet ".repeat(8);
  const segments = [
    ["thr_a", "title", "Deploy pipeline"],
    [
      "thr_a",
      "user_message",
      `${filler}fix the déploy pipeline today ${filler}`,
    ],
    ["thr_b", "assistant_message", "deploy notes"],
  ];
  segments.forEach(([thread_id, source_kind, text], index) => {
    const key = {
      id: `seg_${index}`,
      source_key: `k${index}`,
      source_seq: index,
    };
    const at = { created_at: 1, updated_at: 1 };
    insertRow(db, "thread_search_segments", {
      ...key,
      thread_id,
      source_kind,
      text,
      ...at,
    });
  });
  const found = await get<ThreadSearchResponse>(
    "/threads/search?query=deploy%20pipe",
  );
  expect(found.archived).toEqual({ total: 0, results: [] });
  expect(found.active.total).toBe(1);
  const [title, message] = found.active.results[0]?.matches ?? [];
  expect(title).toMatchObject({
    sourceKind: "title",
    highlightRanges: [
      { start: 0, end: 6 },
      { start: 7, end: 11 },
    ],
  });
  const marked = message?.highlightRanges.map((range) =>
    message.text.slice(range.start, range.end),
  );
  expect(marked).toEqual(["déploy", "pipe"]);
  expect(message?.text.startsWith("…")).toBe(true);
  expect(message?.text.length).toBeLessThanOrEqual(162);
  const broad = await get<ThreadSearchResponse>("/threads/search?query=deploy");
  expect(broad.archived.results.map((result) => result.thread.id)).toEqual([
    "thr_b",
  ]);
  expect((await request("/threads/search?query=d")).status).toBe(400);
});

test("event wait times out with 204 and wakes on a new event", async () => {
  const { ctx, db, get, request } = await setup();
  seedThread(db, "thr_1", {});
  const wait = "/threads/thr_1/events/wait?type=turn/completed";
  expect((await request(`${wait}&waitMs=20`)).status).toBe(204);
  const waiting = get<{ type: string; seq: number }>(`${wait}&afterSeq=0`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  appendEvents(db, "thr_1", exchange(1));
  ctx.hub.thread("thr_1", ["events-appended"]);
  expect(await waiting).toMatchObject({ type: "turn/completed", seq: 7 });
});

test("sidebar bootstrap always carries the personal project", async () => {
  const server = await createTestServer();
  const sidebar = (): Promise<SidebarBootstrapResponse> =>
    fetch(`${server.url}/api/v1/sidebar-bootstrap`).then(
      (response) => response.json() as Promise<SidebarBootstrapResponse>,
    );
  const empty = await sidebar();
  expect(empty).toMatchObject({ sections: [], projects: [] });
  expect(empty.personalProject).toMatchObject({
    id: "proj_personal",
    kind: "personal",
    sources: [],
    threads: [],
    defaultExecutionOptions: null,
  });
  const { db } = server.ctx;
  seedWorkspace(db, server.ctx.config.hostId);
  seedThread(db, "thr_live", {});
  seedThread(db, "thr_gone", { archived_at: 5 });
  const [project] = (await sidebar()).projects;
  expect(project?.threads.map((thread) => thread.id)).toEqual(["thr_live"]);
});
