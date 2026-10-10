import { describe, expect, it } from "vitest";
import {
  configValues,
  effortIds,
  listModels,
  logPath,
  requestsTo,
} from "./models-helpers.js";

describe("acp model listing", () => {
  it("lists grouped models without spawning an agent", async () => {
    const result = await listModels({
      modelLines:
        "Available models\n\nauto - Auto\ngrouped-1-low - Grouped One Low\n" +
        "grouped-1 - Grouped One\ngrouped-1-high - Grouped One High",
      cliPrimaryModels: ["auto"],
    });
    expect(result).toMatchObject({
      models: [{ id: "auto", displayName: "Auto", isDefault: true }],
      selectedOnlyModels: [
        {
          id: "grouped-1",
          displayName: "Grouped One",
          isDefault: false,
          defaultReasoningEffort: "medium",
        },
      ],
    });
    expect(effortIds(result.selectedOnlyModels[0]!)).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("uses the CLI model list before ACP-native session discovery when both are present", async () => {
    const result = await listModels({
      env: { FAKE_ACP_MODEL_CONFIG: "1" },
      modelLines: "cli-model - CLI Model",
    });
    expect(result).toMatchObject({
      models: [{ id: "cli-model", displayName: "CLI Model", isDefault: true }],
      selectedOnlyModels: [],
    });
  });

  it("uses Cursor CLI variants as reasoning metadata for bare ACP models", async () => {
    const result = await listModels({
      dialect: "cursor",
      parameterizedModelPicker: true,
      primaryModels: ["default", "gemini-3.8-flash"],
      modelLines: [
        "auto - Auto (default)",
        "gemini-3.8-flash-low - Gemini 3.8 Flash Low",
        "gemini-3.8-flash-medium - Gemini 3.8 Flash Medium",
        "gemini-3.8-flash-high - Gemini 3.8 Flash High",
      ].join("\n"),
    });
    expect(result.models.map((model) => model.id)).toEqual([
      "default",
      "gemini-3.8-flash",
    ]);
    expect(effortIds(result.models[1]!)).toEqual(["low", "medium", "high"]);
  });

  it("discovers ACP-native models and per-model reasoning from session configOptions", async () => {
    const result = await listModels({
      env: { FAKE_ACP_MODEL_CONFIG: "1", FAKE_ACP_THOUGHT_LEVEL_CONFIG: "1" },
    });
    expect(result).toMatchObject({
      models: [
        {
          id: "fake/default",
          model: "fake/default",
          displayName: "Fake Default",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
        },
        {
          id: "fake/strong",
          model: "fake/strong",
          displayName: "Fake Strong",
          isDefault: false,
          defaultReasoningEffort: "none",
          supportedReasoningEfforts: [
            { reasoningEffort: "none" },
            { reasoningEffort: "low" },
            { reasoningEffort: "medium" },
            { reasoningEffort: "high" },
            { reasoningEffort: "xhigh" },
          ],
        },
      ],
      selectedOnlyModels: [],
    });
  });

  it("keeps probing reasoning for later models after one model's probe fails", async () => {
    const result = await listModels({
      env: {
        FAKE_ACP_MODEL_CONFIG: "1",
        FAKE_ACP_THOUGHT_LEVEL_CONFIG: "1",
        FAKE_ACP_MODEL_COUNT: "3",
        FAKE_ACP_SET_CONFIG_MODEL_ERROR_VALUE: "fake/strong",
      },
    });
    expect(result).toMatchObject({
      models: [
        {
          id: "fake/default",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
        },
        {
          id: "fake/strong",
          supportedReasoningEfforts: [
            {
              reasoningEffort: "medium",
              description:
                "Reasoning effort is managed by the connected ACP agent.",
            },
          ],
        },
        {
          id: "fake/gen-2",
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "medium" },
            { reasoningEffort: "high" },
          ],
        },
      ],
    });
  });

  it("advertises Cursor's parameterized model picker during discovery", async () => {
    const log = logPath("cursor-discovery-requests");
    const result = await listModels({
      dialect: "cursor",
      parameterizedModelPicker: true,
      reasoningProbePriorityModelIds: ["grok-4.6", "grok-4.5"],
      primaryModels: ["default", "composer-2.5", "grok-4.6"],
      env: {
        FAKE_ACP_CURSOR_PARAMETERIZED_MODELS: "1",
        FAKE_ACP_REQUEST_LOG: log,
      },
    });
    expect.soft(requestsTo(log, "initialize")[0]?.params).toMatchObject({
      clientCapabilities: { _meta: { parameterizedModelPicker: true } },
    });
    const grok = result.models.find((model) => model.id === "grok-4.6");
    expect(grok && effortIds(grok)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(configValues(log).slice(0, 2)).toEqual(["grok-4.6", "grok-4.5"]);
    expect(result.models.map((model) => model.id)).toEqual([
      "default",
      "composer-2.5",
      "grok-4.6",
    ]);
    expect(result.selectedOnlyModels.map((model) => model.id)).toEqual([
      "grok-4.5",
      "claude-sonnet-4-6",
    ]);
  });

  it("discovers ACP-native models from session models state", async () => {
    const result = await listModels({ env: { FAKE_ACP_MODELS_FIELD: "1" } });
    expect(result).toMatchObject({
      models: [
        {
          id: "fake/default",
          model: "fake/default",
          displayName: "Fake Default",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
        },
        {
          id: "fake/strong",
          model: "fake/strong",
          displayName: "Fake Strong",
          isDefault: false,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
        },
      ],
      selectedOnlyModels: [],
    });
  });

  it("advertises launch-time reasoning CLI levels on ACP-native models", async () => {
    const result = await listModels({
      env: { FAKE_ACP_MODELS_FIELD: "1" },
      launch: {
        reasoningCli: {
          flag: "--reasoning-effort",
          supportedLevels: ["low", "medium", "high"],
          defaultLevel: "high",
        },
      },
    });
    const levels = [
      { reasoningEffort: "low" },
      { reasoningEffort: "medium" },
      { reasoningEffort: "high" },
    ];
    expect(result).toMatchObject({
      models: [
        {
          id: "fake/default",
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: levels,
        },
        {
          id: "fake/strong",
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: levels,
        },
      ],
      selectedOnlyModels: [],
    });
  });
});
