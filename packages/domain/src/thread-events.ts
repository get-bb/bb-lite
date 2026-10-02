import { z } from "zod";
import {
  approvalPendingInteractionResolutionSchema,
  interactionLifecycleSchema,
  pendingInteractionPermissionGrantApprovalSubjectSchema,
  pendingInteractionStatusSchema,
  userQuestionPendingInteractionPayloadSchema,
  userQuestionPendingInteractionResolutionSchema,
} from "./pending-interactions.js";
import {
  promptInputSchema,
  recordedThreadExecutionOptionsSchema,
} from "./shared-types.js";
import { jsonValueSchema } from "./json-value.js";
import { clientTurnRequestIdSchema } from "./protocol-ids.js";
import {
  systemMessageKindSchema,
  systemMessageSubjectSchema,
  systemThreadInterruptedReasonSchema,
} from "./system-message.js";

export const systemEventTypeValues = [
  "client/thread/start",
  "client/turn/requested",
  "client/turn/rejected",
  "client/turn/start",
  "system/error",
  "system/manager/user_message",
  "system/thread/interrupted",
  "system/operation",
  "system/interaction/lifecycle",
  "system/permissionGrant/lifecycle",
  "system/userQuestion/lifecycle",
  "system/thread-provisioning",
  "system/provider-turn-watchdog",
] as const;
export const threadTurnInitiatorSchema = z.enum(["user", "agent", "system"]);
export type ThreadTurnInitiator = z.infer<typeof threadTurnInitiatorSchema>;

const turnRequestOptionsSchema = recordedThreadExecutionOptionsSchema;

export const turnRequestTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread-start") }),
  z.object({ kind: z.literal("new-turn") }),
  z.object({
    kind: z.literal("auto"),
    expectedTurnId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("steer"),
    expectedTurnId: z.string().nullable(),
  }),
]);
export type TurnRequestTarget = z.infer<typeof turnRequestTargetSchema>;

export const clientTurnLifecycleEventDataSchema = z.object({
  direction: z.literal("outbound"),
  source: z.enum(["spawn", "tell"]),
  initiator: threadTurnInitiatorSchema,
  request: z.object({
    method: z.enum(["thread/start", "turn/start"]),
    params: z.record(z.string(), z.unknown()),
  }),
});

export const turnRequestEventDataSchema = z.object({
  direction: z.literal("outbound"),
  requestId: clientTurnRequestIdSchema,
  retryOfRequestId: clientTurnRequestIdSchema.optional(),
  retryAttempt: z.number().int().min(2).optional(),
  source: z.enum(["spawn", "tell"]),
  initiator: threadTurnInitiatorSchema,
  senderThreadId: z.string().nullable(),
  systemMessageKind: systemMessageKindSchema.optional(),
  systemMessageSubject: systemMessageSubjectSchema.nullable().optional(),
  input: z.array(promptInputSchema),
  inputGroups: z.array(z.array(promptInputSchema).min(1)).min(1).optional(),
  target: turnRequestTargetSchema,
  request: z.object({
    method: z.enum(["thread/start", "turn/start"]),
    params: z.record(z.string(), z.unknown()),
  }),
  execution: turnRequestOptionsSchema,
});
export type TurnRequestEventData = z.infer<typeof turnRequestEventDataSchema>;

export function refineTurnRequestRetryMarker(
  data: Pick<TurnRequestEventData, "retryOfRequestId" | "retryAttempt">,
  ctx: z.RefinementCtx,
): void {
  if (
    (data.retryOfRequestId === undefined) !==
    (data.retryAttempt === undefined)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "retryOfRequestId and retryAttempt must be present together or absent together",
    });
  }
}

export const turnRequestRejectedEventDataSchema = z.object({
  requestId: clientTurnRequestIdSchema,
  reason: z.string().min(1),
  message: z.string().min(1),
});

