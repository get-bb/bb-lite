import {
  jsonValueSchema,
  type JsonObject,
  ThreadEvent,
  ThreadEventItemPresentation,
  ThreadEventItemStatus,
  type ExtensionKind,
  type JsonValue,
  type ThreadEventPlanStep,
  type ThreadEventSearchMode,
  type ThreadEventFileChange,
  requireThreadEventScopeTurnId,
} from "@bb/domain";
import {
  getEventParentToolCallId,
  type EventMeta,
  type EventProjectionApprovalLifecycleStatus,
  type EventProjectionToolCallMessage,
  type EventProjectionToolParsedIntent,
  type EventProjectionFileEditChange,
  type EventProjectionFileEditMessage,
  getEventTurnId,
} from "./event-projection-types.js";
import {
  extractShellCommandFromString,
  parseShellCommandIntents,
} from "./tool-call-parsing.js";

interface DelegationMetadata {
  subagentType?: string;
  description?: string;
  model?: string;
}

function parseToolArgs(
  args: Record<string, unknown> | null,
): JsonObject | null {
  if (!args) return null;
  const toolArgs: JsonObject = {};
  for (const [key, value] of Object.entries(args)) {
    toolArgs[key] = jsonValueSchema.parse(value);
  }
  return toolArgs;
}

type ExecItemViewStatus = EventProjectionToolCallMessage["status"];

export function itemStatusToExecStatus(
  status: ThreadEventItemStatus,
): ExecItemViewStatus {
  return status === "failed" ? "error" : status;
}

interface ExecutionUpdateBase {
  callId: string;
  output?: string;
  completedAt: number | null;
  status?: EventProjectionToolCallMessage["status"];
  parentToolCallId?: string;
  presentation?: ThreadEventItemPresentation;
}

export interface CommandExecutionUpdate extends ExecutionUpdateBase {
  kind: "command";
  command?: string;
  cwd?: string | null;
  parsedIntents?: EventProjectionToolParsedIntent[];
  source?: string | null;
  exitCode?: number | null;
  approvalStatus?: EventProjectionApprovalLifecycleStatus | null;
}

export interface ToolCallExecutionUpdate extends ExecutionUpdateBase {
  kind: "tool-call";
  toolName?: string;
  toolArgs?: JsonObject | null;
  approvalStatus?: EventProjectionApprovalLifecycleStatus | null;
}

export interface DelegationExecutionUpdate
  extends ExecutionUpdateBase, DelegationMetadata {
  kind: "delegation";
  toolName?: string;
  childRef?: string;
  background?: boolean;
}

export type ProviderExecutionUpdate =
  | CommandExecutionUpdate
  | ToolCallExecutionUpdate
  | DelegationExecutionUpdate;

export interface ExecutionOutputUpdate {
  callId: string;
  output: string;
  status?: EventProjectionToolCallMessage["status"];
  parentToolCallId?: string;
}

type ExecLifecycleEvent =
  | { kind: "begin" | "end"; call: ProviderExecutionUpdate }
  | {
      kind: "output";
      output: ExecutionOutputUpdate;
      appendOutput?: boolean;
      replaceOutput?: boolean;
    };

