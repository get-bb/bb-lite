import {
  shell,
  type ShellProvider,
  type ShellThreadListProps,
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

export const BUNDLED_THREAD_LIST_PROVIDER = "thread-list/thread-list";

export const threadListProviderAtom = createSyncedPreferenceAtom(
  "sidebar.threadListProvider",
);

export function useThreadListReplacement(): ResolvedProvider<
  Owned<ShellProvider<ShellThreadListProps>>
> {
  const threadLists = useOwned(shell.threadList);
  const preference = useAtomValue(threadListProviderAtom);
  const settled = usePluginsSettled();
  return resolveProvider(threadLists, preference, {
    bundled: BUNDLED_THREAD_LIST_PROVIDER,
    settled,
  });
}
