import { expect, it, vi } from "vitest";
import { createTestServer } from "./helpers.js";

const DAY = 86_400_000;

vi.mock("node:timers/promises", async (original) => ({
  ...(await original<typeof import("node:timers/promises")>()),
  setTimeout: (
    ms: number,
    value: unknown,
    options?: { signal?: AbortSignal },
  ) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(value), ms);
      options?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(options.signal?.reason);
      });
    }),
}));

it("prunes audit records past the retention days each night", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date(2026, 0, 1, 3, 10, 30));
  try {
    const server = await createTestServer();
    const keep = (retentionDays: number) =>
      server.send(
        "/plugins/audit-log/settings",
        { values: { retentionDays } },
        "PUT",
      );
    const records = () =>
      server.ctx.db.all<{ at: number }>(
        "SELECT at FROM audit_log WHERE op = 'plugins.updateSettings'",
      );
    expect((await keep(30)).status).toBe(200);
    const old = server.clock.now;
    server.clock.now += 29 * DAY;
    await keep(30);
    const recent = server.clock.now;
    server.clock.now += 2 * DAY;
    expect(records()).toEqual([{ at: old }, { at: recent }]);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(records()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(records()).toEqual([{ at: recent }]);

    await keep(0);
    server.clock.now += 365 * DAY;
    await vi.advanceTimersByTimeAsync(DAY);
    expect(records()).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});
