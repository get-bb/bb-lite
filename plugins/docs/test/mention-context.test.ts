import { expect, it } from "vitest";
import { createThreadServer } from "../../../apps/server/test/thread-harness.js";

it("gives the agent the content of a mentioned document", async () => {
  const server = await createThreadServer();
  Object.assign(server.runner.script, {
    readFile: async () => ({
      content: "# Plan\n\nShip it\n",
      contentEncoding: "utf8",
      sha256: "abc",
    }),
  });
  const text = "read @plan.md";
  const resource = {
    kind: "plugin" as const,
    pluginId: "docs",
    itemId: `docs:${JSON.stringify(["personal", "plan.md"])}`,
    label: "plan.md",
  };
  const mentions = [{ start: 5, end: 13, resource }];
  await server.spawn({ input: [{ type: "text" as const, text, mentions }] });
  const input = server.submitted.at(-1)?.input ?? [];
  expect(input).toHaveLength(2);
  expect(input[1]).toMatchObject({ type: "text", visibility: "agent-only" });
  const context = input[1]?.type === "text" ? input[1].text : "";
  expect(context).toContain("Context for @plan.md");
  expect(context).toContain("sha256: abc");
  expect(context).toContain("Ship it");
});
