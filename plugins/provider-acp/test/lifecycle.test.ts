import { describe, expect, it } from "vitest";
import { createHarness } from "./adapter-harness.js";
import { type Harness, ofType, trackSessions } from "./lifecycle-helpers.js";

const tracked = trackSessions();

function usage(harness: Harness) {
  return ofType(harness, "thread/contextWindowUsage/updated").map((event) => ({
    used: event.contextWindowUsage.usedTokens,
    size: event.contextWindowUsage.modelContextWindow,
  }));
}

describe("acp adapter: session construction", () => {
  it("emits identity first at every construction (start, resume)", async () => {
    const env = { FAKE_ACP_LOAD_SESSION: "1" };
    const { harness, session } = await tracked.start({ env });
    expect(harness.types()[0]).toBe("thread/identity");
    await session.close();
    const resumed = createHarness({ env });
    const again = await tracked.open(resumed, session.providerThreadId);
    expect(again.providerThreadId).toBe(session.providerThreadId);
    expect(resumed.types()[0]).toBe("thread/identity");
    expect(ofType(resumed, "thread/identity")).toEqual([
      expect.objectContaining({ providerThreadId: session.providerThreadId }),
    ]);
  });

  it("surfaces Grok context window size and prompt usage from session _meta", async () => {
    const { harness, session } = await tracked.start({
      agent: { dialect: "grok" },
      env: { FAKE_ACP_GROK_CONTEXT: "1" },
    });
    expect(usage(harness)).toEqual([{ used: 0, size: 500_000 }]);
    await harness.turn(session, "hello");
    expect(usage(harness)).toEqual([
      { used: 0, size: 500_000 },
      { used: 17_504, size: 500_000 },
    ]);
  });

  it("ignores Grok-shaped session _meta on other ACP dialects", async () => {
    const { harness, session } = await tracked.start({
      env: { FAKE_ACP_GROK_CONTEXT: "1" },
    });
    expect(usage(harness)).toEqual([]);
    await harness.turn(session, "hello");
    expect(usage(harness)).toEqual([]);
  });

  it("holds an agent update written with the session/new response until thread/identity is out, and leaves out what the agent said before any prompt", async () => {
    const { harness } = await tracked.start({
      env: { FAKE_ACP_UPDATES_WITH_SESSION_RESPONSE: "1" },
    });
    const types = harness.types();
    expect(types[0]).toBe("thread/identity");
    expect(types).not.toContain("item/agentMessage/delta");
    expect(types).not.toContain("turn/started");
    expect(usage(harness)).toEqual([{ used: 12_345, size: 200_000 }]);
  });
});
