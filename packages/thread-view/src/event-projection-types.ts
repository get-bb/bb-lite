import {
  getThreadEventScopeTurnId,
  threadScope,
  turnScope,
  type ActiveThinking,
  type ProviderErrorInfo,
  type ProvisioningTranscriptEntry,
  type Thread,
  type ThreadEvent,
  type ThreadEventItemPresentation,
  type ThreadEventScope,
} from "@bb/domain";
import type {
  TimelineApprovalStatus,
  TimelineApprovalWorkRow,
  TimelineParentChange,
  TimelineRowBase,
  TimelineRowStatus,
  TimelineUserConversationRow,
  TimelineWorkRow,
  TimelineWorkflowWorkRow,
} from "@bb/server-contract";

export type EventMeta = { id: string; seq: number; createdAt: number };

export type ThreadEventWithMeta = { event: ThreadEvent; meta: EventMeta };

export interface ProjectionOptions {
  includeDiagnosticOperations: boolean;
  threadStatus: Thread["status"];
  threadName: string;
}

export function getEventTurnId(decoded: ThreadEvent): string | undefined {
  return getThreadEventScopeTurnId(decoded.scope);
}

export function getEventProviderThreadId(
  decoded: ThreadEvent,
): string | undefined {
  if (decoded.type === "system/provider-turn-watchdog") return undefined;
  return "providerThreadId" in decoded
    ? (decoded.providerThreadId ?? undefined)
    : undefined;
}

export function getEventParentToolCallId(
  decoded: ThreadEvent,
): string | undefined {
  if ("item" in decoded) return decoded.item.parentToolCallId;
  return "parentToolCallId" in decoded ? decoded.parentToolCallId : undefined;
}

export function scopeForTurn(turnId: string | undefined): ThreadEventScope {
  return turnId ? turnScope(turnId) : threadScope();
}

export function areThreadEventScopesEqual(
  left: ThreadEventScope,
  right: ThreadEventScope,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "thread") return true;
  return right.kind === "turn" && left.turnId === right.turnId;
}

interface MessageBase {
  id: string;
  threadId: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  createdAt: number;
  scope: ThreadEventScope;
  startedAt?: number;
  parentToolCallId?: string;
}

type RowFields<Row> = Row extends unknown
  ? Omit<Row, keyof TimelineRowBase | "kind">
  : never;

type WorkRow<Kind extends TimelineWorkRow["workKind"]> = Extract<
  TimelineWorkRow,
  { workKind: Kind }
>;

type ItemRow = WorkRow<
  | "web-search"
  | "web-fetch"
  | "image-view"
  | "image-generation"
  | "file-read"
  | "search"
  | "plan-steps"
  | "extension"
>;

type InteractionRow =
  | Extract<TimelineApprovalWorkRow, { approvalKind: "permission-grant" }>
  | WorkRow<"question" | "form">;

export type ItemRowFields = RowFields<ItemRow>;

type UserRowFields = RowFields<TimelineUserConversationRow>;

export type UserMessage = MessageBase & { kind: "user" } & UserRowFields;

export interface AssistantMessage extends MessageBase {
  kind: "assistant-text";
  text: string;
  status: "streaming" | "completed";
}

type CommandRowFields = RowFields<WorkRow<"command">>;

type ToolRowFields = RowFields<WorkRow<"tool">>;

type CommandMessage = MessageBase & { kind: "exec" } & CommandRowFields;

export type ToolCallMessage = MessageBase & { kind: "exec" } & ToolRowFields;

export interface DelegationMessage extends MessageBase {
  kind: "exec";
  workKind: "delegation";
  status: TimelineRowStatus;
  callId: string;
  toolName: string;
  childRef: string | null;
  background: boolean;
  subagentType?: string;
  description?: string;
  model?: string;
  output: string;
  completedAt: number | null;
  children: Message[];
  presentation?: ThreadEventItemPresentation;
}

