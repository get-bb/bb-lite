import { describe, expect, it } from "vitest";
import { FAKE_AGENT } from "./adapter-harness.js";
import {
  agentTexts,
  closeSessionsAfterEach,
  harnessFor,
  listModels,
  openWith,
} from "./models-helpers.js";
import type { LaunchArgs } from "./models-helpers.js";

closeSessionsAfterEach();

async function argvOf(
  args: LaunchArgs,
  execution: Parameters<typeof openWith>[1] = {},
) {
  const harness = harnessFor({ command: FAKE_AGENT, args: [], ...args });
  await harness.turn(await openWith(harness, execution), "echo-argv");
  return agentTexts(harness);
}

describe("acp launch flags", () => {
  it("launches ACP agents with a configured reasoning CLI flag", async () => {
    const texts = await argvOf(
      {
        launch: {
          reasoningCli: {
            flag: "--reasoning-effort",
            supportedLevels: ["low", "medium", "high"],
            levelValues: { xhigh: "high", max: "high" },
            defaultLevel: "high",
          },
        },
      },
      { reasoningLevel: "xhigh" },
    );
    expect(texts).toContain("argv:--reasoning-effort high");
  });

  it("launches full-mode ACP agents with configured permission CLI args", async () => {
    const texts = await argvOf(
      {
        args: ["agent", "stdio"],
        launch: {
          permissionCli: { full: ["--always-approve"], insertAfterArgs: 1 },
        },
      },
      { permissionMode: "full" },
    );
    expect(texts).toContain("argv:agent --always-approve stdio");
  });

  it("does not apply full-mode permission CLI args in workspace-write mode", async () => {
    const texts = await argvOf(
      { launch: { permissionCli: { full: ["--always-approve"] } } },
      { permissionMode: "accept-edits" },
    );
    expect(texts).toContain("argv:");
  });

  it("uses modelCli only for model selection when reasoningCli owns effort", async () => {
    const launch: LaunchArgs = {
      command: FAKE_AGENT,
      args: [],
      modelListArgs: ["--list-models"],
      selectFlag: "--model",
      env: { FAKE_ACP_MODEL_LINES: "pinme - Pin Me" },
      launch: {
        reasoningCli: {
          flag: "--reasoning-effort",
          supportedLevels: ["low", "medium", "high"],
          levelValues: { max: "high" },
        },
      },
    };
    await listModels(launch);
    const texts = await argvOf(launch, {
      model: "pinme",
      reasoningLevel: "max",
    });
    expect(texts).toContain("argv:--model pinme --reasoning-effort high");
  });
});
