import {
  shell,
  type ShellProvider,
  type SidebarHeaderProps,
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

export const sidebarHeaderProviderAtom = createSyncedPreferenceAtom(
  "sidebar.headerProvider",
);

export function useSidebarHeaderReplacement(): ResolvedProvider<
  Owned<ShellProvider<SidebarHeaderProps>>
> {
  const sidebarHeaders = useOwned(shell.sidebarHeader);
  const preference = useAtomValue(sidebarHeaderProviderAtom);
  const settled = usePluginsSettled();
  return resolveProvider(sidebarHeaders, preference, { settled });
}
