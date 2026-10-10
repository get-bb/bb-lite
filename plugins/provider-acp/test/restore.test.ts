import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHarness, text } from "./adapter-harness.js";
import {
  begin,
  completions,
  jsonLines,
  messages,
  ofType,
  trackSessions,
  until,
} from "./lifecycle-helpers.js";

const tracked = trackSessions();

async function stopped(env: Record<string, string>) {
  const { session } = await tracked.start({ env });
  const providerThreadId = session.providerThreadId;
  await session.close();
  return providerThreadId;
}

describe("acp adapter: restoring sessions", () => {
  it("forwards context usage reported during session/load", async () => {
    const id = await stopped({ FAKE_ACP_LOAD_SESSION: "1" });
    const harness = createHarness({
      env: { FAKE_ACP_LOAD_SESSION: "1", FAKE_ACP_USAGE_ON_LOAD: "1" },
    });
    const session = await tracked.open(harness, id);
    expect(session.providerThreadId).toBe(id);
    expect(
      ofType(harness, "thread/contextWindowUsage/updated").at(-1),
    ).toMatchObject({
      contextWindowUsage: {
        usedTokens: 24_000,
        modelContextWindow: 128_000,
        estimated: false,
      },
    });
    expect(ofType(harness, "provider/warning")).toHaveLength(0);
  });

  it("ignores load-time context usage for a different session", async () => {
    const id = await stopped({ FAKE_ACP_LOAD_SESSION: "1" });
    const harness = createHarness({
      env: {
        FAKE_ACP_LOAD_SESSION: "1",
        FAKE_ACP_USAGE_ON_LOAD: "1",
        FAKE_ACP_USAGE_SESSION_ID: "different-session",
      },
    });
    const session = await tracked.open(harness, id);
    expect(session.providerThreadId).toBe(id);
    expect(ofType(harness, "thread/contextWindowUsage/updated")).toEqual([]);
  });

  it("discards load-time context usage when session/load fails", async () => {
    const id = await stopped({ FAKE_ACP_LOAD_SESSION: "1" });
    const harness = createHarness({
      env: { FAKE_ACP_FAIL_LOAD: "1", FAKE_ACP_USAGE_ON_LOAD: "1" },
    });
    const session = await tracked.open(harness, id);
    expect(session.providerThreadId).not.toBe(id);
    expect(ofType(harness, "thread/contextWindowUsage/updated")).toEqual([]);
    expect(ofType(harness, "provider/warning")).not.toHaveLength(0);
  });

  it("re-applies ACP-native reasoning after session/load resume", async () => {
    const env = {
      FAKE_ACP_LOAD_SESSION: "1",
      FAKE_ACP_MODEL_CONFIG: "1",
      FAKE_ACP_THOUGHT_LEVEL_CONFIG: "1",
    };
    const id = await stopped(env);
    const harness = createHarness({ env });
    harness.execution.model = "fake/strong";
    harness.execution.reasoningLevel = "high";
    const session = await tracked.open(harness, id);
    expect(session.providerThreadId).toBe(id);
    await harness.turn(session, "echo-selected-effort");
    expect(messages(harness)).toContain("selected-effort:high");
  });

  it("falls back to a fresh session with a warning when load is unsupported", async () => {
    const harness = createHarness();
    const session = await tracked.open(harness, "fake-sess-stale");
    expect(session.providerThreadId).not.toBe("fake-sess-stale");
    expect(ofType(harness, "provider/warning")).not.toHaveLength(0);
  });

  it("restores a session with session/resume when the agent offers it, without replaying history", async () => {
    const env = { FAKE_ACP_RESUME_SESSION: "1", FAKE_ACP_LOAD_SESSION: "1" };
    const id = await stopped(env);
    const log = join(createHarness().dir, "requests.jsonl");
    const harness = createHarness({
      env: { ...env, FAKE_ACP_REQUEST_LOG: log },
    });
    const session = await tracked.open(harness, id);
    expect(session.providerThreadId).toBe(id);
    const methods = jsonLines<{ method?: string }>(log).map(
      (request) => request.method,
    );
    expect(methods).toContain("session/resume");
    expect(methods).not.toContain("session/load");
    expect(ofType(harness, "provider/warning")).toEqual([]);
  });

  it("restores a session when the agent offers only session/resume", async () => {
    const env = { FAKE_ACP_RESUME_SESSION: "1" };
    const id = await stopped(env);
    const session = await tracked.open(createHarness({ env }), id);
    expect(session.providerThreadId).toBe(id);
  });

  it("does not send the instructions again to a session the agent restored", async () => {
    const log = join(createHarness().dir, "prompts.log");
    const env = { FAKE_ACP_LOAD_SESSION: "1", FAKE_ACP_PROMPT_LOG: log };
    const options = { env, instructions: "Be terse." };
    const { harness, session } = await tracked.start(options);
    await harness.turn(session, "first");
    await session.close();
    const again = createHarness(options);
    await again.turn(
      await tracked.open(again, session.providerThreadId),
      "second",
    );
    expect(jsonLines(log)).toEqual([
      "<system_instructions>\nBe terse.\n</system_instructions>\nfirst",
      "second",
    ]);
  });

  it("sends the instructions again when the agent could not restore the session", async () => {
    const log = join(createHarness().dir, "prompts.log");
    const options = {
      env: { FAKE_ACP_PROMPT_LOG: log },
      instructions: "Be terse.",
    };
    const id = (await tracked.start(options)).session.providerThreadId;
    const again = createHarness(options);
    const resumed = await tracked.open(again, id);
    expect(resumed.providerThreadId).not.toBe(id);
    await again.turn(resumed, "second");
    expect(jsonLines(log)).toEqual([
      "<system_instructions>\nBe terse.\n</system_instructions>\nsecond",
    ]);
  });
});

