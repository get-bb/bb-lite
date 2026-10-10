import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { FAKE_AGENT } from "./adapter-harness.js";
import {
  agentTexts,
  closeSessionsAfterEach,
  harnessFor,
  listModels,
  logPath,
  openWith,
} from "./models-helpers.js";

closeSessionsAfterEach();

function launches(path: string) {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("acp model discovery", () => {
  it("authenticates before ACP-native model discovery", async () => {
    const result = await listModels({
      env: {
        FAKE_ACP_AUTH_METHODS: "cached_token",
        FAKE_ACP_MODEL_CONFIG: "1",
      },
    });
    expect(result).toMatchObject({
      models: [
        {
          id: "fake/default",
          model: "fake/default",
          displayName: "Fake Default",
        },
        { id: "fake/strong", model: "fake/strong", displayName: "Fake Strong" },
      ],
      selectedOnlyModels: [],
    });
  });

  it("probes per-model reasoning across large catalogs instead of falling back", async () => {
    const result = await listModels({
      env: {
        FAKE_ACP_MODEL_CONFIG: "1",
        FAKE_ACP_THOUGHT_LEVEL_CONFIG: "1",
        FAKE_ACP_MODEL_COUNT: "60",
      },
    });
    expect(result.models).toHaveLength(60);
    const last = result.models.find((model) => model.id === "fake/gen-59");
    expect(last?.supportedReasoningEfforts).toEqual([
      { reasoningEffort: "low", description: "low" },
      { reasoningEffort: "medium", description: "medium" },
      { reasoningEffort: "high", description: "high" },
    ]);
  });

  it("times out hung ACP-native discovery, kills the child, and reports the timeout", async () => {
    const readyFile = logPath("discovery-agent-ready");
    const harness = harnessFor({
      env: { FAKE_ACP_HANG_INITIALIZE: "1", FAKE_ACP_READY_FILE: readyFile },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let listing: ReturnType<typeof harness.adapter.listModels>;
    try {
      listing = harness.adapter.listModels(null);
      listing.catch(() => undefined);
      await vi.waitFor(() => expect(existsSync(readyFile)).toBe(true));
      await vi.advanceTimersByTimeAsync(30_000);
    } finally {
      vi.useRealTimers();
    }
    await expect(listing).rejects.toThrow(
      "The agent did not answer within 30 seconds while bb asked it for its models",
    );
    const pid = Number(readFileSync(readyFile, "utf8"));
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5_000 });
  });

  it("reports the agent's own error when it cannot open a session to list models, instead of a placeholder model", async () => {
    const message = "Could not start pi: executable not found (command: pi)";
    await expect(
      listModels({ env: { FAKE_ACP_SESSION_NEW_ERROR: message } }),
    ).rejects.toThrow(message);
  });

  it("fails model listing with a clear error when the agent itself is missing", async () => {
    await expect(
      listModels({ command: "/nonexistent/acp-agent", args: [] }),
    ).rejects.toMatchObject({ code: "missing_executable" });
  });

  it("tells a signed-out user how to sign in when listing models, with the agent's terminal command", async () => {
    const listing = listModels({
      env: {
        FAKE_ACP_AUTH_METHODS: "agent.login",
        FAKE_ACP_TERMINAL_AUTH_ARGS: "login --device",
      },
    });
    await expect(listing).rejects.toMatchObject({
      code: "auth_required",
      message: expect.stringMatching(
        /^Authentication required.* To sign in, run this in a terminal on the machine that hosts the thread, then try again: \S*node(?:\.exe)? \S*fake-acp-agent\.mjs login --device$/u,
      ),
    });
  });

  it("serves ACP-native discovered models from cache within the TTL and re-discovers after it", async () => {
    const launchLog = logPath("discovery-launches");
    const env = { FAKE_ACP_MODEL_CONFIG: "1", FAKE_ACP_LAUNCH_LOG: launchLog };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_000_000);
      await listModels({ env });
      expect(launches(launchLog)).toBe(1);
      vi.setSystemTime(1_030_000);
      await listModels({ env });
      expect(launches(launchLog)).toBe(1);
      vi.setSystemTime(1_061_000);
      expect(await listModels({ env })).toMatchObject({
        models: [
          { id: "fake/default", isDefault: true },
          { id: "fake/strong", isDefault: false },
        ],
      });
      expect(launches(launchLog)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the synthetic model when ACP-native session discovery has no model option", async () => {
    expect(await listModels()).toMatchObject({
      models: [{ id: "acp-default", isDefault: true }],
      selectedOnlyModels: [],
    });
  });

  it("fails model listing with a clear error when the list command is missing", async () => {
    await expect(
      listModels({
        command: "/nonexistent/acp-model-lister",
        args: [],
        modelLines: "",
      }),
    ).rejects.toThrow(/spawn \/nonexistent\/acp-model-lister ENOENT/u);
  });

  it("fails model listing when the list command reports ACP auth is required", async () => {
    await expect(
      listModels({
        env: {
          FAKE_ACP_MODEL_LIST_STDERR:
            "Error: Authentication required. Run 'agent login', pass " +
            "--api-key/--auth-token, or set CURSOR_API_KEY/CURSOR_AUTH_TOKEN.",
        },
        modelLines: "",
      }),
    ).rejects.toMatchObject({
      code: "auth_required",
      message: "ACP agent is not authenticated.",
    });
  });

  it("falls back to the synthetic model when the list command prints no models", async () => {
    expect(
      await listModels({ modelLines: "no model lines here" }),
    ).toMatchObject({ models: [{ id: "acp-default", isDefault: true }] });
  });

  it("keeps CLI reasoning on the resolved model variant instead of ACP config", async () => {
    const launch = {
      command: FAKE_AGENT,
      args: [],
      modelListArgs: ["--list-models"],
      selectFlag: "--model",
      env: {
        FAKE_ACP_MODEL_LINES:
          "pinme-low - Pin Me Low\npinme - Pin Me\n" +
          "pinme-extra-high - Pin Me Extra High",
      },
    };
    await listModels(launch);
    const harness = harnessFor(launch);
    const session = await openWith(harness, {
      model: "pinme",
      reasoningLevel: "xhigh",
    });
    await harness.turn(session, "echo-argv");
    expect(agentTexts(harness)).toContain("argv:--model pinme-extra-high");
  });

  it.each([
    { dialect: "opencode", client: "acp", question: "false" },
    { dialect: "acp", client: "cli", question: "true" },
  ])(
    "sets native question availability only for $dialect sessions",
    async ({ dialect, client, question }) => {
      const harness = harnessFor({
        dialect,
        env: { OPENCODE_CLIENT: "cli", OPENCODE_ENABLE_QUESTION_TOOL: "true" },
      });
      await harness.turn(await openWith(harness), "echo-question-env");
      expect(agentTexts(harness)).toContain(
        JSON.stringify({ client, question }),
      );
    },
  );
});
