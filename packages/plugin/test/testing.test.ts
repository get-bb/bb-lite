import { expect, it } from "vitest";
import { z } from "zod";
import customInstructions from "../../../plugins/custom-instructions/server.js";
import {
  contract,
  deny,
  op,
  sessions,
  type PluginServerApi,
} from "../src/index.js";
import { createPluginHarness } from "../src/testing.js";

const thread = {
  threadId: "thr_1",
  projectId: "proj_1",
  hostId: null,
  providerId: "codex",
};

it("loads a real plugin against a kernel with nothing else running", async () => {
  const harness = createPluginHarness();
  harness.stub(sessions.instructions, () => []);
  const plugin = await harness.load("custom-instructions", customInstructions);
  expect(await harness.kernel.call(sessions.instructions, thread)).toEqual([]);
  const context = { signal: new AbortController().signal };
  const set = await plugin.cli?.run(["set", "Use", "pnpm"], context);
  expect(set).toEqual({ exitCode: 0, stdout: "Custom instructions updated" });
  expect(plugin.settings.get("instructions")).toBe("Use pnpm");
  expect(await harness.kernel.call(sessions.instructions, thread)).toEqual([
    { source: "custom-instructions", text: "Use pnpm" },
  ]);
  await plugin.unload();
  expect(await harness.kernel.call(sessions.instructions, thread)).toEqual([]);
});

it("runs a plugin's operations as a chosen caller and keeps the record", async () => {
  const harness = createPluginHarness();
  const notes = contract("notes", {
    add: op({
      input: z.object({ text: z.string() }),
      output: z.string(),
      kind: "write",
      hooks: "answer",
    }),
  });
  await harness.load("notes", (bb: PluginServerApi) => {
    bb.implement(notes.add, async ({ text }, { caller }) => {
      await bb.storage.kv.set("last", text);
      return `${caller.user} noted ${text}`;
    });
  });
  const guard = await harness.load("guard", (bb: PluginServerApi) => {
    bb.on(notes.add, { text: "secret" }, () => deny("Not that")).failClosed();
  });
  const member = { user: "usr_bo", role: "member", door: "cli" } as const;
  const added = await harness.as(member, () =>
    harness.kernel.call(notes.add, { text: "milk" }),
  );
  expect(added).toBe("usr_bo noted milk");
  const refused = harness.kernel.call(notes.add, { text: "secret" });
  await expect(refused).rejects.toMatchObject({ plugin: "guard" });
  expect(
    harness.records.map(({ caller, outcome }) => [
      caller.user,
      caller.door,
      outcome,
    ]),
  ).toEqual([
    ["usr_bo", "cli", "ok"],
    ["usr_owner", "app", "denied"],
  ]);
  await guard.unload();
  expect(await harness.kernel.call(notes.add, { text: "secret" })).toBe(
    "usr_owner noted secret",
  );
});
