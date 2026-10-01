import type { PendingInteractionPayload } from "@bb/domain";
import { expect, it } from "vitest";
import type { ThreadEnvironment } from "../src/environments/types.js";
import {
  createThreadServer,
  events,
  FIRST_MESSAGE,
  text,
} from "./thread-harness.js";

type Server = Awaited<ReturnType<typeof createThreadServer>>;
type SendMode =
  | "start"
  | "steer"
  | "steer-if-active"
  | "queue-if-active"
  | "auto";

function sender(server: Server, id: string) {
  return async (mode: SendMode, message: string, sendAt?: number) => {
    const json = { input: text(message), mode, sendAt };
    const response = await server.api.threads[":id"].send.$post({
      param: { id },
      json,
    });
    await server.settle();
    const body = (await response.json()) as {
      delivery?: string;
      code?: string;
      details?: { reason: string };
      queuedMessage?: { waitingOn: { kind: string; hostName?: string } };
    };
    return [
      response.status,
      body.delivery ?? body.details?.reason ?? body.code,
      body.queuedMessage?.waitingOn,
    ].filter((part) => part !== undefined);
  };
}

function lastInput(server: Server): unknown[] {
  const { input, mode } = server.submitted.at(-1)!;
  const [part] = input;
  return [part.type === "text" ? part.text : part.type, mode.kind];
}

const question: PendingInteractionPayload = {
  kind: "user_question",
  questions: [
    { id: "q1", prompt: "Push?", multiSelect: false, allowFreeText: true },
  ],
};

function deferredEnvironment(server: Server) {
  let ready = (_environment: ThreadEnvironment): void => {};
  const { ensureForThread } = server.ctx.environments;
  server.ctx.environments.ensureForThread = (args) =>
    new Promise((resolve, reject) => {
      ready = () => void ensureForThread(args).then(resolve, reject);
    });
  return () => ready({ environmentId: "", path: "" });
}

it("steers, queues and drains around a running turn", async () => {
  const server = await createThreadServer();
  const { api, eventData, ingest, queued, submitted } = server;
  const id = await server.spawn();
  const send = sender(server, id);

  const starting = [200, "queued", { kind: "turn-starting" }];
  expect(await send("steer-if-active", "one")).toEqual(starting);
  await ingest(id, events.identity(), events.started("t1"));
  expect([queued(id), lastInput(server)]).toEqual([[], ["one", "auto"]]);

  expect(await send("steer", "two")).toEqual([200, "sent"]);
  const steer = { kind: "steer", expectedTurnId: "t1" };
  expect(submitted.at(-1)?.mode).toEqual(steer);
  const busy = [200, "queued", { kind: "thread-busy" }];
  expect(await send("queue-if-active", "three")).toEqual(busy);
  expect(await send("start", "nope")).toEqual([409, "already_active"]);
  const queuedMessages = api.threads[":id"]["queued-messages"];
  const explicit = await queuedMessages.$post({
    param: { id },
    json: { input: text("four") },
  });
  expect(explicit.status).toBe(201);
  expect(submitted).toHaveLength(3);

  await ingest(id, events.completed("t1"));
  expect(lastInput(server)).toEqual(["three", "start"]);
  expect(queued(id)).toEqual(["thread-busy"]);
  const targets = eventData(id, "client/turn/requested").map(
    (request) => (request.target as { kind: string }).kind,
  );
  expect(targets).toEqual(["thread-start", "auto", "steer", "new-turn"]);
  await ingest(id, events.started("t2"), events.completed("t2", "failed"));
  expect([server.thread(id).status, queued(id)]).toEqual([
    "error",
    ["thread-busy"],
  ]);
});

