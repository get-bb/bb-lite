import type { ProviderRateLimitState } from "@bb/domain";
import { threads } from "@bb/plugin";
import { expect, it, vi } from "vitest";
import { createThreadServer, events } from "./thread-harness.js";

type Server = Awaited<ReturnType<typeof createThreadServer>>;
type ThreadEvent = Parameters<Server["ingest"]>[1];

const turn = (turnId: string) => ({
  scope: { kind: "turn" as const, turnId },
  providerThreadId: "prov-1",
});

it("tells a failed handler the provider error, rate limits and turn", async () => {
  const server = await createThreadServer();
  const probe = server.ctx.kernel.scope("probe", "installed");
  const seen: unknown[] = [];
  probe.on(threads.failed, (payload) => void seen.push(payload));
  const threadId = await server.spawn();
  const rateLimits: ProviderRateLimitState = {
    providerId: "codex",
    status: "blocked",
    kind: "subscription-window",
    windows: [],
    reachedReason: "Limit reached",
    overageStatus: null,
    overageReason: null,
  };
  const errorInfo = {
    category: "overloaded",
    providerCode: "529",
    httpStatusCode: 529,
  };
  await server.ingest(threadId, events.identity(), events.started("t1"));
  await server.ingest(
    threadId,
    { type: "provider/rateLimits/updated", ...turn("t1"), rateLimits },
    {
      type: "provider/error",
      ...turn("t1"),
      message: "Overloaded",
      errorInfo,
    } as ThreadEvent,
    events.completed("t1", "failed"),
  );
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  const requestId = server.submitted[0]?.clientRequestId;
  expect(seen[0]).toMatchObject({
    thread: { id: threadId },
    errorInfo,
    rateLimits,
    turn: {
      requestId,
      attempt: 1,
      input: [
        { type: "text", text: "Please refactor the scheduler module today" },
      ],
    },
  });
});

it("keeps a queued message with sendAt until its time", async () => {
  const server = await createThreadServer();
  const threadId = await server.spawn();
  await server.runTurn(threadId, "t1", "done");
  const sendAt = server.clock.now + 60_000;
  const created = await server.http<{ sendAt: number | null }>(
    "POST",
    `/threads/${threadId}/queued-messages`,
    { input: [{ type: "text", text: "later", mentions: [] }], sendAt },
  );
  expect(created.body.sendAt).toBe(sendAt);
  expect(server.queued(threadId)).toEqual(["time"]);
  expect(server.submitted).toHaveLength(1);
  await server.advance(30_000);
  expect(server.submitted).toHaveLength(1);
  await server.advance(30_001);
  expect(server.submitted).toHaveLength(2);
  expect(server.lastSubmit()[0]).toBe("later");
});

it("pages the user's prompts across threads, newest first", async () => {
  const server = await createThreadServer();
  const first = await server.spawn();
  server.clock.now += 1_000;
  const second = await server.spawn({
    input: [{ type: "text", text: "Second thread", mentions: [] }],
  });
  type Page = {
    entries: { text: string; threadId: string; scope: string }[];
    nextCursor: string | null;
  };
  const page = await server.http<Page>(
    "GET",
    "/threads/prompt-history?limit=1",
  );
  expect(page.body.entries).toMatchObject([
    { text: "Second thread", threadId: second, scope: "project" },
  ]);
  expect(page.body.nextCursor).not.toBeNull();
  const cursor = encodeURIComponent(page.body.nextCursor ?? "");
  const next = await server.http<Page>(
    "GET",
    `/threads/prompt-history?limit=1&projectId=proj_1&cursor=${cursor}`,
  );
  expect(next.body).toMatchObject({
    entries: [{ threadId: first, projectId: "proj_1", scope: "project" }],
    nextCursor: null,
  });
});
