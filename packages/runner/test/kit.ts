export async function until<T>(
  read: () => T | Promise<T>,
  label = "the condition",
): Promise<NonNullable<T>> {
  for (const deadline = Date.now() + 10_000; ;) {
    const value = await read();
    if (value) return value;
    const late = Date.now() > deadline;
    if (late) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const DROPPED = new Set([
  "turn/diff/updated",
  "provider/rateLimits/updated",
  "provider/unhandled",
]);

export function kept<T extends { type: string }>(recorded: T[]) {
  return recorded.filter((event) => !DROPPED.has(event.type));
}

export async function settle(rounds = 4) {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export function internIds<T>(events: T, sessionIds = false): T {
  const ids = new Map<string, string>();
  const intern = (id: string) => {
    if (!ids.has(id)) ids.set(id, `#${ids.size + 1}`);
    return ids.get(id) ?? id;
  };
  const minted = JSON.stringify(events).replace(
    /da[0-9a-f]{8}-[ti]\d+/g,
    intern,
  );
  const session = /("providerThreadId":")([^"]+)/g;
  const named = (_: string, key: string, id: string) => `${key}${intern(id)}`;
  return JSON.parse(sessionIds ? minted.replace(session, named) : minted) as T;
}
