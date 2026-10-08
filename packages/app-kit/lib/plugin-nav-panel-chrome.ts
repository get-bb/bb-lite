import { useEffect, useMemo } from "react";
import { z } from "zod";
import { createLastKnownCache } from "./last-known-cache";
import {
  usePluginSlots,
  usePluginsSettled,
  type PluginSlot,
} from "../plugins/registry";

const chromeSchema = z.object({
  pluginId: z.string().min(1),
  id: z.string().min(1),
  path: z.string().min(1),
  title: z.string(),
  icon: z.string(),
});

export type PluginNavPanelChrome = z.infer<typeof chromeSchema>;

interface PluginNavPanelChromeEntry {
  chrome: PluginNavPanelChrome;
  panel: PluginSlot<"navPanels"> | null;
}

const chromeCache = createLastKnownCache({
  prefix: "bb.plugin-nav-panels",
  version: "1",
  schema: z.array(chromeSchema),
});
const CACHE_KEY = chromeCache.key("all");

const keyOf = (chrome: { pluginId: string; id: string }) =>
  `${chrome.pluginId}/${chrome.id}`;

export function usePluginNavPanelChrome(): PluginNavPanelChromeEntry[] {
  const settled = usePluginsSettled();
  const { navPanels } = usePluginSlots();
  return useMemo(() => {
    const live = navPanels.map((panel) => ({ chrome: panel, panel }));
    const remembered = settled ? [] : (chromeCache.read(CACHE_KEY) ?? []);
    const rememberedKeys = remembered.map(keyOf);
    return [
      ...remembered.map(
        (chrome): PluginNavPanelChromeEntry =>
          live.find((entry) => keyOf(entry.chrome) === keyOf(chrome)) ?? {
            chrome,
            panel: null,
          },
      ),
      ...live.filter((entry) => !rememberedKeys.includes(keyOf(entry.chrome))),
    ];
  }, [navPanels, settled]);
}

export function useRememberPluginNavPanelChrome(): void {
  const settled = usePluginsSettled();
  const { navPanels } = usePluginSlots();
  useEffect(() => {
    if (!settled) return;
    chromeCache.write(
      CACHE_KEY,
      navPanels.map(({ pluginId, id, path, title, icon }) => ({
        pluginId,
        id,
        path,
        title,
        icon,
      })),
    );
  }, [navPanels, settled]);
}
