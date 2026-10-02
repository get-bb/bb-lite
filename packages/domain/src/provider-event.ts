import { contextSnapshotSchema } from "./context-snapshot.js";
import { z } from "zod";
import {
  systemErrorEventDataSchema,
  systemInteractionLifecycleEventDataSchema,
  systemPermissionGrantLifecycleEventDataSchema,
  systemLegacyUserMessageEventDataSchema,
  systemOperationEventDataSchema,
  systemProviderTurnWatchdogEventDataSchema,
  systemThreadProvisioningEventDataSchema,
  systemUserQuestionLifecycleEventDataSchema,
  systemEventTypeValues,
  systemThreadInterruptedEventDataSchema,
  clientTurnLifecycleEventDataSchema,
  turnRequestEventDataSchema,
  turnRequestRejectedEventDataSchema,
} from "./thread-events.js";
import { jsonValueSchema } from "./json-value.js";
import {
  threadEventScopeSchema,
  validateThreadEventScope,
} from "./thread-event-scope.js";
import { clientTurnRequestIdSchema } from "./protocol-ids.js";
import {
  backgroundTaskStatusSchema,
  backgroundTaskUsageSchema,
  workflowProgressSnapshotSchema,
} from "./background-task.js";
import { threadTimelineGoalStatusSchema } from "./thread-timeline-goal.js";
import { threadEventItemPresentationSchema } from "./item-presentation.js";
import { extensionKindSchema } from "./provider-extension-kind.js";

export const threadEventItemStatusSchema = z.enum([
  "pending",
  "completed",
  "failed",
  "interrupted",
]);
export type ThreadEventItemStatus = z.infer<typeof threadEventItemStatusSchema>;

const threadEventItemApprovalStatusSchema = z
  .enum(["waiting_for_approval", "denied"])
  .nullable();

export const threadEventTurnStatusSchema = z.enum([
  "completed",
  "failed",
  "interrupted",
]);
export type ThreadEventTurnStatus = z.infer<typeof threadEventTurnStatusSchema>;

const providerErrorCategoryValues = [
  "active-turn-not-steerable",
  "bad-request",
  "connection-failed",
  "context-window-exceeded",
  "billing",
  "budget-exceeded",
  "internal",
  "max-output-tokens",
  "max-turns",
  "overloaded",
  "policy",
  "rate-limit",
  "sandbox",
  "stream-disconnected",
  "structured-output-retries",
  "thread-rollback-failed",
  "too-many-failed-attempts",
  "unauthorized",
  "unknown",
] as const;
export const providerErrorCategorySchema = z.enum(providerErrorCategoryValues);
export type ProviderErrorCategory = z.infer<typeof providerErrorCategorySchema>;

export const providerErrorInfoSchema = z.object({
  category: providerErrorCategorySchema,
  providerCode: z.string().nullable(),
  httpStatusCode: z.number().nullable(),
});
export type ProviderErrorInfo = z.infer<typeof providerErrorInfoSchema>;

const providerRateLimitStatusSchema = z.enum([
  "allowed",
  "warning",
  "blocked",
  "unknown",
]);

const providerRateLimitWindowSchema = z.object({
  providerKey: z.string().min(1).nullable(),
  label: z.string().min(1).nullable(),
  status: providerRateLimitStatusSchema,
  resetsAtMs: z.number().int().nonnegative().nullable(),
});

export const providerRateLimitStateSchema = z.object({
  providerId: z.string().min(1),
  status: providerRateLimitStatusSchema,
  kind: z.enum(["subscription-window", "credits", "spend-control", "unknown"]),
  windows: z.array(providerRateLimitWindowSchema),
  reachedReason: z.string().min(1).nullable(),
  overageStatus: z
    .enum(["allowed", "warning", "rejected", "unavailable"])
    .nullable(),
  overageReason: z.string().min(1).nullable(),
});

