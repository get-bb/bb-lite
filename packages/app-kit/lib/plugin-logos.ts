import { useSyncExternalStore } from "react";
import type { InstalledPlugin } from "@bb/server-contract";
import { pluginIconUrl } from "../hooks/queries/plugin-settings-queries";

interface PluginBranding {
  displayName: string;
  icon: string | null;
  compactIconUrl: string | null;
}

let branding: ReadonlyMap<string, PluginBranding> = new Map();
const listeners = new Set<() => void>();

export function setPluginBranding(plugins: readonly InstalledPlugin[]): void {
  branding = new Map(
    plugins.map((plugin) => {
      const compactIconUrl = pluginIconUrl(plugin.icon);
      const icon = compactIconUrl === null ? plugin.icon : null;
      return [plugin.id, { displayName: plugin.name, icon, compactIconUrl }];
    }),
  );
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function getPluginDisplayName(pluginId: string): string {
  return branding.get(pluginId)?.displayName ?? pluginId;
}

export function usePluginCompactBranding(
  pluginId: string,
): PluginBranding | null {
  return useSyncExternalStore(subscribe, () => branding.get(pluginId) ?? null);
}

export function usePluginDisplayName(pluginId: string): string {
  return usePluginCompactBranding(pluginId)?.displayName ?? pluginId;
}
