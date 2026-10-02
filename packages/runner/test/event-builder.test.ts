import { threadEventSchema } from "@bb/domain";
import { expect, it } from "vitest";
import { EventBuilder, type RunnerThreadEvent } from "@bb/runner";

const REQUEST = "creq_aaaaaaaaaa";
const command = { type: "commandExecution" as const, command: "ls", cwd: "/" };

it("holds events until identity, mints parent ids early, drops stray traffic", () => {
  const events: RunnerThreadEvent[] = [];
  const emit = (event: RunnerThreadEvent) => {
    threadEventSchema.parse({ ...event, threadId: "thr_test" });
    events.push(event);
  };
  const builder = new EventBuilder({ emit, now: () => 1_000 });
  builder.started();
  builder.acceptInput(REQUEST);
  const child = builder.openTurn({ turn: "child", parentRef: "call-1" });
  expect(events).toEqual([]);
  builder.identity("prov-1");
  const root = builder.openTurn({ turn: "root" });
  const agent = { type: "delegation" as const, childRef: "c", label: "x" };
  const call = { providerItemId: "call-1" };
  const shape = { ...agent, background: false };
  const parentToolCallId = builder.openItem(call, shape, { turn: "root" });
  expect(root).toMatch(/^da[0-9a-f]{8}-t2$/);
  expect(parentToolCallId).toMatch(/-i1$/);
  expect(builder.providerTurnId(child)).toBe("child");
  expect(builder.activeTurnId).toBe(root);
  expect(events).toMatchObject([
    { type: "thread/identity", scope: { kind: "thread" } },
    { type: "thread/started", scope: { kind: "thread" } },
    { type: "turn/started", providerThreadId: "prov-1", parentToolCallId },
    { type: "turn/started", scope: { turnId: root } },
    { clientRequestId: REQUEST, scope: { turnId: root } },
    { type: "item/started", item: { id: parentToolCallId } },
  ]);
  const key = { providerItemId: "cmd-1", parentRef: "call-1" };
  const done = { turn: "child", status: "completed" as const };
  builder.openItem(key, command, { turn: "child" });
  builder.delta(key, "command", "out", { turn: "child" });
  expect(events.slice(-2)).toMatchObject([
    { item: { status: "pending", parentToolCallId } },
    { delta: "out", parentToolCallId },
  ]);
  builder.closeItem(key, command, done);
  builder.closeItem(key, command, done);
  builder.delta(key, "command", "late", { turn: "child" });
  builder.closeTurn({ turn: "never-opened", status: "completed" });
  const tail = events.slice(-2);
  expect(tail).toMatchObject([{ delta: "out" }, { type: "item/completed" }]);
});