export function parseExecLifecycleEvent(
  decoded: ThreadEvent,
  meta: EventMeta,
  parentToolCallIdOverride?: string,
): ExecLifecycleEvent | null {
  const parentToolCallId =
    parentToolCallIdOverride ?? getEventParentToolCallId(decoded);
  if (decoded.type === "item/commandExecution/outputDelta") {
    const callId = decoded.itemId;
    if (!callId) return null;
    return {
      kind: "output",
      output: {
        callId,
        output: decoded.delta,
        status: "pending",
        ...(parentToolCallId ? { parentToolCallId } : {}),
      },
      ...(decoded.reset ? { replaceOutput: true } : { appendOutput: true }),
    };
  }
  if (
    (decoded.type === "item/started" || decoded.type === "item/completed") &&
    decoded.item.type === "commandExecution"
  ) {
    const callId = decoded.item.id;
    if (!callId) return null;
    const kind = decoded.type === "item/started" ? "begin" : "end";
    const exitCode = decoded.item.exitCode;
    const status =
      exitCode !== undefined && exitCode !== 0
        ? "error"
        : itemStatusToExecStatus(decoded.item.status);
    const completedAt = kind === "end" ? meta.createdAt : null;
    const command = extractShellCommandFromString(decoded.item.command);
    const presentation = decoded.item.presentation;
    return {
      kind,
      call: {
        kind: "command",
        callId,
        command,
        cwd: decoded.item.cwd,
        parsedIntents: parseShellCommandIntents(command),
        output: decoded.item.aggregatedOutput,
        exitCode,
        completedAt,
        approvalStatus: decoded.item.approvalStatus,
        status,
        ...(presentation ? { presentation } : {}),
        ...(parentToolCallId ? { parentToolCallId } : {}),
      },
    };
  }
  return null;
}

export const DELEGATION_ITEM_TOOL_NAME = "delegation";

function parseDelegationItemLifecycleEvent(
  decoded: ThreadEvent,
  meta: EventMeta,
  parentToolCallId: string | undefined,
): ExecLifecycleEvent | null {
  if (
    decoded.type !== "item/started" &&
    decoded.type !== "item/completed" &&
    decoded.type !== "item/delegation/progress" &&
    decoded.type !== "item/delegation/completed"
  ) {
    return null;
  }
  if (decoded.item.type !== "delegation") return null;
  const kind =
    decoded.type === "item/started" ||
    decoded.type === "item/delegation/progress"
      ? "begin"
      : "end";
  const status =
    kind === "end" ? itemStatusToExecStatus(decoded.item.status) : "pending";
  const presentation = decoded.item.presentation;
  return {
    kind,
    call: {
      kind: "delegation",
      callId: decoded.item.id,
      toolName: DELEGATION_ITEM_TOOL_NAME,
      childRef: decoded.item.childRef,
      background: decoded.item.background,
      description: decoded.item.label,
      output: decoded.item.summary,
      completedAt: kind === "end" ? meta.createdAt : null,
      status,
      ...(presentation ? { presentation } : {}),
      ...(parentToolCallId ? { parentToolCallId } : {}),
    },
  };
}

export function parseToolCallLifecycleEvent(
  decoded: ThreadEvent,
  meta: EventMeta,
  parentToolCallIdOverride?: string,
): ExecLifecycleEvent | null {
  const parentToolCallId =
    parentToolCallIdOverride ?? getEventParentToolCallId(decoded);
  if (
    decoded.type === "item/toolCall/progress" ||
    decoded.type === "item/mcpToolCall/progress"
  ) {
    return {
      kind: "output",
      output: {
        callId: decoded.itemId,
        output: decoded.message ?? "Progress update",
        status: "pending",
        ...(parentToolCallId ? { parentToolCallId } : {}),
      },
    };
  }
  const delegationEvent = parseDelegationItemLifecycleEvent(
    decoded,
    meta,
    parentToolCallId,
  );
  if (delegationEvent) return delegationEvent;
  if (decoded.type === "item/started" || decoded.type === "item/completed") {
    if (decoded.item.type !== "toolCall") return null;
    const callId = decoded.item.id;
    if (!callId) return null;
    const toolName = decoded.item.tool;
    const serverPrefix = decoded.item.server ? `${decoded.item.server}:` : "";
    const fullToolName = `${serverPrefix}${toolName}`;
    const parsedArgs = decoded.item.arguments ?? null;
    const kind = decoded.type === "item/started" ? "begin" : "end";
    const status =
      kind === "end" ? itemStatusToExecStatus(decoded.item.status) : "pending";
    const completedAt = kind === "end" ? meta.createdAt : null;
    const result = decoded.item.result;
    const output =
      typeof result === "string"
        ? result
        : result !== undefined
          ? JSON.stringify(result)
          : undefined;
    const errorField = decoded.item.error;
    const toolArgs = parseToolArgs(parsedArgs);
    const presentation = decoded.item.presentation;
    return {
      kind,
      call: {
        kind: "tool-call",
        callId,
        toolName: fullToolName,
        output: kind === "end" ? (output ?? errorField) : undefined,
        completedAt,
        status,
        toolArgs,
        ...(presentation ? { presentation } : {}),
        ...(parentToolCallId ? { parentToolCallId } : {}),
      },
    };
  }
  return null;
}

