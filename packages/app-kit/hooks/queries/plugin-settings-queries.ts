import type {
  InstalledPlugin,
  PluginSettingDescriptor,
  PluginSettingsResponse,
} from "@bb/server-contract";
import { pluginSettingsUpdateRequestSchema } from "@bb/server-contract";
import {
  queryOptions,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";
import { sdk } from "../../lib/sdk";
import { qk } from "./query-keys";

export interface PluginListItem {
  id: string;
  enabled: boolean;
  core: boolean;
  status: InstalledPlugin["status"];
  statusDetail: string | null;
  description: string;
  name: string;
  icon: string | null;
  compactIconUrl: string | null;
  hasSettings: boolean;
}

export type PluginSettingFieldDescriptor = PluginSettingDescriptor;

type PluginSettingsView = Pick<PluginSettingsResponse, "schema" | "values">;

export function pluginIconUrl(icon: string | null): string | null {
  return icon?.startsWith("/") ? icon : null;
}

function toPluginListItem(plugin: InstalledPlugin): PluginListItem {
  const compactIconUrl = pluginIconUrl(plugin.icon);
  return {
    id: plugin.id,
    enabled: plugin.enabled,
    core: plugin.core ?? false,
    status: plugin.status,
    statusDetail: plugin.statusMessage,
    description: plugin.description,
    name: plugin.name,
    icon: compactIconUrl === null ? plugin.icon : null,
    compactIconUrl,
    hasSettings: plugin.hasSettings,
  };
}

export async function updatePluginSettings(
  pluginId: string,
  values: Record<string, unknown>,
): Promise<PluginSettingsView> {
  const request = pluginSettingsUpdateRequestSchema.parse({ values });
  return sdk.plugins.updateSettings({ pluginId, values: request.values });
}

export async function setPluginEnabled(
  pluginId: string,
  enabled: boolean,
): Promise<void> {
  await (enabled ? sdk.plugins.enable : sdk.plugins.disable)({ pluginId });
}

export function applyPluginSettingsView(args: {
  queryClient: QueryClient;
  pluginId: string;
  view: PluginSettingsView;
}): void {
  const { pluginId, queryClient, view } = args;
  queryClient.setQueryData(qk.pluginSettings(pluginId), view);
}

export function invalidatePluginList(args: {
  queryClient: QueryClient;
}): Promise<void> {
  return args.queryClient.invalidateQueries({ queryKey: qk.pluginList() });
}

export function pluginListQueryOptions(args: { enabled: boolean }) {
  return queryOptions({
    queryKey: qk.pluginList(),
    queryFn: async ({ signal }) => (await sdk.plugins.list({ signal })).plugins,
    enabled: args.enabled,
    staleTime: 30_000,
  });
}

export function usePluginList(args: { enabled: boolean }) {
  return useQuery({
    ...pluginListQueryOptions(args),
    select: (plugins) => ({ plugins: plugins.map(toPluginListItem) }),
  });
}

export function usePluginSettingsView(
  pluginId: string,
  options: { enabled: boolean },
) {
  return useQuery({
    queryKey: qk.pluginSettings(pluginId),
    queryFn: (): Promise<PluginSettingsView | null> =>
      sdk.plugins.getSettings({ pluginId }).catch(() => null),
    enabled: options.enabled,
    staleTime: 30_000,
  });
}
