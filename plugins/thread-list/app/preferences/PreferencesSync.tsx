import { useEffect } from "react";
import { useAtomValue, useStore } from "jotai";
import { usePluginId, useRealtime, useRpc } from "@bb/plugin/app";
import type { threadListRpcContract } from "../../server.js";
import { PREFERENCES_CHANGED_CHANNEL } from "../../shared/preferences.js";
import {
  applyRemotePreferenceSignal,
  attachPreferencesStore,
  hydratePreferences,
  hydratePreferencesFromMirror,
  preferencesReadyAtom,
} from "./preferences-sync.js";

export function usePreferencesReady(): boolean {
  return useAtomValue(preferencesReadyAtom());
}

export function PreferencesSync() {
  const rpc = useRpc<typeof threadListRpcContract>();
  const store = useStore();
  const pluginId = usePluginId();
  useEffect(() => {
    attachPreferencesStore(store, pluginId);
    hydratePreferencesFromMirror();
    void hydratePreferences(rpc).catch((error: unknown) => {
      console.warn(
        `${pluginId}: loading preferences failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, [pluginId, rpc, store]);
  useRealtime(PREFERENCES_CHANGED_CHANNEL, applyRemotePreferenceSignal);
  return null;
}
