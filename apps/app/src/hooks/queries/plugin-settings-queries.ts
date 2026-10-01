import type {
  PluginSettingDescriptor,
  PluginSettingsResponse,
} from "@bb/server-contract";
import { pluginSettingsUpdateRequestSchema } from "@bb/server-contract";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { appSurfaceRequestInit } from "@/lib/app-surface";
import { createPluginsClient } from "./plugin-client";
import { pluginListQueryKey, pluginSettingsViewQueryKey } from "./query-keys";

type FetchLike = typeof fetch;

const pluginListEntrySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  iconUrl: z.string().nullable().optional(),
  icons: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean(),
  status: z.string(),
  statusMessage: z.string().nullable(),
  hasSettings: z.boolean(),
  app: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("builtin") }),
      z.object({
        kind: z.literal("external"),
        jsUrl: z.string(),
        cssUrl: z.string().nullable(),
        hash: z.string(),
      }),
    ])
    .nullable(),
});
export type PluginListEntry = z.infer<typeof pluginListEntrySchema>;

const pluginListResponseSchema = z.object({
  plugins: z.array(pluginListEntrySchema),
});

export interface PluginListItem {
  id: string;
  enabled: boolean;
  status: string;
  statusDetail: string | null;
  description: string | null;
  name: string | null;
  icon: string | null;
  compactIconUrl: string | null;
  hasSettings: boolean;
}

export interface PluginListResult {
  plugins: PluginListItem[];
}

export function toPluginListItem(plugin: PluginListEntry): PluginListItem {
  return {
    id: plugin.id,
    enabled: plugin.enabled,
    status: plugin.status,
    statusDetail: plugin.statusMessage,
    description: plugin.description,
    name: plugin.name,
    icon: plugin.icon,
    compactIconUrl: plugin.iconUrl ?? null,
    hasSettings: plugin.hasSettings,
  };
}

export async function fetchInstalledPlugins(
  signal?: AbortSignal,
): Promise<PluginListEntry[]> {
  const response = await fetch(
    "/api/v1/plugins",
    appSurfaceRequestInit({ signal }),
  );
  if (!response.ok) {
    throw new Error(`plugin list failed (HTTP ${response.status})`);
  }
  return pluginListResponseSchema.parse(await response.json()).plugins;
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
    queryFn: ({ signal }) => fetchInstalledPlugins(signal),
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
