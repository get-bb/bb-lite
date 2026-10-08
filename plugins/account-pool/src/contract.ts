import { contract, op } from "@bb/plugin";
import { z } from "zod";

export const HUB_PATH = "/api/v1/plugins/account-pool/http";

export const providerSchema = z.enum(["claude", "codex"]);
export type PoolProvider = z.infer<typeof providerSchema>;

export const FAMILIES = ["fable", "sonnet", "opus", "haiku", "other"] as const;
export type ModelFamily = (typeof FAMILIES)[number];

const httpUrl = z.url({ protocol: /^https?$/u });
const switchThreshold = z.number().positive().max(1);
const wholeNumber = z.number().int();
const natural = wholeNumber.nonnegative();

export const configSchema = z.object({
  anthropicUpstreamBaseUrl: httpUrl.default("https://api.anthropic.com"),
  codexUpstreamBaseUrl: httpUrl.default(
    "https://chatgpt.com/backend-api/codex",
  ),
  claudeTokenUrl: httpUrl.default("https://platform.claude.com/v1/oauth/token"),
  codexAuthBaseUrl: httpUrl.default("https://auth.openai.com"),
  switchThreshold: switchThreshold.default(0.98),
});
export type PoolConfig = z.infer<typeof configSchema>;

export const accountSchema = z.object({
  id: z.uuid(),
  provider: providerSchema,
  kind: z.enum(["oauth", "api-key"]),
  label: z.string().min(1),
  email: z.email().nullable(),
  accountUuid: z.uuid().nullable().default(null),
  codexAccountId: z.string().min(1).optional(),
  subscriptionType: z.string().nullable(),
  rateLimitTier: z.string().nullable(),
  enabled: z.boolean(),
  priority: wholeNumber,
  createdAt: natural,
  lastUsedAt: natural.nullable().default(null),
  lastUsedHostId: z.string().min(1).nullable().default(null),
});
export type Account = z.infer<typeof accountSchema>;

export const limitWindowSchema = z.object({
  key: z.string(),
  minutes: wholeNumber.positive().nullable(),
  utilization: z.number().nullable(),
  resetAt: wholeNumber.nullable(),
  status: z.string().nullable(),
});
export type LimitWindow = z.infer<typeof limitWindowSchema>;

export const quotaSchema = z.object({
  windows: z.array(limitWindowSchema),
  extraUsage: z.boolean().nullable(),
  observedAt: wholeNumber.nullable(),
  heldUntil: wholeNumber.nullable(),
  error: z.string().nullable(),
});
export type AccountQuota = z.infer<typeof quotaSchema>;

export const accountSummarySchema = accountSchema.extend({
  ...quotaSchema.shape,
  inFlight: natural,
  status: z.enum(["disabled", "ready", "held", "exhausted", "error"]),
  blockedUntil: wholeNumber.nullable(),
});
export type AccountSummary = z.infer<typeof accountSummarySchema>;

const hostSchema = z.object({
  hostId: z.string(),
  hostName: z.string().nullable(),
});
export const statusSchema = z.object({
  route: z.string(),
  hosts: z.array(hostSchema),
  accounts: z.array(accountSummarySchema),
  routing: z.object({ claude: z.boolean(), codex: z.boolean() }),
  config: configSchema,
});
export type PoolStatus = z.infer<typeof statusSchema>;

export const accountAddSchema = z.object({
  provider: providerSchema,
  apiKey: z.string().min(1).nullable(),
  label: z.string().min(1).nullable(),
  priority: wholeNumber,
});
export type AccountAddInput = z.infer<typeof accountAddSchema>;

const deviceSchema = z.object({
  userCode: z.string().min(1),
  intervalMs: wholeNumber.positive(),
});
export const loginStartSchema = z.object({
  sessionId: z.uuid(),
  url: z.url(),
  expiresAt: natural,
  device: deviceSchema.nullable(),
});
export type LoginStart = z.infer<typeof loginStartSchema>;

export const loginPollSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("complete"), account: accountSchema }),
  z.object({ status: z.literal("error"), message: z.string().min(1) }),
]);
export type LoginPoll = z.infer<typeof loginPollSchema>;

const provider = z.object({ provider: providerSchema });
const accountId = z.object({ id: z.uuid() });
const session = z.object({ sessionId: z.uuid() });
const accountPatch = z.object({
  enabled: z.boolean().optional(),
  priority: wholeNumber.optional(),
});
const done = z.null();
const write = "write" as const;

export const pool = contract("account-pool", {
  status: op({ input: z.object({}), output: statusSchema }),
  accountAdd: op({
    input: accountAddSchema,
    output: accountSchema,
    kind: write,
    secret: ["apiKey"],
  }),
  accountUpdate: op({
    input: accountId.extend(accountPatch.shape),
    output: accountSchema,
    kind: write,
  }),
  accountRefresh: op({ input: accountId, output: done, kind: write }),
  routingSet: op({
    input: provider.extend({ enabled: z.boolean() }),
    output: done,
    kind: write,
  }),
  configSet: op({
    input: z.object({ switchThreshold }),
    output: done,
    kind: write,
  }),
  loginStart: op({ input: provider, output: loginStartSchema, kind: write }),
  loginComplete: op({
    input: session.extend({ code: z.string().trim().min(1) }),
    output: accountSchema,
    kind: write,
    secret: ["code"],
  }),
  loginPoll: op({ input: session, output: loginPollSchema }),
});
