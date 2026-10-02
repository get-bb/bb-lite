import { z } from "zod";
import { pluginIdSchema } from "./plugin-id.js";
import { clientTurnRequestIdSchema } from "./protocol-ids.js";
import {
  systemMessageKindSchema,
  systemMessageSubjectSchema,
} from "./system-message.js";

export const queuedMessageWaitingOnKindValues = [
  "time",
  "thread-busy",
  "stopping",
  "turn-starting",
  "provisioning",
  "host-offline",
  "interaction",
  "plugin",
] as const;
export const queuedMessageWaitingOnKindSchema = z.enum(
  queuedMessageWaitingOnKindValues,
);
export type QueuedMessageWaitingOnKind = z.infer<
  typeof queuedMessageWaitingOnKindSchema
>;

export const queuedMessageWaitHostNameSchema = z.string().min(1).max(200);

export const QUEUED_MESSAGE_WAIT_REASON_MAX_LENGTH = 200;
export const queuedMessageWaitReasonSchema = z
  .string()
  .min(1)
  .max(QUEUED_MESSAGE_WAIT_REASON_MAX_LENGTH);

export const queuedMessageWaitingOnSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("time") }),
  z.object({ kind: z.literal("thread-busy") }),
  z.object({ kind: z.literal("stopping") }),
  z.object({ kind: z.literal("turn-starting") }),
  z.object({ kind: z.literal("provisioning") }),
  z.object({
    kind: z.literal("host-offline"),
    hostName: queuedMessageWaitHostNameSchema,
  }),
  z.object({ kind: z.literal("interaction") }),
  z.object({
    kind: z.literal("plugin"),
    pluginId: pluginIdSchema,
    reason: queuedMessageWaitReasonSchema,
  }),
]);
export type QueuedMessageWaitingOn = z.infer<
  typeof queuedMessageWaitingOnSchema
>;

export const QUEUED_MESSAGE_FAILURE_REASON_MAX_LENGTH = 200;
export const queuedMessageFailureReasonSchema = z
  .string()
  .min(1)
  .max(QUEUED_MESSAGE_FAILURE_REASON_MAX_LENGTH);

export const QUEUED_MESSAGE_PLUGIN_WAIT_HOLDER_PREFIX = "plugin:";

export const queuedMessageWaitHolderSchema = z.templateLiteral([
  QUEUED_MESSAGE_PLUGIN_WAIT_HOLDER_PREFIX,
  pluginIdSchema,
]);
export type QueuedMessageWaitHolder = z.infer<
  typeof queuedMessageWaitHolderSchema
>;

export const queuedMessagePayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inline") }),
  z.object({
    kind: z.literal("retry"),
    retryOfTurnRequestId: clientTurnRequestIdSchema,
    attempt: z.number().int().min(2),
    reason: queuedMessageWaitReasonSchema,
  }),
]);

export const queuedMessageSystemNoticeSchema = z.object({
  kind: systemMessageKindSchema,
  subject: systemMessageSubjectSchema.nullable(),
});
export type QueuedMessageSystemNotice = z.infer<
  typeof queuedMessageSystemNoticeSchema
>;
