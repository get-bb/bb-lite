import * as domain from "@bb/domain";
import { z } from "zod";
import {
  branchListQuerySchema,
  countField,
  flagField,
  isCommaSeparatedIncludeQueryValue,
  pathListIncludeQueryValueSchema,
  rejectMultipleWorkspaceSelectors,
} from "./shared.js";

const localProjectPathRequestSchema = z
  .string()
  .trim()
  .min(1)
  .transform(domain.normalizeProjectPathInput)
  .superRefine((path, ctx) => {
    const validationMessage = domain.getProjectPathValidationMessage(path);
    if (!validationMessage) {
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: validationMessage,
    });
  });

const createLocalPathProjectSourceRequestSchema = z
  .object({
    hostId: z.string().min(1),
    type: z.literal("local_path"),
    path: localProjectPathRequestSchema,
  })
  .strict();

const cloneProjectSourceRequestSchema = z
  .object({
    hostId: z.string().min(1),
    type: z.literal("clone"),
    targetPath: localProjectPathRequestSchema.optional(),
    remoteUrl: z.string().trim().min(1).optional(),
  })
  .strict();

export const createProjectSourceRequestSchema = z.discriminatedUnion("type", [
  createLocalPathProjectSourceRequestSchema,
  cloneProjectSourceRequestSchema,
]);
export type CreateProjectSourceRequest = z.infer<
  typeof createProjectSourceRequestSchema
>;

