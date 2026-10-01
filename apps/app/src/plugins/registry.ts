import { useSyncExternalStore } from "react";
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

const SLOT_KINDS: readonly SlotKind[] = [
  "navPanels",
  "threadPanels",
  "settingsSections",
  "appOverlays",
  "pendingInteractions",
  "messageDirectives",
  "threadLists",
  "sidebarNavigations",
  "sidebarHeaders",
  "commands",
];

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

export function collectPluginApp(
  definition: PluginAppDefinition,
): PluginRegistrations {
  const collected: PluginRegistrations = {
    navPanels: [],
    threadPanels: [],
    settingsSections: [],
    appOverlays: [],
    pendingInteractions: [],
    messageDirectives: [],
    threadLists: [],
    sidebarNavigations: [],
    sidebarHeaders: [],
    commands: [],
  };
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
  const app: PluginAppApi = {
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
  };
  definition.setup(app);
  return collected;
}

const EMPTY_SLOTS: PluginSlots = {
  navPanels: [],
  threadPanels: [],
  settingsSections: [],
  appOverlays: [],
  pendingInteractions: [],
  messageDirectives: [],
  threadLists: [],
  sidebarNavigations: [],
  sidebarHeaders: [],
  commands: [],
};

const slotsByPluginId = new Map<string, PluginSlots>();
const generationByPluginId = new Map<string, number>();
const crashedSlotKeys = new Set<string>();
const listeners = new Set<() => void>();
let snapshot = EMPTY_SLOTS;
let settled = false;

function publish(): void {
  const pluginIds = [...slotsByPluginId.keys()].sort();
  const next = { ...snapshot };
  for (const kind of SLOT_KINDS) {
    const slots: unknown[] = [];
    for (const pluginId of pluginIds) {
      slots.push(...(slotsByPluginId.get(pluginId)?.[kind] ?? []));
    }
    const previous: readonly unknown[] = snapshot[kind];
    if (
      slots.length !== previous.length ||
      slots.some((slot, index) => slot !== previous[index])
    ) {
      Object.assign(next, { [kind]: slots });
    }
  }
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

export function registerPluginApp(
  pluginId: string,
  definition: PluginAppDefinition,
): Error | null {
  let collected: PluginRegistrations;
  try {
    collected = collectPluginApp(definition);
  } catch (error) {
    console.warn(`[plugin:${pluginId}] app registration failed`, error);
    unregisterPluginApp(pluginId);
    return error instanceof Error ? error : new Error(String(error));
  }
  const generation = (generationByPluginId.get(pluginId) ?? 0) + 1;
  generationByPluginId.set(pluginId, generation);
  const stamped = { ...EMPTY_SLOTS };
  for (const kind of SLOT_KINDS) {
    Object.assign(stamped, {
      [kind]: collected[kind].map((registration) => ({
        ...registration,
        pluginId,
        generation,
      })),
    });
  }
  slotsByPluginId.set(pluginId, stamped);
  resetCrashedSlots(pluginId);
  publish();
  return null;
}

export function unregisterPluginApp(pluginId: string): void {
  if (slotsByPluginId.delete(pluginId)) publish();
}

export function markPluginsSettled(): void {
  if (settled) return;
  settled = true;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPluginSlots(): PluginSlots {
  return snapshot;
}

export function usePluginSlots(): PluginSlots {
  return useSyncExternalStore(subscribe, getPluginSlots, getPluginSlots);
}

function getSettled(): boolean {
  return settled;
}

export function usePluginsSettled(): boolean {
  return useSyncExternalStore(subscribe, getSettled, getSettled);
}

export function slotInstanceKey(
  pluginId: string,
  slotKind: string,
  slotId: string,
  instanceId?: string,
): string {
  const base = `${pluginId}/${slotKind}/${slotId}`;
  return instanceId === undefined ? base : `${base}/${instanceId}`;
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
  slotsByPluginId.clear();
  generationByPluginId.clear();
  crashedSlotKeys.clear();
  settled = false;
  snapshot = EMPTY_SLOTS;
}
