import type { PendingInteractionPayload } from "@bb/domain";
import { expect, it } from "vitest";
import { createThreadServer, events, text } from "./thread-harness.js";

const question: PendingInteractionPayload = {
  kind: "user_question",
  questions: [
    { id: "q1", prompt: "Push?", multiSelect: false, allowFreeText: true },
  ],
};

it("steers, queues and drains around a running turn", async () => {
  const server = await createThreadServer();
  const { eventData, http, ingest, lastSubmit, queued, submitted } = server;
  const id = await server.spawn();
  const send = (mode: string, message: string) =>
    server.send(id, mode, message);

  const starting = [200, "queued", "turn-starting"];
  expect(await send("steer-if-active", "one")).toEqual(starting);
  await ingest(id, events.identity(), events.started("t1"));
  expect([queued(id), lastSubmit()]).toEqual([[], ["one", "auto"]]);

  expect(await send("steer", "two")).toEqual([200, "sent"]);
  const steer = { kind: "steer", expectedTurnId: "t1" };
  expect(submitted[submitted.length - 1].mode).toEqual(steer);
  const busy = [200, "queued", "thread-busy"];
  expect(await send("queue-if-active", "three")).toEqual(busy);
  expect(await send("start", "nope")).toEqual([409, "already_active"]);
  const explicit = { input: text("four") };
  const added = await http("POST", `/threads/${id}/queued-messages`, explicit);
  expect([added.status, submitted.length]).toEqual([201, 3]);

  await ingest(id, events.completed("t1"));
  expect(lastSubmit()).toEqual(["three", "start"]);
  expect(queued(id)).toEqual(["thread-busy"]);
  const targets = eventData(id, "client/turn/requested").map(
    (request) => (request.target as { kind: string }).kind,
  );
  expect(targets).toEqual(["thread-start", "auto", "steer", "new-turn"]);
  await ingest(id, events.started("t2"), events.completed("t2", "failed"));
  const failed = ["error", ["thread-busy"]];
  expect([server.thread(id).status, queued(id)]).toEqual(failed);
});

it("holds messages on time, interactions, hosts and provisioning", async () => {
  const server = await createThreadServer();
  const { clock, ctx, emit, ingest, lastSubmit, queued } = server;
  const id = await server.spawn();
  const send = (mode: string, message: string, at?: number) =>
    server.send(id, mode, message, at);
  await server.runTurn(id, "t1");

  const at = clock.now + 60_000;
  expect(await send("auto", "later", at)).toEqual([200, "queued", "time"]);
  await server.advance(1_000);
  expect(queued(id)).toEqual(["time"]);
  await server.advance(59_000);
  expect(lastSubmit()).toEqual(["later", "start"]);

  await ingest(id, events.started("t2"));
  await server.interact(id, "req-1", question, "t2");
  const waiting = [200, "queued", "interaction"];
  expect(await send("steer-if-active", "answer first")).toEqual(waiting);
  const cancelled = { threadId: id, requestId: "req-1", reason: "gave up" };
  await emit({ kind: "interaction.cancelled", ...cancelled });
  expect(lastSubmit()).toEqual(["answer first", "auto"]);
  await ingest(id, events.completed("t2"));

  ctx.runners.disconnect(server.hostId);
  const offline = [200, "queued", "host-offline"];
  expect(await send("auto", "when back")).toEqual(offline);
  await server.reconnect();
  expect(lastSubmit()).toEqual(["when back", "start"]);

  const release = server.deferEnvironment();
  const other = await server.spawn({ origin: "cli" }, false);
  const followUp = { input: text("also this"), mode: "auto" as const };
  const held = await ctx.threads.send(other, followUp);
  const provisioning = { waitingOn: { kind: "provisioning" } };
  expect(held).toMatchObject({ queuedMessage: provisioning });
  release();
  await server.settle();
  expect(queued(other)).toEqual(["turn-starting"]);
  await ingest(other, events.started("o1"));
  expect(lastSubmit()).toEqual(["also this", "auto"]);
});

it("refuses a message to a thread whose machine was removed", async () => {
  const server = await createThreadServer();
  const id = await server.spawn();
  await server.runTurn(id, "t1");
  server.ctx.runners.disconnect(server.hostId);
  const removed = "UPDATE hosts SET destroyed_at = 1 WHERE id = ?";
  server.ctx.db.run(removed, server.hostId);
  const refused = [409, "machine_removed"];
  expect(await server.send(id, "auto", "anyone?")).toEqual(refused);
  expect(server.queued(id)).toEqual([]);
});

