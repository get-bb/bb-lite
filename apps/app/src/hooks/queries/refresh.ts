import type { QueryClient, QueryKey } from "@tanstack/react-query";

export interface RefreshTiming {
  delay: number;
  gap: number;
}

interface Slot {
  client: QueryClient;
  last: number;
  pending: boolean;
  queryKey: QueryKey;
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  timing: RefreshTiming;
}

const SOON: RefreshTiming = { delay: 50, gap: 0 };
export const STREAM: RefreshTiming = { delay: 0, gap: 200 };
const slots = new Map<string, Slot>();

async function run(slot: Slot): Promise<void> {
  const { client, queryKey } = slot;
  slot.timer = null;
  slot.pending = false;
  slot.running = true;
  slot.last = Date.now();
  const joined = client.isFetching({ queryKey }) > 0;
  await client.invalidateQueries({ queryKey }, { cancelRefetch: false });
  slot.running = false;
  if (joined || slot.pending) schedule(slot);
}

function schedule(slot: Slot): void {
  slot.pending = true;
  if (slot.running || slot.timer !== null || document.hidden) return;
  const wait = slot.last + slot.timing.gap - Date.now();
  slot.timer = setTimeout(
    () => void run(slot),
    Math.max(slot.timing.delay, wait),
  );
}

export function refresh(
  client: QueryClient,
  queryKey: QueryKey,
  timing: RefreshTiming = SOON,
): void {
  const id = JSON.stringify(queryKey);
  let slot = slots.get(id);
  if (slot === undefined) {
    slot = {
      client,
      last: 0,
      pending: false,
      queryKey,
      running: false,
      timer: null,
      timing,
    };
    slots.set(id, slot);
  }
  schedule(slot);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    for (const slot of slots.values()) if (slot.pending) schedule(slot);
  });
}
