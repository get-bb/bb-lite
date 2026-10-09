import type { PromptInput } from "@bb/domain";
import type { ThreadTimelineResponse as Timeline } from "@bb/server-contract";
import { latestSequence } from "@bb/server-kit/db/event-read";
import type { ThreadRow } from "@bb/server-kit/db/threads";
import { findProviderDefinition } from "@bb/server-kit/providers/catalog";
import { expect, it, vi } from "vitest";
import { createEchoServer } from "./helpers.js";
import { text } from "./thread-harness.js";

async function forkScenario() {
  const server = await createEchoServer();
  const { api, ctx, project, read } = server;
  const json = {
    projectId: project.id,
    origin: "app",
    providerId: "echo",
    input: text("first pineapple"),
    environment: { type: "project-default" },
    startedOnBehalfOf: null,
  } as const;
  const { id } = await (await api.threads.$post({ json })).json();
  const row = (threadId: string) =>
    ctx.db.get<ThreadRow>("SELECT * FROM threads WHERE id = ?", threadId);
  const send = async (threadId: string, said: string) => {
    const before = latestSequence(ctx.db, threadId);
    await api.threads[":id"].send.$post({
      param: { id: threadId },
      json: { input: text(said), mode: "start" },
    });
    await vi.waitFor(() => {
      expect(latestSequence(ctx.db, threadId)).toBeGreaterThan(before);
      expect(row(threadId)?.status).toBe("idle");
    });
  };
  await vi.waitFor(() => expect(row(id)?.status).toBe("idle"));
  const fork = (body: object) =>
    server.request(`/threads/${id}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const created = async (body: object) => {
    const response = await fork(body);
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
  };
  const requested = (threadId: string) => {
    const found = ctx.db.get<{ data: string }>(
      `SELECT data FROM events WHERE thread_id = ?
       AND type = 'client/turn/requested' ORDER BY sequence DESC LIMIT 1`,
      threadId,
    );
    return JSON.parse(found?.data ?? "{}").input as PromptInput[];
  };
  const conversation = async (threadId: string) => {
    const timeline = await read<Timeline>(`/threads/${threadId}/timeline`);
    return timeline.rows.flatMap((entry) =>
      entry.kind === "conversation" ? [`${entry.role}: ${entry.text}`] : [],
    );
  };
  return {
    ...server,
    id,
    row,
    send,
    fork,
    created,
    requested,
    conversation,
  };
}

it("forks at a checkpoint with the source's timeline and no transcript", async () => {
  const s = await forkScenario();
  const end = latestSequence(s.ctx.db, s.id);
  await s.send(s.id, "second banana");

  const late = await s.fork({ sourceSeqEnd: 1_000_000 });
  expect(late.status).toBe(503);
  expect(await late.text()).toContain("fork_source_session_unavailable");

  const seed = [
    { type: "text", text: "Re: x", mentions: [], visibility: "agent-only" },
  ] satisfies PromptInput[];
  const forked = await s.created({
    sourceSeqEnd: end,
    visibility: "hidden",
    lifecycleOwnerThreadId: s.id,
    agentContextSeed: seed,
  });
  expect(s.row(forked)).toMatchObject({
    originKind: "fork",
    sourceThreadId: s.id,
    lifecycleOwnerThreadId: s.id,
    visibility: "hidden",
    providerId: "echo",
    status: "pending",
    providerThreadId: null,
  });
  const fresh = s.row(forked);
  expect(fresh?.latestAttentionAt).toBeLessThanOrEqual(fresh?.lastReadAt ?? 0);
  expect(await s.conversation(forked)).toEqual([
    "user: first pineapple",
    "assistant: Response to: first pineapple",
  ]);
  const usage = s.ctx.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE thread_id = ?
     AND (type LIKE '%Usage/updated' OR provider_thread_id IS NOT NULL)`,
    forked,
  );
  expect(usage?.n).toBe(0);

  await s.send(forked, "count");
  expect(s.row(forked)?.environmentId).toBe(s.row(s.id)?.environmentId);
  expect(s.requested(forked)).toEqual([seed[0], ...text("count")]);
  expect(await s.conversation(forked)).toEqual([
    "user: first pineapple",
    "assistant: Response to: first pineapple",
    "user: count",
    "assistant: Turn count: 2",
  ]);

  const tip = await s.created({});
  await s.send(tip, "count");
  expect((await s.conversation(tip)).at(-1)).toBe("assistant: Turn count: 3");
});

it("edits the first message of a fork by forking the source again", async () => {
  const s = await forkScenario();
  const forked = await s.created({});
  await s.send(forked, "count");
  await s.send(forked, "count");
  expect((await s.conversation(forked)).at(-1)).toBe(
    "assistant: Turn count: 3",
  );
  const first = s.ctx.db.get<{ sequence: number }>(
    `SELECT sequence FROM events WHERE thread_id = ?
     AND type = 'client/turn/requested' AND provider_thread_id IS NOT NULL
     ORDER BY sequence LIMIT 1`,
    forked,
  );
  const own = s.ctx.db.all<{ sequence: number }>(
    `SELECT e.sequence FROM events e WHERE e.thread_id = ?
     AND e.type = 'client/turn/requested' ORDER BY e.sequence`,
    forked,
  );
  const seq = first?.sequence ?? own.at(-2)?.sequence ?? 0;
  const edited = await s.request(`/threads/${forked}/messages/update`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ seq, input: text("count") }),
  });
  expect(edited.status).toBe(200);
  await vi.waitFor(async () => {
    expect(await s.conversation(forked)).toEqual([
      "user: first pineapple",
      "assistant: Response to: first pineapple",
      "user: count",
      "assistant: Turn count: 2",
    ]);
  });
});

it("still edits in a fork after its source's history is rewritten", async () => {
  const s = await forkScenario();
  await s.send(s.id, "count");
  const forked = await s.created({});
  await s.send(forked, "count");
  const requests = (threadId: string) =>
    s.ctx.db.all<{ sequence: number }>(
      `SELECT sequence FROM events WHERE thread_id = ?
       AND type = 'client/turn/requested' ORDER BY sequence`,
      threadId,
    );
  const update = (threadId: string, seq: number) =>
    s.request(`/threads/${threadId}/messages/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq, input: text("count") }),
    });
  const rewritten = await update(s.id, requests(s.id)[0]?.sequence ?? 0);
  expect(rewritten.status).toBe(200);
  await vi.waitFor(async () => {
    expect((await s.conversation(s.id)).at(-1)).toBe(
      "assistant: Turn count: 1",
    );
  });
  const last = requests(forked).at(-1)?.sequence ?? 0;
  const edited = await update(forked, last);
  expect(edited.status).toBe(200);
  await vi.waitFor(async () => {
    expect((await s.conversation(forked)).at(-1)).toBe(
      "assistant: Turn count: 3",
    );
  });
});

it("seeds a transcript when the provider cannot fork a checkpoint", async () => {
  const s = await forkScenario();
  const definition = findProviderDefinition(s.ctx.db, "echo");
  if (definition === undefined) throw new Error("echo is not declared");
  definition.info.capabilities.fork = undefined;

  const forked = await s.created({});
  await s.send(forked, "count");
  const input = s.requested(forked);
  expect(input).toHaveLength(2);
  expect(input[0]).toMatchObject({ visibility: "agent-only" });
  expect(JSON.stringify(input[0])).toContain("User: first pineapple");
  expect(await s.conversation(forked)).toEqual([
    "user: first pineapple",
    "assistant: Response to: first pineapple",
    "user: count",
    "assistant: Turn count: 1",
  ]);
});
