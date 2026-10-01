import { useAtomValue } from "jotai";
import { createSyncedPreferenceAtom } from "@/lib/ui-preferences/synced-preference-atom";
import {
  resolveProvider,
  usePluginSlots,
  usePluginsSettled,
  type PluginSlot,
  type ResolvedProvider,
} from "@/plugins/registry";

export const BUNDLED_NAVIGATION_PROVIDER = "compact-nav/icons";

export const sidebarNavigationProviderAtom = createSyncedPreferenceAtom(
  "sidebar.navigationProvider",
);

export function useSidebarNavigationReplacement(): ResolvedProvider<
  PluginSlot<"sidebarNavigations">
> {
  const { sidebarNavigations } = usePluginSlots();
  const preference = useAtomValue(sidebarNavigationProviderAtom);
  const settled = usePluginsSettled();
  return resolveProvider(sidebarNavigations, preference, {
    bundled: BUNDLED_NAVIGATION_PROVIDER,
    settled,
  });
}
