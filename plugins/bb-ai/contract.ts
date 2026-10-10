import { contract, op } from "@bb/plugin";
import { z } from "zod";

export const usageSchema = z.object({
  day: z.string(),
  spentMicros: z.number().nonnegative(),
  limitMicros: z.number().nonnegative(),
  resetsAt: z.number(),
});
export type BbAiUsage = z.infer<typeof usageSchema>;

export const overviewSchema = z.object({
  enabled: z.boolean(),
  signedIn: z.boolean(),
  handle: z.string().nullable(),
  ready: z.boolean(),
  message: z.string().nullable(),
  usage: usageSchema.nullable(),
  usageError: z.string().nullable(),
});
export type BbAiOverview = z.infer<typeof overviewSchema>;

export function formatDollars(micros: number): string {
  if (micros > 0 && micros < 10_000) return "<$0.01";
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

export function formatResetTime(resetsAt: number): string {
  return new Date(resetsAt).toISOString().slice(11, 16);
}

export function formatUsage(usage: BbAiUsage): string {
  const spent = formatDollars(usage.spentMicros);
  const limit = formatDollars(usage.limitMicros);
  return `${spent} of ${limit} today, resets ${formatResetTime(usage.resetsAt)} UTC`;
}

export function describeOverview(view: BbAiOverview): string {
  const account = view.signedIn
    ? `Signed in as ${view.handle ?? "a bb account"}`
    : "Signed out. Run `bb account login`.";
  const ready = view.ready ? "Ready" : `Not ready: ${view.message ?? ""}`;
  const usage =
    view.usage !== null
      ? `Usage: ${formatUsage(view.usage)}`
      : view.usageError !== null
        ? `Usage unavailable: ${view.usageError}`
        : null;
  return [account, ready, usage].filter((line) => line !== null).join("\n");
}

export const bbAi = contract("bb-ai", {
  status: op({
    input: z.object({}),
    output: overviewSchema,
    doors: {
      cli: {
        path: "ai status",
        summary: "Show whether bb cloud is on and ready, and today's usage",
        print: describeOverview,
      },
    },
  }),
  update: op({
    input: z.object({ enabled: z.boolean() }),
    output: overviewSchema,
    kind: "write",
    allow: "owner",
  }),
  usage: op({
    input: z.object({}),
    output: usageSchema,
    doors: {
      cli: {
        path: "ai usage",
        summary: "Show today's bb cloud spend against the daily limit",
        print: formatUsage,
      },
    },
  }),
});
