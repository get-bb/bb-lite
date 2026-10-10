import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageReading } from "@bb/plugin";
import { z } from "zod";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TIMEOUT_MS = 15_000;
const WINDOW_KINDS: Record<number, "five-hour" | "daily" | "weekly"> = {
  18_000: "five-hour",
  86_400: "daily",
  604_800: "weekly",
};
const authSchema = z.object({
  OPENAI_API_KEY: z.string().nullish(),
  tokens: z
    .object({
      access_token: z.string(),
      id_token: z.string().nullish(),
      account_id: z.string().nullish(),
    })
    .nullish(),
});
const claimsSchema = z.object({
  exp: z.number().optional(),
  email: z.string().optional(),
  "https://api.openai.com/auth": z
    .object({
      chatgpt_account_id: z.string().optional(),
      chatgpt_account_is_fedramp: z.boolean().optional(),
    })
    .optional(),
});
const windowSchema = z
  .object({
    used_percent: z.number(),
    reset_at: z.number().nullish(),
    limit_window_seconds: z.number().nullish(),
  })
  .nullish();
const responseSchema = z.object({
  plan_type: z.string().nullish(),
  rate_limit: z
    .object({ primary_window: windowSchema, secondary_window: windowSchema })
    .nullish(),
});

function claims(token: string | null | undefined) {
  const payload = Buffer.from(token?.split(".")[1] ?? "", "base64url");
  try {
    return claimsSchema.parse(JSON.parse(payload.toString()));
  } catch {
    return null;
  }
}

function usageWindow(value: z.infer<typeof windowSchema>, label: string) {
  if (value == null) return null;
  const kind = windowKind(value.limit_window_seconds);
  return {
    kind,
    label: kind === "weekly" ? "Weekly limit" : label,
    usedPercent: Math.min(100, Math.max(0, value.used_percent)),
    resetsAt:
      value.reset_at == null
        ? null
        : new Date(value.reset_at * 1000).toISOString(),
  };
}

function windowKind(
  seconds: number | null | undefined,
): "five-hour" | "daily" | "weekly" | "custom" {
  return (seconds == null ? undefined : WINDOW_KINDS[seconds]) ?? "custom";
}

export async function readCodexUsage(
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
): Promise<UsageReading> {
  const home = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  let raw: string;
  try {
    raw = await readFile(join(home, "auth.json"), "utf8");
  } catch {
    return { status: "unauthenticated" };
  }
  let auth: z.infer<typeof authSchema>;
  try {
    auth = authSchema.parse(JSON.parse(raw));
  } catch (error) {
    return { status: "error", message: `Unreadable auth.json: ${error}` };
  }
  if (auth.tokens == null) {
    if (auth.OPENAI_API_KEY)
      return {
        status: "error",
        message:
          "Codex is signed in with an API key, which has no usage limits.",
      };
    return { status: "unauthenticated" };
  }
  const access = claims(auth.tokens.access_token);
  const identity = claims(auth.tokens.id_token);
  const openai = identity?.["https://api.openai.com/auth"];
  const accountId = auth.tokens.account_id ?? openai?.chatgpt_account_id;
  if (!accountId) return { status: "unauthenticated" };
  const exp = access?.exp;
  if (exp !== undefined && Date.now() >= exp * 1000)
    return { status: "expired" };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.tokens.access_token}`,
    "chatgpt-account-id": accountId,
    originator: "bb",
    "User-Agent": "bb-provider-codex",
    Accept: "application/json",
  };
  if (openai?.chatgpt_account_is_fedramp) headers["X-OpenAI-Fedramp"] = "true";
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetcher(USAGE_URL, { headers, signal });
  if (response.status === 401) return { status: "expired" };
  if (!response.ok)
    return {
      status: "error",
      message: `Codex usage request failed (HTTP ${response.status}).`,
    };
  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success)
    return { status: "error", message: "Codex usage response was malformed." };
  const { plan_type: plan, rate_limit: limits } = parsed.data;
  const windows = [
    usageWindow(limits?.primary_window, "Current session"),
    usageWindow(limits?.secondary_window, "Weekly limit"),
  ].filter((window) => window !== null);
  const usage = {
    status: "ok" as const,
    accountEmail: identity?.email ?? null,
    planLabel: plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null,
    plan: plan ? { id: plan, multiplier: null } : null,
    windows,
  };
  return {
    accounts: [
      { accountKey: `openai:chatgpt:${accountId}`, label: null, usage },
    ],
  };
}