it("holds messages on time, interactions, hosts and provisioning", async () => {
  const server = await createThreadServer();
  const { clock, ctx, emit, hostId, ingest, queued, runner } = server;
  const id = await server.spawn();
  const send = sender(server, id);
  await server.runTurn(id, "t1");

  const at = clock.now + 60_000;
  expect(await send("auto", "later", at)).toEqual([
    200,
    "queued",
    { kind: "time" },
  ]);
  ctx.threads.sweep();
  await server.settle();
  expect(queued(id)).toEqual(["time"]);
  clock.now = at;
  ctx.threads.sweep();
  await server.settle();
  expect(lastInput(server)).toEqual(["later", "start"]);

  await ingest(id, events.started("t2"));
  const request = { threadId: id, turnId: "t2", requestId: "req-1" };
  const provider = { providerId: "codex" as const, providerThreadId: "prov-1" };
  const kind = "interaction.requested";
  await emit({ kind, ...request, ...provider, payload: question });
  const waiting = [200, "queued", { kind: "interaction" }];
  expect(await send("steer-if-active", "answer first")).toEqual(waiting);
  const reason = "provider gave up";
  await emit({ kind: "interaction.cancelled", ...request, reason });
  expect(lastInput(server)).toEqual(["answer first", "auto"]);
  await ingest(id, events.completed("t2"));

  ctx.runners.disconnect(hostId);
  const offline = { kind: "host-offline", hostName: "local" };
  expect(await send("auto", "when back")).toEqual([200, "queued", offline]);
  ctx.runners.connect(hostId, (sink) => {
    runner.emit = sink;
    return runner.api;
  });
  await server.settle();
  expect(lastInput(server)).toEqual(["when back", "start"]);

  const release = deferredEnvironment(server);
  const created = await server.api.threads.$post({
    json: {
      ...FIRST_MESSAGE,
      projectId: "proj_1",
      origin: "cli",
      input: text("second thread"),
      model: "gpt-test",
      environment: { type: "project-default" },
    },
  });
  const other = (await created.json()).id;
  const followUp = { input: text("also this"), mode: "auto" as const };
  const held = await ctx.threads.send(other, followUp);
  expect(held).toMatchObject({
    queuedMessage: { waitingOn: { kind: "provisioning" } },
  });
  release();
  await server.settle();
  expect(queued(other)).toEqual(["turn-starting"]);
  await ingest(other, events.started("o1"));
  expect(lastInput(server)).toEqual(["also this", "auto"]);
});

it("stops a running turn and pauses the turn-bound queue", async () => {
  const server = await createThreadServer();
  const { api, eventData, ingest, queued, runner, thread } = server;
  const id = await server.spawn();
  const send = sender(server, id);
  await ingest(id, events.identity(), events.started("t1"));
  expect(await send("queue-if-active", "held")).toHaveLength(3);
  const emitQuestion = { threadId: id, turnId: "t1", requestId: "req-1" };
  const provider = { providerId: "codex" as const, providerThreadId: "prov-1" };
  const kind = "interaction.requested";
  await server.emit({ kind, ...emitQuestion, ...provider, payload: question });

  await api.threads[":id"].stop.$post({ param: { id } });
  expect(thread(id).status).toBe("stopping");
  expect(runner.calls.map((call) => call.method)).toContain("interruptTurn");
  const stopping = [200, "queued", { kind: "stopping" }];
  expect(await send("auto", "after stop")).toEqual(stopping);
  await ingest(id, events.completed("t1", "interrupted"));
  expect(eventData(id, "system/thread/interrupted")).toEqual([
    { reason: "manual-stop" },
  ]);
  const interactions = server.ctx.db.all(
    "SELECT status, status_reason FROM pending_interactions",
  );
  const stopped = "Thread stopped by user request";
  expect(interactions).toEqual([
    { status: "interrupted", statusReason: stopped },
  ]);
  expect(lastInput(server)).toEqual(["after stop", "start"]);
  expect(queued(id)).toEqual(["thread-busy"]);
  await ingest(id, events.started("t2"), events.completed("t2"));
  expect(lastInput(server)).toEqual(["held", "start"]);
});

it("stops a thread that is still provisioning or about to start", async () => {
  const server = await createThreadServer();
  const { api, ctx, eventData, ingest, runner, submitted, thread } = server;
  const release = deferredEnvironment(server);
  const created = await api.threads.$post({
    json: {
      ...FIRST_MESSAGE,
      projectId: "proj_1",
      origin: "app",
      input: text("stop me early"),
      model: "gpt-test",
      environment: { type: "project-default" },
    },
  });
  const id = (await created.json()).id;
  await ctx.threads.stop(id);
  expect(thread(id).status).toBe("idle");
  const [cancelled] = eventData(id, "system/thread-provisioning").slice(-1);
  expect(cancelled.status).toBe("cancelled");
  release();
  await server.settle();
  expect([submitted.length, thread(id).environmentId]).toEqual([
    0,
    expect.stringMatching(/^env_/u),
  ]);

  const send = sender(server, id);
  expect(await send("auto", "now go")).toEqual([200, "sent"]);
  expect(thread(id)).toMatchObject({ status: "active", activeTurnId: null });
  runner.script.interruptTurn = async () => ({ interrupted: false });
  await ctx.threads.stop(id);
  expect(thread(id).status).toBe("idle");
  const interrupts = (): number =>
    runner.calls.filter((call) => call.method === "interruptTurn").length;
  const before = interrupts();
  await ingest(id, events.started("t1"));
  expect([thread(id).status, interrupts()]).toEqual(["idle", before + 1]);
  await ingest(id, events.completed("t1", "interrupted"));
  expect(thread(id)).toMatchObject({ status: "idle", activeTurnId: null });
});
