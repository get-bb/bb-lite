import { describe, expect, it } from "vitest";
import {
  agentTexts,
  closeSessionsAfterEach,
  harnessFor,
  logPath,
  openWith,
  requestsTo,
} from "./models-helpers.js";

closeSessionsAfterEach();

function configCalls(log: string) {
  return requestsTo(log, "session/set_config_option").map((request) => ({
    configId: request.params?.["configId"],
    value: request.params?.["value"],
  }));
}

describe("acp model selection", () => {
  it.each([
    { serviceTier: "default", initialFast: "true", selectedFast: "false" },
    { serviceTier: "fast", initialFast: "false", selectedFast: "true" },
  ] as const)(
    "applies Cursor model parameters and maps $serviceTier to fast=$selectedFast",
    async ({ serviceTier, initialFast, selectedFast }) => {
      const log = logPath(`cursor-${serviceTier}-session-requests`);
      const harness = harnessFor({
        dialect: "cursor",
        parameterizedModelPicker: true,
        env: {
          FAKE_ACP_CURSOR_PARAMETERIZED_MODELS: "1",
          FAKE_ACP_INITIAL_FAST: initialFast,
          FAKE_ACP_REQUEST_LOG: log,
        },
      });
      const session = await openWith(harness, {
        model: "grok-4.6",
        reasoningLevel: "high",
        serviceTier,
      });
      expect(requestsTo(log, "initialize")[0]?.params).toMatchObject({
        clientCapabilities: { _meta: { parameterizedModelPicker: true } },
      });
      expect(configCalls(log)).toEqual([
        { configId: "model", value: "grok-4.6" },
        { configId: "effort", value: "high" },
        { configId: "fast", value: selectedFast },
      ]);
      await harness.turn(session, "echo-selected-fast");
      expect(agentTexts(harness)).toContain(`selected-fast:${selectedFast}`);
    },
  );

  it.each([
    ["start", "cursor-grok-4.6-medium", "grok-4.6"],
    ["resume", "claude-4.6-sonnet-medium-thinking", "claude-sonnet-4-6"],
  ] as const)(
    "translates a legacy Cursor model for %s session construction",
    async (method, legacyModel, selectedModel) => {
      const log = logPath(`legacy-cursor-${method}`);
      const harness = harnessFor({
        dialect: "cursor",
        parameterizedModelPicker: true,
        env: {
          FAKE_ACP_CURSOR_PARAMETERIZED_MODELS: "1",
          FAKE_ACP_REQUEST_LOG: log,
          ...(method === "resume" ? { FAKE_ACP_LOAD_SESSION: "1" } : {}),
        },
      });
      Object.assign(harness.execution, {
        model: legacyModel,
        reasoningLevel: "high",
        serviceTier: "fast",
      });
      const session = await harness.open(
        method === "resume"
          ? { providerThreadId: "legacy-resume-session" }
          : {},
      );
      await session.close();
      expect(configCalls(log).map((call) => call.value)).toEqual([
        selectedModel,
        "high",
        "true",
      ]);
    },
  );

  it("fails session construction when an advertised Fast selection is rejected", async () => {
    const harness = harnessFor({
      parameterizedModelPicker: true,
      env: {
        FAKE_ACP_CURSOR_PARAMETERIZED_MODELS: "1",
        FAKE_ACP_INITIAL_FAST: "true",
        FAKE_ACP_SET_CONFIG_FAST_ERROR: "1",
      },
    });
    await expect(
      openWith(harness, { model: "grok-4.6", serviceTier: "default" }),
    ).rejects.toThrow(/fast config update failed/u);
  });

  it("leaves service tier untouched when the agent advertises no Fast option", async () => {
    const log = logPath("no-fast-session-requests");
    const harness = harnessFor({
      parameterizedModelPicker: true,
      env: { FAKE_ACP_MODEL_CONFIG: "1", FAKE_ACP_REQUEST_LOG: log },
    });
    await openWith(harness, { model: "fake/strong", serviceTier: "fast" });
    expect(configCalls(log).map((call) => call.configId)).toEqual(["model"]);
  });
});
