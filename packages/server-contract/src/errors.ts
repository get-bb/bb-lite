import * as domain from "@bb/domain";
import { z } from "zod";

export const apiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  details: z.unknown().optional(),
  retryable: z.boolean().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const environmentNotReadyErrorDetailsSchema = z.object({
  environmentStatus: domain.environmentStatusSchema,
  hasPath: z.boolean(),
});
export type EnvironmentNotReadyErrorDetails = z.infer<
  typeof environmentNotReadyErrorDetailsSchema
>;

export const threadNotWritableReasonSchema = z.enum([
  "archived",
  "stopping",
  "deleted",
  "not_started",
  "not_active",
  "errored",
  "already_active",
  "still_starting",
]);
export type ThreadNotWritableReason = z.infer<
  typeof threadNotWritableReasonSchema
>;

export const threadNotWritableErrorDetailsSchema = z.object({
  reason: threadNotWritableReasonSchema,
  archivedAt: z.number().int().nonnegative().nullable(),
  threadStatus: domain.threadStatusSchema,
});
export type ThreadNotWritableErrorDetails = z.infer<
  typeof threadNotWritableErrorDetailsSchema
>;

export const threadEnvironmentUnavailableReasonSchema = z.enum([
  "never_attached",
  "destroyed",
  "provisioning",
  "errored",
]);

export const threadEnvironmentUnavailableErrorDetailsSchema = z.object({
  reason: threadEnvironmentUnavailableReasonSchema,
  environmentStatus: domain.environmentStatusSchema.nullable(),
});
export type ThreadEnvironmentUnavailableErrorDetails = z.infer<
  typeof threadEnvironmentUnavailableErrorDetailsSchema
>;

export const hostUnavailableReasonSchema = z.enum([
  "suspended",
  "disconnected",
  "destroyed",
]);

export const hostUnavailableErrorDetailsSchema = z.object({
  reason: hostUnavailableReasonSchema,
  hostStatus: domain.hostStatusSchema.nullable(),
  suspendedAt: z.number().int().nonnegative().nullable(),
  destroyedAt: z.number().int().nonnegative().nullable(),
});
export type HostUnavailableErrorDetails = z.infer<
  typeof hostUnavailableErrorDetailsSchema
>;

export const parentThreadInvalidReasonSchema = z.enum([
  "not_found",
  "archived",
  "deleted",
  "self",
  "cycle",
  "too_deep",
]);

export const parentThreadInvalidSubjectSchema = z.enum(["parent", "sender"]);

export const parentThreadInvalidErrorDetailsSchema = z.object({
  reason: parentThreadInvalidReasonSchema,
  subject: parentThreadInvalidSubjectSchema,
});
export type ParentThreadInvalidErrorDetails = z.infer<
  typeof parentThreadInvalidErrorDetailsSchema
>;

export const environmentNotReadyApiErrorSchema = apiErrorSchema.extend({
  code: z.literal("environment_not_ready"),
  details: environmentNotReadyErrorDetailsSchema,
});

export const threadNotWritableApiErrorSchema = apiErrorSchema.extend({
  code: z.literal("thread_not_writable"),
  details: threadNotWritableErrorDetailsSchema,
});

export const threadEnvironmentUnavailableApiErrorSchema = apiErrorSchema.extend(
  {
    code: z.literal("thread_environment_unavailable"),
    details: threadEnvironmentUnavailableErrorDetailsSchema,
  },
);

export const hostUnavailableApiErrorSchema = apiErrorSchema.extend({
  code: z.literal("host_unavailable"),
  details: hostUnavailableErrorDetailsSchema,
});

export const parentThreadInvalidApiErrorSchema = apiErrorSchema.extend({
  code: z.literal("parent_thread_invalid"),
  details: parentThreadInvalidErrorDetailsSchema,
});

export const lifecycleApiErrorSchema = z.discriminatedUnion("code", [
  environmentNotReadyApiErrorSchema,
  threadNotWritableApiErrorSchema,
  threadEnvironmentUnavailableApiErrorSchema,
  hostUnavailableApiErrorSchema,
  parentThreadInvalidApiErrorSchema,
]);
export type LifecycleApiError = z.infer<typeof lifecycleApiErrorSchema>;
