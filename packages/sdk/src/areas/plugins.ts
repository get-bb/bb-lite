import { type JsonValue } from "@bb/domain";
import {
  installedPluginSchema,
  pluginContributionsResponseSchema,
  pluginSettingsResponseSchema,
  pluginSettingsUpdateRequestSchema,
  type InstalledPlugin,
  type PluginContributionsResponse,
  type PluginListResponse,
  type PluginSettingsResponse,
} from "@bb/server-contract";
import { z } from "zod";
import type { CreateSdkAreaArgs } from "./common.js";

const installedPluginResponseSchema = installedPluginSchema;
const pluginListResponseSchema = z.object({
  plugins: z.array(installedPluginResponseSchema),
});
const pluginInstallResponseSchema = z.object({
  ok: z.literal(true),
  plugin: installedPluginResponseSchema,
});

export const pluginMutationResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  plugin: installedPluginResponseSchema.optional(),
  plugins: z.array(installedPluginResponseSchema).optional(),
});
export type PluginMutationResponse = z.infer<
  typeof pluginMutationResponseSchema
>;

export interface PluginIdArgs {
  pluginId: string;
}

export interface PluginSettingsUpdateArgs extends PluginIdArgs {
  values: Record<string, JsonValue>;
}

export interface PluginGetSettingsArgs extends PluginIdArgs {
  signal?: AbortSignal;
}

export interface PluginListArgs {
  signal?: AbortSignal;
}

export interface PluginReloadArgs {
  pluginId?: string;
}

export type PluginDisableResult = InstalledPlugin;
export type PluginEnableResult = InstalledPlugin;
export type PluginGetSettingsResult = PluginSettingsResponse;
export type PluginListResult = PluginListResponse;
export type PluginUpdateSettingsResult = PluginSettingsResponse;

export interface PluginsArea {
  contributions(args?: PluginListArgs): Promise<PluginContributionsResponse>;
  reload(args?: PluginReloadArgs): Promise<PluginListResult>;
  disable(args: PluginIdArgs): Promise<PluginDisableResult>;
  enable(args: PluginIdArgs): Promise<PluginEnableResult>;
  getSettings(args: PluginGetSettingsArgs): Promise<PluginGetSettingsResult>;
  list(args?: PluginListArgs): Promise<PluginListResult>;
  updateSettings(
    args: PluginSettingsUpdateArgs,
  ): Promise<PluginUpdateSettingsResult>;
}

function pluginPath(pluginId: string, suffix = ""): string {
  const id = z.string().min(1).parse(pluginId);
  return `/api/v1/plugins/${encodeURIComponent(id)}${suffix}`;
}

export function createPluginsArea(args: CreateSdkAreaArgs): PluginsArea {
  const { transport } = args;

  async function requestParsed<TOutput>(
    path: string,
    schema: z.ZodType<TOutput>,
    init?: RequestInit,
  ): Promise<TOutput> {
    const url = transport.baseUrl
      ? `${transport.baseUrl.replace(/\/$/u, "")}${path}`
      : path;
    const response = await transport.resolve(transport.fetch(url, init));
    const json: unknown = await response.json();
    return schema.parse(json);
  }

  function jsonInit(method: "POST" | "PUT", body: unknown): RequestInit {
    return {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  return {
    async contributions(input = {}) {
      return requestParsed(
        "/api/v1/plugins/contributions",
        pluginContributionsResponseSchema,
        { signal: input.signal },
      );
    },
    async reload(input = {}) {
      const { pluginId } = input;
      const query =
        pluginId === undefined ? "" : `?id=${encodeURIComponent(pluginId)}`;
      return requestParsed(
        `/api/v1/plugins/reload${query}`,
        pluginListResponseSchema,
        jsonInit("POST", {}),
      );
    },
    async disable(input) {
      const response = await requestParsed(
        pluginPath(input.pluginId, "/disable"),
        pluginInstallResponseSchema,
        jsonInit("POST", {}),
      );
      return response.plugin;
    },
    async enable(input) {
      const response = await requestParsed(
        pluginPath(input.pluginId, "/enable"),
        pluginInstallResponseSchema,
        jsonInit("POST", {}),
      );
      return response.plugin;
    },
    async getSettings(input) {
      return requestParsed(
        pluginPath(input.pluginId, "/settings"),
        pluginSettingsResponseSchema,
        { signal: input.signal },
      );
    },
    async list(input = {}) {
      return requestParsed("/api/v1/plugins", pluginListResponseSchema, {
        signal: input.signal,
      });
    },
    async updateSettings(input) {
      const body = pluginSettingsUpdateRequestSchema.parse({
        values: input.values,
      });
      return requestParsed(
        pluginPath(input.pluginId, "/settings"),
        pluginSettingsResponseSchema,
        jsonInit("PUT", body),
      );
    },
  };
}
