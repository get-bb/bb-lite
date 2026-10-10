import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createHarness, text } from "./adapter-harness.js";
import {
  allowOnce,
  completions,
  jsonLines,
  messages,
  ofType,
  streamed,
  trackSessions,
  until,
} from "./lifecycle-helpers.js";

const tracked = trackSessions();
const QUIET_MS = 5_000;

describe("acp adapter: work the agent starts on its own", () => {
  it("does not show what an agent says before its first prompt, and does not open a turn that would block the prompt", async () => {
    const { harness, session } = await tracked.start({
      env: { FAKE_ACP_STARTUP_BANNER: "fake agent v1\n\n## Skills" },
    });
    await delay(300);
    expect(ofType(harness, "turn/started")).toHaveLength(0);
    await harness.turn(session, "hello");
    expect(ofType(harness, "turn/started")).toHaveLength(1);
    expect(completions(harness)).toEqual(["completed"]);
    expect(ofType(harness, "provider/warning")).toEqual([]);
    expect(messages(harness)).toHaveLength(1);
    expect(messages(harness).join("")).not.toContain("fake agent v1");
  });

  it("says so when the agent ends a prompted turn without sending anything, and stays quiet when it replied", async () => {
    const { harness, session } = await tracked.start();
    await harness.turn(session, "hello");
    expect(ofType(harness, "provider/warning")).toEqual([]);
    await harness.turn(session, "end-silently");
    expect(ofType(harness, "provider/warning")).toMatchObject([
      { summary: "The agent ended the turn without replying" },
    ]);
    expect(completions(harness)).toEqual(["completed", "completed"]);
  });

  it(
    "opens a turn for unprompted output and closes it after a quiet window",
    async () => {
      const { harness, session } = await tracked.start();
      await harness.turn(session, "then-unprompted-stream");
      await until(() => expect(ofType(harness, "turn/started")).toHaveLength(2));
      await until(() => expect(streamed(harness)).toContain(" unprompted two"));
      expect(completions(harness)).toEqual(["completed"]);
      await until(
        () => expect(completions(harness)).toEqual(["completed", "completed"]),
        QUIET_MS + 5_000,
      );
      expect(messages(harness)).toEqual([
        "prompted reply",
        "unprompted one",
        " unprompted two",
      ]);
      const backgroundJob = harness
        .items()
        .find(
          (item) =>
            JSON.stringify(item).includes("Background job") ||
            JSON.stringify(item).includes("unprompted-tool"),
        );
      expect(backgroundJob).toBeDefined();
    },
    20_000,
  );

  it(
    "keeps the agent's turn open while a tool it announced is running, and settles it as interrupted when the user sends a message",
    async () => {
      const { harness, session } = await tracked.start();
      await harness.turn(session, "then-unprompted-open-tool");
      await until(() => expect(ofType(harness, "turn/started")).toHaveLength(2));
      await delay(QUIET_MS + 500);
      expect(completions(harness)).toEqual(["completed"]);
      await harness.turn(session, "after the build");
      await until(() => expect(completions(harness)).toHaveLength(3));
      expect(completions(harness)).toEqual([
        "completed",
        "interrupted",
        "completed",
      ]);
      expect(messages(harness).at(-1)).toBe("echo:after the build");
    },
    20_000,
  );

  it("runs a steer that arrives during the agent's own turn as a prompt inside that turn", async () => {
    const { harness, session } = await tracked.start();
    await harness.turn(session, "then-unprompted-open-tool");
    await until(() => expect(ofType(harness, "turn/started")).toHaveLength(2));
    const outcome = await session.steer({
      clientRequestId: "req_steer",
      input: text("what is running?"),
      options: harness.execution,
      expectedTurnId: harness.host.events.activeTurnId ?? "",
    });
    expect(outcome).toBe("steered");
    await until(() => expect(completions(harness)).toHaveLength(2));
    expect(ofType(harness, "turn/started")).toHaveLength(2);
    expect(completions(harness)).toEqual(["completed", "completed"]);
    expect(messages(harness).at(-1)).toBe("echo:what is running?");
    expect(ofType(harness, "turn/input/accepted")).toHaveLength(2);
  });

  it("shows a permission request the agent raises with no prompt in flight instead of cancelling it", async () => {
    const { harness, session } = await tracked.start({
      permissionMode: "accept-edits",
      answer: allowOnce,
    });
    await harness.turn(session, "then-unprompted-permission");
    await until(() => expect(harness.interactions).toHaveLength(1));
    expect(harness.interactions[0]).toMatchObject({ kind: "approval" });
    expect(ofType(harness, "turn/started")).toHaveLength(2);
    await until(() =>
      expect(streamed(harness)).toContain("permission:allow"),
    );
  });

  it("fails the agent's own turn when the agent exits during it", async () => {
    const readyFile = join(createHarness().dir, "agent-ready");
    const { harness, session } = await tracked.start({
      env: { FAKE_ACP_READY_FILE: readyFile },
    });
    await harness.turn(session, "then-unprompted-open-tool");
    await until(() => expect(ofType(harness, "turn/started")).toHaveLength(2));
    process.kill(Number(readFileSync(readyFile, "utf8")), "SIGKILL");
    await until(() => expect(completions(harness)).toHaveLength(2));
    expect(completions(harness)).toEqual(["completed", "failed"]);
  });
});

describe("acp adapter: busy agents and stop reasons", () => {
  it("waits for a busy agent to go quiet and resends the prompt once", async () => {
    const log = join(createHarness().dir, "prompts.log");
    const { harness, session } = await tracked.start({
      env: { FAKE_ACP_SESSION_BUSY_PROMPTS: "1", FAKE_ACP_PROMPT_LOG: log },
    });
    await harness.turn(session, "hello");
    expect(completions(harness)).toEqual(["completed"]);
    expect(jsonLines(log)).toEqual(["hello", "hello"]);
    expect(messages(harness)).toEqual(["echo:hello"]);
    expect(ofType(harness, "turn/input/accepted")).toHaveLength(1);
  });

  it(
    "fails the turn with the agent's own error when it stays busy",
    async () => {
      const log = join(createHarness().dir, "prompts.log");
      const { harness, session } = await tracked.start({
        env: { FAKE_ACP_SESSION_BUSY_PROMPTS: "10", FAKE_ACP_PROMPT_LOG: log },
      });
      await session.startTurn({
        clientRequestId: "req_busy",
        input: text("hello"),
        options: harness.execution,
      });
      await until(() => expect(completions(harness)).toEqual(["failed"]), 15_000);
      expect(jsonLines(log)).toHaveLength(4);
      expect(JSON.stringify(ofType(harness, "provider/error"))).toContain(
        "already processing",
      );
    },
    20_000,
  );

  it.each([
    ["max_tokens", "The agent stopped at its output limit"],
    ["refusal", "The agent declined to continue"],
    ["paused_by_vendor", "The agent stopped the turn"],
  ])(
    "ends a turn that stops with %s as completed with a notice",
    async (stopReason, summary) => {
      const { harness, session } = await tracked.start();
      await harness.turn(session, `stop-reason:${stopReason}`);
      expect(completions(harness)).toEqual(["completed"]);
      expect(ofType(harness, "provider/warning").at(-1)).toMatchObject({
        summary,
      });
    },
  );
});
