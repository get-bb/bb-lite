import type { z } from "zod";

export function createLastKnownCache<T>(args: {
  prefix: string;
  version: string;
  schema: z.ZodType<T>;
  maxEntries?: number;
}) {
  const { prefix, version, schema, maxEntries = Infinity } = args;
  const scopePrefix = [prefix, version].join(".");
  const prune = (key: string) => {
    const others = Object.keys(window.localStorage).filter(
      (stored) => stored.startsWith(scopePrefix) && stored !== key,
    );
    for (const stale of others.slice(0, others.length - maxEntries + 1)) {
      window.localStorage.removeItem(stale);
    }
  };
  return {
    key: (...scope: ReadonlyArray<string | null | undefined>) =>
      [scopePrefix, ...scope.map((part) => part ?? "-")].join("."),
    read: (key: string): T | null => {
      try {
        const stored = window.localStorage.getItem(key);
        if (stored === null) return null;
        const parsed = schema.safeParse(JSON.parse(stored));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    write: (key: string, value: T): void => {
      try {
        prune(key);
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {}
    },
  };
}
