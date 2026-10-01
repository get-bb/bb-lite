import { jsonValueSchema, type JsonValue } from "@bb/domain";
import {
  installedPluginSchema,
  pluginRpcDiscoveryQuerySchema,
  pluginRpcDiscoveryResponseSchema,
  type PluginRpcDiscoveryQuery,
  type PublishedPluginRpcMethod,
  pluginSettingsResponseSchema,
  pluginSettingsUpdateRequestSchema,
  pluginTokenRequestSchema,
  pluginTokenResponseSchema,
  type InstalledPlugin,
  type PluginListResponse,
  type PluginSettingsResponse,
  type PluginTokenResponse,
} from "@bb/server-contract";
import { z } from "zod";
import type { CreateSdkAreaArgs } from "./common.js";

/**
 * A server older than `providerIds` (bb-app < 0.39) or `icons` answers with
 * the installed-plugin shape minus those fields. The contract keeps them
 * required — the server fills them once at its boundary — so the tolerance
 * lives here, on the response side only: the SDK never sends this shape, and a
 * default on the contract would leak into request bodies.
 */
const installedPluginResponseSchema = installedPluginSchema.extend({
  screenshots: installedPluginSchema.shape.screenshots.default([]),
  collections: installedPluginSchema.shape.collections.default([]),
  providerIds: z.array(z.string()).default([]),
  icons: z.record(z.string(), z.string()).default({}),
});
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

export interface PluginTokenArgs extends PluginIdArgs {
  rotate?: boolean;
}

export interface PluginRpcArgs<TOutput> extends PluginIdArgs {
  signal?: AbortSignal;
  input?: JsonValue;
  method: string;
  outputSchema: z.ZodType<TOutput>;
}

export interface PluginGetSettingsArgs extends PluginIdArgs {
  signal?: AbortSignal;
}

export interface PluginListArgs {
  signal?: AbortSignal;
}

export type PluginDisableResult = InstalledPlugin;
export type PluginEnableResult = InstalledPlugin;
export type PluginGetSettingsResult = PluginSettingsResponse;
export type PluginListResult = PluginListResponse;
export type PluginTokenResult = PluginTokenResponse;
export type PluginUpdateSettingsResult = PluginSettingsResponse;

export interface PluginsArea {
  experimental_discoverRpc(
    args?: PluginRpcDiscoveryQuery,
  ): Promise<PublishedPluginRpcMethod[]>;
  callRpc<TOutput>(args: PluginRpcArgs<TOutput>): Promise<TOutput>;
  disable(args: PluginIdArgs): Promise<PluginDisableResult>;
  enable(args: PluginIdArgs): Promise<PluginEnableResult>;
  getSettings(args: PluginGetSettingsArgs): Promise<PluginGetSettingsResult>;
  list(args?: PluginListArgs): Promise<PluginListResult>;
  token(args: PluginTokenArgs): Promise<PluginTokenResult>;
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
    async experimental_discoverRpc(input = {}) {
      const query = pluginRpcDiscoveryQuerySchema.parse(input);
      const params = new URLSearchParams();
      if (query.pluginId !== undefined) params.set("pluginId", query.pluginId);
      if (query.method !== undefined) params.set("method", query.method);
      return requestParsed(
        `/api/v1/plugins/rpc?${params}`,
        pluginRpcDiscoveryResponseSchema,
      );
    },
    async callRpc(input) {
      const envelope = await requestParsed(
        pluginPath(input.pluginId, `/rpc/${encodeURIComponent(input.method)}`),
        z.object({ ok: z.literal(true), result: jsonValueSchema }),
        { ...jsonInit("POST", input.input ?? null), signal: input.signal },
      );
      return input.outputSchema.parse(envelope.result);
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
    async token(input) {
      const body = pluginTokenRequestSchema.parse({
        rotate: input.rotate ?? false,
      });
      return requestParsed(
        pluginPath(input.pluginId, "/token"),
        pluginTokenResponseSchema,
        jsonInit("POST", body),
      );
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
