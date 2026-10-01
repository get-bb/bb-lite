import { useCallback, useSyncExternalStore } from "react";
import { parseNamespacedGlyph } from "@bb/domain";
import { setPluginAssetIcons } from "@bb/shared-ui/icon-registry";
import type { PluginListEntry } from "@/hooks/queries/plugin-settings-queries";

interface PluginLogoUrls {
  displayName: string | null;
  icon: string | null;
  compactIconUrl: string | null;
  icons: ReadonlyMap<string, string>;
}

let logoUrls: ReadonlyMap<string, PluginLogoUrls> = new Map();
const listeners = new Set<() => void>();

export function setPluginBranding(plugins: readonly PluginListEntry[]): void {
  const assetIcons = new Map<string, string>();
  logoUrls = new Map(
    plugins.map((plugin) => {
      const icons = new Map(Object.entries(plugin.icons ?? {}));
      for (const [name, url] of icons) {
        assetIcons.set(`${plugin.id}/${name}`, url);
      }
      return [
        plugin.id,
        {
          displayName: plugin.name,
          icon: plugin.icon,
          compactIconUrl: plugin.iconUrl ?? null,
          icons,
        },
      ];
    }),
  );
  setPluginAssetIcons(assetIcons);
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

export function usePluginIconUrl(
  glyph: string | undefined,
): string | undefined {
  const getSnapshot = useCallback(
    () => resolvePluginIconUrl(getPluginLogoUrls(), glyph),
    [glyph],
  );
  return useSyncExternalStore(subscribePluginLogos, getSnapshot, getSnapshot);
}

function resolvePluginIconUrl(
  entries: ReadonlyMap<string, Pick<PluginLogoUrls, "icons">>,
  glyph: string | undefined,
): string | undefined {
  const parsed = glyph === undefined ? null : parseNamespacedGlyph(glyph);
  if (parsed === null) {
    return undefined;
  }
  return entries.get(parsed.pluginId)?.icons.get(parsed.name);
}
