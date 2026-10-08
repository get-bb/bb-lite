import { registerIcons } from "@bb/shared-ui/icon";
import { useSyncExternalStore } from "react";
import {
  app,
  createKernel,
  type Caller,
  type Kernel,
  type MessageDirective,
  type Op,
  type PluginAppApi,
  type PluginAppEntry,
  type PluginScope,
  type PluginVerbs,
  type Slot,
  type SlotEntryView,
  type Stop,
  type Tier,
} from "@bb/plugin/app";
import { callRemoteOp } from "./ops";

export type Owned<Item> = Item & { pluginId: string };

const APP_CALLER: Caller = {
  user: null,
  role: "member",
  door: "app",
  thread: null,
  via: [],
};

function newKernel(): Kernel {
  return createKernel({
    currentCaller: () => APP_CALLER,
    enter: (_caller, work) => work(),
    record: () => {},
    now: Date.now,
    warn: (message, fields) => console.warn(`[plugin] ${message}`, fields),
  });
}

let kernel = newKernel();

export function appKernel(): Kernel {
  return kernel;
}

function hasLocalOwner(op: Op): boolean {
  return kernel
    .ops()
    .some((entry) => entry.op.name === op.name && entry.owner !== null);
}

export function callOp(op: Op, input: unknown): Promise<unknown> {
  if (hasLocalOwner(op)) return kernel.call(op, input);
  return callRemoteOp(op.name, input);
}

interface Running {
  scope: PluginScope;
  stops: Stop[];
  starters: Parameters<PluginAppApi["onStart"]>[0][];
}

const running = new Map<string, Running>();
const crashedSlotKeys = new Set<string>();
const listeners = new Set<() => void>();
let settled = false;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function byPlugin<Entry>(
  entries: readonly Entry[],
  pluginOf: (entry: Entry) => string,
): Entry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        pluginOf(a.entry).localeCompare(pluginOf(b.entry)) || a.index - b.index,
    )
    .map(({ entry }) => entry);
}

interface SortedSlot {
  version: number;
  views: SlotEntryView<unknown>[];
  items: unknown[];
  owned: unknown[] | null;
}

const sortedSlots = new Map<string, SortedSlot>();

function sortedSlot<Item>(slot: Slot<Item>): SortedSlot {
  const version = kernel.version();
  const cached = sortedSlots.get(slot.name);
  if (cached?.version === version) return cached;
  const entries = kernel.entries(slot);
  const views = byPlugin(entries, ({ plugin }) => plugin);
  const unchanged =
    cached !== undefined &&
    cached.views.length === views.length &&
    views.every((view, index) => view === cached.views[index]);
  const sorted = unchanged
    ? { ...cached, version }
    : { version, views, items: views.map(({ item }) => item), owned: null };
  sortedSlots.set(slot.name, sorted);
  return sorted;
}

export function slotEntries<Item>(
  slot: Slot<Item>,
): readonly SlotEntryView<Item>[] {
  const { views } = sortedSlot(slot);
  return views as SlotEntryView<Item>[];
}

export function slotItems<Item>(slot: Slot<Item>): readonly Item[] {
  return sortedSlot(slot).items as Item[];
}

export function ownedItems<Item extends object>(
  slot: Slot<Item>,
): readonly Owned<Item>[] {
  const sorted = sortedSlot(slot);
  sorted.owned ??= sorted.views.map(({ plugin, item }) => ({
    ...(item as object),
    pluginId: plugin,
  }));
  return sorted.owned as Owned<Item>[];
}

export function watchSlots(listener: () => void): () => void {
  return kernel.watch(listener);
}

function logger(pluginId: string): PluginAppApi["log"] {
  const tag = `[plugin:${pluginId}]`;
  return {
    debug: (message, fields) => console.debug(tag, message, fields ?? ""),
    info: (message, fields) => console.info(tag, message, fields ?? ""),
    warn: (message, fields) => console.warn(tag, message, fields ?? ""),
    error: (message, fields) => console.error(tag, message, fields ?? ""),
  };
}

function start(pluginId: string, entry: Running): void {
  for (const begin of entry.starters.splice(0)) {
    Promise.resolve()
      .then(begin)
      .then((stop) => {
        if (typeof stop !== "function") return;
        if (running.get(pluginId) === entry) entry.stops.push(stop);
        else void stop();
      })
      .catch((error: unknown) => {
        console.warn(`[plugin:${pluginId}] onStart failed`, error);
      });
  }
}

function stop(pluginId: string): void {
  const entry = running.get(pluginId);
  if (entry === undefined) return;
  running.delete(pluginId);
  for (const end of entry.stops.splice(0).reverse()) {
    Promise.resolve()
      .then(end)
      .catch((error: unknown) => {
        console.warn(`[plugin:${pluginId}] onDispose failed`, error);
      });
  }
  entry.scope.dispose();
}

let iconsVersion = -1;

