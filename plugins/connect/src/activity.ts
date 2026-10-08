import { setTimeout as sleep } from "node:timers/promises";

const INTERVAL_MS = 10 * 60_000;

export interface ActivityOptions {
  signal: AbortSignal;
  busy(): Promise<boolean>;
  report(): Promise<void>;
  warn(message: string): void;
  intervalMs?: number;
}

export async function watchActivity(options: ActivityOptions): Promise<void> {
  const { signal, intervalMs = INTERVAL_MS } = options;
  const timer = { signal, ref: false };
  while (!signal.aborted) {
    try {
      if (await options.busy()) await options.report();
    } catch (error) {
      options.warn(`reporting activity to the relay: ${String(error)}`);
    }
    await sleep(intervalMs, undefined, timer).catch(() => null);
  }
}