export type ExecMessage = CommandMessage | ToolCallMessage | DelegationMessage;

export type ItemMessage = MessageBase & { kind: "item" } & ItemRowFields;

export type InteractionMessage = MessageBase & {
  kind: "interaction";
} & RowFields<InteractionRow>;

export interface FileEditChange {
  path: string;
  kind?: string;
  movePath?: string | null;
  diff?: string;
}

export interface FileEditMessage extends MessageBase {
  kind: "file-edit";
  callId: string;
  changes: FileEditChange[];
  stdout?: string;
  approvalStatus: TimelineApprovalStatus;
  status: TimelineRowStatus;
  presentation?: ThreadEventItemPresentation;
}

export interface OperationMessage extends MessageBase {
  kind: "operation";
  opType:
    | "reasoning"
    | "provider-environment"
    | "warning"
    | "deprecation"
    | "thread-interrupted"
    | "thread-provisioning"
    | "operation"
    | "compaction"
    | "context-clear";
  title: string;
  detail?: string;
  status: TimelineRowStatus;
  completedAt: number | null;
  mergeKey?: string;
  transcript?: ProvisioningTranscriptEntry[];
  parentChange?: TimelineParentChange | null;
}

export type WorkflowMessage = MessageBase & {
  kind: "workflow";
  familyId: string | null;
  skipTranscript: boolean;
} & Omit<RowFields<TimelineWorkflowWorkRow>, "workKind">;

export interface ErrorMessage extends MessageBase {
  kind: "error";
  message: string;
  detail: string | null;
  rawType: string;
  providerErrorInfo?: ProviderErrorInfo;
  willRetry?: boolean;
}

export type Message =
  | UserMessage
  | AssistantMessage
  | ExecMessage
  | ItemMessage
  | FileEditMessage
  | OperationMessage
  | InteractionMessage
  | WorkflowMessage
  | ErrorMessage;

export interface ProjectedTurn {
  turnId: string;
  threadId: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  startedAt: number;
  createdAt: number;
  completedAt: number | null;
  status: TimelineRowStatus;
  externalUserBoundarySeqs?: number[];
  messages: Message[];
}

export type ProjectionEntry =
  | { kind: "projected-message"; message: Message }
  | { kind: "turn"; turn: ProjectedTurn };

export interface Projection {
  entries: ProjectionEntry[];
  activeThinking: ActiveThinking | null;
  activeWorkflows: WorkflowMessage[];
  activeBackgroundCommands: WorkflowMessage[];
}

export function extendMessageBounds(
  target: { sourceSeqEnd: number; createdAt: number },
  sourceSeqEnd: number,
  createdAt: number,
): void {
  target.sourceSeqEnd = Math.max(target.sourceSeqEnd, sourceSeqEnd);
  target.createdAt = Math.max(target.createdAt, createdAt);
}

export interface VisibleTextBuffer {
  visible: string;
  pending: string;
}

export function createVisibleTextBuffer(): VisibleTextBuffer {
  return { visible: "", pending: "" };
}

export function appendVisibleText(
  buffer: VisibleTextBuffer,
  delta: string,
): void {
  const lastNewline = delta.lastIndexOf("\n");
  if (lastNewline === -1) {
    buffer.pending += delta;
    return;
  }
  buffer.visible += buffer.pending + delta.slice(0, lastNewline + 1);
  buffer.pending = delta.slice(lastNewline + 1);
}

export function setVisibleText(
  buffer: VisibleTextBuffer,
  text: string,
  showTrailingPartial: boolean,
): void {
  const cut = showTrailingPartial ? text.length : text.lastIndexOf("\n") + 1;
  buffer.visible = text.slice(0, cut);
  buffer.pending = text.slice(cut);
}

export function flushVisibleText(buffer: VisibleTextBuffer): boolean {
  if (buffer.pending === "") return false;
  buffer.visible += buffer.pending;
  buffer.pending = "";
  return true;
}
