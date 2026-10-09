import { expect, it, vi } from "vitest";
import {
  createThreadServer,
  events,
} from "../../../apps/server/test/thread-harness.js";

type Server = Awaited<ReturnType<typeof createThreadServer>>;
type ThreadEvent = Parameters<Server["ingest"]>[1];

const scope = (turnId: string) => ({
  scope: { kind: "turn" as const, turnId },
  providerThreadId: "prov-1",
});

const providerError = (turnId: string, category: string): ThreadEvent =>
  ({
    type: "provider/error",
    ...scope(turnId),
    message: `Provider failed: ${category}`,
    errorInfo: { category, providerCode: null, httpStatusCode: null },
  }) as ThreadEvent;

async function failTurn(server: Server, threadId: string, turnId: string) {
  await server.ingest(threadId, events.identity(), events.started(turnId));
  await server.ingest(
    threadId,
    providerError(turnId, "overloaded"),
    events.completed(turnId, "failed"),
  );
  await vi.waitFor(() => expect(server.queued(threadId)).toEqual(["time"]));
}

async function cli(server: Server, ...argv: string[]) {
  const body = JSON.stringify({ argv, cwd: "/" });
  const response = await fetch(
    `${server.url}/api/v1/plugins/provider-retry/cli`,
    { method: "POST", headers: { "content-type": "application/json" }, body },
  );
  return (await response.json()) as { exitCode: number; stdout: string };
}

it("retries an overloaded turn later with the same input", async () => {
  const server = await createThreadServer();
  const threadId = await server.spawn();
  expect(server.submitted).toHaveLength(1);
  await failTurn(server, threadId, "t1");
  const status = await cli(server, "status", "--json");
  const { retries } = JSON.parse(status.stdout) as {
    retries: { threadId: string; sendAt: number }[];
  };
  expect(retries).toMatchObject([{ threadId }]);
  await server.advance(retries[0].sendAt - server.clock.now + 1);
  expect(server.submitted).toHaveLength(2);
  expect(server.lastSubmit()[0]).toBe(
    "Please refactor the scheduler module today",
  );
});

it("does not retry a failure that is not retryable", async () => {
  const server = await createThreadServer();
  const threadId = await server.spawn();
  await server.ingest(threadId, events.identity(), events.started("t1"));
  await server.ingest(
    threadId,
    providerError("t1", "unauthorized"),
    events.completed("t1", "failed"),
  );
  expect(server.queued(threadId)).toEqual([]);
  expect((await cli(server, "status", threadId)).stdout).toBe(
    "No provider retries are pending.\n",
  );
});

it("cancels a pending retry from the CLI", async () => {
  const server = await createThreadServer();
  const threadId = await server.spawn();
  await failTurn(server, threadId, "t1");
  const cancelled = await cli(server, "cancel", threadId);
  expect(cancelled.stdout).toBe(`Cancelled provider retry for ${threadId}.\n`);
  expect(server.queued(threadId)).toEqual([]);
  expect((await cli(server, "retry", threadId)).exitCode).toBe(1);
});