const threadEventFileChangeKindSchema = z.enum(["add", "delete", "update"]);

const threadEventFileChangeSchema = z.object({
  path: z.string(),
  kind: threadEventFileChangeKindSchema,
  movePath: z.string().optional(),
  diff: z.string().optional(),
});

const threadEventPlanStepStatusSchema = z.enum([
  "pending",
  "active",
  "completed",
  "failed",
]);

export const threadEventPlanStepSchema = z.object({
  step: z.string(),
  status: threadEventPlanStepStatusSchema.optional(),
});
export type ThreadEventPlanStep = z.infer<typeof threadEventPlanStepSchema>;

const itemPresentationField = {
  presentation: threadEventItemPresentationSchema.optional(),
};

function item<Type extends string, Shape extends z.ZodRawShape>(
  type: Type,
  shape: Shape,
) {
  return z.object({
    type: z.literal(type),
    id: z.string(),
    ...shape,
    ...itemPresentationField,
    parentToolCallId: z.string().optional(),
  });
}

function providerEvent<Type extends string, Shape extends z.ZodRawShape>(
  type: Type,
  shape: Shape,
) {
  return z.object({
    type: z.literal(type),
    threadId: z.string(),
    providerThreadId: z.string(),
    ...shape,
  });
}

function systemEvent<Type extends string, Data extends z.ZodRawShape>(
  type: Type,
  data: z.ZodObject<Data>,
) {
  return z.object({ type: z.literal(type), threadId: z.string() }).merge(data);
}

const threadEventWebSearchItemSchema = item("webSearch", {
  queries: z.array(z.string()).min(1),
  resultText: z.string().nullable(),
});

const threadEventWebFetchItemSchema = item("webFetch", {
  url: z.string(),
  prompt: z.string().nullable(),
  pattern: z.string().nullable(),
  resultText: z.string().nullable(),
});

const threadEventImageViewItemSchema = item("imageView", {
  path: z.string(),
});

export const threadEventFileReadItemSchema = item("fileRead", {
  path: z.string(),
  cmd: z.string().optional(),
  status: threadEventItemStatusSchema,
});

export const threadEventSearchModeSchema = z.enum(["content", "path", "list"]);

export const threadEventSearchItemSchema = item("search", {
  mode: threadEventSearchModeSchema,
  query: z.string(),
  path: z.string().optional(),
  cmd: z.string().optional(),
  status: threadEventItemStatusSchema,
});

export const threadEventDelegationItemSchema = item("delegation", {
  childRef: z.string().min(1),
  label: z.string(),
  status: threadEventItemStatusSchema,
  background: z.boolean(),
  summary: z.string().optional(),
});

export const threadEventPlanStepsItemSchema = item("planSteps", {
  steps: z.array(threadEventPlanStepSchema),
  explanation: z.string().optional(),
  status: threadEventItemStatusSchema,
});

export const threadEventExtensionItemSchema = z.object({
  type: z.literal("extension"),
  id: z.string(),
  kind: extensionKindSchema,
  payload: jsonValueSchema,
  status: threadEventItemStatusSchema,
  presentation: threadEventItemPresentationSchema,
  parentToolCallId: z.string().optional(),
});

const threadEventTextTruncationSchema = z.object({
  originalLength: z.number(),
  retainedHeadLength: z.number(),
  retainedTailLength: z.number(),
  truncatedAt: z.number(),
});

const threadEventItemTruncationSchema = z.object({
  aggregatedOutput: threadEventTextTruncationSchema.optional(),
  result: threadEventTextTruncationSchema.optional(),
  resultText: threadEventTextTruncationSchema.optional(),
});

export const threadEventImageGenerationItemSchema = item("imageGeneration", {
  status: threadEventItemStatusSchema,
  prompt: z.string().nullable(),
  path: z.string().nullable(),
  result: z.string().optional(),
  error: z.string().nullable(),
  transparentBackground: z.boolean(),
  truncation: threadEventItemTruncationSchema.optional(),
});

const threadEventUserContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), url: z.string() }),
  z.object({ type: z.literal("localImage"), path: z.string() }),
  z.object({ type: z.literal("localFile"), path: z.string() }),
]);

export const threadEventTokenUsageBreakdownSchema = z.object({
  totalTokens: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheReadInputTokens: z.number().nonnegative().optional(),
  cacheWriteInputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
});
export type ThreadEventTokenUsageBreakdown = z.infer<
  typeof threadEventTokenUsageBreakdownSchema
>;

const threadEventContextWindowUsageSchema = z.object({
  snapshot: contextSnapshotSchema.optional(),
  usedTokens: z.number().nullable(),
  modelContextWindow: z.number().nullable(),
  estimated: z.boolean(),
});

const threadEventTokenUsageSchema = z.object({
  total: threadEventTokenUsageBreakdownSchema,
  last: threadEventTokenUsageBreakdownSchema,
  modelContextWindow: z.number().nullable(),
});

export const threadEventWarningCategorySchema = z.enum([
  "deprecation",
  "config",
  "general",
  "compaction-skipped",
]);

export const providerRawEventSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: jsonValueSchema.optional(),
});

const providerUnhandledEventSchema = providerEvent("provider/unhandled", {
  providerId: z.string(),
  rawType: z.string(),
  rawEvent: providerRawEventSchema,
  parentToolCallId: z.string().optional(),
});

const toolCallProgressEventSchema = providerEvent("item/toolCall/progress", {
  itemId: z.string(),
  message: z.string().optional(),
  parentToolCallId: z.string().optional(),
});

export const threadEventBackgroundTaskItemSchema = item("backgroundTask", {
  familyId: z.string().optional(),
  taskType: z.string(),
  description: z.string(),
  status: threadEventItemStatusSchema,
  taskStatus: backgroundTaskStatusSchema,
  skipTranscript: z.boolean(),
  workflowName: z.string().optional(),
  workflow: workflowProgressSnapshotSchema.optional(),
  usage: backgroundTaskUsageSchema.optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  outputFile: z.string().optional(),
});
export type ThreadEventBackgroundTaskItem = z.infer<
  typeof threadEventBackgroundTaskItemSchema
>;

export const threadEventItemSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("userMessage"),
      id: z.string(),
      content: z.array(threadEventUserContentSchema),
      clientRequestId: clientTurnRequestIdSchema.optional(),
      parentToolCallId: z.string().optional(),
    })
    .strict(),
  item("agentMessage", {
    text: z.string(),
  }),
  item("commandExecution", {
    command: z.string(),
    cwd: z.string(),
    status: threadEventItemStatusSchema,
    approvalStatus: threadEventItemApprovalStatusSchema,
    aggregatedOutput: z.string().optional(),
    exitCode: z.number().optional(),
    durationMs: z.number().optional(),
    truncation: threadEventItemTruncationSchema.optional(),
  }),
  item("fileChange", {
    changes: z.array(threadEventFileChangeSchema),
    status: threadEventItemStatusSchema,
    approvalStatus: threadEventItemApprovalStatusSchema,
  }),
  threadEventWebSearchItemSchema,
  threadEventWebFetchItemSchema,
  threadEventImageViewItemSchema,
  threadEventImageGenerationItemSchema,
  threadEventFileReadItemSchema,
  threadEventSearchItemSchema,
  item("toolCall", {
    server: z.string().optional(),
    tool: z.string(),
    arguments: z.record(z.string(), z.unknown()).optional(),
    status: threadEventItemStatusSchema,
    result: z.unknown().optional(),
    error: z.string().optional(),
    durationMs: z.number().optional(),
    truncation: threadEventItemTruncationSchema.optional(),
  }),
  item("reasoning", {
    summary: z.array(z.string()),
    content: z.array(z.string()),
  }),
  item("plan", {
    text: z.string(),
  }),
  threadEventPlanStepsItemSchema,
  item("contextCompaction", {}),
  threadEventBackgroundTaskItemSchema,
  threadEventDelegationItemSchema,
  threadEventExtensionItemSchema,
]);
export type ThreadEventItem = z.infer<typeof threadEventItemSchema>;
export type ThreadEventItemType = ThreadEventItem["type"];

