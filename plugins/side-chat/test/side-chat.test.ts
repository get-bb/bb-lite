import type { ThreadRow } from "@bb/server-kit/db/threads";
import { expect, it, vi } from "vitest";
import { createEchoServer } from "../../../apps/server/test/helpers.js";
import { text } from "../../../apps/server/test/thread-harness.js";

it("opens a hidden side-chat fork seeded with the quoted message", async () => {
  const server = await createEchoServer();
  const { api, ctx, project } = server;
  const json = {
    projectId: project.id,
    origin: "app",
    providerId: "echo",
    input: text("main question"),
    environment: { type: "project-default" },
    startedOnBehalfOf: null,
  } as const;
  const { id } = await (await api.threads.$post({ json })).json();
  const row = (threadId: string) =>
    ctx.db.get<ThreadRow>("SELECT * FROM threads WHERE id = ?", threadId);
  await vi.waitFor(() => expect(row(id)?.status).toBe("idle"));
  const create = async (body: object) => {
    const response = await server.request("/side-chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { threadId: string };
  };

  const { threadId } = await create({
    sourceThreadId: id,
    sourceSeqEnd: 1_000_000,
    anchorText: "  the quoted answer ",
  });
  expect(row(threadId)).toMatchObject({
    originKind: "fork",
    originPluginId: "side-chat",
    sourceThreadId: id,
    lifecycleOwnerThreadId: id,
    visibility: "hidden",
  });
  const startup = JSON.parse(row(threadId)?.startupContext ?? "{}");
  expect(JSON.stringify(startup.seed)).toContain(
    "Replying to this earlier message in the conversation:\\n\\nthe quoted answer",
  );
  const sidebar = await server.read<{ id: string }[]>("/threads");
  expect(sidebar.map((thread) => thread.id)).not.toContain(threadId);

  const plain = await create({ sourceThreadId: id, anchorText: "" });
  const seed = JSON.parse(row(plain.threadId)?.startupContext ?? "{}").seed;
  expect(seed).toHaveLength(1);
});
