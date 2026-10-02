import {
  jsonValueSchema,
  requireThreadEventScopeTurnId,
  type JsonObject,
  type ThreadEvent,
  type ThreadEventItemPresentation,
  type ThreadEventItemStatus,
} from "@bb/domain";
import type {
  TimelineActivityIntent,
  TimelineApprovalStatus,
  TimelineRowStatus,
} from "@bb/server-contract";
import {
  getEventParentToolCallId,
  getEventTurnId,
  type EventMeta,
  type FileEditChange,
  type ItemRowFields,
} from "./event-projection-types.js";
import {
  extractShellCommandFromString,
  parseShellCommandIntents,
} from "./tool-call-parsing.js";

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

export function itemStatusToExecStatus(
  status: ThreadEventItemStatus,
): TimelineRowStatus {
  return status === "failed" ? "error" : status;
}

interface ExecutionUpdateBase {
  callId: string;
  output?: string;
  completedAt: number | null;
  status?: TimelineRowStatus;
  parentToolCallId?: string;
  presentation?: ThreadEventItemPresentation;
}

interface CommandExecutionUpdate extends ExecutionUpdateBase {
  workKind: "command";
  command?: string;
  cwd?: string | null;
  activityIntents?: TimelineActivityIntent[];
  source?: string | null;
  exitCode?: number | null;
  approvalStatus?: TimelineApprovalStatus;
}

interface ToolCallExecutionUpdate extends ExecutionUpdateBase {
  workKind: "tool";
  toolName?: string;
  toolArgs?: JsonObject | null;
  approvalStatus?: TimelineApprovalStatus;
}

interface DelegationExecutionUpdate extends ExecutionUpdateBase {
  workKind: "delegation";
  toolName?: string;
  childRef?: string;
  background?: boolean;
  subagentType?: string;
  description?: string;
  model?: string;
}

export type ProviderExecutionUpdate =
  | CommandExecutionUpdate
  | ToolCallExecutionUpdate
  | DelegationExecutionUpdate;

export interface ExecutionOutputUpdate {
  callId: string;
  output: string;
  status?: TimelineRowStatus;
  parentToolCallId?: string;
}

export type ExecLifecycleEvent =
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
  const parent = parentToolCallId ? { parentToolCallId } : {};
  if (decoded.type === "item/commandExecution/outputDelta") {
    if (!decoded.itemId) return null;
    return {
      kind: "output",
      output: {
        callId: decoded.itemId,
        output: decoded.delta,
        status: "pending",
        ...parent,
      },
      ...(decoded.reset ? { replaceOutput: true } : { appendOutput: true }),
    };
  }
  if (
    (decoded.type !== "item/started" && decoded.type !== "item/completed") ||
    decoded.item.type !== "commandExecution" ||
    !decoded.item.id
  ) {
    return null;
  }
  const { item } = decoded;
  const kind = decoded.type === "item/started" ? "begin" : "end";
  const failedExit = item.exitCode !== undefined && item.exitCode !== 0;
  const command = extractShellCommandFromString(item.command);
  return {
    kind,
    call: {
      workKind: "command",
      callId: item.id,
      command,
      cwd: item.cwd,
      activityIntents: parseShellCommandIntents(command),
      output: item.aggregatedOutput,
      exitCode: item.exitCode,
      completedAt: kind === "end" ? meta.createdAt : null,
      approvalStatus: item.approvalStatus,
      status: failedExit ? "error" : itemStatusToExecStatus(item.status),
      ...(item.presentation ? { presentation: item.presentation } : {}),
      ...parent,
    },
  };
}

function parseDelegationItemLifecycleEvent(
  decoded: ThreadEvent,
  meta: EventMeta,
  parentToolCallId: string | undefined,
): ExecLifecycleEvent | null {
  if (
    (decoded.type !== "item/started" &&
      decoded.type !== "item/completed" &&
      decoded.type !== "item/delegation/progress" &&
      decoded.type !== "item/delegation/completed") ||
    decoded.item.type !== "delegation"
  ) {
    return null;
  }
  const { item } = decoded;
  const kind =
    decoded.type === "item/started" ||
    decoded.type === "item/delegation/progress"
      ? "begin"
      : "end";
  return {
    kind,
    call: {
      workKind: "delegation",
      callId: item.id,
      toolName: "delegation",
      childRef: item.childRef,
      background: item.background,
      description: item.label,
      output: item.summary,
      completedAt: kind === "end" ? meta.createdAt : null,
      status: kind === "end" ? itemStatusToExecStatus(item.status) : "pending",
      ...(item.presentation ? { presentation: item.presentation } : {}),
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
  const parent = parentToolCallId ? { parentToolCallId } : {};
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
        ...parent,
      },
    };
  }
  const delegationEvent = parseDelegationItemLifecycleEvent(
    decoded,
    meta,
    parentToolCallId,
  );
  if (delegationEvent) return delegationEvent;
  if (
    (decoded.type !== "item/started" && decoded.type !== "item/completed") ||
    decoded.item.type !== "toolCall" ||
    !decoded.item.id
  ) {
    return null;
  }
  const { item } = decoded;
  const ended = decoded.type === "item/completed";
  const result =
    typeof item.result === "string"
      ? item.result
      : item.result !== undefined
        ? JSON.stringify(item.result)
        : undefined;
  return {
    kind: ended ? "end" : "begin",
    call: {
      workKind: "tool",
      callId: item.id,
      toolName: `${item.server ? `${item.server}:` : ""}${item.tool}`,
      output: ended ? (result ?? item.error) : undefined,
      completedAt: ended ? meta.createdAt : null,
      status: ended ? itemStatusToExecStatus(item.status) : "pending",
      toolArgs: parseToolArgs(item.arguments ?? null),
      ...(item.presentation ? { presentation: item.presentation } : {}),
      ...parent,
    },
  };
}

