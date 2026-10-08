import { useSyncExternalStore } from "react";
import {
  createKernel,
  shell,
  type Caller,
  type Kernel,
  type Op,
  type PluginScope,
  type PluginVerbs,
  type Slot,
  type SlotEntryView,
  type Tier,
} from "@bb/plugin/app";
import type {
  PluginAppApi,
  PluginAppDefinition,
  PluginCommandRegistration,
  PluginComponentRegistration,
  PluginMessageDirectiveProps,
  PluginNavPanelRegistration,
  PluginPendingInteractionProps,
  PluginProviderRegistration,
  PluginSettingsSectionRegistration,
  PluginThreadListProps,
  PluginThreadPanelRegistration,
  SidebarHeaderProps,
  SidebarNavigationProps,
} from "@bb/plugin/app";
import { callRemoteOp } from "./ops";

export interface PluginRegistrations {
  navPanels: PluginNavPanelRegistration[];
  threadPanels: PluginThreadPanelRegistration[];
  settingsSections: PluginSettingsSectionRegistration[];
  appOverlays: PluginComponentRegistration[];
  pendingInteractions: PluginComponentRegistration<PluginPendingInteractionProps>[];
  messageDirectives: PluginComponentRegistration<PluginMessageDirectiveProps>[];
  threadLists: PluginProviderRegistration<PluginThreadListProps>[];
  sidebarNavigations: PluginProviderRegistration<SidebarNavigationProps>[];
  sidebarHeaders: PluginProviderRegistration<SidebarHeaderProps>[];
  commands: PluginCommandRegistration[];
}

type SlotKind = keyof PluginRegistrations;

export type PluginSlot<Kind extends SlotKind> =
  PluginRegistrations[Kind][number] & {
    pluginId: string;
    generation: number;
  };

export type PluginSlots = {
  readonly [Kind in SlotKind]: readonly PluginSlot<Kind>[];
};

const SLOT_DEFS = {
  navPanels: shell.navPanel,
  threadPanels: shell.threadPanel,
  settingsSections: shell.settingsSection,
  appOverlays: shell.appOverlay,
  pendingInteractions: shell.pendingInteraction,
  messageDirectives: shell.messageDirective,
  threadLists: shell.threadList,
  sidebarNavigations: shell.sidebarNavigation,
  sidebarHeaders: shell.sidebarHeader,
  commands: shell.command,
} as const;

const SLOT_KINDS = Object.keys(SLOT_DEFS) as SlotKind[];

const SLOT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function isPluginAppDefinition(
  value: unknown,
): value is PluginAppDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    "__bbPluginApp" in value &&
    value.__bbPluginApp === true &&
    "setup" in value &&
    typeof value.setup === "function"
  );
}

function slotRecord<Slots>(listFor: (kind: SlotKind) => object[]): Slots {
  const record: object = Object.fromEntries(
    SLOT_KINDS.map((kind) => [kind, listFor(kind)]),
  );
  return record as Slots;
}

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

function collect(
  definition: PluginAppDefinition,
  verbs: PluginVerbs,
  pluginId: string,
): PluginRegistrations {
  const collected = slotRecord<PluginRegistrations>(() => []);
  const add =
    <Kind extends SlotKind>(
      kind: Kind,
      slot: string,
      body: "component" | "run" = "component",
    ) =>
    (registration: PluginRegistrations[Kind][number]): void => {
      const id: unknown = registration?.id;
      if (typeof id !== "string" || !SLOT_ID_PATTERN.test(id)) {
        throw new Error(`${slot}: "id" must match ${SLOT_ID_PATTERN}`);
      }
      const list: { id: string }[] = collected[kind];
      if (list.some((existing) => existing.id === id)) {
        throw new Error(`${slot}: duplicate id "${id}"`);
      }
      const value: unknown = Reflect.get(registration, body);
      if (
        typeof value !== "function" &&
        (body === "run" || typeof value !== "object" || value === null)
      ) {
        throw new Error(`${slot} "${id}": missing ${body}`);
      }
      list.push({ ...registration });
    };
  let mounts = 0;
  const app: PluginAppApi = {
    ...verbs,
    call: ((op: Op, input: unknown) =>
      hasLocalOwner(op)
        ? verbs.call(op, input)
        : callRemoteOp(op.name, input)) as PluginVerbs["call"],
    pluginId,
    slots: {
      navPanel: add("navPanels", "navPanel"),
      threadPanel: add("threadPanels", "threadPanel"),
      settingsSection: add("settingsSections", "settingsSection"),
      appOverlay: add("appOverlays", "appOverlay"),
      pendingInteraction: add("pendingInteractions", "pendingInteraction"),
      messageDirective: add("messageDirectives", "messageDirective"),
      threadList: add("threadLists", "threadList"),
      sidebarNavigation: add("sidebarNavigations", "sidebarNavigation"),
      sidebarHeader: add("sidebarHeaders", "sidebarHeader"),
    },
    commands: { register: add("commands", "commands.register", "run") },
    onMount(run) {
      mounts += 1;
      verbs.add(shell.mount, { id: `mount-${mounts}`, run });
    },
  };
  definition.setup(app);
  return collected;
}