function itemTextDeltaEventSchema<Type extends string>(type: Type) {
  return providerEvent(type, {
    itemId: z.string(),
    delta: z.string(),
    parentToolCallId: z.string().optional(),
  });
}

const unscopedProviderEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("thread/started"),
    threadId: z.string(),
  }),
  providerEvent("thread/identity", {}),
  providerEvent("turn/started", {
    parentToolCallId: z.string().optional(),
  }),
  z.object({
    type: z.literal("turn/completed"),
    threadId: z.string(),
    providerThreadId: z.string().nullable(),
    status: threadEventTurnStatusSchema,
    error: z.object({ message: z.string() }).optional(),
    providerCheckpointId: z.string().min(1).optional(),
  }),
  z
    .object({
      type: z.literal("turn/input/accepted"),
      threadId: z.string(),
      providerThreadId: z.string(),
      clientRequestId: clientTurnRequestIdSchema,
      scope: threadEventScopeSchema,
    })
    .strict(),
  providerEvent("thread/name/updated", {
    threadName: z.string(),
  }),
  providerEvent("thread/compacted", {}),
  providerEvent("thread/context/cleared", {}),
  providerEvent("thread/goal/updated", {
    objective: z.string(),
    status: threadTimelineGoalStatusSchema,
    tokenBudget: z.number().nullable(),
    tokensUsed: z.number(),
    timeUsedSeconds: z.number(),
  }),
  providerEvent("thread/goal/cleared", {}),
  providerEvent("item/started", {
    item: threadEventItemSchema,
  }),
  providerEvent("item/completed", {
    item: threadEventItemSchema,
  }),
  itemTextDeltaEventSchema("item/agentMessage/delta"),
  providerEvent("item/commandExecution/outputDelta", {
    itemId: z.string(),
    delta: z.string(),
    reset: z.boolean().optional(),
    parentToolCallId: z.string().optional(),
  }),
  itemTextDeltaEventSchema("item/fileChange/outputDelta"),
  itemTextDeltaEventSchema("item/reasoning/summaryTextDelta"),
  itemTextDeltaEventSchema("item/reasoning/textDelta"),
  itemTextDeltaEventSchema("item/plan/delta"),
  providerEvent("item/mcpToolCall/progress", {
    itemId: z.string(),
    message: z.string().optional(),
    parentToolCallId: z.string().optional(),
  }),
  toolCallProgressEventSchema,
  providerEvent("item/backgroundTask/progress", {
    item: threadEventBackgroundTaskItemSchema,
  }),
  providerEvent("item/backgroundTask/completed", {
    item: threadEventBackgroundTaskItemSchema,
  }),
  providerEvent("item/delegation/progress", {
    item: threadEventDelegationItemSchema,
  }),
  providerEvent("item/delegation/completed", {
    item: threadEventDelegationItemSchema,
  }),
  providerEvent("thread/tokenUsage/updated", {
    tokenUsage: threadEventTokenUsageSchema,
  }),
  providerEvent("thread/contextWindowUsage/updated", {
    contextWindowUsage: threadEventContextWindowUsageSchema,
  }),
  providerEvent("turn/plan/updated", {
    plan: z.array(threadEventPlanStepSchema),
    explanation: z.string().optional(),
  }),
  providerEvent("turn/diff/updated", {
    diff: z.string().optional(),
  }),
  providerEvent("provider/error", {
    message: z.string(),
    detail: z.string().optional(),
    willRetry: z.boolean().optional(),
    errorInfo: providerErrorInfoSchema.optional(),
  }),
  providerEvent("provider/rateLimits/updated", {
    rateLimits: providerRateLimitStateSchema,
  }),
  providerEvent("provider.env-resolved", {
    entries: z.array(
      z
        .object({
          name: z.string(),
          source: z.union([
            z.literal("shell"),
            z.object({ plugin: z.string() }).strict(),
            z
              .object({
                core: z.enum([
                  "machine-git",
                  "machine-environment",
                  "project-environment",
                ]),
              })
              .strict(),
          ]),
          value: z.union([
            z.string(),
            z.object({ masked: z.literal(true) }).strict(),
          ]),
          reason: z.string().optional(),
        })
        .strict(),
    ),
  }),
  providerEvent("thread/extensionState/updated", {
    kind: extensionKindSchema,
    payload: jsonValueSchema,
  }),
  providerEvent("provider/warning", {
    category: threadEventWarningCategorySchema,
    summary: z.string().optional(),
    details: z.string().optional(),
  }),
  providerEvent("provider/modelFallback", {
    originalModel: z.string().min(1),
    fallbackModel: z.string().min(1),
    reason: z.enum(["refusal", "provider"]),
    message: z.string(),
  }),
  providerUnhandledEventSchema,
]);
const scopedEventDataSchema = z.object({
  scope: threadEventScopeSchema,
});
const providerEventSchema = unscopedProviderEventSchema.and(
  scopedEventDataSchema,
);
const providerEventTypeValues = unscopedProviderEventSchema.options.map(
  (option) => option.shape.type.value,
);

