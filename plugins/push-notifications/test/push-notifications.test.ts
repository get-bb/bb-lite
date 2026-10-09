import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, onTestFinished } from "vitest";
import {
  createThreadServer,
  events,
} from "../../../apps/server/test/thread-harness.js";
import type { ExpoPushMessage } from "../sender.js";

async function fakeRelay(tickets: (message: ExpoPushMessage) => object) {
  const received: ExpoPushMessage[] = [];
  const relay = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const batch = JSON.parse(body) as ExpoPushMessage[];
      received.push(...batch);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: batch.map(tickets) }));
    });
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => void relay.close());
  const { port } = relay.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/push`, received };
}

interface Body {
  id: string;
  subscriptions: object[];
  lastSendOutcome: { status: string };
}

async function pushServer(relayUrl: string) {
  const server = await createThreadServer();
  const put = (path: string, json: object, method = "POST") =>
    server.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(json),
    });
  const op = async (name: string, input: object = {}) => {
    const response = await put(`/ops/pushNotifications.${name}`, input);
    const json = (await response.json()) as { result?: unknown };
    return { status: response.status, body: json.result ?? json } as {
      status: number;
      body: Body;
    };
  };
  const settings = (values: object) =>
    put("/plugins/push-notifications/settings", { values }, "PUT");
  expect((await settings({ expoPushUrl: relayUrl })).status).toBe(200);
  return { ...server, op, settings };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out");
}

it("registers, refreshes, lists and removes a device", async () => {
  const relay = await fakeRelay(() => ({ status: "ok" }));
  const { op } = await pushServer(relay.url);
  const input = { token: "ExponentPushToken[abc123]", platform: "ios" };
  const first = await op("create", { ...input, label: "Phone" });
  expect(first.body).toMatchObject({ created: true });
  const again = await op("create", { ...input, label: "My phone" });
  expect(again.body).toEqual({ id: first.body.id, created: false });
  expect((await op("list")).body.subscriptions).toEqual([
    expect.objectContaining({
      deviceLabel: "My phone",
      tokenSuffix: "bc123]",
    }),
  ]);
  expect((await op("delete", { subscriptionId: first.body.id })).body).toEqual({
    id: first.body.id,
    removed: true,
  });
  expect((await op("delete", { subscriptionId: first.body.id })).status).toBe(
    400,
  );
  expect((await op("status")).body).toMatchObject({
    subscriptionCount: 0,
    relayUrl: relay.url,
    lastSendOutcome: { status: "never" },
  });
});

it("pushes a finished turn to registered devices and drops unregistered ones", async () => {
  const relay = await fakeRelay((message) =>
    message.to === "gone"
      ? { status: "error", details: { error: "DeviceNotRegistered" } }
      : { status: "ok" },
  );
  const server = await pushServer(relay.url);
  await server.op("create", { token: "live", platform: "ios", label: "A" });
  await server.op("create", { token: "gone", platform: "android", label: "B" });
  const id = await server.spawn();
  await server.ingest(id, events.identity(), events.started("t1"));
  await server.ingest(id, ...events.message("t1", "m1", "All **done** here"));
  server.clock.now += 60_000;
  await server.ingest(id, events.completed("t1"));
  const status = await until(
    async () => (await server.op("status")).body,
    (body) => body.lastSendOutcome.status !== "never",
  );
  expect(status.lastSendOutcome).toMatchObject({
    status: "sent",
    sentCount: 1,
  });
  expect(relay.received).toHaveLength(2);
  expect(relay.received.find((m) => m.to === "live")).toMatchObject({
    to: "live",
    body: "All done here",
    data: { kind: "turn-finished", threadId: id, projectId: "proj_1" },
  });
  const { subscriptions } = (await server.op("list")).body;
  expect(subscriptions).toEqual([
    expect.objectContaining({ deviceLabel: "A" }),
  ]);
});

it("refuses a test for a disabled channel", async () => {
  const relay = await fakeRelay(() => ({ status: "ok" }));
  const server = await pushServer(relay.url);
  expect((await server.op("test", { channel: "web" })).body).toEqual({
    ok: true,
  });
  await server.settings({ webEnabled: false });
  const refused = await server.op("test", { channel: "web" });
  expect(refused.status).toBe(400);
  expect(JSON.stringify(refused.body)).toContain("disabled");
});
