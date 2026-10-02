import { threadEventSchema } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { EventBuilder, type RunnerThreadEvent } from "@bb/runner";

const REQUEST = "creq_aaaaaaaaaa";
const command = {
  type: "commandExecution" as const,
  command: "ls",
  cwd: "/work",
};

function harness(identified = true) {
  const events: RunnerThreadEvent[] = [];
  let clock = 1_000;
  const builder = new EventBuilder({
    providerId: "echo",
    emit: (event) => events.push(event),
    now: () => clock,
  });
  if (identified) builder.identity("prov-1");
  return {
    builder,
    events,
    advance: (ms: number) => (clock += ms),
    types: () => events.map((event) => event.type),
    take: () => events.splice(0),
  };
}

function expectValid(events: RunnerThreadEvent[]) {
  for (const event of events) {
    threadEventSchema.parse({ ...event, threadId: "thr_test" });
  }
}

describe("EventBuilder", () => {
  it("holds events until identity and mints a parent id before its item", () => {
    const { builder, events } = harness(false);
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
    const stamped = { providerThreadId: "prov-1" };
    expect(events).toMatchObject([
      { type: "thread/identity", scope: { kind: "thread" } },
      { type: "thread/started", scope: { kind: "thread" } },
      { type: "turn/started", ...stamped, parentToolCallId },
      { type: "turn/started", scope: { turnId: root } },
      { clientRequestId: REQUEST, scope: { turnId: root } },
      { type: "item/started", item: { id: parentToolCallId } },
    ]);
    const key = { providerItemId: "cmd-1", parentRef: "call-1" };
    builder.openItem(key, command, { turn: "child" });
    builder.delta(key, "command", "out", { turn: "child" });
    expect(events.slice(-2)).toMatchObject([
      { item: { status: "pending", parentToolCallId } },
      { delta: "out", parentToolCallId },
    ]);
    expectValid(events);
  });

  it("coalesces text within 100 ms and flushes at ordering barriers", () => {
    const { builder, events, advance, take } = harness();
    builder.openTurn({ turn: "t" });
    const key = { providerItemId: "msg" };
    take();
    builder.delta(key, "agentMessage", "a", { turn: "t" });
    expect(events.map((event) => event.type)).toEqual([
      "item/started",
      "item/agentMessage/delta",
    ]);
    advance(10);
    builder.delta(key, "agentMessage", "b", { turn: "t" });
    builder.delta(key, "agentMessage", "c", { turn: "t" });
    expect(events).toHaveLength(2);
    builder.openItem({ providerItemId: "cmd" }, command, { turn: "t" });
    expect(take().slice(2)).toMatchObject([
      { type: "item/agentMessage/delta", delta: "bc" },
      { type: "item/started", item: { type: "commandExecution" } },
    ]);
    builder.delta(key, "agentMessage", "d", { turn: "t" });
    expect(events).toHaveLength(0);
    advance(100);
    builder.delta(key, "agentMessage", "e", { turn: "t" });
    expect(take()).toMatchObject([{ delta: "d" }]);
    builder.delta(key, "agentMessage", "f", { turn: "t" });
    builder.textClose(key, "agentMessage", undefined, { turn: "t" });
    const closed = take();
    expect(closed).toMatchObject([
      { delta: "ef" },
      {
        type: "item/completed",
        item: { type: "agentMessage", text: "abcdef" },
      },
    ]);
    expectValid(closed);
  });

  it("drops traffic that breaks the live grammar", () => {
    const { builder, take, types } = harness();
    builder.openTurn({ turn: "t" });
    builder.openTurn({ turn: "t" });
    builder.closeTurn({ turn: "never-opened", status: "completed" });
    builder.delta({ providerItemId: "ghost" }, "command", "x", {
      turn: "t",
    });
    builder.progress({ providerItemId: "ghost" }, { turn: "t" });
    const key = { providerItemId: "cmd" };
    builder.openItem(key, command, { turn: "t" });
    builder.closeItem(key, command, { turn: "t", status: "completed" });
    builder.closeItem(key, command, { turn: "t", status: "failed" });
    builder.delta(key, "command", "late", { turn: "t" });
    builder.closeTurn({ turn: "t", status: "completed" });
    builder.closeTurn({ turn: "t", status: "failed" });
    builder.openTurn({ turn: "t" });

    expect(types()).toEqual([
      "thread/identity",
      "turn/started",
      "item/started",
      "item/completed",
      "turn/completed",
    ]);
    expect(builder.activeTurnId).toBeNull();
    expectValid(take());
  });

  it("settles open items and turns when a session ends", () => {
    const { builder, take } = harness();
    builder.openTurn({ turn: "t" });
    builder.openItem({ providerItemId: "cmd" }, command, { turn: "t" });
    builder.delta({ providerItemId: "msg" }, "agentMessage", "partial", {
      turn: "t",
    });
    const task = {
      type: "backgroundTask" as const,
      taskType: "local_bash",
      description: "watch",
      taskStatus: "running" as const,
      skipTranscript: false,
    };
    builder.openItem({ providerItemId: "bg" }, task, { turn: "t" });
    take();
    builder.settle("interrupted");
    const settled = take();
    expect(settled).toMatchObject([
      { type: "item/completed", item: { status: "interrupted" } },
      {
        type: "item/completed",
        item: { type: "agentMessage", text: "partial" },
      },
      { type: "turn/completed", status: "interrupted" },
    ]);
    expect(builder.activeTurnId).toBeNull();
    expect(builder.hasOpenBackgroundWork()).toBe(true);
    builder.closeItem({ providerItemId: "bg" }, task, { status: "completed" });
    const background = take();
    expect(background).toMatchObject([
      { type: "item/backgroundTask/completed", scope: { kind: "thread" } },
    ]);
    expect(builder.hasOpenBackgroundWork()).toBe(false);
    expectValid([...settled, ...background]);
  });

  it("opens a turn for queued input when an error settles it", () => {
    const { builder, take } = harness();
    builder.acceptInput(REQUEST);
    builder.error({ detail: "boom", willRetry: false }, { settlesTurn: true });
    const failed = take().slice(1);
    expect(failed.map((event) => event.type)).toEqual([
      "turn/started",
      "turn/input/accepted",
      "provider/error",
      "turn/completed",
    ]);
    expect(failed[3]).toMatchObject({ status: "failed" });
    builder.error({ detail: "outside" }, { threadScoped: true });
    builder.usage({ total: usage, last: usage, modelContextWindow: 10 });
    const window = { usedTokens: 5, modelContextWindow: 10, estimated: false };
    builder.contextWindow(window, undefined, true);
    const after = take();
    expect(after.map((event) => event.scope.kind)).toEqual([
      "thread",
      "turn",
      "thread",
    ]);
    expectValid([...failed, ...after]);
  });
});

const usage = {
  totalTokens: 5,
  inputTokens: 4,
  cachedInputTokens: 0,
  outputTokens: 1,
  reasoningOutputTokens: 0,
};
