import { useEffect } from "react";
import {
  atom,
  getDefaultStore,
  useAtomValue,
  useStore,
  type PrimitiveAtom,
  type SetStateAction,
  type WritableAtom,
} from "jotai";
import {
  usePluginId,
  useRealtime,
  useRpc,
  type PluginRpcClient,
} from "@bb/plugin/app";
import type { threadListRpcContract } from "../server.js";
import {
  parsePreferences,
  PREFERENCE_DEFAULTS,
  PREFERENCE_KEYS,
  PREFERENCES_CHANGED_CHANNEL,
  type PreferenceKey,
  type PreferenceValues,
} from "../shared/preferences.js";

const WRITE_DEBOUNCE_MS = 150;

type PreferencesRpc = PluginRpcClient<typeof threadListRpcContract>;

interface PendingWrite {
  timer: number | null;
  value: unknown;
}

const valueAtoms = new Map<PreferenceKey, PrimitiveAtom<unknown>>(
  PREFERENCE_KEYS.map((key) => [key, atom<unknown>(PREFERENCE_DEFAULTS[key])]),
);
const readyAtom = atom(false);
const pendingWrites = new Map<PreferenceKey, PendingWrite>();
let store = getDefaultStore();
let rpc: PreferencesRpc | null = null;
let pluginId: string | null = null;
let hydrateGeneration = 0;

function valueAtom<Key extends PreferenceKey>(
  key: Key,
): PrimitiveAtom<PreferenceValues[Key]> {
  return valueAtoms.get(key) as PrimitiveAtom<PreferenceValues[Key]>;
}

function mirrorStorage(): Storage | null {
  try {
    return pluginId === null || typeof window === "undefined"
      ? null
      : (window.localStorage ?? null);
  } catch {
    return null;
  }
}

function readMirror(): Partial<PreferenceValues> | null {
  try {
    const raw = mirrorStorage()?.getItem(`bb.${pluginId}.preferences.v1`);
    const parsed: unknown = raw == null ? null : JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? parsePreferences(parsed)
      : null;
  } catch {
    return null;
  }
}

function writeMirror(): void {
  const snapshot = Object.fromEntries(
    PREFERENCE_KEYS.map((key) => [key, store.get(valueAtom(key))]),
  );
  try {
    mirrorStorage()?.setItem(
      `bb.${pluginId}.preferences.v1`,
      JSON.stringify(snapshot),
    );
  } catch {
    return;
  }
}

function applyValues(values: Partial<PreferenceValues>): void {
  for (const key of PREFERENCE_KEYS) {
    const value = values[key];
    if (value === undefined || pendingWrites.has(key)) continue;
    store.set(valueAtoms.get(key) as PrimitiveAtom<unknown>, value);
  }
}

async function hydratePreferences(client: PreferencesRpc): Promise<void> {
  rpc = client;
  const generation = ++hydrateGeneration;
  const response: unknown = await client.call("listPreferences");
  if (generation !== hydrateGeneration) return;
  const preferences =
    typeof response === "object" && response !== null
      ? Reflect.get(response, "preferences")
      : undefined;
  applyValues({ ...PREFERENCE_DEFAULTS, ...parsePreferences(preferences) });
  writeMirror();
  store.set(readyAtom, true);
}

function applyRemotePreferenceSignal(payload: unknown): void {
  if (typeof payload !== "object" || payload === null) return;
  const key: unknown = Reflect.get(payload, "key");
  const values = parsePreferences({
    [String(key)]: Reflect.get(payload, "value"),
  });
  if (Object.keys(values).length === 0) return;
  applyValues(values);
  writeMirror();
}

function flushWrite(key: PreferenceKey): void {
  const pending = pendingWrites.get(key);
  if (pending === undefined) return;
  pending.timer = null;
  if (rpc === null) {
    pendingWrites.delete(key);
    return;
  }
  void rpc
    .call("setPreference", { key, value: pending.value })
    .catch((error: unknown) => {
      console.warn(
        `${pluginId}: saving preference ${key} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    })
    .finally(() => {
      if (pendingWrites.get(key) === pending && pending.timer === null) {
        pendingWrites.delete(key);
      }
    });
}

function schedulePreferenceWrite(key: PreferenceKey, value: unknown): void {
  writeMirror();
  let pending = pendingWrites.get(key);
  if (pending === undefined) {
    pending = { timer: null, value };
    pendingWrites.set(key, pending);
  }
  pending.value = value;
  if (pending.timer !== null) window.clearTimeout(pending.timer);
  pending.timer = window.setTimeout(() => flushWrite(key), WRITE_DEBOUNCE_MS);
}

function syncedPreferenceAtom<Key extends PreferenceKey>(
  key: Key,
): WritableAtom<
  PreferenceValues[Key],
  [SetStateAction<PreferenceValues[Key]>],
  void
> {
  return atom(
    (get) => get(valueAtom(key)),
    (get, set, update: SetStateAction<PreferenceValues[Key]>) => {
      const previous = get(valueAtom(key));
      const next = typeof update === "function" ? update(previous) : update;
      if (Object.is(next, previous)) return;
      set(valueAtom(key), next);
      schedulePreferenceWrite(key, next);
    },
  );
}

export const collapsedThreadIdsAtom = syncedPreferenceAtom("collapsedThreads");
export const collapsedSidebarSectionIdsAtom =
  syncedPreferenceAtom("collapsedSections");
export const sidebarManualSectionOrderAtom =
  syncedPreferenceAtom("manualSectionOrder");
export const sidebarChronologicalSortAtom =
  syncedPreferenceAtom("chronologicalSort");
export const sidebarSortDirectionAtom = syncedPreferenceAtom("sortDirection");
export const sidebarCollapsedThreadSectionsAtom = syncedPreferenceAtom(
  "collapsedThreadSections",
);
export const sidebarThreadLifecyclesAtom =
  syncedPreferenceAtom("threadLifecycles");
export const sidebarShowProviderIconsAtom =
  syncedPreferenceAtom("showProviderIcons");

export function usePreferencesReady(): boolean {
  return useAtomValue(readyAtom);
}

export function PreferencesSync() {
  const client = useRpc<typeof threadListRpcContract>();
  const jotaiStore = useStore();
  const id = usePluginId();
  useEffect(() => {
    store = jotaiStore;
    pluginId = id;
    const mirrored = readMirror();
    if (mirrored !== null) applyValues(mirrored);
    void hydratePreferences(client).catch((error: unknown) => {
      console.warn(
        `${id}: loading preferences failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, [client, id, jotaiStore]);
  useRealtime(PREFERENCES_CHANGED_CHANNEL, applyRemotePreferenceSignal);
  return null;
}
