import { expect, it } from "vitest";
import { createThreadServer } from "../../../apps/server/test/thread-harness.js";
import { drafts } from "../contract.js";

it("keeps a draft queued until it is sent by hand", async () => {
  const server = await createThreadServer();
  const { ctx, settle, submitted, spawn } = server;
  const threadId = await spawn();
  await server.runTurn(threadId, "t1");
  const before = submitted.length;
  const { queuedMessageId } = await ctx.kernel.call(drafts.create, {
    threadId,
    text: "Later",
  });
  await settle();
  expect(submitted.length).toBe(before);
  const [row] = server.rows<{ id: string; waitingOn: string }>(
    "SELECT id, waiting_on AS waitingOn FROM queued_thread_messages WHERE thread_id = ?",
    threadId,
  );
  expect(row.id).toBe(queuedMessageId);
  expect(JSON.parse(row.waitingOn)).toEqual({
    kind: "plugin",
    pluginId: "drafts",
    reason: "Draft",
  });
  const path = `/threads/${threadId}/queued-messages/${queuedMessageId}/send`;
  await server.http("POST", path, { mode: "auto" });
  expect(submitted.length).toBe(before + 1);
  expect(server.lastSubmit()[0]).toBe("Later");
});

it("keeps a draft's mentions and attachments", async () => {
  const server = await createThreadServer();
  const threadId = await server.spawn();
  const input = [
    {
      type: "text" as const,
      text: "See @notes",
      mentions: [
        {
          start: 4,
          end: 10,
          resource: {
            kind: "path" as const,
            source: "workspace" as const,
            entryKind: "file" as const,
            path: "notes.md",
            label: "notes.md",
          },
        },
      ],
    },
    { type: "localFile" as const, path: "/tmp/a.txt", name: "a.txt" },
  ];
  await server.ctx.kernel.call(drafts.create, { threadId, input });
  const [row] = server.rows<{ content: string }>(
    "SELECT content FROM queued_thread_messages WHERE thread_id = ?",
    threadId,
  );
  expect(JSON.parse(row.content)).toEqual(input);
  await expect(
    server.ctx.kernel.call(drafts.create, { threadId }),
  ).rejects.toThrow();
});