export const systemErrorEventDataSchema = z.object({
  code: z.string().optional(),
  message: z.string(),
  detail: z.string().optional(),
});
const ownershipChangeOperationActionSchema = z.enum([
  "assign",
  "release",
  "transfer",
]);

export const ownershipChangeOperationMetadataSchema = z.object({
  action: ownershipChangeOperationActionSchema,
  nextParentThreadId: z.string().nullable(),
  nextParentThreadTitle: z.string().nullable(),
  previousParentThreadId: z.string().nullable(),
  previousParentThreadTitle: z.string().nullable(),
});
export type OwnershipChangeOperationMetadata = z.infer<
  typeof ownershipChangeOperationMetadataSchema
>;

export const THREAD_CONTEXT_CLEAR_OPERATION = "context_clear";

export const systemOperationEventDataSchema = z.object({
  operation: z.string(),
  status: z.string(),
  message: z.string(),
  operationId: z.string(),
  metadata: z.record(z.string(), jsonValueSchema).optional(),
});

export const systemInteractionLifecycleEventDataSchema = z.object({
  interaction: interactionLifecycleSchema,
});

export const systemPermissionGrantLifecycleEventDataSchema = z.object({
  interactionId: z.string(),
  providerId: z.string(),
  providerRequestId: z.string(),
  status: pendingInteractionStatusSchema,
  resolution: approvalPendingInteractionResolutionSchema
    .nullable()
    .default(null),
  statusReason: z.string().nullable().default(null),
  subject: pendingInteractionPermissionGrantApprovalSubjectSchema,
});

export const systemUserQuestionLifecycleEventDataSchema = z.object({
  interactionId: z.string(),
  providerId: z.string(),
  providerRequestId: z.string(),
  status: pendingInteractionStatusSchema,
  resolution: userQuestionPendingInteractionResolutionSchema
    .nullable()
    .default(null),
  statusReason: z.string().nullable().default(null),
  payload: userQuestionPendingInteractionPayloadSchema,
});

export const systemThreadInterruptedEventDataSchema = z.object({
  reason: systemThreadInterruptedReasonSchema,
  cause: z.literal("host-connection-lost").optional(),
});

export const WORKSPACE_PROVISIONING_STEP_KEYS = {
  workspacePath: "workspace-path",
  workspaceBranch: "workspace-branch",
} as const;

export const provisioningTranscriptEntrySchema = z.object({
  type: z.enum(["step", "output"]),
  key: z.string(),
  text: z.string(),
  startedAt: z.number().optional(),
  status: z.enum(["started", "completed", "failed"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ProvisioningTranscriptEntry = z.infer<
  typeof provisioningTranscriptEntrySchema
>;
const systemThreadProvisioningStatusSchema = z.enum([
  "active",
  "completed",
  "failed",
  "cancelled",
]);
export type SystemThreadProvisioningStatus = z.infer<
  typeof systemThreadProvisioningStatusSchema
>;

export const systemThreadProvisioningEventDataSchema = z.object({
  provisioningId: z.string(),
  status: systemThreadProvisioningStatusSchema,
  environmentId: z.string().nullable(),
  entries: z.array(provisioningTranscriptEntrySchema),
});

export const systemLegacyUserMessageEventDataSchema = z.object({
  text: z.string(),
  toolCallId: z.string().optional(),
  turnId: z.string().optional(),
});

export const systemProviderTurnWatchdogEventDataSchema = z.object({
  reason: z.literal("provider-turn-idle"),
  thresholdMs: z.number().int().positive(),
  elapsedMs: z.number().int().nonnegative(),
  activeTurnId: z.string().min(1),
  activeTurnStartedAt: z.number().int().nonnegative(),
  lastActivityEventSequence: z.number().int().positive(),
  lastActivityEventType: z.string().min(1),
  lastActivityEventAt: z.number().int().nonnegative(),
  providerId: z.string().min(1),
  providerThreadId: z.string().min(1).nullable(),
  firedAt: z.number().int().nonnegative(),
});