export interface ItemLifecycleEvent {
  kind: "begin" | "end";
  parentToolCallId?: string;
  row: ItemRowFields;
}

export function parseItemLifecycleEvent(
  decoded: ThreadEvent,
  meta: EventMeta,
  parentToolCallIdOverride?: string,
): ItemLifecycleEvent | null {
  if (
    (decoded.type !== "item/started" && decoded.type !== "item/completed") ||
    !decoded.item.id
  ) {
    return null;
  }
  const parentToolCallId =
    parentToolCallIdOverride ?? getEventParentToolCallId(decoded);
  const { item } = decoded;
  const ended = decoded.type === "item/completed";
  const settled = (status?: ThreadEventItemStatus): TimelineRowStatus => {
    if (!ended) return "pending";
    return status === undefined || status === "pending"
      ? "completed"
      : itemStatusToExecStatus(status);
  };
  const callId = item.id;
  const completedAt = ended ? meta.createdAt : null;
  const presented =
    "presentation" in item && item.presentation
      ? { presentation: item.presentation }
      : {};
  const event = (row: ItemRowFields): ItemLifecycleEvent => ({
    kind: ended ? "end" : "begin",
    ...(parentToolCallId ? { parentToolCallId } : {}),
    row,
  });
  switch (item.type) {
    case "webSearch":
      return event({
        workKind: "web-search",
        status: settled(),
        callId,
        queries: item.queries,
        completedAt,
        ...presented,
      });
    case "webFetch":
      return event({
        workKind: "web-fetch",
        status: settled(),
        callId,
        url: item.url,
        prompt: item.prompt,
        pattern: item.pattern,
        completedAt,
        ...presented,
      });
    case "imageView":
      return event({
        workKind: "image-view",
        status: settled(),
        callId,
        path: item.path,
        completedAt,
        ...presented,
      });
    case "imageGeneration":
      return event({
        workKind: "image-generation",
        status: settled(item.status),
        callId,
        prompt: item.prompt,
        path: item.path,
        error: item.error,
        transparentBackground: item.transparentBackground,
        completedAt,
        ...presented,
      });
    case "fileRead":
      return event({
        workKind: "file-read",
        status: settled(item.status),
        callId,
        path: item.path,
        cmd: item.cmd ?? null,
        completedAt,
        ...presented,
      });
    case "search":
      return event({
        workKind: "search",
        status: settled(item.status),
        callId,
        mode: item.mode,
        query: item.query,
        path: item.path ?? null,
        cmd: item.cmd ?? null,
        completedAt,
        ...presented,
      });
    case "planSteps":
      return event({
        workKind: "plan-steps",
        status: settled(item.status),
        callId,
        steps: item.steps,
        explanation: item.explanation ?? null,
        completedAt,
        ...presented,
      });
    case "extension":
      return event({
        workKind: "extension",
        status: settled(item.status),
        callId,
        extensionKind: item.kind,
        payload: item.payload,
        completedAt,
        presentation: item.presentation,
      });
    default:
      return null;
  }
}

interface FileEditPartialBase {
  callId: string;
  parentToolCallId?: string;
}

interface FileEditOutputPartial extends FileEditPartialBase {
  stdout: string;
  status: "pending";
}

interface FileEditChangesPartial extends FileEditPartialBase {
  changes: FileEditChange[];
  approvalStatus: TimelineApprovalStatus;
  status: TimelineRowStatus;
  presentation?: ThreadEventItemPresentation;
}

export type FileEditPartial = FileEditOutputPartial | FileEditChangesPartial;

export function parseFileEditFromItemEvent(
  decoded: ThreadEvent,
  parentToolCallIdOverride?: string,
): FileEditPartial | null {
  const parentToolCallId =
    parentToolCallIdOverride ?? getEventParentToolCallId(decoded);
  const parent = parentToolCallId ? { parentToolCallId } : {};
  if (decoded.type === "item/fileChange/outputDelta") {
    if (!decoded.itemId) return null;
    return {
      callId: decoded.itemId,
      stdout: decoded.delta,
      status: "pending",
      ...parent,
    };
  }
  if (
    (decoded.type !== "item/started" && decoded.type !== "item/completed") ||
    decoded.item.type !== "fileChange" ||
    !decoded.item.id
  ) {
    return null;
  }
  const { item } = decoded;
  return {
    callId: item.id,
    changes: item.changes.map((change) => ({
      path: change.path,
      kind: change.kind,
      movePath: change.movePath ?? null,
      diff: change.diff,
    })),
    approvalStatus: item.approvalStatus,
    status: itemStatusToExecStatus(item.status),
    ...(item.presentation ? { presentation: item.presentation } : {}),
    ...parent,
  };
}

export interface CompactionLifecycleEvent {
  key: string;
  kind: "begin" | "end";
  detail?: string;
  parentToolCallId?: string;
}

function getCompactionKey(decoded: ThreadEvent, meta: EventMeta): string {
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
  const compactionItem =
    (decoded.type === "item/started" || decoded.type === "item/completed") &&
    decoded.item.type === "contextCompaction";
  if (!compactionItem && decoded.type !== "thread/compacted") return null;
  return {
    key: getCompactionKey(decoded, meta),
    kind: decoded.type === "item/started" ? "begin" : "end",
    ...(parentToolCallId ? { parentToolCallId } : {}),
  };
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
