import { expect, it } from "vitest";
import { createThreadServer } from "../../../apps/server/test/thread-harness.js";
import { docs } from "../contract.js";

type Row = Record<string, unknown>;

it("refreshes the opened Markdown file after a save", async () => {
  const server = await createThreadServer();
  const threadId = await server.spawn();
  Object.assign(server.runner.script, {
    writeFile: async () => ({ outcome: "written", sha256: "next" }),
  });
  const socket = await server.socket();
  const saved = await server.ctx.kernel.call(docs.saveOpenedFile, {
    threadId,
    path: "README.md",
    content: "x",
    expectedSha256: "before",
  });
  expect(saved).toEqual({ sha256: "next" });
  const signal = await socket.next((message: Row) => {
    const payload = message.payload as Row | undefined;
    return (
      message.type === "plugin-signal" && payload?.name === "docs.openFile"
    );
  });
  expect(signal).toBeTruthy();
});
