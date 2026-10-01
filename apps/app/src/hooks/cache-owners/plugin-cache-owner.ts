import type { QueryClient } from "@tanstack/react-query";
import type { PluginSettingsView } from "../queries/plugin-settings-queries";
import {
  allPluginListQueryKeyPrefix,
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
