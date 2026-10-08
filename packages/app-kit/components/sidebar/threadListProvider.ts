import { useAtomValue } from "jotai";
import { createSyncedPreferenceAtom } from "../../lib/ui-preferences";
import {
  resolveProvider,
  usePluginSlots,
  usePluginsSettled,
  type PluginSlot,
  type ResolvedProvider,
} from "../../plugins/registry";

export const BUNDLED_THREAD_LIST_PROVIDER = "thread-list/thread-list";

export const threadListProviderAtom = createSyncedPreferenceAtom(
  "sidebar.threadListProvider",
);

export function useThreadListReplacement(): ResolvedProvider<
  PluginSlot<"threadLists">
> {
  const { threadLists } = usePluginSlots();
  const preference = useAtomValue(threadListProviderAtom);
  const settled = usePluginsSettled();
  return resolveProvider(threadLists, preference, {
    bundled: BUNDLED_THREAD_LIST_PROVIDER,
    settled,
  });
}
