import { useAtomValue } from "jotai";
import { createSyncedPreferenceAtom } from "../../lib/ui-preferences";
import {
  resolveProvider,
  usePluginSlots,
  usePluginsSettled,
  type PluginSlot,
  type ResolvedProvider,
} from "../../plugins/registry";

export const sidebarHeaderProviderAtom = createSyncedPreferenceAtom(
  "sidebar.headerProvider",
);

export function useSidebarHeaderReplacement(): ResolvedProvider<
  PluginSlot<"sidebarHeaders">
> {
  const { sidebarHeaders } = usePluginSlots();
  const preference = useAtomValue(sidebarHeaderProviderAtom);
  const settled = usePluginsSettled();
  return resolveProvider(sidebarHeaders, preference, { settled });
}
