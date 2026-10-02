import { z } from "zod";
import {
  FAMILIES,
  type Account,
  type AccountQuota,
  type AccountSummary,
  type LimitWindow,
  type ModelFamily,
} from "./contract.js";

type Scalar = string | number | null;
type WindowUpdates = Record<string, LimitWindow | null>;

const CLAUDE_PREFIX = "anthropic-ratelimit-unified-";
const SCOPED_HEADER =
  /^anthropic-ratelimit-unified-7d_(.+)-(?:utilization|reset|status)$/u;
const CODEX_SLOTS = ["primary", "secondary"];
const FAMILY_KEYS = FAMILIES.map((family) => `7d:${family}`);
const WINDOW_ORDER = ["5h", "7d", ...FAMILY_KEYS, ...CODEX_SLOTS];
const CLAUDE_USAGE_FIELDS: Record<string, string> = {
  "5h": "five_hour",
  "7d": "seven_day",
  ...Object.fromEntries(
    FAMILIES.map((family) => [`7d:${family}`, `seven_day_${family}`]),
  ),
};
const BLOCK_WITHOUT_RESET_MS = 5 * 60 * 1_000;
const record = z.record(z.string(), z.unknown());

export const EMPTY_QUOTA: AccountQuota = {
  windows: [],
  extraUsage: null,
  observedAt: null,
  heldUntil: null,
  error: null,
};

export function dig(value: unknown, ...keys: string[]): unknown {
  const step = (parent: unknown, key: string) =>
    record.safeParse(parent).data?.[key];
  return keys.reduce(step, value);
}

function scalar(value: unknown, ...keys: string[]): Scalar {
  const isScalar = (entry: unknown): entry is string | number =>
    typeof entry === "number" || typeof entry === "string";
  return keys.map((key) => dig(value, key)).find(isScalar) ?? null;
}