export function collectPluginApp(
  definition: PluginAppDefinition,
): PluginRegistrations {
  const { dispose, ...verbs } = newKernel().scope("collect", "product");
  try {
    return collect(definition, verbs, "collect");
  } finally {
    dispose();
  }
}

const EMPTY_SLOTS = slotRecord<PluginSlots>(() => []);

const scopes = new Map<string, PluginScope>();
const generationByPluginId = new Map<string, number>();
const crashedSlotKeys = new Set<string>();
const listeners = new Set<() => void>();
let snapshot = EMPTY_SLOTS;
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

function publish(): void {
  const next = { ...snapshot };
  for (const kind of SLOT_KINDS) {
    const definition: Slot<{ pluginId: string }> = SLOT_DEFS[kind];
    const owned = kernel.read(definition);
    const slots = byPlugin<unknown>(owned, (slot) => {
      return (slot as { pluginId: string }).pluginId;
    });
    const previous: readonly unknown[] = snapshot[kind];
    if (
      slots.length !== previous.length ||
      slots.some((slot, index) => slot !== previous[index])
    ) {
      Object.assign(next, { [kind]: slots });
    }
  }
  snapshot = next;
  notify();
}

interface SortedSlot {
  version: number;
  views: SlotEntryView<unknown>[];
  items: unknown[];
}

const sortedSlots = new Map<string, SortedSlot>();

function sortedSlot(slot: Slot<unknown>): SortedSlot {
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
    : { version, views, items: views.map(({ item }) => item) };
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

export function watchSlots(listener: () => void): () => void {
  return kernel.watch(listener);
}

export function registerPluginApp(
  pluginId: string,
  definition: PluginAppDefinition,
  tier: Tier = "product",
): Error | null {
  scopes.get(pluginId)?.dispose();
  scopes.delete(pluginId);
  const scope = kernel.scope(pluginId, tier);
  const { dispose, ...verbs } = scope;
  let collected: PluginRegistrations;
  try {
    collected = collect(definition, verbs, pluginId);
  } catch (error) {
    console.warn(`[plugin:${pluginId}] app registration failed`, error);
    dispose();
    publish();
    return error instanceof Error ? error : new Error(String(error));
  }
  const generation = (generationByPluginId.get(pluginId) ?? 0) + 1;
  generationByPluginId.set(pluginId, generation);
  for (const kind of SLOT_KINDS) {
    const definitionOf: Slot<object> = SLOT_DEFS[kind];
    for (const registration of collected[kind]) {
      scope.add(definitionOf, { ...registration, pluginId, generation });
    }
  }
  scopes.set(pluginId, scope);
  resetCrashedSlots(pluginId);
  publish();
  return null;
}

export function unregisterPluginApp(pluginId: string): void {
  const scope = scopes.get(pluginId);
  if (scope === undefined) return;
  scope.dispose();
  scopes.delete(pluginId);
  publish();
}

export function markPluginsSettled(): void {
  settled = true;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function getPluginSlots(): PluginSlots {
  return snapshot;
}

export function usePluginSlots(): PluginSlots {
  return useSyncExternalStore(subscribe, getPluginSlots);
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
  | { status: "ok"; slot: PluginSlot<"messageDirectives"> }
  | { status: "collision"; pluginIds: readonly string[] };

export function resolveMessageDirectives(
  slots: PluginSlots["messageDirectives"],
): ReadonlyMap<string, ResolvedMessageDirective> {
  const claimants = new Map<string, PluginSlot<"messageDirectives">[]>();
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
  kernel = newKernel();
  scopes.clear();
  sortedSlots.clear();
  generationByPluginId.clear();
  crashedSlotKeys.clear();
  settled = false;
  snapshot = EMPTY_SLOTS;
}
