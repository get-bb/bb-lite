import {
  sessions,
  threads,
  type PluginServerApi,
  type UsageSource,
} from "@bb/plugin";
import {
  providerUsage,
  usageReadingSchema,
  type ProviderUsage,
  type Usage,
  type UsageAccount,
} from "./contract.js";

const MAX_AGE_MS = 2 * 60_000;
const READ_TIMEOUT_MS = 45_000;
const PLANS: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  max: "Max",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  education: "Education",
  edu: "Education",
};
const WINDOWS = {
  "five-hour": "Five-hour limit",
  daily: "Daily limit",
  weekly: "Weekly limit",
};

interface Reading {
  accounts: UsageAccount[];
  error: string | null;
  observedAt: number | null;
  loadedAt: number;
}

export function normalizeUsage(usage: Usage): Usage {
  if (usage.status !== "ok") return usage;
  const plan = usage.plan === null ? undefined : PLANS[usage.plan.id];
  const multiplier = usage.plan?.multiplier;
  return {
    ...usage,
    planLabel: plan
      ? `${plan}${multiplier == null ? "" : ` (${multiplier}x)`}`
      : usage.planLabel,
    windows: usage.windows.map((window) => {
      if (window.kind === "custom") return window;
      if (window.model === null)
        return { ...window, label: WINDOWS[window.kind] };
      const model =
        window.model.charAt(0).toUpperCase() + window.model.slice(1);
      const kind = window.kind === "weekly" ? "Weekly" : WINDOWS[window.kind];
      return { ...window, label: `${kind} · ${model}` };
    }),
  };
}

function dedupe(accounts: UsageAccount[]): UsageAccount[] {
  const seen = new Set<string>();
  return accounts.filter((account) => {
    if (account.accountKey === null) return true;
    if (seen.has(account.accountKey)) return false;
    seen.add(account.accountKey);
    return true;
  });
}

export default function providerUsageServer(bb: PluginServerApi): void {
  const readings = new Map<string, Reading>();
  const pending = new Map<string, Promise<Reading>>();

  const read = async (
    source: UsageSource,
    hostId: string | null,
    previous: Reading | undefined,
  ): Promise<Reading> => {
    const now = bb.now();
    try {
      const raw = await Promise.race([
        source.read({ hostId }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("timed out")),
            READ_TIMEOUT_MS,
          ).unref(),
        ),
      ]);
      const parsed = usageReadingSchema.parse(raw);
      const accounts =
        parsed === null
          ? []
          : "accounts" in parsed
            ? parsed.accounts
            : [{ accountKey: null, label: null, usage: parsed }];
      const failed = accounts.find(
        (account) => account.usage.status === "error",
      );
      if (failed && previous && previous.accounts.length > 0)
        return { ...previous, error: "Usage could not be refreshed." };
      return {
        accounts: dedupe(
          accounts.map((account) => ({
            ...account,
            usage: normalizeUsage(account.usage),
          })),
        ),
        error: null,
        observedAt: now,
        loadedAt: now,
      };
    } catch (error) {
      bb.log.warn("usage read failed", {
        providerId: source.providerId,
        error: String(error),
      });
      return {
        accounts: previous?.accounts ?? [],
        error: previous
          ? "Usage could not be refreshed."
          : "Usage could not be collected.",
        observedAt: previous?.observedAt ?? null,
        loadedAt: now,
      };
    }
  };

  const reading = (
    source: UsageSource,
    hostId: string | null,
    refresh: boolean,
  ): Promise<Reading> => {
    const scoped = source.scope === "shared" ? null : hostId;
    const key = JSON.stringify([source.providerId, scoped]);
    const running = pending.get(key);
    if (running) return running;
    const cached = readings.get(key);
    if (cached && !refresh && bb.now() - cached.loadedAt < MAX_AGE_MS)
      return Promise.resolve(cached);
    const promise = read(source, scoped, cached)
      .then((value) => {
        readings.set(key, value);
        return value;
      })
      .finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  };

  bb.implement(providerUsage.usage, async ({ hostId, refresh }) => {
    const target = hostId ?? null;
    const names = new Map(
      bb
        .read(sessions.provider)
        .map((provider) => [provider.id, provider.displayName]),
    );
    const providers = await Promise.all(
      bb.read(sessions.usage).map(async (source): Promise<ProviderUsage> => {
        const value = await reading(source, target, refresh);
        return {
          providerId: source.providerId,
          displayName: names.get(source.providerId) ?? source.providerId,
          accounts: value.accounts,
          error: value.error,
          observedAt: value.observedAt,
        };
      }),
    );
    return {
      hostId: target,
      providers: providers.filter(
        (provider) => provider.accounts.length > 0 || provider.error !== null,
      ),
    };
  });

  const markStale = () => {
    for (const value of readings.values()) value.loadedAt = 0;
  };
  bb.on(threads.idle, markStale);
  bb.on(threads.failed, markStale);
}
