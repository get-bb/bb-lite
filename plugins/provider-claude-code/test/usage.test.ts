import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { usageReadingSchema } from "@bb/plugin";
import { expect, test, vi } from "vitest";
import { scratch } from "../../../apps/server/test/helpers.js";
import { readClaudeUsage } from "../runner/usage.js";

test("Claude usage reads the OAuth login and maps model windows", async () => {
  const home = scratch();
  const fetcher = vi.fn<typeof fetch>();
  expect(await readClaudeUsage(home, fetcher)).toEqual({
    status: "unauthenticated",
  });
  mkdirSync(join(home, ".claude"));
  const login = (oauth: object) =>
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: oauth }),
    );
  login({ accessToken: "tok", expiresAt: 1 });
  expect(await readClaudeUsage(home, fetcher)).toEqual({ status: "expired" });
  login({
    accessToken: "tok",
    subscriptionType: "Max",
    rateLimitTier: "default_claude_max_20x",
  });
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      oauthAccount: { emailAddress: "me@example.com", accountUuid: "u1" },
    }),
  );
  fetcher.mockResolvedValueOnce(new Response("", { status: 429 }));
  expect(await readClaudeUsage(home, fetcher)).toMatchObject({
    status: "error",
  });
  const resets = "2026-10-10T00:00:00Z";
  const model = (name: string) => ({
    kind: "weekly_scoped",
    percent: 30,
    resets_at: resets,
    scope: { model: { display_name: name } },
  });
  fetcher.mockResolvedValueOnce(
    Response.json({
      five_hour: { utilization: 40, resets_at: resets },
      seven_day: { utilization: 10, resets_at: resets },
      limits: [model("Opus"), model("opus"), { kind: "other", percent: 5 }],
    }),
  );
  const reading = usageReadingSchema.parse(
    await readClaudeUsage(home, fetcher),
  );
  const headers = new Headers(fetcher.mock.calls.at(-1)?.[1]?.headers);
  expect(headers.get("authorization")).toBe("Bearer tok");
  expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
  expect(reading).toEqual({
    accounts: [
      {
        accountKey: "anthropic:account:u1",
        label: null,
        usage: {
          status: "ok",
          accountEmail: "me@example.com",
          planLabel: null,
          plan: { id: "max", multiplier: 20 },
          windows: [
            expect.objectContaining({ kind: "five-hour", usedPercent: 40 }),
            expect.objectContaining({ kind: "weekly", model: null }),
            expect.objectContaining({ kind: "weekly", model: "opus" }),
          ],
        },
      },
    ],
  });
});
