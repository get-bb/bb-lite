import * as domain from "@bb/domain";
import { z } from "zod";

export const pluginStatusSchema = z.enum([
  "running",
  "needs-configuration",
  "error",
  "disabled",
]);

const pluginSettingBaseSchema = {
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  scope: z.enum(["workspace", "user", "project"]).optional(),
};

export const pluginSettingDescriptorSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...pluginSettingBaseSchema,
      type: z.literal("string"),
      secret: z.literal(true).optional(),
      multiline: z.boolean().optional(),
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
      type: z.literal("select"),
      options: z
        .array(z.object({ value: z.string().min(1), label: z.string().min(1) }))
        .min(1),
      default: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...pluginSettingBaseSchema,
      type: z.literal("number"),
      min: z.number().optional(),
      max: z.number().optional(),
      integer: z.boolean().optional(),
      default: z.number().optional(),
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

const pluginSettingDescriptorsSchema = z.record(
  z.string(),
  pluginSettingDescriptorSchema,
);

export const pluginAppSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("builtin") }),
  z.object({
    kind: z.literal("external"),
    jsUrl: z.string(),
    cssUrl: z.string().nullable(),
    utilitiesUrl: z.string().nullable().default(null),
    hash: z.string(),
    shared: z.array(z.string()).default([]),
  }),
]);
export type PluginApp = z.infer<typeof pluginAppSchema>;

const pluginCliCommandSchema = z.object({
  name: z.string(),
  summary: z.string(),
});

export const installedPluginSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string().nullable(),
  enabled: z.boolean(),
  core: z.boolean().default(false),
  status: pluginStatusSchema,
  statusMessage: z.string().nullable(),
  hasSettings: z.boolean(),
  settings: pluginSettingDescriptorsSchema,
  app: pluginAppSchema.nullable(),
  cliCommands: z.array(pluginCliCommandSchema),
});
export type InstalledPlugin = z.infer<typeof installedPluginSchema>;

export const pluginListResponseSchema = z.object({
  plugins: z.array(installedPluginSchema),
});
export type PluginListResponse = z.infer<typeof pluginListResponseSchema>;

export const pluginSettingsResponseSchema = z.object({
  ok: z.literal(true),
  schema: pluginSettingDescriptorsSchema,
  values: z.record(z.string(), domain.jsonValueSchema),
});
export type PluginSettingsResponse = z.infer<
  typeof pluginSettingsResponseSchema
>;

export const pluginSettingsUpdateRequestSchema = z
  .object({
    values: z.record(z.string(), domain.jsonValueSchema),
    projectId: z.string().optional(),
  })
  .strict();

export const pluginTokenRequestSchema = z
  .object({ rotate: z.boolean().optional().default(false) })
  .strict();

export const pluginCliRequestSchema = z.object({
  argv: z.array(z.string()),
  cwd: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  hostId: z.string().min(1).optional(),
});

export const pluginCliResponseSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

export const pluginMentionTriggerSchema = z.enum(["@", "#", "$", "!", "~"]);
export type PluginMentionTrigger = z.infer<typeof pluginMentionTriggerSchema>;

export const pluginContributionsResponseSchema = z.object({
  cliCommands: z.array(
    pluginCliCommandSchema.extend({
      pluginId: z.string(),
      commands: z.array(pluginCliCommandSchema),
    }),
  ),
  mentionProviders: z.array(
    z.object({
      pluginId: z.string(),
      id: z.string(),
      label: z.string(),
      triggers: z.array(pluginMentionTriggerSchema),
    }),
  ),
});
export type PluginContributionsResponse = z.infer<
  typeof pluginContributionsResponseSchema
>;

export const pluginMentionSearchQuerySchema = z.object({
  q: z.string().default(""),
  trigger: pluginMentionTriggerSchema.default("@"),
  projectId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
});

export const pluginMentionGroupSchema = z.object({
  pluginId: z.string(),
  providerId: z.string(),
  label: z.string(),
  items: z.array(
    z.object({
      itemId: z.string(),
      title: z.string(),
      subtitle: z.string().nullable(),
      icon: z.string().nullable(),
    }),
  ),
});
export type PluginMentionGroup = z.infer<typeof pluginMentionGroupSchema>;
