import { contract, op } from "@bb/plugin";
import { z } from "zod";

const text = z.string().min(1);

export const usageWindowSchema = z.object({
  kind: z.enum(["five-hour", "daily", "weekly", "custom"]).default("custom"),
  label: text,
  usedPercent: z.number().nonnegative(),
  resetsAt: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  cost: z
    .object({
      usedUsdCents: z.number().nonnegative(),
      limitUsdCents: z.number().positive(),
    })
    .nullable()
    .default(null),
});

export const usageSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    accountEmail: z.string().nullable().default(null),
    planLabel: z.string().nullable().default(null),
    plan: z
      .object({ id: text, multiplier: z.number().int().positive().nullable() })
      .nullable()
      .default(null),
    windows: z.array(usageWindowSchema),
  }),
  z.object({ status: z.literal("not_installed") }),
  z.object({ status: z.literal("unauthenticated") }),
  z.object({ status: z.literal("expired") }),
  z.object({ status: z.literal("error"), message: text }),
]);

export const usageAccountSchema = z.object({
  accountKey: text.nullable().default(null),
  label: text.nullable().default(null),
  usage: usageSchema,
});

export const usageReadingSchema = z.union([
  z.null(),
  z.object({ accounts: z.array(usageAccountSchema) }),
  usageSchema,
]);

export const providerUsageSchema = z.object({
  providerId: text,
  displayName: text,
  accounts: z.array(usageAccountSchema),
  error: z.string().nullable(),
  observedAt: z.number().nullable(),
});

export const usageSnapshotSchema = z.object({
  hostId: z.string().nullable(),
  providers: z.array(providerUsageSchema),
});

export type UsageReading = z.input<typeof usageReadingSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type UsageWindow = z.infer<typeof usageWindowSchema>;
export type UsageAccount = z.infer<typeof usageAccountSchema>;
export type ProviderUsage = z.infer<typeof providerUsageSchema>;
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;

export const providerUsage = contract("provider-usage", {
  usage: op({
    input: z.object({
      hostId: text
        .nullish()
        .describe("Machine to read host-local usage on; omit for shared"),
      refresh: z
        .boolean()
        .default(false)
        .describe("Collect fresh usage instead of a recent reading"),
    }),
    output: usageSnapshotSchema,
    doors: {
      cli: {
        path: "provider-usage show",
        summary: "Show each provider's usage limits and reset times",
        print: (snapshot) => formatSnapshot(snapshot),
      },
    },
  }),
});

export function formatSnapshot(snapshot: UsageSnapshot): string {
  if (snapshot.providers.length === 0) return "No provider reports usage.";
  return snapshot.providers
    .map((provider) =>
      [
        provider.displayName,
        ...(provider.error === null ? [] : [`  ${provider.error}`]),
        ...provider.accounts.flatMap((account) => {
          const name = account.label ?? accountEmail(account.usage);
          const head = name === null ? [] : [`  ${name}`];
          if (account.usage.status !== "ok")
            return [...head, `  ${statusText(account.usage)}`];
          const plan = account.usage.planLabel;
          return [
            ...head,
            ...(plan === null ? [] : [`  Plan: ${plan}`]),
            ...account.usage.windows.map((window) =>
              [
                `  ${window.label}: ${Math.round(window.usedPercent)}% used`,
                formatReset(window.resetsAt, Date.now()),
              ]
                .filter((part) => part !== null)
                .join(", "),
            ),
          ];
        }),
      ].join("\n"),
    )
    .join("\n\n");
}

function accountEmail(usage: Usage): string | null {
  return usage.status === "ok" ? usage.accountEmail : null;
}

export function statusText(usage: Usage): string {
  switch (usage.status) {
    case "ok":
      return usage.windows.length === 0 ? "No usage limits reported." : "";
    case "not_installed":
      return "Not installed on this machine.";
    case "unauthenticated":
      return "Not signed in. Sign in, then reload usage.";
    case "expired":
      return "Session expired. Sign in again, then reload usage.";
    case "error":
      return usage.message;
  }
}

export function formatReset(resetsAt: string | null, now: number) {
  if (resetsAt === null) return null;
  const reset = new Date(resetsAt).getTime();
  if (Number.isNaN(reset)) return null;
  const minutes = Math.round((reset - now) / 60_000);
  if (minutes <= 0) return "resetting now";
  if (minutes < 60) return `resets in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return minutes % 60 === 0
      ? `resets in ${hours} hr`
      : `resets in ${hours} hr ${minutes % 60} min`;
  const withinWeek = reset - now < 7 * 24 * 60 * 60_000;
  return `resets ${new Date(reset).toLocaleString(undefined, {
    weekday: withinWeek ? "short" : undefined,
    month: withinWeek ? undefined : "short",
    day: withinWeek ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}
