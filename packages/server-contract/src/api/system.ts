import * as domain from "@bb/domain";
import { rejectMultipleWorkspaceSelectors } from "./shared.js";
import { z } from "zod";
import { machineEnvironmentSetSchema } from "./machine-environment.js";

const machineEnvironmentReplacementVariableSchema =
  machineEnvironmentSetSchema.extend({
    value: machineEnvironmentSetSchema.shape.value.nullable(),
  });

export const machineEnvironmentReplaceSchema = z
  .object({
    variables: z.array(machineEnvironmentReplacementVariableSchema),
  })
  .strict()
  .superRefine(({ variables }, context) => {
    const names = new Set<string>();
    for (const [index, variable] of variables.entries()) {
      if (names.has(variable.name)) {
        context.addIssue({
          code: "custom",
          path: ["variables", index, "name"],
          message: "Machine environment variable names must be unique",
        });
      }
      names.add(variable.name);
    }
  });
export type MachineEnvironmentReplace = z.infer<
  typeof machineEnvironmentReplaceSchema
>;

export const systemExecutionOptionsModelLoadErrorCodeSchema = z.enum([
  "provider_unavailable",
  "missing_executable",
  "auth_required",
  "timeout",
  "failed",
]);

export const systemExecutionOptionsModelLoadErrorSchema = z.object({
  providerId: z.string().min(1),
  code: systemExecutionOptionsModelLoadErrorCodeSchema,
  detail: z.string().min(1).nullable(),
});
export type SystemExecutionOptionsModelLoadError = z.infer<
  typeof systemExecutionOptionsModelLoadErrorSchema
>;

export const systemExecutionOptionsResponseSchema = z.object({
  providers: z.array(domain.providerInfoSchema),
  permissionCeiling: domain.permissionModeSchema,
  models: z.array(domain.availableModelSchema),
  selectedOnlyModels: z.array(domain.availableModelSchema),
  modelLoadError: systemExecutionOptionsModelLoadErrorSchema.nullable(),
});
export type SystemExecutionOptionsResponse = z.infer<
  typeof systemExecutionOptionsResponseSchema
>;

const systemProviderHostQueryFields = {
  hostId: z.string().min(1),
  environmentId: z.string().min(1),
} as const;

export const systemProvidersQuerySchema = z
  .object({
    ...systemProviderHostQueryFields,
    capability: z.enum(["usage"]),
  })
  .partial()
  .superRefine(rejectMultipleWorkspaceSelectors);
export type SystemProvidersQuery = z.infer<typeof systemProvidersQuerySchema>;

export const systemExecutionOptionsQuerySchema = z
  .object({
    ...systemProviderHostQueryFields,
    providerId: z.string().min(1),
  })
  .partial()
  .superRefine(rejectMultipleWorkspaceSelectors);
export type SystemExecutionOptionsQuery = z.infer<
  typeof systemExecutionOptionsQuerySchema
>;

export const serverAccessStatusSchema = z.object({
  providers: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      description: z.string(),
      pluginId: z.string().min(1).nullable(),
      availability: z
        .discriminatedUnion("status", [
          z.object({
            status: z.literal("available"),
            serverUrl: z.string().url().optional(),
          }),
          z.object({
            status: z.literal("setup-required"),
            message: z.string(),
          }),
          z.object({ status: z.literal("unavailable"), message: z.string() }),
        ])
        .nullable(),
    }),
  ),
  defaultProviderId: z.string(),
  effectiveUrl: z.string().nullable(),
  urlSource: z.enum(["setting", "BB_EXTERNAL_URL"]).nullable(),
});
export type ServerAccessStatus = z.infer<typeof serverAccessStatusSchema>;

export const systemConfigResponseSchema = z.object({
  serverAccess: serverAccessStatusSchema,
  generalSettings: domain.appSettingsSchema,
  keybindings: domain.appKeybindingsSchema,
  defaultKeybindings: domain.appDefaultKeybindingsSchema,
  keybindingOverrides: domain.appKeybindingOverridesSchema,
  appearance: domain.appThemeSchema,
  featureFlags: domain.featureFlagsSchema,
  serverUrl: z.string().url(),
  primaryHostId: z.string().nullable(),
  primaryHostPlatform: domain.hostPlatformSchema.nullable(),
  dataDir: z.string(),
});
export type SystemConfigResponse = z.infer<typeof systemConfigResponseSchema>;

const systemEnvironmentProviderAvailabilitySchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("available") }),
    z.object({
      status: z.literal("setup-required"),
      message: z.string().min(1),
    }),
    z.object({
      status: z.literal("unavailable"),
      message: z.string().min(1),
    }),
  ],
);

export const systemEnvironmentProviderSchema = z.object({
  environmentProviderId: z.string().min(1).optional(),
  machineProviderId: z.string().min(1).nullable(),
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1).nullable(),
  icon: z.string().min(1).nullable(),
  logoUrl: z.string().min(1).nullable(),
  pluginId: z.string().min(1),
  requires: z.object({
    projectCheckout: z.boolean(),
    gitCheckout: z.boolean(),
    gitRemote: z.boolean(),
    projectless: z.boolean(),
  }),
  inputs: domain.jsonValueSchema.nullable(),
  acceptsEmptyInputs: z.boolean(),
  availability: systemEnvironmentProviderAvailabilitySchema.nullable(),
  machineAvailability: z.record(
    z.string().min(1),
    systemEnvironmentProviderAvailabilitySchema.nullable(),
  ),
  machineInputs: domain.jsonValueSchema.nullable().optional(),
  machineAcceptsEmptyInputs: z.boolean().optional(),
  machineProviderPluginId: z.string().min(1).optional(),
});
export type SystemEnvironmentProvider = z.infer<
  typeof systemEnvironmentProviderSchema
>;

export const systemEnvironmentProvidersResponseSchema = z.object({
  providers: z.array(systemEnvironmentProviderSchema),
});
export type SystemEnvironmentProvidersResponse = z.infer<
  typeof systemEnvironmentProvidersResponseSchema
>;

export const systemEnvironmentProvidersQuerySchema = z
  .object({
    projectId: z.string().min(1).optional(),
    hostId: z.string().min(1).optional(),
  })
  .superRefine((query, context) => {
    if (query.hostId !== undefined && query.projectId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["hostId"],
        message: "hostId requires projectId",
      });
    }
  });
export type SystemEnvironmentProvidersQuery = z.infer<
  typeof systemEnvironmentProvidersQuerySchema
>;

export const systemProviderCatalogEntrySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  pluginId: z.string(),
  pluginName: z.string(),
  pluginEnabled: z.boolean(),
  enabled: z.boolean(),
  available: z.boolean(),
  logoUrl: z.string().nullable(),
  info: domain.providerInfoSchema.nullable(),
});
export type SystemProviderCatalogEntry = z.infer<
  typeof systemProviderCatalogEntrySchema
>;
export const systemProviderEnabledRequestSchema = z
  .object({ enabled: z.boolean() })
  .strict();
export type SystemProviderEnabledRequest = z.infer<
  typeof systemProviderEnabledRequestSchema
>;
