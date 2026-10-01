import type {
  InstalledPlugin,
  PluginSettingDescriptor,
  PluginSettingsResponse,
} from "@bb/server-contract";
import { pluginSettingsUpdateRequestSchema } from "@bb/server-contract";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { createPluginsClient } from "./plugin-client";
import { pluginListQueryKey, pluginSettingsViewQueryKey } from "./query-keys";

type FetchLike = typeof fetch;

export interface PluginListItem {
  id: string;
  enabled: boolean;
  status: InstalledPlugin["status"];
  statusDetail: string | null;
  description: string;
  name: string;
  icon: string | null;
  compactIconUrl: string | null;
  hasSettings: boolean;
}

export interface PluginListResult {
  plugins: PluginListItem[];
}

export function pluginIconUrl(icon: string | null): string | null {
  return icon?.startsWith("/") ? icon : null;
}

export function toPluginListItem(plugin: InstalledPlugin): PluginListItem {
  const compactIconUrl = pluginIconUrl(plugin.icon);
  return {
    id: plugin.id,
    enabled: plugin.enabled,
    status: plugin.status,
    statusDetail: plugin.statusMessage,
    description: plugin.description,
    name: plugin.name,
    icon: compactIconUrl === null ? plugin.icon : null,
    compactIconUrl,
    hasSettings: plugin.hasSettings,
  };
}

export async function fetchInstalledPlugins(
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<InstalledPlugin[]> {
  return (await createPluginsClient(fetchImpl).list({ signal })).plugins;
}

export type PluginSettingFieldDescriptor = PluginSettingDescriptor;

export interface PluginSettingsView {
  schema: Record<string, PluginSettingFieldDescriptor>;
  values: PluginSettingsResponse["values"];
}

async function fetchPluginSettingsView(
  fetchImpl: FetchLike,
  pluginId: string,
): Promise<PluginSettingsView | null> {
  try {
    const result = await createPluginsClient(fetchImpl).getSettings({
      pluginId,
    });
    return { schema: result.schema, values: result.values };
  } catch {
    return null;
  }
}

export async function updatePluginSettings(
  fetchImpl: FetchLike,
  pluginId: string,
  values: Record<string, unknown>,
): Promise<PluginSettingsView> {
  const request = pluginSettingsUpdateRequestSchema.parse({ values });
  const result = await createPluginsClient(fetchImpl).updateSettings({
    pluginId,
    values: request.values,
  });
  return { schema: result.schema, values: result.values };
}

export async function setPluginEnabled(
  fetchImpl: FetchLike,
  pluginId: string,
  enabled: boolean,
): Promise<void> {
  const plugins = createPluginsClient(fetchImpl);
  if (enabled) await plugins.enable({ pluginId });
  else await plugins.disable({ pluginId });
}

export function pluginListQueryOptions(args: { enabled: boolean }) {
  return queryOptions({
    queryKey: pluginListQueryKey(args.enabled),
    queryFn: ({ signal }) => fetchInstalledPlugins(fetch, signal),
    enabled: args.enabled,
    staleTime: 30_000,
  });
}

export function usePluginList(args: { enabled: boolean }) {
  return useQuery({
    ...pluginListQueryOptions(args),
    select: (plugins): PluginListResult => ({
      plugins: plugins.map(toPluginListItem),
    }),
  });
}

export function usePluginSettingsView(
  pluginId: string,
  options: { enabled: boolean },
) {
  return useQuery({
    queryKey: pluginSettingsViewQueryKey(pluginId),
    queryFn: () => fetchPluginSettingsView(fetch, pluginId),
    enabled: options.enabled,
    staleTime: 30_000,
  });
}
