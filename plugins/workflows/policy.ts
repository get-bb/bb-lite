export const SETTINGS = {
  maxActiveRuns: {
    type: "number",
    label: "Maximum active runs",
    description: "Concurrent workflow runs across the plugin (1-32).",
    default: 4,
  },
  maxConcurrentAgents: {
    type: "number",
    label: "Per-run agent concurrency",
    description: "Agent calls that one workflow may run concurrently (1-64).",
    default: 8,
  },
  maxAgentCalls: {
    type: "number",
    label: "Maximum agent calls",
    description: "Agent calls allowed during one workflow run (1-1000).",
    default: 100,
  },
  totalRunTimeoutMs: {
    type: "number",
    label: "Total run timeout (milliseconds)",
    description:
      "Fail a workflow after this total duration in milliseconds (60000-604800000).",
    default: 86_400_000,
  },
  retentionDays: {
    type: "number",
    label: "Retention (days)",
    description: "Days to retain completed workflow data (1-3650).",
    default: 7,
  },
  maxNotificationBytes: {
    type: "number",
    label: "Maximum notification bytes",
    description:
      "Maximum UTF-8 size of a completion notification (1024-262144).",
    default: 16_384,
  },
} as const;

export type Limits = Record<keyof typeof SETTINGS, number>;

const BOUNDS: Record<keyof Limits, [number, number]> = {
  maxActiveRuns: [1, 32],
  maxConcurrentAgents: [1, 64],
  maxAgentCalls: [1, 1000],
  totalRunTimeoutMs: [60_000, 604_800_000],
  retentionDays: [1, 3650],
  maxNotificationBytes: [1024, 262_144],
};

export function clampLimits(values: Limits): Limits {
  const entries = Object.entries(BOUNDS).map(([key, [min, max]]) => {
    const value = Math.trunc(values[key as keyof Limits]);
    const fallback = SETTINGS[key as keyof Limits].default;
    const number = Number.isFinite(value) ? value : fallback;
    return [key, Math.min(max, Math.max(min, number))];
  });
  return Object.fromEntries(entries) as Limits;
}

export const RETRY_DELAYS_MS = [1_000, 4_000] as const;

const TRANSIENT = [
  /provider[^\n]*(?:overload|capacity|busy|temporar|unavailable|rate.?limit)/,
  /(?:rate.?limit|too many requests)/,
  /(?:http|status|api error|error)\s*(?:429|500|502|503|504|529)\b/,
  /\b(?:econnreset|econnrefused|etimedout|ehostunreach|enetunreach)\b/,
  /(?:connection reset|connection closed|socket hang up|network error)/,
];

export function isTransient(detail: string): boolean {
  const text = detail.toLowerCase();
  return TRANSIENT.some((pattern) => pattern.test(text));
}

export function clipUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  const marker = "\n[truncated]";
  const kept = bytes.subarray(0, maxBytes - Buffer.byteLength(marker));
  return `${kept.toString("utf8").replace(/�+$/u, "")}${marker}`;
}
