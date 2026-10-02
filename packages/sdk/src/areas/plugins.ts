import type { JsonValue } from "@bb/domain";
import {
  installedPluginSchema,
  pluginContributionsResponseSchema,
  pluginListResponseSchema,
  pluginSettingsResponseSchema,
  pluginSettingsUpdateRequestSchema,
} from "@bb/server-contract";
import type * as api from "@bb/server-contract";
import { z } from "zod";
import type { Http } from "../http.js";

type Abortable = { signal?: AbortSignal };
type PluginTarget = { pluginId: string };

export interface PluginsArea {
  contributions(args?: Abortable): Promise<api.PluginContributionsResponse>;
  reload(args?: { pluginId?: string }): Promise<api.PluginListResponse>;
  disable(args: PluginTarget): Promise<api.InstalledPlugin>;
  enable(args: PluginTarget): Promise<api.InstalledPlugin>;
  getSettings(
    args: PluginTarget & Abortable,
  ): Promise<api.PluginSettingsResponse>;
  list(args?: Abortable): Promise<api.PluginListResponse>;
  updateSettings(
    args: PluginTarget & { values: Record<string, JsonValue> },
  ): Promise<api.PluginSettingsResponse>;
}

const PLUGINS_PATH = "/api/v1/plugins";
const toggledPluginSchema = z.object({
  ok: z.literal(true),
  plugin: installedPluginSchema,
});

function pluginPath(pluginId: string, suffix: string): string {
  const id = z.string().min(1).parse(pluginId);
  return `${PLUGINS_PATH}/${encodeURIComponent(id)}${suffix}`;
}

function jsonInit(method: "POST" | "PUT", body: unknown): RequestInit {
  const headers = { "content-type": "application/json" };
  return { method, headers, body: JSON.stringify(body) };
}

export function createPluginsArea(http: Http): PluginsArea {
  async function read<Output>(
    path: string,
    schema: z.ZodType<Output>,
    init: RequestInit,
  ): Promise<Output> {
    const reply = await http.request(path, init);
    return schema.parse(await reply.json());
  }
  async function toggle(pluginId: string, action: "enable" | "disable") {
    const path = pluginPath(pluginId, `/${action}`);
    const toggled = await read(path, toggledPluginSchema, jsonInit("POST", {}));
    return toggled.plugin;
  }
  const settingsSchema = pluginSettingsResponseSchema;

  return {
    contributions: ({ signal } = {}) =>
      read(`${PLUGINS_PATH}/contributions`, pluginContributionsResponseSchema, {
        signal,
      }),
    reload({ pluginId } = {}) {
      const query =
        pluginId === undefined ? "" : `?id=${encodeURIComponent(pluginId)}`;
      const path = `${PLUGINS_PATH}/reload${query}`;
      return read(path, pluginListResponseSchema, jsonInit("POST", {}));
    },
    disable: ({ pluginId }) => toggle(pluginId, "disable"),
    enable: ({ pluginId }) => toggle(pluginId, "enable"),
    getSettings: ({ pluginId, signal }) =>
      read(pluginPath(pluginId, "/settings"), settingsSchema, { signal }),
    list: ({ signal } = {}) =>
      read(PLUGINS_PATH, pluginListResponseSchema, { signal }),
    async updateSettings({ pluginId, values }) {
      const body = pluginSettingsUpdateRequestSchema.parse({ values });
      const path = pluginPath(pluginId, "/settings");
      return read(path, settingsSchema, jsonInit("PUT", body));
    },
  };
}
