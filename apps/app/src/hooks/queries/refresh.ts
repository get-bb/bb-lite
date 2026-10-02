import type {
  QueryClient,
  QueryFilters,
  QueryKey,
} from "@tanstack/react-query";

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

export const ANY = "*";
const SOON: RefreshTiming = { delay: 50, gap: 0 };
export const STREAM: RefreshTiming = { delay: 0, gap: 200 };
const slots = new Map<string, Slot>();

export function filterFor(queryKey: QueryKey): QueryFilters {
  if (!queryKey.includes(ANY)) return { queryKey };
  const matches = (key: QueryKey) =>
    queryKey.every((part, index) => part === ANY || part === key[index]);
  return { predicate: (query) => matches(query.queryKey) };
}

async function run(slot: Slot): Promise<void> {
  const { client } = slot;
  const filter = filterFor(slot.queryKey);
  slot.timer = null;
  slot.pending = false;
  slot.running = true;
  slot.last = Date.now();
  const joined = client.isFetching(filter) > 0;
  await client.invalidateQueries(filter, { cancelRefetch: false });
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
  const slot = slots.get(id) ?? {
    client,
    last: 0,
    pending: false,
    queryKey,
    running: false,
    timer: null,
    timing,
  };
  slot.timing = timing;
  slots.set(id, slot);
  schedule(slot);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    for (const slot of slots.values()) if (slot.pending) schedule(slot);
  });
}