type StatusedItemActivity = { status: ThreadEventItemStatus };

export type WebActivityLifecycleEvent = {
  kind: "begin" | "end";
  callId: string;
  parentToolCallId?: string;
  presentation?: ThreadEventItemPresentation;
} & (
  | { itemKind: "web-search"; queries: string[] }
  | {
      itemKind: "web-fetch";
      url: string;
      prompt: string | null;
      pattern: string | null;
    }
  | { itemKind: "image-view"; path: string }
  | (StatusedItemActivity & {
      itemKind: "image-generation";
      prompt: string | null;
      path: string | null;
      error: string | null;
      transparentBackground: boolean;
    })
  | (StatusedItemActivity & {
      itemKind: "file-read";
      path: string;
      cmd: string | null;
    })
  | (StatusedItemActivity & {
      itemKind: "search";
      mode: ThreadEventSearchMode;
      query: string;
      path: string | null;
      cmd: string | null;
    })
  | (StatusedItemActivity & {
      itemKind: "plan-steps";
      steps: ThreadEventPlanStep[];
      explanation: string | null;
    })
  | (StatusedItemActivity & {
      itemKind: "extension";
      extensionKind: ExtensionKind;
      payload: JsonValue;
      presentation: ThreadEventItemPresentation;
    })
);

export function parseWebActivityLifecycleEvent(
  decoded: ThreadEvent,
  parentToolCallIdOverride?: string,
): WebActivityLifecycleEvent | null {
  if (decoded.type !== "item/started" && decoded.type !== "item/completed") {
    return null;
  }
  const parentToolCallId =
    parentToolCallIdOverride ?? getEventParentToolCallId(decoded);
  const item = decoded.item;
  const callId = item.id;
  if (!callId) return null;
  const kind = decoded.type === "item/started" ? "begin" : "end";
  const base = {
    kind,
    callId,
    ...(parentToolCallId ? { parentToolCallId } : {}),
    ...("presentation" in item && item.presentation
      ? { presentation: item.presentation }
      : {}),
  } as const;
  switch (item.type) {
    case "webSearch":
      return { ...base, itemKind: "web-search", queries: item.queries };
    case "webFetch":
      return {
        ...base,
        itemKind: "web-fetch",
        url: item.url,
        prompt: item.prompt,
        pattern: item.pattern,
      };
    case "imageView":
      return { ...base, itemKind: "image-view", path: item.path };
    case "imageGeneration":
      return {
        ...base,
        itemKind: "image-generation",
        prompt: item.prompt,
        path: item.path,
        error: item.error,
        transparentBackground: item.transparentBackground,
        status: item.status,
      };
    case "fileRead":
      return {
        ...base,
        itemKind: "file-read",
        path: item.path,
        cmd: item.cmd ?? null,
        status: item.status,
      };
    case "search":
      return {
        ...base,
        itemKind: "search",
        mode: item.mode,
        query: item.query,
        path: item.path ?? null,
        cmd: item.cmd ?? null,
        status: item.status,
      };
    case "planSteps":
      return {
        ...base,
        itemKind: "plan-steps",
        steps: item.steps,
        explanation: item.explanation ?? null,
        status: item.status,
      };
    case "extension":
      return {
        ...base,
        itemKind: "extension",
        extensionKind: item.kind,
        payload: item.payload,
        status: item.status,
        presentation: item.presentation,
      };
    default:
      return null;
  }
}

