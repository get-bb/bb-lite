import type { ThreadTimelineResponse as Timeline } from "@bb/server-contract";
import { latestSequence } from "@bb/server-kit/db/event-read";
import type { ThreadRow } from "@bb/server-kit/db/threads";
import { findProviderDefinition } from "@bb/server-kit/providers/catalog";
import { expect, it, vi } from "vitest";
import { createEchoServer } from "./helpers.js";
import { text } from "./thread-harness.js";

async function editScenario() {
  const server = await createEchoServer();
  const { api, ctx, project, read } = server;
  const json = {
    projectId: project.id,
    origin: "app",
    providerId: "echo",
    input: text("count"),
    environment: { type: "project-default" },
    startedOnBehalfOf: null,
  } as const;
  const { id } = await (await api.threads.$post({ json })).json();
  const status = () =>
    ctx.db.get<ThreadRow>("SELECT * FROM threads WHERE id = ?", id)?.status;
  const settle = async (before: number) =>
    vi.waitFor(() => {
      expect(latestSequence(ctx.db, id)).toBeGreaterThan(before);
      expect(status()).toBe("idle");
    });
  await settle(0);
  const send = async (said: string) => {
    const before = latestSequence(ctx.db, id);
    await api.threads[":id"].send.$post({
      param: { id },
      json: { input: text(said), mode: "start" },
    });
    await settle(before);
  };
  const messages = () =>
    ctx.db
      .all<{ sequence: number }>(
        `SELECT sequence FROM events WHERE thread_id = ?
         AND type = 'client/turn/requested' ORDER BY sequence`,
        id,
      )
      .map(({ sequence }) => sequence);
  const edit = (seq: number, said: string) =>
    server.request(`/threads/${id}/messages/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq, input: text(said) }),
    });
  const editAndSettle = async (seq: number, said: string) => {
    const response = await edit(seq, said);
    expect(response.status).toBe(200);
    await settle(seq);
  };
  const conversation = async () => {
    const timeline = await read<Timeline>(`/threads/${id}/timeline`);
    return timeline.rows.flatMap((entry) =>
      entry.kind === "conversation" ? [`${entry.role}: ${entry.text}`] : [],
    );
  };
  return { ...server, id, send, messages, edit, editAndSettle, conversation };
}

it("rewinds the session to the checkpoint before an edited message", async () => {
  const s = await editScenario();
  await s.send("count");
  await s.send("count");
  expect((await s.conversation()).at(-1)).toBe("assistant: Turn count: 3");

  await s.editAndSettle(s.messages()[2] ?? 0, "count again");
  expect(await s.conversation()).toEqual([
    "user: count",
    "assistant: Turn count: 1",
    "user: count",
    "assistant: Turn count: 2",
    "user: count again",
    "assistant: Turn count: 3",
  ]);

  await s.editAndSettle(s.messages()[0] ?? 0, "count anew");
  expect(await s.conversation()).toEqual([
    "user: count anew",
    "assistant: Turn count: 1",
  ]);
  expect(s.messages()).toHaveLength(1);
  const found = s.ctx.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM thread_search_segments
     WHERE thread_id = ? AND source_kind = 'user_message'`,
    s.id,
  );
  expect(found?.n).toBe(1);
});

it("refuses edits it cannot rewind", async () => {
  const s = await editScenario();
  await s.send("count");
  const [first = 0, second = 0] = s.messages();

  const missing = await s.edit(second + 1, "x");
  expect(missing.status).toBe(404);

  s.ctx.db.run(
    `UPDATE events SET data = json_remove(data, '$.providerCheckpointId')
     WHERE thread_id = ? AND type = 'turn/completed'`,
    s.id,
  );
  const unchecked = await s.edit(second, "x");
  expect(unchecked.status).toBe(503);
  expect(await unchecked.text()).toContain("rewind_unsupported");

  const before = latestSequence(s.ctx.db, s.id);
  await s.api.threads[":id"].send.$post({
    param: { id: s.id },
    json: { input: text("hold_turn"), mode: "start" },
  });
  await vi.waitFor(() =>
    expect(latestSequence(s.ctx.db, s.id)).toBeGreaterThan(before + 1),
  );
  const running = await s.edit(first, "x");
  expect(running.status).toBe(409);

  const definition = findProviderDefinition(s.ctx.db, "echo");
  if (definition === undefined) throw new Error("echo is not declared");
  definition.info.capabilities.fork = undefined;
  const unsupported = await s.edit(first, "x");
  expect(unsupported.status).toBe(503);
  expect(await unsupported.text()).toContain("rewind_unsupported");
});