function syncIcons(): void {
  if (iconsVersion === kernel.version()) return;
  iconsVersion = kernel.version();
  const icons = kernel.read(app.icon).map(({ name, view }) => [name, view]);
  registerIcons(Object.fromEntries(icons));
}

export function registerPluginApp(
  pluginId: string,
  setup: PluginAppEntry,
  tier: Tier = "product",
): Error | null {
  stop(pluginId);
  const scope = kernel.scope(pluginId, tier);
  const { dispose: _, ...verbs } = scope;
  const entry: Running = { scope, stops: [], starters: [] };
  const call = (op: Op, input: unknown) =>
    hasLocalOwner(op) ? verbs.call(op, input) : callRemoteOp(op.name, input);
  const bb: PluginAppApi = {
    ...verbs,
    call: call as PluginVerbs["call"],
    pluginId,
    log: logger(pluginId),
    onStart: (begin) => void entry.starters.push(begin),
    onDispose: (end) => void entry.stops.push(end),
  };
  try {
    setup(bb);
  } catch (error) {
    console.warn(`[plugin:${pluginId}] app registration failed`, error);
    scope.dispose();
    notify();
    return error instanceof Error ? error : new Error(String(error));
  }
  running.set(pluginId, entry);
  resetCrashedSlots(pluginId);
  syncIcons();
  if (settled) start(pluginId, entry);
  notify();
  return null;
}

export function unregisterPluginApp(pluginId: string): void {
  if (!running.has(pluginId)) return;
  stop(pluginId);
  notify();
}

export function markPluginsSettled(): void {
  settled = true;
  for (const [pluginId, entry] of running) start(pluginId, entry);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function usePluginsSettled(): boolean {
  return useSyncExternalStore(subscribe, () => settled);
}

export function slotInstanceKey(...parts: (string | undefined)[]): string {
  return parts.filter((part) => part !== undefined).join("/");
}

export function markSlotCrashed(instanceKey: string): void {
  crashedSlotKeys.add(instanceKey);
}

export function isSlotCrashed(instanceKey: string): boolean {
  return crashedSlotKeys.has(instanceKey);
}

export function resetCrashedSlots(pluginId: string): void {
  for (const key of [...crashedSlotKeys]) {
    if (key.startsWith(`${pluginId}/`)) crashedSlotKeys.delete(key);
  }
}

export const AUTOMATIC_PROVIDER = "__automatic__";
export const NO_PROVIDER = "__builtin__";

interface ProviderIdentity {
  pluginId: string;
  id: string;
}

export function providerKey(slot: ProviderIdentity): string {
  return `${slot.pluginId}/${slot.id}`;
}

export function findAutomaticProvider<Slot extends ProviderIdentity>(
  slots: readonly Slot[],
  bundled?: string,
): Slot | undefined {
  return slots.find((slot) => providerKey(slot) !== bundled) ?? slots[0];
}

export type ResolvedProvider<Slot> =
  | { kind: "plugin"; slot: Slot }
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "missing" };

export function resolveProvider<Slot extends ProviderIdentity>(
  slots: readonly Slot[],
  preference: string,
  options: { bundled?: string; settled: boolean },
): ResolvedProvider<Slot> {
  if (preference === NO_PROVIDER) return { kind: "none" };
  const preferred =
    preference === AUTOMATIC_PROVIDER
      ? findAutomaticProvider(slots, options.bundled)
      : slots.find((slot) => providerKey(slot) === preference);
  if (preferred !== undefined) return { kind: "plugin", slot: preferred };
  if (!options.settled) return { kind: "loading" };
  const fallback = slots.find((slot) => providerKey(slot) === options.bundled);
  return fallback === undefined
    ? { kind: "missing" }
    : { kind: "plugin", slot: fallback };
}

export type ResolvedMessageDirective =
  | { status: "ok"; slot: Owned<MessageDirective> }
  | { status: "collision"; pluginIds: readonly string[] };

export function resolveMessageDirectives(
  slots: readonly Owned<MessageDirective>[],
): ReadonlyMap<string, ResolvedMessageDirective> {
  const claimants = new Map<string, Owned<MessageDirective>[]>();
  for (const slot of slots) {
    claimants.set(slot.id, [...(claimants.get(slot.id) ?? []), slot]);
  }
  const resolved = new Map<string, ResolvedMessageDirective>();
  for (const [id, [first, ...rest]] of claimants) {
    if (first === undefined) continue;
    resolved.set(
      id,
      rest.length === 0
        ? { status: "ok", slot: first }
        : {
            status: "collision",
            pluginIds: [
              ...new Set([first, ...rest].map((slot) => slot.pluginId)),
            ].sort(),
          },
    );
  }
  return resolved;
}

export function resetPluginRegistryForTest(): void {
  for (const pluginId of [...running.keys()]) stop(pluginId);
  kernel = newKernel();
  sortedSlots.clear();
  crashedSlotKeys.clear();
  settled = false;
  iconsVersion = -1;
}
