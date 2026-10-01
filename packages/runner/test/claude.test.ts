import { threadEventSchema } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  normalizeIds,
  readOriginalEvents,
  replayClaudeRecording,
} from "./claude-replay.js";

const SCENARIOS = [
  "turn-tools",
  "steer-compaction",
  "stop-interrupt",
  "approval-allow",
  "approval-deny",
  "subagent",
  "resume",
  "web-search",
  "plan-mode",
  "user-question",
  "fork",
  "auth-failure",
];

describe("claude adapter against recorded Claude Code sessions", () => {
  it.each(SCENARIOS)("%s matches the original pipeline", async (scenario) => {
    const { events, mismatches } = await replayClaudeRecording(scenario);
    for (const event of events) {
      threadEventSchema.parse({ ...event, threadId: "thr_replay" });
    }
    expect(normalizeIds(events)).toEqual(
      normalizeIds(readOriginalEvents(scenario)),
    );
    expect(mismatches).toEqual([]);
  });
});
