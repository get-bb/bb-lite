import type { QueryClient } from "@tanstack/react-query";
import {
  pluginListQueryOptions,
  type PluginSettingsView,
} from "../queries/plugin-settings-queries";
import {
  allPluginListQueryKeyPrefix,
  pluginListQueryKey,
  pluginSettingsViewQueryKey,
} from "../queries/query-keys";

export function applyPluginSettingsView(args: {
  queryClient: QueryClient;
  pluginId: string;
  view: PluginSettingsView;
}): void {
  args.queryClient.setQueryData(
    pluginSettingsViewQueryKey(args.pluginId),
    args.view,
  );
}

export function invalidatePluginList(args: {
  queryClient: QueryClient;
}): Promise<void> {
  return args.queryClient.invalidateQueries({
    queryKey: allPluginListQueryKeyPrefix(),
  });
}

export async function markEnabledPluginListStale(args: {
  queryClient: QueryClient;
}): Promise<void> {
  const queryKey = pluginListQueryKey(true);
  if (args.queryClient.getQueryState(queryKey)?.fetchStatus === "fetching") {
    try {
      await args.queryClient.fetchQuery(
        pluginListQueryOptions({ enabled: true }),
      );
    } catch {}
  }
  await args.queryClient.invalidateQueries({
    exact: true,
    queryKey,
    refetchType: "none",
  });
}
