import { expect, it, vi } from "vitest";
import { watchActivity } from "../src/activity.js";

it("tells the relay about activity only while a thread is busy", async () => {
  const controller = new AbortController();
  const { signal } = controller;
  const state = { busy: false, reports: 0, warnings: [] as string[] };
  const watching = watchActivity({
    signal,
    intervalMs: 5,
    busy: async () => state.busy,
    report: async () => {
      state.reports += 1;
      if (state.reports === 2) throw new Error("relay is down");
    },
    warn: (message) => state.warnings.push(message),
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(state.reports).toBe(0);
  state.busy = true;
  await vi.waitFor(() => expect(state.reports).toBeGreaterThan(2));
  expect(state.warnings).toEqual([
    "reporting activity to the relay: Error: relay is down",
  ]);
  controller.abort();
  await watching;
});
