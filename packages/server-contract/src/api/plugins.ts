import {
  jsonValueSchema,
  pluginCatalogCategoryIdSchema,
  pluginMarketplaceCollectionIdSchema,
} from "@bb/domain";
import { z } from "zod";

export const pluginRuntimeStatusSchema = z.enum([
  "starting",
  "running",
  "error",
  "incompatible",
  "missing",
  "disabled",
  "degraded",
  "needs-configuration",
]);

export const pluginUpdateOutcomeSchema = z.enum([
  "current",
  "update-available",
  "pinned",
  "incompatible",
  "unavailable",
]);

export const pluginUpdateStateSchema = z.object({
  outcome: pluginUpdateOutcomeSchema.optional(),
  detail: z.string().optional(),
  availableVersion: z.string().optional(),
  blockedVersion: z.string().optional(),
  blockedReasons: z.array(z.string()).optional(),
  lastCheckAt: z.number().optional(),
  lastFailure: z
    .object({ version: z.string(), at: z.number(), detail: z.string() })
    .optional(),
});

export const pluginHandlerStatsSchema = z.object({
  count: z.number(),
  totalMs: z.number(),
  maxMs: z.number(),
  errorCount: z.number(),
});
export type PluginHandlerStats = z.infer<typeof pluginHandlerStatsSchema>;

export const pluginServiceEntrySchema = z.object({
  name: z.string(),
  state: z.enum(["running", "backoff", "stopped"]),
});
export const pluginScheduleEntrySchema = z.object({
  name: z.string(),
  cron: z.string(),
  nextRunAt: z.number(),
  lastRunAt: z.number().nullable(),
  lastStatus: z.enum(["running", "ok", "error"]).nullable(),
  lastError: z.string().nullable(),
});

export const pluginAppStateSchema = z.object({
  hasApp: z.boolean(),
  bundle: z
    .object({
      jsUrl: z.string(),
      cssUrl: z.string().nullable(),
      jsBytes: z.number().int().nonnegative(),
      hash: z.string(),
      sdkMajor: z.number(),
      sdkVersion: z.string(),
      compatible: z.boolean(),
    })
    .nullable(),
});

export const pluginCapabilitySchema = z.object({
  kind: z.enum(["skill", "theme", "agent-tool", "thread-integration"]),
  id: z.string(),
  label: z.string(),
  detail: z.string().nullable(),
});

export const pluginCapabilitySummarySchema = z.array(pluginCapabilitySchema);
export type PluginCapabilitySummary = z.infer<
  typeof pluginCapabilitySummarySchema
>;

export const installedPluginSchema = z.object({
  id: z.string(),
  source: z.string(),
  rootDir: z.string(),
  version: z.string(),
  provenance: z.enum(["builtin", "direct", "catalog"]),
  isOrphanedBuiltin: z.boolean(),
  catalogEntryId: z.string().optional(),
  catalogMarketplaceName: z.string().optional(),
  publisherLabel: z.string().nullable().default(null),
  sourceDisplay: z.string(),
  updateState: pluginUpdateStateSchema,
  enabled: z.boolean(),
  description: z.string().nullable(),
  name: z.string().nullable(),
  categoryId: pluginCatalogCategoryIdSchema.optional(),
  category: z.string().optional(),
  screenshots: z.array(z.string()),
  collections: z.array(
    z.object({
      id: pluginMarketplaceCollectionIdSchema,
      rank: z.number().int().nonnegative(),
    }),
  ),
  publishedAt: z.iso.datetime({ offset: true }).optional(),
  updatedAt: z.iso.datetime({ offset: true }).optional(),
  icon: z.string().nullable(),
  iconUrl: z.string().nullable(),
  status: pluginRuntimeStatusSchema,
  statusDetail: z.string().nullable(),
  handlerStats: pluginHandlerStatsSchema,
  services: z.array(pluginServiceEntrySchema),
  schedules: z.array(pluginScheduleEntrySchema),
  cliCommand: z.object({ name: z.string(), summary: z.string() }).nullable(),
  capabilities: pluginCapabilitySummarySchema.default([]),
  hasSettings: z.boolean(),
  app: pluginAppStateSchema,
  logoUrl: z.string().nullable(),
  logoDarkUrl: z.string().nullable(),
  providerIds: z.array(z.string()),
  /**
   * The plugin's declared icons (`bb.branding.experimental_icons`): declared
   * name → hashed asset URL (`/api/v1/plugins/<id>/assets/icons/<name>.svg?h=…`).
   * A timeline row or provider whose glyph is `"<pluginId>/<name>"` resolves
   * here; a name that is absent (the plugin changed its map, or is gone)
   * renders the per-kind fallback glyph. Identity-backed like `iconUrl`, so a
   * disabled plugin's icons still resolve. Empty for a plugin that declares
   * none; the server fills it for every plugin, with the same response-side
   * tolerance as `providerIds` in @bb/sdk for servers older than the field.
   */
  icons: z.record(z.string(), z.string()),
});
export type InstalledPlugin = z.infer<typeof installedPluginSchema>;

