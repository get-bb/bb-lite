import { threads } from "@bb/plugin";
import { expect, it } from "vitest";
import { createTestServer } from "./helpers.js";

it("delivers threads.paneAction only to the user it names", async () => {
  const { ctx } = await createTestServer();
  const frames = { usr_a: [] as unknown[], usr_b: [] as unknown[] };
  for (const user of ["usr_a", "usr_b"] as const) {
    const send = (data: string) => {
      const frame = JSON.parse(data) as { type: string };
      if (frame.type === "plugin-signal") frames[user].push(frame);
    };
    ctx.hub.connect({ send, close: () => {} }, user);
  }
  const plugin = ctx.kernel.scope("handsfree", "product");
  const payload = { threadId: "thr_1", action: "maximize" } as const;
  plugin.emit(threads.paneAction, payload, { userId: "usr_a" });
  expect(frames.usr_b).toEqual([]);
  expect(frames.usr_a).toMatchObject([
    { pluginId: "kernel", payload: { name: "threads.paneAction", payload } },
  ]);
});
