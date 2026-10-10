import { readFileSync, existsSync } from "node:fs";
import type { ProviderSession, RunnerThreadEvent } from "@bb/runner";
import { afterEach, vi } from "vitest";
import { createHarness, type HarnessOptions } from "./adapter-harness.js";

export type Harness = ReturnType<typeof createHarness>;

export function trackSessions() {
  const sessions: ProviderSession[] = [];
  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      await session.close().catch(() => undefined);
    }
  });
  return {
    async open(harness: Harness, providerThreadId?: string) {
      const session = await harness.open(
        providerThreadId === undefined ? {} : { providerThreadId },
      );
      sessions.push(session);
      return session;
    },
    async start(options: HarnessOptions = {}) {
      const harness = createHarness(options);
      const session = await harness.open();
      sessions.push(session);
      return { harness, session };
    },
    keep(session: ProviderSession) {
      sessions.push(session);
      return session;
    },
  };
}

export function ofType<T extends RunnerThreadEvent["type"]>(
  harness: Harness,
  type: T,
): Extract<RunnerThreadEvent, { type: T }>[] {
  harness.host.events.flush();
  return harness.events.filter(
    (event): event is Extract<RunnerThreadEvent, { type: T }> =>
      event.type === type,
  );
}

export function messages(harness: Harness): string[] {
  harness.host.events.flush();
  return harness
    .items()
    .flatMap((item) => (item.type === "agentMessage" ? [item.text] : []));
}

export function completions(harness: Harness): string[] {
  return ofType(harness, "turn/completed").map((event) => event.status);
}

export async function until(check: () => void, timeout = 10_000) {
  await vi.waitFor(check, { timeout, interval: 20 });
}

export function begin(harness: Harness, session: ProviderSession, t: string) {
  return session.startTurn({
    clientRequestId: `req_${t.replaceAll(" ", "_")}`,
    input: [{ type: "text", text: t, mentions: [] }],
    options: harness.execution,
  });
}

export function jsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
