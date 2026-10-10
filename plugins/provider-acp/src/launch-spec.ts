import { reasoningLevelSchema } from "@bb/domain";
import { z } from "zod";

export function isRelativeRootPath(value: string): boolean {
  if (value.length === 0) return false;
  const normalized = value.replaceAll("\\", "/");
  return (
    !normalized.startsWith("/") &&
    !/^[a-zA-Z]:\//u.test(normalized) &&
    normalized
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

const relativePath = z
  .string()
  .min(1)
  .refine(isRelativeRootPath, "must be a relative path without dot segments");

export const acpNativeRootSchema = z.union([
  relativePath,
  z
    .object({
      path: relativePath,
      recursive: z.boolean().optional(),
      ancestors: z.boolean().optional(),
      skipIfManifest: relativePath.optional(),
    })
    .strict(),
]);
export type AcpNativeRoot = z.infer<typeof acpNativeRootSchema>;

export function nativeRootPath(root: AcpNativeRoot): string {
  return typeof root === "string" ? root : root.path;
}

const nativeSkillRootsSchema = z
  .object({
    user: z.array(acpNativeRootSchema).default([]),
    project: z.array(acpNativeRootSchema).default([]),
  })
  .strict();

const levelValues = z.record(reasoningLevelSchema, z.string().min(1));

function checkLevels(
  spec: { supportedLevels: string[]; defaultLevel?: string },
  context: z.RefinementCtx,
) {
  const supported = new Set(spec.supportedLevels);
  if (supported.size !== spec.supportedLevels.length) {
    context.addIssue({
      code: "custom",
      message: "supportedLevels must not contain duplicates",
      path: ["supportedLevels"],
    });
  }
  if (spec.defaultLevel !== undefined && !supported.has(spec.defaultLevel)) {
    context.addIssue({
      code: "custom",
      message: "defaultLevel must be one of supportedLevels",
      path: ["defaultLevel"],
    });
  }
}

export const acpReasoningCliSchema = z
  .object({
    flag: z.string().min(1),
    supportedLevels: z.array(reasoningLevelSchema).min(1),
    levelValues: levelValues.optional(),
    defaultLevel: reasoningLevelSchema.optional(),
  })
  .strict()
  .superRefine(checkLevels);
export type AcpReasoningCli = z.infer<typeof acpReasoningCliSchema>;

export const acpNativeReasoningSchema = z
  .object({
    configId: z.string().min(1),
    supportedLevels: z.array(reasoningLevelSchema).min(1),
    levelValues: levelValues.optional(),
    defaultLevel: reasoningLevelSchema.optional(),
  })
  .strict()
  .superRefine(checkLevels);
export type AcpNativeReasoning = z.infer<typeof acpNativeReasoningSchema>;

const permissionArgs = z.array(z.string().min(1)).min(1);

export const acpPermissionCliSchema = z
  .object({
    full: permissionArgs.optional(),
    workspaceWrite: permissionArgs.optional(),
    readonly: permissionArgs.optional(),
    insertAfterArgs: z.number().int().min(0).optional(),
  })
  .strict()
  .refine(
    (cli) =>
      cli.full !== undefined ||
      cli.workspaceWrite !== undefined ||
      cli.readonly !== undefined,
    "permissionCli must configure at least one permission mode",
  );
export type AcpPermissionCli = z.infer<typeof acpPermissionCliSchema>;

export const acpLaunchSpecSchema = z
  .object({
    displayName: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.record(z.string().min(1), z.string()),
    cwd: z.string().min(1).optional(),
    modelCli: z
      .object({
        listArgs: z.array(z.string()),
        selectFlag: z.string().min(1).optional(),
        primaryModels: z.array(z.string()),
      })
      .strict()
      .optional(),
    reasoningCli: acpReasoningCliSchema.optional(),
    nativeReasoning: acpNativeReasoningSchema.optional(),
    nativeSkillRoots: nativeSkillRootsSchema.optional(),
    permissionCli: acpPermissionCliSchema.optional(),
  })
  .strict();
export type AcpLaunchSpec = z.infer<typeof acpLaunchSpecSchema>;

export const acpRunnerAgentSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    launch: acpLaunchSpecSchema,
    dialect: z.string().min(1).optional(),
    parameterizedModelPicker: z.boolean().optional(),
    primaryModels: z.array(z.string()).optional(),
    reasoningProbePriorityModelIds: z.array(z.string()).optional(),
    supportsManualCompaction: z.boolean().optional(),
    fork: z.enum(["none", "tip"]).optional(),
    signInCommand: z.string().min(1).optional(),
    installUrl: z.string().min(1).optional(),
  })
  .strict();
export type AcpRunnerAgent = z.infer<typeof acpRunnerAgentSchema>;

export const acpAgentProbeSchema = z.union([
  z.object({ reachable: z.literal(true), fork: z.boolean() }),
  z.object({ reachable: z.literal(false), reason: z.string() }),
]);
export type AcpAgentProbe = z.infer<typeof acpAgentProbeSchema>;