export const createProjectRequestSchema = z.object({
  name: z.string().min(1),
  source: createLocalPathProjectSourceRequestSchema,
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const threadSectionSchema = z
  .object({
    id: z.string(),
    name: z.string().min(1),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export type ThreadSectionResponse = z.infer<typeof threadSectionSchema>;

export const createThreadSectionRequestSchema = z
  .object({
    name: z.string().min(1),
  })
  .strict();
export type CreateThreadSectionRequest = z.infer<
  typeof createThreadSectionRequestSchema
>;

export const updateThreadSectionRequestSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();
export type UpdateThreadSectionRequest = z.infer<
  typeof updateThreadSectionRequestSchema
>;

export const deleteThreadSectionRequestSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();
export type DeleteThreadSectionRequest = z.infer<
  typeof deleteThreadSectionRequestSchema
>;

export const threadSectionMutationResponseSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    updatedThreadCount: z.number().int().nonnegative(),
  })
  .strict();
export type ThreadSectionMutationResponse = z.infer<
  typeof threadSectionMutationResponseSchema
>;

export const projectListIncludeOptionSchema = z.enum(["threads"]);

export const projectListQuerySchema = z.object({
  include: z
    .string()
    .min(1)
    .refine(
      (value) =>
        isCommaSeparatedIncludeQueryValue({
          allowedValues: projectListIncludeOptionSchema.options,
          value,
        }),
      { message: "Invalid include" },
    )
    .optional(),
  includePersonal: flagField.optional(),
});
export type ProjectListQuery = z.infer<typeof projectListQuerySchema>;

const projectWorkspaceRoutingFields = {
  hostId: z.string().min(1),
  environmentId: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
} as const;

export const projectPathsQuerySchema = z
  .object({
    ...projectWorkspaceRoutingFields,
    query: z.string().min(1).max(domain.FILE_LIST_QUERY_MAX_LENGTH).optional(),
    limit: countField.optional(),
    includeFiles: pathListIncludeQueryValueSchema,
    includeDirectories: pathListIncludeQueryValueSchema,
  })
  .partial({
    hostId: true,
    environmentId: true,
    query: true,
    limit: true,
  })
  .superRefine(rejectMultipleWorkspaceSelectors);
export type ProjectPathsQuery = z.infer<typeof projectPathsQuerySchema>;

export const projectBranchesQuerySchema = branchListQuerySchema
  .extend({
    hostId: z.string().min(1),
    selectedBranch: domain.gitBranchNameSchema.optional(),
  })
  .strict();
export type ProjectBranchesQuery = z.infer<typeof projectBranchesQuerySchema>;

export const projectBranchesResponseSchema =
  domain.projectSourceCheckoutSchema.extend({
    defaultWorktreeBaseBranch: z.string().min(1).nullable(),
  });
export type ProjectBranchesResponse = z.infer<
  typeof projectBranchesResponseSchema
>;

export const projectAttachmentContentQuerySchema = z.object({
  path: z.string().min(1),
});
export type ProjectAttachmentContentQuery = z.infer<
  typeof projectAttachmentContentQuerySchema
>;

export const projectDefaultExecutionOptionsQuerySchema = z.object({});
export type ProjectDefaultExecutionOptionsQuery = z.infer<
  typeof projectDefaultExecutionOptionsQuerySchema
>;

export const promptHistoryQuerySchema = z
  .object({
    limit: countField,
  })
  .partial();
export type PromptHistoryQuery = z.infer<typeof promptHistoryQuerySchema>;

export const recentPromptsQuerySchema = z
  .object({
    cursor: z.string().min(1),
    limit: countField,
    projectId: z.string().min(1),
  })
  .partial();

export const recentPromptsResponseSchema = z.object({
  entries: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      mentions: z.array(domain.promptTextMentionSchema).optional(),
      threadId: z.string(),
      projectId: z.string(),
      scope: z.enum(["project", "thread"]),
      sentAt: z.number(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type RecentPromptsResponse = z.infer<typeof recentPromptsResponseSchema>;

export const promptHistoryResponseSchema = z.array(
  domain.promptHistoryEntrySchema,
);
export type PromptHistoryResponse = z.infer<typeof promptHistoryResponseSchema>;

export type ProjectAttachmentUploadForm = Record<"file", Blob>;

export const updateProjectRequestSchema = z
  .object({
    name: z.string().min(1),
  })
  .partial()
  .refine(
    (value) => value.name !== undefined,
    "At least one field must be provided",
  );
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

export const updateProjectSourceRequestSchema = z
  .object({
    type: z.literal("local_path"),
    path: localProjectPathRequestSchema.optional(),
    isDefault: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (value) => value.path !== undefined || value.isDefault !== undefined,
    "At least one field besides type must be provided",
  );
export type UpdateProjectSourceRequest = z.infer<
  typeof updateProjectSourceRequestSchema
>;

export const providerCommandSourceSchema = z.enum(["skill", "command"]);
export type ProviderCommandSource = z.infer<typeof providerCommandSourceSchema>;

export const providerCommandOriginSchema = z.enum([
  "builtin",
  "project",
  "user",
]);
export type ProviderCommandOrigin = z.infer<typeof providerCommandOriginSchema>;

export const providerCommandSchema = z.object({
  name: z.string(),
  source: providerCommandSourceSchema,
  origin: providerCommandOriginSchema,
  description: z.string().nullable(),
  argumentHint: z.string().nullable(),
  pluginId: z.string().min(1).optional(),
  path: z.string().optional(),
});
export type ProviderCommand = z.infer<typeof providerCommandSchema>;

export const PROVIDER_COMMAND_SECTIONS = [
  "agent-command",
  "skill",
  "project-command",
  "user-command",
] as const;
export type ProviderCommandSection = (typeof PROVIDER_COMMAND_SECTIONS)[number];

export function providerCommandSection(cmd: {
  source: ProviderCommandSource;
  origin: ProviderCommandOrigin;
}): ProviderCommandSection {
  if (cmd.origin === "builtin") {
    return "agent-command";
  }
  if (cmd.source === "skill") {
    return "skill";
  }
  return cmd.origin === "project" ? "project-command" : "user-command";
}

export function providerCommandSectionRank(cmd: {
  source: ProviderCommandSource;
  origin: ProviderCommandOrigin;
}): number {
  return PROVIDER_COMMAND_SECTIONS.indexOf(providerCommandSection(cmd));
}

export const commandListResponseSchema = z.object({
  commands: z.array(providerCommandSchema),
});
export type CommandListResponse = z.infer<typeof commandListResponseSchema>;

export const projectCommandsQuerySchema = z
  .object({
    ...projectWorkspaceRoutingFields,
    provider: z.string().min(1),
  })
  .partial({ hostId: true, environmentId: true })
  .strict()
  .superRefine(rejectMultipleWorkspaceSelectors);
export type ProjectCommandsQuery = z.infer<typeof projectCommandsQuerySchema>;

export const projectResponseSchema = domain.projectSchema.extend({
  sources: z.array(domain.projectSourceSchema),
});
export type ProjectResponse = z.infer<typeof projectResponseSchema>;

export const projectWithThreadsResponseSchema = projectResponseSchema.extend({
  threads: z.array(domain.threadListEntrySchema),
  defaultExecutionOptions: domain.projectExecutionDefaultsSchema.nullable(),
});
export type ProjectWithThreadsResponse = z.infer<
  typeof projectWithThreadsResponseSchema
>;

export const sidebarBootstrapResponseSchema = z.object({
  sections: z.array(threadSectionSchema),
  projects: z.array(projectWithThreadsResponseSchema),
  personalProject: projectWithThreadsResponseSchema,
});
export type SidebarBootstrapResponse = z.infer<
  typeof sidebarBootstrapResponseSchema
>;

export const uploadedPromptAttachmentSchema = z.object({
  type: z.enum(["localImage", "localFile"]),
  path: z.string(),
  name: z.string(),
  mimeType: z.string().optional(),
  sizeBytes: z.number(),
});
export type UploadedPromptAttachment = z.infer<
  typeof uploadedPromptAttachmentSchema
>;

export const copyProjectAttachmentsRequestSchema = z
  .object({
    sourceProjectId: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1).max(100),
  })
  .strict();
export type CopyProjectAttachmentsRequest = z.infer<
  typeof copyProjectAttachmentsRequestSchema
>;