it("stops a running turn and pauses the turn-bound queue", async () => {
  const server = await createThreadServer();
  const { eventData, ingest, lastSubmit, queued, thread } = server;
  const id = await server.spawn();
  const send = (mode: string, message: string) =>
    server.send(id, mode, message);
  await ingest(id, events.identity(), events.started("t1"));
  expect(await send("queue-if-active", "held")).toHaveLength(3);
  await server.interact(id, "req-1", question);

  await server.http("POST", `/threads/${id}/stop`);
  expect(thread(id).status).toBe("stopping");
  expect(server.callsTo("interruptTurn")).toEqual([{ threadId: id }]);
  const stopping = [200, "queued", "stopping"];
  expect(await send("auto", "after stop")).toEqual(stopping);
  await ingest(id, events.completed("t1", "interrupted"));
  const interrupted = eventData(id, "system/thread/interrupted");
  expect(interrupted).toEqual([{ reason: "manual-stop" }]);
  const reasons = "SELECT status_reason FROM pending_interactions";
  const statusReason = "Thread stopped by user request";
  expect(server.rows(reasons)).toEqual([{ statusReason }]);
  expect(lastSubmit()).toEqual(["after stop", "start"]);
  expect(queued(id)).toEqual(["thread-busy"]);
  await ingest(id, events.started("t2"), events.completed("t2"));
  expect(lastSubmit()).toEqual(["held", "start"]);
});

it("stops a thread that is still provisioning or about to start", async () => {
  const server = await createThreadServer();
  const { ctx, eventData, ingest, runner, submitted, thread } = server;
  const release = server.deferEnvironment();
  const id = await server.spawn({}, false);
  await ctx.threads.stop(id);
  expect(thread(id).status).toBe("idle");
  const provisioning = eventData(id, "system/thread-provisioning");
  expect(provisioning[provisioning.length - 1].status).toBe("cancelled");
  release();
  await server.settle();
  const attached = expect.stringMatching(/^env_/u);
  expect([submitted.length, thread(id).environmentId]).toEqual([0, attached]);

  expect(await server.send(id, "auto", "now go")).toEqual([200, "sent"]);
  expect(thread(id)).toMatchObject({ status: "active", activeTurnId: null });
  runner.script.interruptTurn = async () => ({ interrupted: false });
  await ctx.threads.stop(id);
  expect(thread(id).status).toBe("idle");
  const interrupts = () => server.callsTo("interruptTurn").length;
  const before = interrupts();
  await ingest(id, events.started("t1"));
  expect([thread(id).status, interrupts()]).toEqual(["idle", before + 1]);
  await ingest(id, events.completed("t1", "interrupted"));
  expect(thread(id)).toMatchObject({ status: "idle", activeTurnId: null });
});

it("sends queued messages in the order a client set", async () => {
  const server = await createThreadServer();
  const { http, ingest, lastSubmit } = server;
  const id = await server.spawn();
  await server.send(id, "steer-if-active", "one");
  await ingest(id, events.identity(), events.started("t1"));
  await server.send(id, "queue-if-active", "two");
  await server.send(id, "queue-if-active", "three");
  const path = `/threads/${id}/queued-messages`;
  type Queued = { id: string }[];
  const listed = (await http<Queued>("GET", path)).body;
  const reversed = listed.map((message) => message.id).reverse();
  const moved = await http<Queued>("PUT", `${path}/order`, {
    queuedMessageIds: reversed.slice(0, 1),
  });
  expect(moved.body.map((message) => message.id)).toEqual(reversed);
  const stray = { queuedMessageIds: ["qmsg_missing"] };
  expect((await http("PUT", `${path}/order`, stray)).status).toBe(404);
  await ingest(id, events.completed("t1"));
  expect(lastSubmit()).toEqual(["three", "start"]);
});

it("sends queued messages up to a group boundary as one turn", async () => {
  const server = await createThreadServer();
  const { http, ingest, submitted } = server;
  const id = await server.spawn();
  await server.send(id, "steer-if-active", "one");
  await ingest(id, events.identity(), events.started("t1"));
  for (const message of ["two", "three", "four"]) {
    await server.send(id, "queue-if-active", message);
  }
  const path = `/threads/${id}/queued-messages`;
  type Queued = { id: string; groupWithNext: boolean }[];
  const ids = (await http<Queued>("GET", path)).body.map((row) => row.id);
  const boundary = `${path}/${ids[1]}/boundary`;
  const stale = { expectedGroupedPrefixQueuedMessageIds: [ids[1]] };
  expect((await http("PUT", boundary, stale)).status).toBe(409);
  const grouped = await http<Queued>("PUT", boundary, {
    expectedGroupedPrefixQueuedMessageIds: ids.slice(0, 2),
  });
  const flags = grouped.body.map((row) => row.groupWithNext);
  expect(flags).toEqual([true, false, false]);
  const listed = (await http<Queued>("GET", path)).body;
  expect(listed.map((row) => row.groupWithNext)).toEqual(flags);
  await ingest(id, events.completed("t1"));
  const sent = submitted[submitted.length - 1].input.map((part) =>
    part.type === "text" ? part.text : part.type,
  );
  expect(sent).toEqual(["two", "\n\n", "three"]);
  const left = (await http<Queued>("GET", path)).body.map((row) => row.id);
  expect(left).toEqual([ids[2]]);
});
