import { sessions } from "@bb/plugin";
import { expect, it } from "vitest";
import { createTestServer } from "../../../apps/server/test/helpers.js";
import {
  formatSnapshot,
  providerUsage,
  type UsageReading,
} from "../contract.js";

async function usageServer(readings: Record<string, () => UsageReading>) {
  const server = await createTestServer();
  const reads: (string | null)[] = [];
  for (const [providerId, reading] of Object.entries(readings)) {
    server.ctx.kernel.scope(providerId, "installed").add(sessions.usage, {
      providerId,
      read: async ({ hostId }) => {
        reads.push(hostId);
        return reading();
      },
    });
  }
  const usage = (input: { hostId?: string; refresh?: boolean } = {}) =>
    server.ctx.kernel.call(providerUsage.usage, {
      refresh: false,
      ...input,
    });
  return { server, reads, usage };
}

const resetsAt = new Date(Date.now() + 90 * 60_000).toISOString();

it("shows each source's accounts with plan and window labels", async () => {
  const { usage } = await usageServer({
    codex: () => ({
      status: "ok",
      accountEmail: "me@example.com",
      planLabel: null,
      plan: { id: "pro", multiplier: null },
      windows: [
        { kind: "five-hour", label: "5h", usedPercent: 42, resetsAt },
        { kind: "weekly", label: "w", usedPercent: 85, model: "opus" },
      ],
    }),
    "claude-code": () => ({ status: "unauthenticated" }),
    silent: () => null,
  });
  const snapshot = await usage({ hostId: "host-1" });
  expect(snapshot.hostId).toBe("host-1");
  expect(snapshot.providers.map((p) => p.providerId)).toEqual([
    "codex",
    "claude-code",
  ]);
  const [account] = snapshot.providers[0]!.accounts;
  expect(account?.usage).toMatchObject({
    planLabel: "Pro",
    windows: [{ label: "Five-hour limit" }, { label: "Weekly · Opus" }],
  });
  const text = formatSnapshot(snapshot);
  expect(text).toContain("Five-hour limit: 42% used, resets in 1 hr 30 min");
  expect(text).toContain("Not signed in.");
});

it("prints usage through bb provider-usage show", async () => {
  const { server } = await usageServer({
    codex: () => ({
      status: "ok",
      windows: [{ kind: "daily", label: "d", usedPercent: 12.4 }],
    }),
  });
  const response = await server.send("/plugins/provider-usage/cli", {
    argv: ["show", "--host-id", "host-2"],
  });
  const output = (await response.json()) as { stdout: string };
  expect(output.stdout).toContain("Codex\n  Daily limit: 12% used");
});

it("caches readings, refreshes on request and keeps the last on failure", async () => {
  let fail = false;
  const { usage, reads } = await usageServer({
    pool: () => {
      if (fail) throw new Error("down");
      return {
        accounts: [
          { accountKey: "a", label: "One", usage: { status: "expired" } },
          { accountKey: "a", label: "Dup", usage: { status: "expired" } },
          { accountKey: null, label: "Two", usage: { status: "expired" } },
        ],
      };
    },
  });
  const first = await usage();
  expect(first.providers[0]?.accounts.map((a) => a.label)).toEqual([
    "One",
    "Two",
  ]);
  await usage();
  expect(reads).toEqual([null]);
  fail = true;
  const failed = await usage({ refresh: true });
  expect(reads).toHaveLength(2);
  expect(failed.providers[0]).toMatchObject({
    error: "Usage could not be refreshed.",
    accounts: [{ label: "One" }, { label: "Two" }],
  });
});