describe("acp adapter: agent exits", () => {
  it("reports unexpected agent exits as a single provider error", async () => {
    const { harness, session } = await tracked.start();
    await begin(harness, session, "die");
    await until(() => expect(harness.exits).toHaveLength(1));
    await until(() => expect(completions(harness)).toEqual(["failed"]));
    await session.close();
    expect(harness.exits).toHaveLength(1);
    const next = await tracked.open(harness, session.providerThreadId);
    await harness.turn(next, "after");
    expect(completions(harness)).toEqual(["failed", "completed"]);
    expect(messages(harness)).toContain("echo:after");
  });

  it.each([
    { loadSession: "0", failLoad: "0", activeTurn: false },
    { loadSession: "1", failLoad: "0", activeTurn: false },
    { loadSession: "1", failLoad: "1", activeTurn: false },
    { loadSession: "0", failLoad: "0", activeTurn: true },
    { loadSession: "1", failLoad: "0", activeTurn: true },
    { loadSession: "1", failLoad: "1", activeTurn: true },
  ])(
    "recovers after an external agent exit (load=$loadSession, failLoad=$failLoad, active=$activeTurn)",
    async ({ loadSession, failLoad, activeTurn }) => {
      const dir = createHarness().dir;
      const readyFile = join(dir, "agent-ready");
      const promptLog = join(dir, "prompts.jsonl");
      const requestLog = join(dir, "requests.jsonl");
      const { harness, session } = await tracked.start({
        env: {
          FAKE_ACP_LOAD_SESSION: loadSession,
          FAKE_ACP_FAIL_LOAD: failLoad,
          FAKE_ACP_READY_FILE: readyFile,
          FAKE_ACP_PROMPT_LOG: promptLog,
          FAKE_ACP_REQUEST_LOG: requestLog,
        },
      });
      const id = session.providerThreadId;
      if (activeTurn) {
        await begin(harness, session, "hang");
        await until(() => expect(jsonLines(promptLog)).toContain("hang"));
      } else {
        await harness.turn(session, "before");
        expect(completions(harness)).toEqual(["completed"]);
      }
      process.kill(Number(readFileSync(readyFile, "utf8")), "SIGTERM");
      await until(() => expect(harness.exits).toHaveLength(1));
      expect(harness.exits[0]?.message).toContain("exited unexpectedly");
      if (activeTurn) {
        await until(() => expect(completions(harness).at(-1)).toBe("failed"));
      }
      await session.close();
      const count = completions(harness).length;
      const next = await tracked.open(harness, id);
      await harness.turn(next, "after");
      expect(completions(harness)[count]).toBe("completed");
      expect(messages(harness)).toContain("echo:after");
      const contextLost = loadSession === "0" || failLoad === "1";
      expect(next.providerThreadId === id).toBe(!contextLost);
      expect(ofType(harness, "thread/identity").at(-1)).toMatchObject({
        providerThreadId: next.providerThreadId,
      });
      const loads = jsonLines<{ method?: string }>(requestLog).filter(
        (request) => request.method === "session/load",
      );
      expect(loads).toHaveLength(loadSession === "1" ? 1 : 0);
      expect(harness.exits).toHaveLength(1);
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails the interrupted turn and accepts the next message while an exited agent's process tree is still being cleaned up",
    async () => {
      const dir = createHarness().dir;
      const readyFile = join(dir, "agent-ready");
      const pidFile = join(dir, "descendant-pid");
      const promptLog = join(dir, "prompts.jsonl");
      const { harness, session } = await tracked.start({
        env: {
          FAKE_ACP_LINGERING_DESCENDANT_PID_FILE: pidFile,
          FAKE_ACP_READY_FILE: readyFile,
          FAKE_ACP_PROMPT_LOG: promptLog,
          FAKE_ACP_LOAD_SESSION: "1",
        },
      });
      await begin(harness, session, "hang");
      await until(() => expect(jsonLines(promptLog)).toContain("hang"));
      await until(() => expect(readFileSync(pidFile, "utf8")).not.toBe(""));
      process.kill(Number(readFileSync(readyFile, "utf8")), "SIGTERM");
      await until(() => expect(completions(harness)).toEqual(["failed"]));
      const steer = await session
        .steer({
          clientRequestId: "req_late",
          input: text("late steer"),
          options: harness.execution,
          expectedTurnId: "turn-1",
        })
        .catch((error: unknown) => error);
      expect(steer).not.toBe("steered");
      await session.close();
      const next = await tracked.open(harness, session.providerThreadId);
      await harness.turn(next, "after");
      expect(completions(harness)).toEqual(["failed", "completed"]);
      expect(jsonLines(promptLog)).toEqual(["hang", "after"]);
    },
    15_000,
  );

  it("fails thread/start with a clear error when the agent command is missing", async () => {
    const harness = createHarness({
      agent: {
        launch: {
          displayName: "Missing",
          command: "definitely-not-a-real-binary-bb",
          args: [],
          env: {},
        },
      },
    });
    await expect(harness.open()).rejects.toMatchObject({
      message: expect.stringMatching(/definitely-not-a-real-binary-bb/u),
    });
  });
});