function numeric(value: Scalar): number | null {
  if (value === null || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function epochMs(value: number): number {
  return Math.round(value < 1_000_000_000_000 ? value * 1_000 : value);
}

function resetTime(value: Scalar): number | null {
  const number = numeric(value);
  if (number !== null) return epochMs(number);
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? null : parsed;
}

function clamp(fraction: number): number {
  return Math.max(0, Math.min(1, fraction));
}

function windowOf(quota: AccountQuota, key: string): LimitWindow | null {
  return quota.windows.find((window) => window.key === key) ?? null;
}

function mergeWindows(previous: LimitWindow[], updates: WindowUpdates) {
  const kept = previous.filter((window) => !(window.key in updates));
  const added = Object.values(updates).filter((window) => window !== null);
  const rank = (window: LimitWindow) => WINDOW_ORDER.indexOf(window.key);
  return [...kept, ...added].sort((left, right) => rank(left) - rank(right));
}

export function modelFamily(model: string | null): ModelFamily {
  const name = model?.toLowerCase() ?? "";
  return FAMILIES.find((family) => name.includes(family)) ?? "other";
}

export function claudeQuotaFromHeaders(
  headers: Headers,
  previous: AccountQuota,
  family: ModelFamily,
  now: number,
): AccountQuota {
  let observed = false;
  const read = (key: string, header: string): LimitWindow | null => {
    const prior = windowOf(previous, key);
    const utilization = numeric(headers.get(`${header}-utilization`));
    const resetAt = resetTime(headers.get(`${header}-reset`));
    const status = headers.get(`${header}-status`);
    const absent = utilization === null && resetAt === null && status === null;
    if (absent) return prior;
    observed = true;
    return {
      key,
      minutes: null,
      utilization: utilization ?? prior?.utilization ?? null,
      resetAt: resetAt ?? prior?.resetAt ?? null,
      status: status ?? prior?.status ?? null,
    };
  };
  const updates: WindowUpdates = {
    "5h": read("5h", `${CLAUDE_PREFIX}5h`),
    "7d": read("7d", `${CLAUDE_PREFIX}7d`),
  };
  const scope = [...headers.keys()]
    .map((name) => SCOPED_HEADER.exec(name)?.[1])
    .find((bucket) => bucket !== undefined);
  if (scope !== undefined) {
    const key = `7d:${family}`;
    updates[key] = read(key, `${CLAUDE_PREFIX}7d_${scope}`);
  }
  const overage = headers.get(`${CLAUDE_PREFIX}overage-status`) ?? "";
  const known = ["allowed", "allowed_warning", "rejected"].includes(overage);
  return {
    ...previous,
    windows: mergeWindows(previous.windows, updates),
    extraUsage: known ? overage !== "rejected" : previous.extraUsage,
    observedAt: observed || known ? now : previous.observedAt,
  };
}

export function isClaudeQuotaRejection(headers: Headers): boolean {
  const shared = [`${CLAUDE_PREFIX}5h-status`, `${CLAUDE_PREFIX}7d-status`];
  return [...headers].some(([name, value]) => {
    const scoped = SCOPED_HEADER.test(name) && name.endsWith("-status");
    const limited = shared.includes(name) || scoped;
    return limited && value.toLowerCase() === "rejected";
  });
}

function claudeUsageWindow(key: string, usage: unknown): LimitWindow | null {
  const names = ["used_percentage", "utilization", "usedPercentage", "percent"];
  const percent = numeric(scalar(usage, ...names));
  const utilization = percent === null ? null : percent / 100;
  const resetAt = resetTime(scalar(usage, "resets_at", "reset_at", "resetAt"));
  const stated = z.string().safeParse(dig(usage, "status")).data ?? null;
  if (utilization === null && resetAt === null && stated === null) return null;
  const full = (utilization ?? 0) >= 1 ? "rejected" : "allowed";
  const status = stated ?? (utilization === null ? null : full);
  return { key, minutes: null, utilization, resetAt, status };
}

export function claudeQuotaFromUsage(
  payload: unknown,
  previous: AccountQuota,
  now: number,
): AccountQuota | null {
  const updates: WindowUpdates = {};
  const limits = z.array(record).safeParse(dig(payload, "limits")).data;
  if (limits !== undefined) for (const key of FAMILY_KEYS) updates[key] = null;
  for (const limit of limits ?? []) {
    const name = dig(limit, "scope", "model", "display_name");
    const weekly = limit.kind === "weekly_scoped" || limit.group === "weekly";
    if (typeof name !== "string" || !weekly) continue;
    const key = `7d:${modelFamily(name)}`;
    const found = claudeUsageWindow(key, limit);
    const current = updates[key]?.utilization ?? -1;
    const stronger =
      updates[key] == null || (found?.utilization ?? -1) > current;
    if (found !== null && stronger) updates[key] = found;
  }
  for (const [key, field] of Object.entries(CLAUDE_USAGE_FIELDS)) {
    const window = claudeUsageWindow(key, dig(payload, field));
    if (window !== null) updates[key] = window;
  }
  const extra = dig(payload, "extra_usage");
  if (Object.keys(updates).length === 0 && extra === undefined) return null;
  const used = (name: string) => numeric(scalar(extra, name));
  const cap = used("monthly_limit");
  const underCap = cap === null || (used("used_credits") ?? 0) < cap;
  const enabled = dig(extra, "is_enabled") === true;
  const allowed = enabled && (used("utilization") ?? 0) < 100 && underCap;
  const overage = extra === null ? null : allowed;
  return {
    ...previous,
    windows: mergeWindows(previous.windows, updates),
    extraUsage: extra === undefined ? previous.extraUsage : overage,
    observedAt: now,
  };
}

function codexHeaderWindow(
  headers: Headers,
  key: string,
  prior: LimitWindow | null,
  now: number,
): LimitWindow | null {
  const read = (name: string) => numeric(headers.get(`x-codex-${key}-${name}`));
  const [used, at] = [read("used-percent"), read("reset-at") ?? 0];
  const after = read("reset-after-seconds") ?? 0;
  const relative = after > 0 ? now + Math.round(after * 1_000) : null;
  const reset = at > 0 ? epochMs(at) : relative;
  const over = headers.get(`x-codex-${key}-over-limit`)?.toLowerCase();
  const overLimit = over === "true";
  if (used === null && reset === null && !overLimit) return prior;
  const length = read("window-minutes") ?? 0;
  const minutes = length > 0 ? Math.round(length) : (prior?.minutes ?? null);
  const pending = (prior?.resetAt ?? 0) > now ? (prior?.resetAt ?? null) : null;
  const resetAt = reset ?? pending;
  const utilization =
    used === null ? (prior?.utilization ?? null) : clamp(used / 100);
  const empty = minutes === null && resetAt === null && !utilization;
  if (empty && !overLimit) return null;
  const status = overLimit || (utilization ?? 0) >= 1 ? "rejected" : null;
  return { key, minutes, utilization, resetAt, status };
}

export function codexQuotaFromHeaders(
  headers: Headers,
  previous: AccountQuota,
  now: number,
): AccountQuota {
  const priors = CODEX_SLOTS.map((key) => windowOf(previous, key));
  const windows = CODEX_SLOTS.map((key, index) =>
    codexHeaderWindow(headers, key, priors[index] ?? null, now),
  );
  const credits = ["has-credits", "unlimited"].map((name) =>
    headers.get(`x-codex-credits-${name}`)?.toLowerCase(),
  );
  const seen = credits.every((value) =>
    ["true", "1", "false", "0"].includes(value ?? ""),
  );
  const funded = credits.some((value) => value === "true" || value === "1");
  const unchanged = windows.every((window, index) => window === priors[index]);
  if (unchanged && !seen) return previous;
  return {
    ...previous,
    windows: windows.filter((window) => window !== null),
    extraUsage: seen ? funded : previous.extraUsage,
    observedAt: now,
    heldUntil: null,
  };
}

export function isCodexQuotaRejection(headers: Headers): boolean {
  if (headers.has("x-codex-rate-limit-reached-type")) return true;
  return CODEX_SLOTS.some((key) => {
    const used = numeric(headers.get(`x-codex-${key}-used-percent`)) ?? 0;
    const over = headers.get(`x-codex-${key}-over-limit`)?.toLowerCase();
    return used >= 100 || over === "true";
  });
}

export function codexQuotaFromUsage(
  payload: unknown,
  previous: AccountQuota,
  now: number,
): AccountQuota | null {
  const limits = dig(payload, "rate_limit");
  const credits = dig(payload, "credits");
  if (limits === undefined && credits === undefined) return null;
  const windows = CODEX_SLOTS.flatMap((key): LimitWindow[] => {
    const usage = dig(limits, `${key}_window`);
    const used = numeric(scalar(usage, "used_percent"));
    if (used === null) return [];
    const utilization = clamp(used / 100);
    const at = numeric(scalar(usage, "reset_at"));
    const after = numeric(scalar(usage, "reset_after_seconds"));
    const relative = after === null ? null : now + Math.round(after * 1_000);
    const resetAt = at === null ? relative : epochMs(at);
    const seconds = numeric(scalar(usage, "limit_window_seconds")) ?? 0;
    const minutes = Math.round(seconds / 60) || null;
    const status = utilization >= 1 ? "rejected" : "allowed";
    return [{ key, minutes, utilization, resetAt, status }];
  });
  const funded = ["has_credits", "unlimited"].some(
    (name) => dig(credits, name) === true,
  );
  const overage = credits === null ? null : funded;
  return {
    ...previous,
    windows: limits === undefined ? previous.windows : windows,
    extraUsage: credits === undefined ? previous.extraUsage : overage,
    observedAt: now,
  };
}

function blockingWindows(
  quota: AccountQuota,
  family: ModelFamily | null,
  threshold: number,
  now: number,
): LimitWindow[] {
  return quota.windows.filter(({ key, resetAt, status, utilization }) => {
    const applies = !key.startsWith("7d:") || key === `7d:${family}`;
    const pending = resetAt === null || resetAt > now;
    const rejected = status?.toLowerCase() === "rejected";
    return applies && pending && (rejected || (utilization ?? 0) >= threshold);
  });
}

export function isExhausted(
  quota: AccountQuota,
  family: ModelFamily | null,
  threshold: number,
  now: number,
): boolean {
  return blockingWindows(quota, family, threshold, now).length > 0;
}

export function blocked(quota: AccountQuota, now: number): AccountQuota {
  const resetAt = now + BLOCK_WITHOUT_RESET_MS;
  const block = { key: "blocked", minutes: null, utilization: null };
  const windows = mergeWindows(quota.windows, {
    blocked: { ...block, resetAt, status: "rejected" },
  });
  return { ...quota, windows };
}

export function blockingResetAt(
  quota: AccountQuota,
  family: ModelFamily | null,
  threshold: number,
  now: number,
): number | null {
  const blocking = blockingWindows(quota, family, threshold, now);
  const resets = blocking.flatMap(({ resetAt }) => resetAt ?? []);
  const unknown = resets.length === 0 || resets.length < blocking.length;
  return unknown ? null : Math.max(...resets);
}

export function accountStatus(
  account: Account,
  quota: AccountQuota,
  threshold: number,
  now: number,
): AccountSummary["status"] {
  if (!account.enabled) return "disabled";
  if (quota.error !== null) return "error";
  if ((quota.heldUntil ?? 0) > now) return "held";
  const spent = isExhausted(quota, null, threshold, now);
  return spent && quota.extraUsage !== true ? "exhausted" : "ready";
}

export function retryAfterMs(value: string | null, now: number): number {
  if (value === null) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1_000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? 1_000 : Math.max(0, date - now);
}
