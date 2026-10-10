import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderSession } from "@bb/runner";
import { createHarness, text } from "./adapter-harness.js";

const sessions: ProviderSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
});

async function opened(harness: ReturnType<typeof createHarness>) {
  const session = await harness.open();
  sessions.push(session);
  return session;
}

it("runs a turn against an ACP agent and writes it to the timeline", async () => {
  const harness = createHarness();
  const session = await opened(harness);
  expect(session.providerThreadId).toMatch(/^fake-sess-/u);
  await harness.turn(session, "hello there");
  expect(harness.types()).toEqual([
    "thread/identity",
    "turn/started",
    "turn/input/accepted",
    "item/started",
    "item/agentMessage/delta",
    "item/completed",
    "turn/completed",
  ]);
  expect(harness.items()).toEqual([
    expect.objectContaining({ type: "agentMessage", text: "echo:hello there" }),
  ]);
});

it("asks before a tool runs in accept-edits mode and allows it in full mode", async () => {
  const asking = createHarness({ permissionMode: "accept-edits" });
  await asking.turn(await opened(asking), "request-permission");
  expect(asking.interactions).toHaveLength(1);
  expect(asking.interactions[0]).toMatchObject({ kind: "approval" });

  const trusting = createHarness({ permissionMode: "full" });
  await trusting.turn(await opened(trusting), "request-permission");
  expect(trusting.interactions).toEqual([]);
});

it("shows a file the agent writes through bb as a file change", async () => {
  const harness = createHarness();
  const target = join(harness.dir, "notes.txt");
  const session = await harness.open();
  sessions.push(session);
  await session.close();
  const writing = createHarness({ env: { FAKE_ACP_WRITE_PATH: target } });
  await writing.turn(await opened(writing), "write-file");
  expect(existsSync(target)).toBe(true);
  expect(writing.items()).toContainEqual(
    expect.objectContaining({
      type: "fileChange",
      changes: [expect.objectContaining({ path: target, kind: "add" })],
    }),
  );
  expect(readFileSync(target, "utf8").length).toBeGreaterThan(0);
});

it("stops a running turn and resumes the session for the next message", async () => {
  const harness = createHarness({ env: { FAKE_ACP_LOAD_SESSION: "1" } });
  const session = await opened(harness);
  const { execution } = harness;
  const input = text("hang");
  await session.startTurn({
    clientRequestId: "req_hang",
    input,
    options: execution,
  });
  await vi.waitFor(() => expect(harness.types()).toContain("turn/started"));
  await session.interrupt();
  harness.host.events.flush();
  expect(harness.events.at(-1)).toMatchObject({
    type: "turn/completed",
    status: "interrupted",
  });
  expect(session.canApply(harness.spec, execution)).toBe(false);

  const providerThreadId = session.providerThreadId;
  const resumed = await harness.open({ providerThreadId });
  sessions.push(resumed);
  expect(resumed.providerThreadId).toBe(providerThreadId);
  await harness.turn(resumed, "after the stop");
  expect(harness.items().at(-1)).toMatchObject({ text: "echo:after the stop" });
});

it("delivers a message sent during a turn as a steer", async () => {
  const harness = createHarness();
  const session = await opened(harness);
  const { execution } = harness;
  const first = text("slow first");
  await session.startTurn({
    clientRequestId: "req_a",
    input: first,
    options: execution,
  });
  await vi.waitFor(() => expect(harness.types()).toContain("turn/started"));
  const expectedTurnId = harness.host.events.activeTurnId ?? "";
  const outcome = await session.steer({
    clientRequestId: "req_b",
    input: text("second"),
    options: execution,
    expectedTurnId,
  });
  expect(outcome).toBe("steered");
  await vi.waitFor(
    () => {
      harness.host.events.flush();
      expect(harness.types()).toContain("turn/completed");
    },
    { timeout: 10_000 },
  );
  const accepted = harness.events.flatMap((event) =>
    event.type === "turn/input/accepted" ? [event.clientRequestId] : [],
  );
  expect(accepted).toEqual(["req_a", "req_b"]);
  expect(harness.items().at(-1)).toMatchObject({
    text: "echo:slow firstecho:second",
  });
});

it("reports a missing agent command as a missing executable", async () => {
  const harness = createHarness({
    agent: {
      launch: {
        displayName: "Missing",
        command: "bb-acp-agent-that-does-not-exist",
        args: [],
        env: {},
      },
    },
  });
  await expect(harness.open()).rejects.toMatchObject({
    code: "missing_executable",
  });
  expect(await harness.adapter.status()).toMatchObject({
    installed: false,
    auth: "unknown",
  });
});

it("lists the agent's models from the session it opens", async () => {
  const harness = createHarness({ env: { FAKE_ACP_MODEL_CONFIG: "1" } });
  const { models } = await harness.adapter.listModels(null);
  expect(models.length).toBeGreaterThan(0);
  expect(models.some((model) => model.isDefault)).toBe(true);
});
