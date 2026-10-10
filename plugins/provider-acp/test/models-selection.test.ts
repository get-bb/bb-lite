import { describe, expect, it, vi } from "vitest";
import { createHarness, FAKE_AGENT, text } from "./adapter-harness.js";
import {
  agentTexts,
  closeSessionsAfterEach,
  completeTurnWith,
  harnessFor,
  listModels,
  loggedLines,
  logPath,
  openWith,
  requestsTo,
  startTurn,
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

describe("acp model switching", () => {
  it.each<{ label: string; env: Record<string, string> }>([
    { label: "model config option", env: { FAKE_ACP_MODEL_CONFIG: "1" } },
    { label: "session models state", env: { FAKE_ACP_MODELS_FIELD: "1" } },
  ])(
    "switches ACP-native models A to B to A when setters return no state ($label)",
    async ({ env }) => {
      const harness = harnessFor({
        env: { ...env, FAKE_ACP_EMPTY_MODEL_RESULT: "1" },
      });
      const session = await openWith(harness, { model: "fake/strong" });
      for (const model of ["fake/default", "fake/strong"]) {
        expect(
          await completeTurnWith(harness, session, "echo-selected-model", {
            model,
          }),
        ).toBe(`selected-model:${model}`);
      }
    },
  );

  it("applies a queued steer's changed ACP-native model before its prompt", async () => {
    const harness = harnessFor({ env: { FAKE_ACP_MODEL_CONFIG: "1" } });
    const session = await openWith(harness, { model: "fake/default" });
    await startTurn(harness, session, "hang");
    const expectedTurnId = harness.host.events.activeTurnId;
    expect(expectedTurnId).not.toBeNull();
    const steered = await session.steer({
      clientRequestId: "req_models_steer",
      input: text("echo-selected-model"),
      options: { ...harness.execution, model: "fake/strong" },
      expectedTurnId: expectedTurnId!,
    });
    expect(steered).not.toBe("stale");
    await vi.waitFor(() => {
      harness.host.events.flush();
      expect(harness.types()).toContain("turn/completed");
    });
    expect(agentTexts(harness)).toContain("selected-model:fake/strong");
    expect(
      harness.events.filter((event) => event.type === "thread/identity"),
    ).toHaveLength(1);
  });

  it("restores the requested ACP-native model after the agent switches itself", async () => {
    const harness = harnessFor({ env: { FAKE_ACP_MODEL_CONFIG: "1" } });
    const session = await openWith(harness, { model: "fake/default" });
    expect(await completeTurnWith(harness, session, "self-switch-model")).toBe(
      "selected-model:fake/strong",
    );
    expect(
      await completeTurnWith(harness, session, "echo-selected-model"),
    ).toBe("selected-model:fake/default");
  });

  it("tracks an acknowledged ACP-native model when a later tier update fails", async () => {
    const harness = harnessFor({
      dialect: "cursor",
      parameterizedModelPicker: true,
      env: {
        FAKE_ACP_CURSOR_PARAMETERIZED_MODELS: "1",
        FAKE_ACP_SET_CONFIG_FAST_ERROR: "1",
      },
    });
    const session = await openWith(harness, { model: "composer-2.5" });
    await expect(
      startTurn(harness, session, "echo-selected-model", {
        model: "grok-4.6",
        serviceTier: "fast",
      }),
    ).rejects.toThrow("fast config update failed");
    expect(
      await completeTurnWith(harness, session, "echo-selected-model", {
        model: "composer-2.5",
      }),
    ).toBe("selected-model:composer-2.5");
  });
});

describe("acp native selection", () => {
  it.each<{ label: string; env: Record<string, string> }>([
    {
      label: "with session/set_config_option",
      env: { FAKE_ACP_MODEL_CONFIG: "1" },
    },
    {
      label: "falling back to session/set_model when the config option errors",
      env: { FAKE_ACP_MODEL_CONFIG: "1", FAKE_ACP_SET_CONFIG_MODEL_ERROR: "1" },
    },
    { label: "from session models state", env: { FAKE_ACP_MODELS_FIELD: "1" } },
  ])(
    "selects ACP-native models $label before the first prompt",
    async ({ env }) => {
      const harness = harnessFor({ env });
      const session = await openWith(harness, { model: "fake/strong" });
      await harness.turn(session, "echo-selected-model");
      expect(agentTexts(harness)).toContain("selected-model:fake/strong");
    },
  );

  it.each<{ label: string; env: Record<string, string> }>([
    { label: "model config option", env: { FAKE_ACP_MODEL_CONFIG: "1" } },
    { label: "session models state", env: { FAKE_ACP_MODELS_FIELD: "1" } },
  ])(
    "applies a changed ACP-native model before a follow-up prompt ($label)",
    async ({ env }) => {
      const log = logPath(
        `native-model-switch-${env["FAKE_ACP_MODELS_FIELD"]}`,
      );
      const harness = harnessFor({
        env: { ...env, FAKE_ACP_REQUEST_LOG: log },
      });
      const session = await openWith(harness, { model: "fake/strong" });
      for (const model of ["fake/strong", "fake/default", "fake/strong"]) {
        expect(
          await completeTurnWith(harness, session, "echo-selected-model", {
            model,
          }),
        ).toBe(`selected-model:${model}`);
      }
      expect(requestsTo(log, "session/new")).toHaveLength(1);
      expect(requestsTo(log, "session/load")).toEqual([]);
    },
  );

  it("applies changed ACP-native reasoning and service tier before a follow-up prompt", async () => {
    const harness = harnessFor({
      dialect: "cursor",
      parameterizedModelPicker: true,
      env: { FAKE_ACP_CURSOR_PARAMETERIZED_MODELS: "1" },
    });
    const session = await openWith(harness, {
      model: "grok-4.6",
      reasoningLevel: "low",
      serviceTier: "default",
    });
    const next = {
      model: "grok-4.6",
      reasoningLevel: "high",
      serviceTier: "fast",
    } as const;
    expect(
      await completeTurnWith(harness, session, "echo-selected-effort", next),
    ).toBe("selected-effort:high");
    expect(
      await completeTurnWith(harness, session, "echo-selected-fast", next),
    ).toBe("selected-fast:true");
  });

  it("rejects a follow-up turn whose ACP-native model the agent refuses", async () => {
    const promptLog = logPath("rejected-model-prompts");
    const harness = harnessFor({
      env: { FAKE_ACP_MODEL_CONFIG: "1", FAKE_ACP_PROMPT_LOG: promptLog },
    });
    const session = await openWith(harness, { model: "fake/strong" });
    await expect(
      startTurn(harness, session, "echo-selected-model", {
        model: "fake/missing",
      }),
    ).rejects.toThrow("model not found: fake/missing");
    expect(loggedLines(promptLog)).toEqual([]);
  });

  it("relaunches a CLI-selected ACP agent when a follow-up changes its model", async () => {
    const harness = harnessFor({
      command: FAKE_AGENT,
      args: [],
      modelListArgs: ["--list-models"],
      selectFlag: "--model",
      env: {
        FAKE_ACP_LOAD_SESSION: "1",
        FAKE_ACP_MODEL_LINES: "pinme - Pin Me\nother - Other",
      },
    });
    const session = await openWith(harness, { model: "pinme" });
    expect(
      await completeTurnWith(harness, session, "echo-argv", { model: "other" }),
    ).toBe("argv:--model other");
    const identities = harness.types().filter((t) => t === "thread/identity");
    expect(identities.length).toBeGreaterThan(1);
  });

  it("selects ACP-native reasoning with session/set_config_option before the first prompt", async () => {
    const harness = harnessFor({
      env: { FAKE_ACP_MODEL_CONFIG: "1", FAKE_ACP_THOUGHT_LEVEL_CONFIG: "1" },
    });
    const session = await openWith(harness, {
      model: "fake/strong",
      reasoningLevel: "max",
    });
    await harness.turn(session, "echo-selected-effort");
    expect(agentTexts(harness)).toContain("selected-effort:xhigh");
  });
});

describe("acp configured native reasoning", () => {
  it("applies configured native reasoning when the ACP agent does not advertise thought_level", async () => {
    const harness = harnessFor({
      env: {
        FAKE_ACP_MODEL_CONFIG: "1",
        FAKE_ACP_ACCEPT_NATIVE_REASONING: "1",
      },
      launch: {
        nativeReasoning: {
          configId: "reasoning_effort",
          supportedLevels: ["none", "low", "medium", "high", "xhigh", "max"],
          defaultLevel: "medium",
        },
      },
    });
    const session = await openWith(harness, {
      model: "fake/strong",
      reasoningLevel: "max",
    });
    await harness.turn(session, "echo-selected-effort");
    expect(agentTexts(harness)).toContain("selected-effort:max");
  });

  it("warns and launches the family id when a reasoning variant is missing", async () => {
    const launch = {
      command: FAKE_AGENT,
      args: [],
      modelListArgs: ["--list-models"],
      selectFlag: "--model",
      env: { FAKE_ACP_MODEL_LINES: "solo-2 - Solo Two" },
    };
    await listModels(launch);
    const harness = harnessFor(launch);
    const session = await openWith(harness, {
      model: "solo-2",
      reasoningLevel: "max",
    });
    await harness.turn(session, "echo-argv");
    expect(agentTexts(harness)).toContain("argv:--model solo-2");
    const warnings = harness.events.filter(
      (event) => event.type === "provider/warning",
    );
    expect(warnings.at(-1)).toMatchObject({
      summary: expect.stringContaining("no max reasoning variant"),
    });
  });

  it("preserves Electron Node mode for the dynamic-tool MCP process only", async () => {
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
    try {
      const harness = createHarness({
        dynamicTools: [
          {
            name: "update_environment_directory",
            description: "Move this thread to another environment directory.",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      });
      const session = await openWith(harness);
      await harness.turn(session, "echo-mcp-server-config");
      const prefix = "mcp-server-config:";
      const config = agentTexts(harness).find((t) => t.startsWith(prefix));
      expect(config).toBeDefined();
      const [server] = JSON.parse(config!.slice(prefix.length)) as {
        env: { name: string; value: string }[];
      }[];
      const electron = server?.env.find(
        ({ name }) => name === "ELECTRON_RUN_AS_NODE",
      );
      expect(electron?.value).toBe("1");
      await harness.turn(session, "echo-electron-run-as-node");
      expect(agentTexts(harness)).toContain("electron-run-as-node:missing");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
