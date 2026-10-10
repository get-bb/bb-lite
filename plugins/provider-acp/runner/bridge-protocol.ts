import { z } from "zod";
import { acpSessionUpdateSchema, acpStopReasonSchema } from "./wire.js";

export type {
  AcpNativeReasoning as AcpBridgeNativeReasoning,
  AcpPermissionCli as AcpBridgePermissionCli,
  AcpReasoningCli as AcpBridgeReasoningCli,
} from "../src/launch-spec.js";

export const ACP_DEFAULT_MODEL_ID = "acp-default";

export const ACP_TURN_STARTED_METHOD = "acp/turn/started";
export const ACP_TURN_COMPLETED_METHOD = "acp/turn/completed";
export const ACP_COMPACTION_STARTED_METHOD = "acp/compaction/started";
export const ACP_COMPACTION_COMPLETED_METHOD = "acp/compaction/completed";
export const ACP_UPDATE_METHOD = "acp/update";
export const ACP_FS_WRITE_METHOD = "acp/fs/write";
export const ACP_WARNING_METHOD = "acp/warning";

export const acpTurnStartedNotificationParamsSchema = z
  .object({
    threadId: z.string().min(1),
  })
  .passthrough();

export const acpTurnCompletedNotificationParamsSchema = z
  .object({
    threadId: z.string().min(1),
    stopReason: acpStopReasonSchema,
  })
  .passthrough();

export const acpCompactionCompletedNotificationParamsSchema =
  z.discriminatedUnion("status", [
    z
      .object({
        threadId: z.string().min(1),
        status: z.literal("completed"),
      })
      .passthrough(),
    z
      .object({
        threadId: z.string().min(1),
        status: z.literal("interrupted"),
      })
      .passthrough(),
    z
      .object({
        threadId: z.string().min(1),
        status: z.literal("skipped"),
        detail: z.string().min(1),
      })
      .passthrough(),
    z
      .object({
        threadId: z.string().min(1),
        status: z.literal("failed"),
        error: z.string().min(1),
      })
      .passthrough(),
  ]);

export const acpUpdateNotificationParamsSchema = z
  .object({
    threadId: z.string().min(1),
    update: acpSessionUpdateSchema,
  })
  .passthrough();

export const acpFsWriteNotificationParamsSchema = z
  .object({
    threadId: z.string().min(1),
    path: z.string().min(1),
    kind: z.enum(["add", "update"]),
    oldText: z.string().optional(),
    content: z.string(),
  })
  .passthrough();

export const acpWarningNotificationParamsSchema = z
  .object({
    threadId: z.string().min(1),
    summary: z.string().min(1),
    details: z.string().optional(),
  })
  .passthrough();
