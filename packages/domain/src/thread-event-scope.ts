import { z } from "zod";
import type { ThreadEventType } from "./provider-event.js";

export const threadEventScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread") }),
  z.object({ kind: z.literal("turn"), turnId: z.string().min(1) }),
]);
export type ThreadEventScope = z.infer<typeof threadEventScopeSchema>;

type ThreadEventScopePolicy = "thread" | "turn" | "thread-or-turn";

interface ScopedEventType {
  scope: ThreadEventScope;
  type: ThreadEventType;
}

const scopePolicyByType: Record<ThreadEventType, ThreadEventScopePolicy> = {
  "thread/started": "thread",
  "thread/identity": "thread",
  "turn/started": "turn",
  "turn/completed": "turn",
  "turn/input/accepted": "turn",
  "thread/name/updated": "thread",
  "thread/compacted": "turn",
  "thread/context/cleared": "turn",
  "thread/goal/updated": "thread",
  "thread/goal/cleared": "thread",
  "item/started": "turn",
  "item/completed": "turn",
  "item/agentMessage/delta": "turn",
  "item/commandExecution/outputDelta": "turn",
  "item/fileChange/outputDelta": "turn",
  "item/reasoning/summaryTextDelta": "turn",
  "item/reasoning/textDelta": "turn",
  "item/plan/delta": "turn",
  "item/mcpToolCall/progress": "turn",
  "item/toolCall/progress": "turn",
  "item/backgroundTask/progress": "thread",
  "item/backgroundTask/completed": "thread",
  "item/delegation/progress": "thread",
  "item/delegation/completed": "thread",
  "thread/tokenUsage/updated": "turn",
  "thread/contextWindowUsage/updated": "thread-or-turn",
  "turn/plan/updated": "turn",
  "turn/diff/updated": "turn",
  "provider/error": "thread-or-turn",
  "provider/rateLimits/updated": "thread",
  "provider.env-resolved": "thread",
  "thread/extensionState/updated": "thread",
  "provider/warning": "thread-or-turn",
  "provider/modelFallback": "thread-or-turn",
  "provider/unhandled": "thread-or-turn",
  "client/thread/start": "thread",
  "client/turn/requested": "thread",
  "client/turn/rejected": "thread",
  "client/turn/start": "thread",
  "system/error": "thread-or-turn",
  "system/manager/user_message": "thread-or-turn",
  "system/thread/interrupted": "thread",
  "system/operation": "thread-or-turn",
  "system/interaction/lifecycle": "thread-or-turn",
  "system/permissionGrant/lifecycle": "turn",
  "system/userQuestion/lifecycle": "turn",
  "system/thread-provisioning": "thread",
  "system/provider-turn-watchdog": "thread",
};

export function threadScope(): ThreadEventScope {
  return { kind: "thread" };
}

export function turnScope(turnId: string): ThreadEventScope {
  return { kind: "turn", turnId };
}

export function getThreadEventScopeTurnId(
  scope: ThreadEventScope,
): string | undefined {
  return scope.kind === "turn" ? scope.turnId : undefined;
}

export function requireThreadEventScopeTurnId(args: ScopedEventType): string {
  if (args.scope.kind !== "turn") {
    throw new Error(
      `${args.type} requires turn scope but received ${args.scope.kind} scope`,
    );
  }
  return args.scope.turnId;
}

export function validateThreadEventScope(args: ScopedEventType): {
  message?: string;
  valid: boolean;
} {
  const policy = scopePolicyByType[args.type];
  const { kind } = args.scope;
  if (policy === "thread-or-turn" || policy === kind) return { valid: true };
  const message = `${args.type} requires ${policy} scope but received ${kind} scope`;
  return { valid: false, message };
}