const unscopedSystemEventSchema = z.discriminatedUnion("type", [
  systemEvent("client/thread/start", clientTurnLifecycleEventDataSchema),
  systemEvent("client/turn/requested", turnRequestEventDataSchema),
  systemEvent("client/turn/rejected", turnRequestRejectedEventDataSchema),
  systemEvent("client/turn/start", clientTurnLifecycleEventDataSchema),
  systemEvent("system/error", systemErrorEventDataSchema),
  systemEvent(
    "system/manager/user_message",
    systemLegacyUserMessageEventDataSchema,
  ),
  systemEvent(
    "system/thread/interrupted",
    systemThreadInterruptedEventDataSchema,
  ),
  systemEvent("system/operation", systemOperationEventDataSchema),
  systemEvent(
    "system/interaction/lifecycle",
    systemInteractionLifecycleEventDataSchema,
  ),
  systemEvent(
    "system/permissionGrant/lifecycle",
    systemPermissionGrantLifecycleEventDataSchema,
  ),
  systemEvent(
    "system/userQuestion/lifecycle",
    systemUserQuestionLifecycleEventDataSchema,
  ),
  systemEvent(
    "system/thread-provisioning",
    systemThreadProvisioningEventDataSchema,
  ),
  systemEvent(
    "system/provider-turn-watchdog",
    systemProviderTurnWatchdogEventDataSchema,
  ),
]);
const systemEventSchema = unscopedSystemEventSchema.and(scopedEventDataSchema);

export const threadEventSchema = z
  .union([providerEventSchema, systemEventSchema])
  .superRefine((event, ctx) => {
    const result = validateThreadEventScope({
      type: event.type,
      scope: event.scope,
    });
    if (!result.valid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: result.message ?? "Invalid thread event scope",
        path: ["scope"],
      });
      return;
    }
  });
export type ThreadEvent = z.infer<typeof threadEventSchema>;
export type ThreadEventType = ThreadEvent["type"];

export const threadEventTypeValues = [
  ...providerEventTypeValues,
  ...systemEventTypeValues,
] as const;
const threadEventTypeSet = new Set<string>(threadEventTypeValues);
export const threadEventTypeSchema = z
  .string()
  .refine(
    (value): value is ThreadEventType => threadEventTypeSet.has(value),
    "Invalid thread event type",
  );