export const pluginListResponseSchema = z.object({
  plugins: z.array(installedPluginSchema),
});
export type PluginListResponse = z.infer<typeof pluginListResponseSchema>;

const pluginSettingBaseSchema = {
  label: z.string().min(1),
  description: z.string().min(1).optional(),
};

export const pluginSettingDescriptorSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...pluginSettingBaseSchema,
      type: z.literal("string"),
      secret: z.literal(true).optional(),
      experimental_multiline: z.boolean().optional(),
      default: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...pluginSettingBaseSchema,
      type: z.literal("boolean"),
      default: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...pluginSettingBaseSchema,
      type: z.literal("number"),
      default: z.number().finite().optional(),
    })
    .strict(),
  z
    .object({
      ...pluginSettingBaseSchema,
      type: z.literal("select"),
      options: z.array(z.string().min(1)).min(1),
      default: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...pluginSettingBaseSchema,
      type: z.literal("project"),
      default: z.string().optional(),
    })
    .strict(),
]);
export type PluginSettingDescriptor = z.infer<
  typeof pluginSettingDescriptorSchema
>;

export const pluginSettingsResponseSchema = z.object({
  ok: z.literal(true),
  schema: z.record(z.string(), pluginSettingDescriptorSchema),
  values: z.record(z.string(), jsonValueSchema),
});
export type PluginSettingsResponse = z.infer<
  typeof pluginSettingsResponseSchema
>;

export const pluginSettingsUpdateRequestSchema = z
  .object({ values: z.record(z.string(), jsonValueSchema) })
  .strict();

export const pluginTokenRequestSchema = z
  .object({ rotate: z.boolean().optional().default(false) })
  .strict();

export const pluginTokenResponseSchema = z.object({
  ok: z.literal(true),
  token: z.string(),
});
export type PluginTokenResponse = z.infer<typeof pluginTokenResponseSchema>;

export const pluginRpcDiscoveryQuerySchema = z.object({
  pluginId: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
});
export type PluginRpcDiscoveryQuery = z.infer<
  typeof pluginRpcDiscoveryQuerySchema
>;

export const publishedPluginRpcMethodSchema = z.object({
  pluginId: z.string().min(1),
  displayName: z.string().min(1),
  method: z.string().min(1),
  registrationDescription: z.string().nullable(),
  methodDescription: z.string().nullable(),
  inputSchema: z.record(z.string(), jsonValueSchema),
  outputSchema: z.record(z.string(), jsonValueSchema),
});
export type PublishedPluginRpcMethod = z.infer<
  typeof publishedPluginRpcMethodSchema
>;
export const pluginRpcDiscoveryResponseSchema = z.array(
  publishedPluginRpcMethodSchema,
);
