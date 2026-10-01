import { useSyncExternalStore } from "react";
import type { InstalledPlugin } from "@bb/server-contract";
import { pluginIconUrl } from "@/hooks/queries/plugin-settings-queries";

interface PluginLogoUrls {
  displayName: string;
  icon: string | null;
  compactIconUrl: string | null;
}

let logoUrls: ReadonlyMap<string, PluginLogoUrls> = new Map();
const listeners = new Set<() => void>();

export function setPluginBranding(plugins: readonly InstalledPlugin[]): void {
  logoUrls = new Map(
    plugins.map((plugin) => {
      const compactIconUrl = pluginIconUrl(plugin.icon);
      return [
        plugin.id,
        {
          displayName: plugin.name,
          icon: compactIconUrl === null ? plugin.icon : null,
          compactIconUrl,
        },
      ];
    }),
  );
  for (const listener of listeners) listener();
}

function subscribePluginLogos(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getPluginLogoUrls(): ReadonlyMap<string, PluginLogoUrls> {
  return logoUrls;
}

export function getPluginDisplayName(pluginId: string): string {
  return getPluginLogoUrls().get(pluginId)?.displayName ?? pluginId;
}

export function usePluginCompactBranding(
  pluginId: string,
): Pick<PluginLogoUrls, "icon" | "compactIconUrl"> | null {
  const entries = useSyncExternalStore(
    subscribePluginLogos,
    getPluginLogoUrls,
    getPluginLogoUrls,
  );
  const branding = entries.get(pluginId);
  return branding === undefined
    ? null
    : { icon: branding.icon, compactIconUrl: branding.compactIconUrl };
}

export function usePluginDisplayName(pluginId: string): string {
  const entries = useSyncExternalStore(
    subscribePluginLogos,
    getPluginLogoUrls,
    getPluginLogoUrls,
  );
  return entries.get(pluginId)?.displayName ?? pluginId;
}
