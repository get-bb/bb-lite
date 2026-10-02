import { useEffect } from "react";
import { atom, getDefaultStore, type PrimitiveAtom } from "jotai";
import {
  getUiPreferenceDefault,
  type UiPreferenceEntries,
  type UiPreferenceKey,
  type UiPreferenceValue,
} from "@bb/domain";
import { appToast } from "@/components/ui/app-toast";
import {
  getCachedUiPreferences,
  invalidateCachedUiPreferences,
  setCachedUiPreferences,
} from "@/hooks/cache-owners/ui-preferences-cache-owner";
import { useUiPreferences } from "@/hooks/queries/system-queries";
import { appQueryClient } from "./app-query-client";
import { sdk } from "./sdk";

const valueAtoms = new Map<UiPreferenceKey, PrimitiveAtom<unknown>>();
const pendingWrites = new Map<UiPreferenceKey, number>();
let writeQueue: Promise<void> = Promise.resolve();
let syncFailureNotified = false;

function reconcile(preferences: UiPreferenceEntries): void {
  const store = getDefaultStore();
  for (const [key, valueAtom] of valueAtoms) {
    const { value } = preferences[key];
    if (
      !pendingWrites.has(key) &&
      JSON.stringify(store.get(valueAtom)) !== JSON.stringify(value)
    ) {
      store.set(valueAtom, value);
    }
  }
}

async function write<Key extends UiPreferenceKey>(
  key: Key,
  value: UiPreferenceValue<Key>,
): Promise<void> {
  try {
    const current =
      getCachedUiPreferences(appQueryClient) ??
      (await sdk.system.uiPreferences.list());
    const { revision } = await sdk.system.uiPreferences.set({
      expectedRevision: current.preferences[key].revision,
      key,
      value,
    });
    const preferences =
      getCachedUiPreferences(appQueryClient)?.preferences ??
      current.preferences;
    setCachedUiPreferences(appQueryClient, {
      preferences: { ...preferences, [key]: { revision, value } },
    });
  } catch (error) {
    invalidateCachedUiPreferences(appQueryClient);
    if (syncFailureNotified) return;
    syncFailureNotified = true;
    appToast.error("Couldn’t sync sidebar preferences", {
      description:
        error instanceof Error ? error.message : "Changes stay on this device.",
    });
  }
}

export function createSyncedPreferenceAtom<Key extends UiPreferenceKey>(
  key: Key,
) {
  const valueAtom = atom(getUiPreferenceDefault(key));
  valueAtoms.set(key, valueAtom as PrimitiveAtom<unknown>);
  return atom(
    (get) => get(valueAtom),
    (_get, set, value: UiPreferenceValue<Key>) => {
      set(valueAtom, value);
      pendingWrites.set(key, (pendingWrites.get(key) ?? 0) + 1);
      writeQueue = writeQueue
        .then(() => write(key, value))
        .then(() => {
          const remaining = (pendingWrites.get(key) ?? 1) - 1;
          if (remaining > 0) pendingWrites.set(key, remaining);
          else pendingWrites.delete(key);
          const cached = getCachedUiPreferences(appQueryClient);
          if (cached !== undefined) reconcile(cached.preferences);
        });
    },
  );
}

export function UiPreferencesSync() {
  const { data } = useUiPreferences();
  useEffect(() => {
    if (data !== undefined) reconcile(data.preferences);
  }, [data]);
  return null;
}
