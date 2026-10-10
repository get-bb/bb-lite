import { createStandaloneBuiltinCompactCommandInput } from "@bb/domain";
import { expect, it, vi } from "vitest";
import { createHarness } from "./adapter-harness.js";
import {
  accepted,
  agentTexts,
  closeSessionsAfterEach,
  completions,
  fakeLaunch,
  lastCompleted,
  loggedPrompts,
  nextRequestId,
  openSession,
  started,
  startTurn,
  steer,
  waitForCompletions,
  type Harness,
} from "./sessions-helpers.js";

closeSessionsAfterEach();

const count = (harness: Harness, type: string) =>
  harness.types().filter((value) => value === type).length;

async function running(
  harness: Harness,
  session: Parameters<typeof startTurn>[1],
  prompt: string,
) {
  const id = await startTurn(harness, session, prompt);
  await vi.waitFor(() => expect(harness.host.events.activeTurnId));
  return id;
}

it("keeps partial output from the cancelled prompt then continues", async () => {
  const { harness, session } = await started();
  await running(harness, session, "slow first");
  await vi.waitFor(() => {
    harness.host.events.flush();
    expect(
      harness.events.some(
        (event) =>
          event.type === "item/agentMessage/delta" &&
          event.delta.includes("echo:slow first"),
      ),
    ).toBe(true);
  });
  expect(await steer(harness, session, "steered")).toBe("steered");
  await waitForCompletions(harness, 1);
  expect(lastCompleted(harness)).toMatchObject({ status: "completed" });
  expect(agentTexts(harness).join("")).toContain("echo:slow first");
  expect(agentTexts(harness).join("")).toContain("echo:steered");
  expect(count(harness, "turn/started")).toBe(1);
  expect(count(harness, "turn/completed")).toBe(1);
  expect(count(harness, "thread/identity")).toBe(1);
});

it.each(["0", "1"])(
  "rebuilds a stuck agent after a steer cancellation error (session/load=%s)",
  async (loadSession) => {
    const probe = createHarness();
    const promptLog = `${probe.dir}/prompts.jsonl`;
    const env = {
      FAKE_ACP_LOAD_SESSION: loadSession,
      FAKE_ACP_CANCEL_ERROR: "1",
      FAKE_ACP_PROMPT_LOG: promptLog,
    };
    const { harness, session } = await started({ agent: fakeLaunch(env) });
    await running(harness, session, "hang");
    await vi.waitFor(() => expect(loggedPrompts(promptLog)).toContain("hang"));
    expect(await steer(harness, session, "steered")).toBe("steered");
    await waitForCompletions(harness, 1);
    expect(lastCompleted(harness)).toMatchObject({ status: "failed" });
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: "provider/error",
        message:
          "Internal error: 'NoneType' object has no attribute 'startswith'",
      }),
    );
    expect(agentTexts(harness)).not.toContain("echo:steered");
    expect(accepted(harness)).toHaveLength(1);
    await startTurn(harness, session, "follow-up");
    await waitForCompletions(harness, 2);
    expect(lastCompleted(harness)).toMatchObject({ status: "completed" });
    expect(agentTexts(harness)).toContain("echo:follow-up");
    expect(agentTexts(harness)).not.toContain(
      "Queued for the next turn. (1 queued)",
    );
    const lost = harness.types().includes("provider/warning");
    expect(lost).toBe(loadSession === "0");
  },
);

it("delivers stacked steers on the same turn", async () => {
  const { harness, session } = await started();
  await running(harness, session, "hang");
  const first = steer(harness, session, "first-steer");
  const second = steer(harness, session, "second-steer");
  expect(await first).toBe("steered");
  expect(await second).toBe("steered");
  await waitForCompletions(harness, 1);
  expect(lastCompleted(harness)).toMatchObject({ status: "completed" });
  expect(agentTexts(harness).join("")).toContain("echo:first-steer");
  expect(agentTexts(harness).join("")).toContain("echo:second-steer");
  expect(count(harness, "turn/started")).toBe(1);
  expect(count(harness, "turn/completed")).toBe(1);
});

it("cancels a stacked steer prompt that also hangs", async () => {
  const { harness, session } = await started();
  await running(harness, session, "hang");
  const first = steer(harness, session, "hang again");
  const second = steer(harness, session, "second-steer");
  expect(await first).toBe("steered");
  expect(await second).toBe("steered");
  await waitForCompletions(harness, 1);
  expect(lastCompleted(harness)).toMatchObject({ status: "completed" });
  expect(agentTexts(harness)).toContain("echo:second-steer");
  expect(count(harness, "turn/started")).toBe(1);
  expect(count(harness, "turn/completed")).toBe(1);
});

async function compact(env: Record<string, string>, dialect?: string) {
  const agent = dialect === undefined ? {} : { dialect };
  const { harness, session } = await started({ env, agent });
  await session.startTurn({
    clientRequestId: nextRequestId(),
    input: createStandaloneBuiltinCompactCommandInput(),
    options: harness.execution,
  });
  await waitForCompletions(harness, 1);
  return harness;
}

