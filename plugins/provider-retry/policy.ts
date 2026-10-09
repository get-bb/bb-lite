import type { ProviderErrorCategory } from "@bb/domain";

export const RESET_BUFFER_MS = 15_000;
export const RESET_JITTER_MS = 30_000;
export const DEFAULT_MAXIMUM_WAIT_MS = 6 * 60 * 60 * 1_000;
export const OVERLOAD_RETRY_BASE_MS = 5_000;
export const MAX_RETRY_ATTEMPTS = 5;

export interface RateLimitState {
  status: string;
  kind: string;
  windows: { status: string; resetsAtMs: number | null }[];
}

export interface Failure {
  attemptNumber: number;
  category: ProviderErrorCategory | null;
  rateLimits: RateLimitState | null;
}

export type RetryDecision =
  | { kind: "decline"; reason: string }
  | { kind: "retry"; sendAt: number; reason: string };

export interface RetryPolicyInput {
  failure: Failure;
  maximumWaitMs: number | null;
  now: number;
  random: number;
}

function resetAtMs(rateLimits: RateLimitState): number | null {
  const blocked = rateLimits.windows.filter((w) => w.status === "blocked");
  const relevant = blocked.length > 0 ? blocked : rateLimits.windows;
  const resets = relevant.flatMap((w) =>
    w.resetsAtMs === null ? [] : [w.resetsAtMs],
  );
  return resets.length === 0 ? null : Math.max(...resets);
}

export function decideRetry(input: RetryPolicyInput): RetryDecision {
  const { failure, now, random } = input;
  if (failure.attemptNumber >= MAX_RETRY_ATTEMPTS) {
    return { kind: "decline", reason: "attempts-exhausted" };
  }
  if (failure.category === "overloaded") {
    const delay = OVERLOAD_RETRY_BASE_MS * 2 ** (failure.attemptNumber - 1);
    const sendAt = now + delay + Math.floor(random * delay);
    return { kind: "retry", sendAt, reason: "Provider overloaded" };
  }
  if (failure.category !== "rate-limit") {
    return { kind: "decline", reason: "not-retryable" };
  }
  const { rateLimits } = failure;
  if (rateLimits === null || rateLimits.status !== "blocked") {
    return { kind: "decline", reason: "no-rate-limit-state" };
  }
  const resetsAt = resetAtMs(rateLimits);
  if (rateLimits.kind !== "subscription-window" || resetsAt === null) {
    return { kind: "decline", reason: "not-resettable" };
  }
  if (input.maximumWaitMs !== null && resetsAt - now > input.maximumWaitMs) {
    return { kind: "decline", reason: "beyond-maximum-wait" };
  }
  const base = Math.max(resetsAt, now);
  const sendAt = base + RESET_BUFFER_MS + Math.floor(random * RESET_JITTER_MS);
  return { kind: "retry", sendAt, reason: "Rate limited" };
}
