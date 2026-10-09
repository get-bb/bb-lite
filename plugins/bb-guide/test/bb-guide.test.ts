import { plugins, sessions } from "@bb/plugin";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createThreadServer } from "../../../apps/server/test/thread-harness.js";
import { withCreatePluginPrompt } from "../app.js";

const context = {
  threadId: "thr_1",
  projectId: "proj_1",
  hostId: "host_1",
  providerId: "codex",
};

it("sends the introduction and skills until they are turned off", async () => {
  const { ctx } = await createThreadServer();
  const { kernel } = ctx;
  const intro = async () =>
    (await kernel.call(sessions.instructions, context)).some(({ text }) =>
      text.includes("`bb thread tell <thread id>`"),
    );
  const has = async (name: string) =>
    (await kernel.call(sessions.skillDirs, context)).some((root) =>
      existsSync(join(root, name, "SKILL.md")),
    );
  expect(await intro()).toBe(true);
  for (const name of ["bb-cli", "skill-creator", "submit-a-plugin"]) {
    expect(await has(name)).toBe(true);
  }
  const update = (values: Record<string, boolean>) =>
    kernel.call(plugins.updateSettings, { pluginId: "bb-guide", values });
  await update({ introduction: false, skillCreator: false });
  expect(await intro()).toBe(false);
  expect(await has("skill-creator")).toBe(false);
  expect(await has("submit-a-plugin")).toBe(true);
  await update({ skills: false });
  expect(await has("bb-cli")).toBe(false);
  expect(await has("submit-a-plugin")).toBe(false);
});

it("starts a message with the create-plugin prompt once", () => {
  expect(withCreatePluginPrompt("  a timer")).toBe(
    "Create a new bb plugin that a timer",
  );
  expect(withCreatePluginPrompt("Create a new bb plugin that x")).toBe(
    "Create a new bb plugin that x",
  );
});