it("runs the builtin /compact command as compaction, not as a prompt", async () => {
  const promptLog = `${createHarness().dir}/compact-prompt-log.jsonl`;
  const harness = await compact({ FAKE_ACP_PROMPT_LOG: promptLog });
  expect(lastCompleted(harness)).toMatchObject({ status: "completed" });
  expect(count(harness, "thread/compacted")).toBe(1);
  const compactions = harness.events.filter(
    (event) =>
      event.type === "item/started" && event.item.type === "contextCompaction",
  );
  expect(compactions).toHaveLength(1);
  expect(loggedPrompts(promptLog)).toEqual(["/compact"]);
  expect(agentTexts(harness)).not.toContain("echo:/compact");
});

it("fails the compaction turn legibly when the agent rejects the request", async () => {
  const harness = await compact({ FAKE_ACP_PROMPT_ERROR: "1" });
  expect(lastCompleted(harness)).toMatchObject({
    status: "failed",
    error: { message: "Fake prompt failure" },
  });
  expect(count(harness, "thread/compacted")).toBe(0);
});

it("does not report an ACP refusal as successful compaction", async () => {
  const harness = await compact({ FAKE_ACP_COMPACT_STOP_REASON: "refusal" });
  expect(lastCompleted(harness)).toMatchObject({
    status: "failed",
    error: { message: "Agent stopped compaction: refusal" },
  });
  expect(count(harness, "thread/compacted")).toBe(0);
});

it("accepts turn input only after the prompt carrying it goes out", async () => {
  const { harness, session } = await started();
  await harness.turn(session, "hello there");
  const types = harness.types();
  expect(types.indexOf("turn/input/accepted")).toBe(
    types.indexOf("turn/started") + 1,
  );
});

it("never accepts a queued steer the stopped turn did not send", async () => {
  const { harness, session } = await started();
  await running(harness, session, "hang");
  expect(await steer(harness, session, "never sent")).toBe("steered");
  await session.interrupt();
  await waitForCompletions(harness, 1);
  expect(accepted(harness)).toHaveLength(1);
});

it("rejects steers when no turn is active", async () => {
  const { harness, session } = await started();
  expect(await steer(harness, session, "late")).toBe("stale");
});

it("cancels the active turn on thread/stop", async () => {
  const { harness, session } = await started();
  await running(harness, session, "hang");
  await session.interrupt();
  await waitForCompletions(harness, 1);
  expect(lastCompleted(harness)).toMatchObject({ status: "interrupted" });
});

it("settles the interrupted turn itself when the agent ignores session/cancel", async () => {
  const harness = createHarness({ env: { FAKE_ACP_IGNORE_CANCEL: "1" } });
  const session = await openSession(harness);
  await running(harness, session, "hang");
  await session.interrupt();
  await waitForCompletions(harness, 1);
  expect(lastCompleted(harness)).toMatchObject({ status: "interrupted" });
  expect(completions(harness)).toBe(1);
  expect(harness.exits).toEqual([]);
});

it.each([
  { dialect: "generic", id: undefined },
  { dialect: "OpenCode", id: "opencode" },
])("does not apply OMP compaction prose to $dialect ACP", async ({ id }) => {
  const message =
    "The first compaction failed, but retry succeeded and the context is now smaller.";
  const harness = await compact(
    { FAKE_ACP_COMPACT_AGENT_MESSAGE: message },
    id,
  );
  expect(lastCompleted(harness)).toMatchObject({ status: "completed" });
  expect(count(harness, "thread/compacted")).toBe(1);
});

it.each([
  [
    "fails the compaction turn when the agent reports the failure in an end-turn message",
    "Compaction failed: summary model rejected the request",
    "failed",
  ],
  [
    "completes a no-op compaction turn without reporting a compacted context",
    "Compaction failed: Nothing to compact (session too small)",
    "skipped",
  ],
  [
    "keeps classifying a no-op compaction when the agent rewords its prose",
    "compaction failed: nothing to compact — the session is still small",
    "skipped",
  ],
  [
    "fails the compaction turn when the failure report is reworded or preceded by other text",
    "Tried shrinking the context.\nCompaction failed: session is locked by another compaction",
    "failed",
  ],
])("%s", async (_name, message, outcome) => {
  const env = { FAKE_ACP_COMPACT_AGENT_MESSAGE: message };
  const harness = await compact(env, "omp");
  expect(count(harness, "thread/compacted")).toBe(0);
  if (outcome === "failed") {
    expect(lastCompleted(harness)).toMatchObject({
      status: "failed",
      error: { message },
    });
    return;
  }
  expect(lastCompleted(harness)).toMatchObject({ status: "completed" });
  const warnings = harness.events.filter(
    (event) => event.type === "provider/warning",
  );
  expect(warnings.at(-1)).toMatchObject({
    category: "compaction-skipped",
    summary: "Context compaction skipped",
    details: message,
  });
});
