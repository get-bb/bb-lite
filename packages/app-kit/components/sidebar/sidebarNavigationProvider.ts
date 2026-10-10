import {
  shell,
  type ShellProvider,
  type SidebarNavigationProps,
} from "@bb/plugin/app";
import { useOwned } from "../../plugins/slots";
import { useAtomValue } from "jotai";
import { createSyncedPreferenceAtom } from "../../lib/ui-preferences";
import {
  resolveProvider,
  usePluginsSettled,
  type Owned,
  type ResolvedProvider,
} from "../../plugins/registry";

export const BUNDLED_NAVIGATION_PROVIDER = "navigation/navigation";

export const sidebarNavigationProviderAtom = createSyncedPreferenceAtom(
  "sidebar.navigationProvider",
);

export function useSidebarNavigationReplacement(): ResolvedProvider<
  Owned<ShellProvider<SidebarNavigationProps>>
> {
  const sidebarNavigations = useOwned(shell.sidebarNavigation);
  const preference = useAtomValue(sidebarNavigationProviderAtom);
  const settled = usePluginsSettled();
  return resolveProvider(sidebarNavigations, preference, {
    bundled: BUNDLED_NAVIGATION_PROVIDER,
    settled,
  });
}
