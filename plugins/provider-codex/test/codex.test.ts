import { threadEventSchema } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  createCodexFake,
  readOriginalEvents,
  replayCodexRecording,
} from "./codex-replay.js";
import { internIds, kept, until } from "../../../packages/runner/test/kit.js";

const SCENARIOS = [
  "turn-tools",
  "steer",
  "stop-interrupt",
  "approval-allow",
  "approval-deny",
  "subagent",
  "resume",
  "web-search",
  "plan-mode",
  "user-question",
  "auth-failure",
];

describe("codex adapter against recorded app-server sessions", () => {
  it.each(SCENARIOS)("%s matches the original pipeline", async (scenario) => {
    const { events, mismatches } = await replayCodexRecording(scenario);
    const original = kept(readOriginalEvents(scenario));
    for (const event of events) {
      threadEventSchema.parse({ ...event, threadId: "thr_replay" });
    }
    expect(internIds(events)).toEqual(internIds(original));
    expect(mismatches).toEqual([]);
  });
});

describe("codex checkpoint fork", () => {
  it("reports each recorded turn's id as its checkpoint", () => {
    const original = readOriginalEvents("turn-tools");
    const done = original.filter((e) => e.type === "turn/completed");
    expect(done.length).toBeGreaterThan(0);
    for (const event of done) {
      expect(event).toMatchObject({ providerCheckpointId: expect.any(String) });
    }
  });

  it("opens a forkFrom session with thread/fork at the checkpoint", async () => {
    const fake = createCodexFake();
    const checkpoint = { providerThreadId: "src", checkpointId: "turn-2" };
    const opening = fake.open({ forkFrom: checkpoint });
    await fake.reply("initialize", {});
    const fork = await fake.reply("thread/fork", { thread: { id: "forked" } });
    expect(fork.params).toMatchObject({
      threadId: "src",
      lastTurnId: "turn-2",
      cwd: "/work",
      model: "gpt-test",
    });
    const session = await opening;
    expect(session.providerThreadId).toBe("forked");
    const input = [{ type: "text" as const, text: "hi", mentions: [] }];
    const options = fake.execution;
    const turn = session.startTurn({ clientRequestId: "c1", input, options });
    await fake.reply("turn/start", {
      turn: { id: "t9", status: "inProgress" },
    });
    await turn;
    const completed = { id: "t9", status: "completed" };
    const params = { threadId: "forked", turn: completed };
    fake.notify({ method: "turn/completed", params });
    const closed = () => fake.events.find((e) => e.type === "turn/completed");
    expect(await until(closed)).toMatchObject({ providerCheckpointId: "t9" });
    await session.close();
  });

  it("refuses to fork on a Codex too old to cut at a turn", async () => {
    const fake = createCodexFake();
    const checkpoint = { providerThreadId: "src", checkpointId: "turn-2" };
    const opening = fake.open({ forkFrom: checkpoint });
    const refused = expect(opening).rejects.toThrow("0.143.0 or newer");
    await fake.reply("initialize", { userAgent: "codex_cli_rs/0.142.9 (x)" });
    await refused;
  });
});
