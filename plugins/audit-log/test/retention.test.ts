import { plugins } from "@bb/plugin";
import { expect, it } from "vitest";
import { createThreadServer } from "../../../apps/server/test/thread-harness.js";

it("refuses a negative or fractional number of days to keep", async () => {
  const { ctx } = await createThreadServer();
  const { kernel } = ctx;
  const update = (retentionDays: number) =>
    kernel.call(plugins.updateSettings, {
      pluginId: "audit-log",
      values: { retentionDays },
    });
  await expect(update(-5)).rejects.toThrow(/whole number at least 0/u);
  await expect(update(1.5)).rejects.toThrow(/whole number at least 0/u);
  const saved = await update(30);
  expect(saved.values).toEqual({ retentionDays: 30 });
});
