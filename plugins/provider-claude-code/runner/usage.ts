import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { UsageReading } from "@bb/plugin";
import { z } from "zod";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TIMEOUT_MS = 15_000;
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const credentialsSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    expiresAt: z.number().nullish(),
    subscriptionType: z.string().nullish(),
    rateLimitTier: z.string().nullish(),
  }),
});
const accountSchema = z.object({
  oauthAccount: z
    .object({
      emailAddress: z.string().nullish(),
      accountUuid: z.string().nullish(),
    })
    .nullish(),
});
const windowSchema = z
  .object({
    utilization: z.number().nullish(),
    resets_at: z.string().nullish(),
  })
  .nullish();
const responseSchema = z.object({
  five_hour: windowSchema,
  seven_day: windowSchema,
  limits: z
    .array(
      z.object({
        kind: z.string().nullish(),
        percent: z.number().nullish(),
        resets_at: z.string().nullish(),
        scope: z
          .object({
            model: z.object({ display_name: z.string().nullish() }).nullish(),
          })
          .nullish(),
      }),
    )
    .nullish(),
});
type Credentials = z.infer<typeof credentialsSchema>["claudeAiOauth"];

function parseJson<T>(schema: z.ZodType<T>, text: string): T | null {
  for (const candidate of [text, Buffer.from(text, "hex").toString()]) {
    try {
      return schema.parse(JSON.parse(candidate));
    } catch {}
  }
  return null;
}

async function keychain(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const run = promisify(execFile);
  const base = ["find-generic-password", "-s", KEYCHAIN_SERVICE];
  for (const args of [
    [...base, "-a", userInfo().username, "-w"],
    [...base, "-w"],
  ]) {
    const found = await run("security", args).catch(() => null);
    if (found !== null) return found.stdout.trim();
  }
  return null;
}

async function credentials(home: string): Promise<Credentials | null> {
  const file = join(home, ".claude", ".credentials.json");
  const sources = [keychain(), readFile(file, "utf8").catch(() => null)];
  for (const source of sources) {
    const text = await source;
    const parsed = text === null ? null : parseJson(credentialsSchema, text);
    if (parsed !== null) return parsed.claudeAiOauth;
  }
  return null;
}

const percent = (value: number) => Math.min(100, Math.max(0, value));

export async function readClaudeUsage(
  home: string = homedir(),
  fetcher: typeof fetch = fetch,
): Promise<UsageReading> {
  const auth = await credentials(home);
  if (auth === null) return { status: "unauthenticated" };
  if (auth.expiresAt != null && Date.now() >= auth.expiresAt)
    return { status: "expired" };
  const profile = await readFile(join(home, ".claude.json"), "utf8")
    .then((text) => parseJson(accountSchema, text)?.oauthAccount ?? null)
    .catch(() => null);
  const response = await fetcher(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-code/2.1.0",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 401) return { status: "expired" };
  if (response.status === 429)
    return {
      status: "error",
      message:
        "Claude usage is temporarily throttled; this does not mean your limit is exhausted.",
    };
  if (!response.ok)
    return {
      status: "error",
      message: `Claude usage request failed (HTTP ${response.status}).`,
    };
  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success)
    return { status: "error", message: "Claude usage response was malformed." };
  const { five_hour: session, seven_day: week, limits } = parsed.data;
  const seen = new Set<string>();
  const scoped = (limits ?? []).flatMap((limit) => {
    const label = limit.scope?.model?.display_name;
    if (limit.kind !== "weekly_scoped" || !label || limit.percent == null)
      return [];
    if (seen.has(label.toLowerCase())) return [];
    seen.add(label.toLowerCase());
    return [
      {
        kind: "weekly" as const,
        label,
        model: label.toLowerCase(),
        usedPercent: percent(limit.percent),
        resetsAt: limit.resets_at ?? null,
      },
    ];
  });
  const fixed = [
    { value: session, label: "Current session", kind: "five-hour" as const },
    { value: week, label: "Weekly limit", kind: "weekly" as const },
  ].flatMap(({ value, label, kind }) =>
    value?.utilization == null
      ? []
      : [
          {
            kind,
            label,
            usedPercent: percent(value.utilization),
            resetsAt: value.resets_at ?? null,
          },
        ],
  );
  const subscription = auth.subscriptionType?.toLowerCase();
  const multiplier = Number(/max_(\d+)x/u.exec(auth.rateLimitTier ?? "")?.[1]);
  const usage = {
    status: "ok" as const,
    accountEmail: profile?.emailAddress ?? null,
    plan: subscription
      ? { id: subscription, multiplier: multiplier || null }
      : null,
    windows: [...fixed, ...scoped],
  };
  const accountKey = profile?.accountUuid
    ? `anthropic:account:${profile.accountUuid}`
    : null;
  return { accounts: [{ accountKey, label: null, usage }] };
}
