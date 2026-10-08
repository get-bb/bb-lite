import { threadEventSchema } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { readOriginalEvents, replayCodexRecording } from "./codex-replay.js";
import { internIds, kept } from "../../../packages/runner/test/kit.js";

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