function mapFileChanges(
  changes: ThreadEventFileChange[],
): EventProjectionFileEditChange[] {
  return changes.map((change) => ({
    path: change.path,
    kind: change.kind,
    movePath: change.movePath ?? null,
    diff: change.diff,
  }));
}

type FileEditStatus = EventProjectionFileEditMessage["status"];

type FileEditPartialBase = { callId: string; parentToolCallId?: string };

interface FileEditOutputPartial extends FileEditPartialBase {
  stdout: string;
  appendStdout: true;
  status: Extract<FileEditStatus, "pending">;
}

interface FileEditChangesPartial extends FileEditPartialBase {
  changes: EventProjectionFileEditChange[];
  approvalStatus: EventProjectionApprovalLifecycleStatus | null;
  status: FileEditStatus;
  presentation?: ThreadEventItemPresentation;
}

export type FileEditPartial = FileEditOutputPartial | FileEditChangesPartial;

export function parseFileEditFromItemEvent(
  decoded: ThreadEvent,
  parentToolCallIdOverride?: string,
): FileEditPartial | null {
  const parentToolCallId =
    parentToolCallIdOverride ?? getEventParentToolCallId(decoded);
  if (decoded.type === "item/fileChange/outputDelta") {
    const callId = decoded.itemId;
    if (!callId) return null;
    return {
      callId,
      stdout: decoded.delta,
      appendStdout: true,
      status: "pending",
      ...(parentToolCallId ? { parentToolCallId } : {}),
    };
  }
  if (decoded.type !== "item/started" && decoded.type !== "item/completed") {
    return null;
  }
  if (decoded.item.type !== "fileChange") return null;
  const callId = decoded.item.id;
  if (!callId) return null;
  const changes = mapFileChanges(decoded.item.changes);
  return {
    callId,
    changes,
    approvalStatus: decoded.item.approvalStatus,
    status: itemStatusToExecStatus(decoded.item.status),
    ...(decoded.item.presentation
      ? { presentation: decoded.item.presentation }
      : {}),
    ...(parentToolCallId ? { parentToolCallId } : {}),
  };
}

export interface CompactionLifecycleEvent {
  key: string;
  kind: "begin" | "end";
  detail?: string;
  parentToolCallId?: string;
}

export function getCompactionKey(
  decoded: ThreadEvent,
  meta: EventMeta,
): string {
  if (decoded.type === "thread/compacted") {
    return requireThreadEventScopeTurnId(decoded);
  }
  const turnId = getEventTurnId(decoded);
  if (decoded.type === "item/started" || decoded.type === "item/completed") {
    return turnId ?? decoded.item.id;
  }
  return turnId ?? `seq-${meta.seq}`;
}

export function parseCompactionLifecycleEvent(
  decoded: ThreadEvent,
  meta: EventMeta,
  parentToolCallId: string | undefined,
): CompactionLifecycleEvent | null {
  if (
    (decoded.type === "item/started" || decoded.type === "item/completed") &&
    decoded.item.type === "contextCompaction"
  ) {
    return {
      key: getCompactionKey(decoded, meta),
      kind: decoded.type === "item/started" ? "begin" : "end",
      ...(parentToolCallId ? { parentToolCallId } : {}),
    };
  }
  if (decoded.type === "thread/compacted") {
    return {
      key: getCompactionKey(decoded, meta),
      kind: "end",
      ...(parentToolCallId ? { parentToolCallId } : {}),
    };
  }
  return null;
}

export function shouldSuppressLowValueToolCall(decoded: ThreadEvent): boolean {
  if (decoded.type !== "item/started" && decoded.type !== "item/completed") {
    return false;
  }
  const item = decoded.item;
  switch (item.type) {
    case "toolCall":
    case "fileRead":
    case "search":
    case "planSteps":
    case "extension":
    case "delegation":
    case "fileChange":
      if (item.presentation?.suppress !== true) return false;
      return item.status === "pending" || item.status === "completed";
    default:
      return false;
  }
}
