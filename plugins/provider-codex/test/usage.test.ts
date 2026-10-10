import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { usageReadingSchema } from "@bb/plugin";
import { expect, test, vi } from "vitest";
import { scratch } from "../../../apps/server/test/helpers.js";
import { readCodexUsage } from "../runner/usage.js";

const jwt = (claims: object) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

test("Codex usage reads the ChatGPT login and maps both windows", async () => {
  const env = { CODEX_HOME: scratch() };
  const fetcher = vi.fn<typeof fetch>();
  const login = (auth: object) =>
    writeFileSync(join(env.CODEX_HOME, "auth.json"), JSON.stringify(auth));
  expect(await readCodexUsage(env, fetcher)).toEqual({
    status: "unauthenticated",
  });
  login({ tokens: { access_token: jwt({ exp: 1 }), account_id: "acct" } });
  expect(await readCodexUsage(env, fetcher)).toEqual({ status: "expired" });
  const id_token = jwt({ email: "me@example.com" });
  login({ tokens: { access_token: jwt({}), id_token, account_id: "acct" } });
  fetcher.mockResolvedValueOnce(new Response("", { status: 401 }));
  expect(await readCodexUsage(env, fetcher)).toEqual({ status: "expired" });
  const window = (used: number, seconds: number) => ({
    used_percent: used,
    reset_at: 1_800_000_000,
    limit_window_seconds: seconds,
  });
  const body = {
    plan_type: "pro",
    rate_limit: {
      primary_window: window(12, 18_000),
      secondary_window: window(140, 604_800),
    },
  };
  fetcher.mockResolvedValueOnce(Response.json(body));
  const reading = await readCodexUsage(env, fetcher);
  const [url, init] = fetcher.mock.calls.at(-1) ?? [];
  expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
  expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("acct");
  expect(usageReadingSchema.parse(reading)).toEqual({
    accounts: [
      {
        accountKey: "openai:chatgpt:acct",
        label: null,
        usage: {
          status: "ok",
          accountEmail: "me@example.com",
          planLabel: "Pro",
          plan: { id: "pro", multiplier: null },
          windows: [
            expect.objectContaining({ kind: "five-hour", usedPercent: 12 }),
            expect.objectContaining({
              kind: "weekly",
              label: "Weekly limit",
              usedPercent: 100,
              resetsAt: "2027-01-15T08:00:00.000Z",
            }),
          ],
        },
      },
    ],
  });
});
