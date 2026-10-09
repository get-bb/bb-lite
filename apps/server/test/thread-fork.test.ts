import type { PromptInput } from "@bb/domain";
import type { ThreadTimelineResponse as Timeline } from "@bb/server-contract";
import type { ThreadRow } from "@bb/server-kit/db/threads";
import { expect, it, vi } from "vitest";
import { createEchoServer } from "./helpers.js";
import { text } from "./thread-harness.js";

it("forks a thread into the source environment with its history", async () => {
  const server = await createEchoServer();
  const { api, ctx, project, read: get } = server;
  const environment = { type: "project-default" } as const;
  const json = {
    projectId: project.id,
    origin: "app",
    providerId: "echo",
    input: text("first pineapple"),
    environment,
    startedOnBehalfOf: null,
  } as const;
  const { id } = await (await api.threads.$post({ json })).json();
  const row = (threadId: string) =>
    ctx.db.get<ThreadRow>("SELECT * FROM threads WHERE id = ?", threadId);
  await vi.waitFor(() => expect(row(id)?.status).toBe("idle"));
  const fork = (body: object) =>
    server.request(`/threads/${id}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const late = await fork({ sourceSeqEnd: 1_000_000 });
  expect(late.status).toBe(503);
  expect(await late.text()).toContain("fork_source_session_unavailable");

  const seed = [
    { type: "text", text: "Re: x", mentions: [], visibility: "agent-only" },
  ] satisfies PromptInput[];
  const created = await fork({
    visibility: "hidden",
    lifecycleOwnerThreadId: id,
    agentContextSeed: seed,
  });
  expect(created.status).toBe(201);
  const forked = (await created.json()) as { id: string };
  expect(row(forked.id)).toMatchObject({
    originKind: "fork",
    sourceThreadId: id,
    lifecycleOwnerThreadId: id,
    visibility: "hidden",
    providerId: "echo",
    status: "pending",
  });

  const send = { input: text("second"), mode: "start" as const };
  await api.threads[":id"].send.$post({
    param: { id: forked.id },
    json: send,
  });
  await vi.waitFor(() => expect(row(forked.id)?.status).toBe("idle"));
  expect(row(forked.id)?.environmentId).toBe(row(id)?.environmentId);
  const requested = ctx.db.get<{ data: string }>(
    `SELECT data FROM events WHERE thread_id = ?
     AND type = 'client/turn/requested'`,
    forked.id,
  );
  const input = JSON.parse(requested?.data ?? "{}").input as PromptInput[];
  expect(input).toHaveLength(3);
  expect(input[0]).toMatchObject({ visibility: "agent-only" });
  expect(JSON.stringify(input[0])).toContain("User: first pineapple");
  expect(input[1]).toMatchObject(seed[0]);
  const timeline = await get<Timeline>(`/threads/${forked.id}/timeline`);
  const said = timeline.rows.flatMap((entry) =>
    entry.kind === "conversation" && entry.role === "user" ? [entry.text] : [],
  );
  expect(said).toEqual(["second"]);
});
