import { z } from "zod";
import {
  hostTypeSchema,
  jsonValueSchema,
  permissionModeSchema,
} from "@bb/domain";

export const hostDirectoryQuerySchema = z.object({
  path: z.string().min(1).optional(),
});
export type HostDirectoryQuery = z.infer<typeof hostDirectoryQuerySchema>;

export const hostDirectoryEntrySchema = z.object({
  kind: z.enum(["file", "directory"]),
  name: z.string(),
  path: z.string(),
});

export const hostDirectoryListingSchema = z.object({
  directory: z.string(),
  parent: z.string().nullable(),
  entries: z.array(hostDirectoryEntrySchema),
});
export type HostDirectoryListing = z.infer<typeof hostDirectoryListingSchema>;

export const hostCloneDefaultPathQuerySchema = z.object({
  projectId: z.string().min(1),
});
export type HostCloneDefaultPathQuery = z.infer<
  typeof hostCloneDefaultPathQuerySchema
>;

export const hostCloneDefaultPathResponseSchema = z
  .object({ path: z.string().min(1) })
  .strict();
export type HostCloneDefaultPathResponse = z.infer<
  typeof hostCloneDefaultPathResponseSchema
>;

export const createHostJoinCodeRequestSchema = z.object({}).strict();
export type CreateHostJoinCodeRequest = z.infer<
  typeof createHostJoinCodeRequestSchema
>;

export const createMachineRequestSchema = z
  .object({
    machineProviderId: z.string().min(1),
    inputs: jsonValueSchema.nullable(),
    key: z.string().min(1).optional(),
  })
  .strict();
export type CreateMachineRequest = z.infer<typeof createMachineRequestSchema>;

export const hostEnrollmentCommandResponseSchema = z
  .object({
    command: z.string().min(1),
    expiresAt: z.number().int().positive(),
  })
  .nullable();
export type HostEnrollmentCommandResponse = z.infer<
  typeof hostEnrollmentCommandResponseSchema
>;

export const hostReconnectResponseSchema = z
  .object({
    command: z.string().min(1),
    expiresAt: z.number().int().positive(),
    hostId: z.string().min(1),
  })
  .strict();
export type HostReconnectResponse = z.infer<typeof hostReconnectResponseSchema>;

export const createHostJoinCodeResponseSchema = z.object({
  joinCode: z.string().min(1),
  hostId: z.string().min(1),
  expiresAt: z.number().int().positive(),
});
export type CreateHostJoinCodeResponse = z.infer<
  typeof createHostJoinCodeResponseSchema
>;

export const updateHostRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
  })
  .strict();
export type UpdateHostRequest = z.infer<typeof updateHostRequestSchema>;

export const updateHostPermissionCeilingRequestSchema = z
  .object({
    maxPermissionMode: permissionModeSchema,
  })
  .strict();
export type UpdateHostPermissionCeilingRequest = z.infer<
  typeof updateHostPermissionCeilingRequestSchema
>;

export const hostPathsExistRequestSchema = z.object({
  paths: z
    .array(z.string().min(1))
    .min(1)
    .max(200)
    .transform((paths) => Array.from(new Set(paths))),
});
export type HostPathsExistRequest = z.infer<typeof hostPathsExistRequestSchema>;

export interface HostPathsExistResponse {
  existence: Record<string, boolean>;
}

export const hostOpenTargetSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["editor", "file-manager", "terminal"]),
  capabilities: z.object({
    openDirectory: z.boolean(),
    openFile: z.boolean(),
    openFileAtLine: z.boolean(),
    openFileAtColumn: z.boolean(),
  }),
});
export type HostOpenTarget = z.infer<typeof hostOpenTargetSchema>;

export interface HostOpenTargetsResponse {
  targets: HostOpenTarget[];
}

export const hostOpenRequestSchema = z
  .object({
    targetId: z.string().min(1),
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
  })
  .strict();
export type HostOpenRequest = z.infer<typeof hostOpenRequestSchema>;

export const hostListQuerySchema = z.object({
  includeCreating: z.enum(["true", "false"]).optional(),
  type: hostTypeSchema.optional(),
});
export type HostListQuery = z.input<typeof hostListQuerySchema>;
