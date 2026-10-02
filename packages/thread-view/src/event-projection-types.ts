import {
  getThreadEventScopeTurnId,
  type ThreadEvent,
  type ActiveThinking,
  type BackgroundTaskStatus,
  type BackgroundTaskUsage,
  type ExtensionKind,
  type JsonObject,
  type JsonValue,
  type OwnershipChangeOperationMetadata,
  type PendingInteractionUserAnswer,
  type PendingInteractionUserQuestionQuestion,
  type ProviderErrorInfo,
  type PromptTextMention,
  type SystemMessageKind,
  type SystemMessageSubject,
  type Thread,
  type ThreadEventItemPresentation,
  type ThreadEventPlanStep,
  type ThreadEventScope,
  type ThreadEventSearchMode,
  type ThreadTurnInitiator,
  type WorkflowProgressSnapshot,
  threadScope,
  turnScope,
} from "@bb/domain";
import type { AcceptedClientRequestContext } from "./user-message-parsing.js";

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

export type EventMeta = { id: string; seq: number; createdAt: number };

export type EventProjectionTurnStatus =
  | "pending"
  | "completed"
  | "error"
  | "interrupted";

export type EventProjectionTurnMessageDetail = "summary" | "full";

export interface BuildEventProjectionOptions extends BuildEventProjectionMessagesOptions {
  acceptedClientRequestContext?: AcceptedClientRequestContext;
  turnMessageDetail: EventProjectionTurnMessageDetail;
}

export type EventProjectionEntry =
  | { kind: "projected-message"; message: EventProjectionMessage }
  | { kind: "turn"; turn: EventProjectionTurn };

export interface EventProjectionTurn {
  turnId: string;
  threadId: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  startedAt: number;
  createdAt: number;
  completedAt: number | null;
  status: EventProjectionTurnStatus;
  summaryCount: number;
  externalUserBoundarySeqs?: number[];
  terminalMessage?: EventProjectionMessage;
  messages?: EventProjectionMessage[];
}

export interface EventProjection {
  entries: EventProjectionEntry[];
  state: {
    activeThinking: ActiveThinking | null;
    activeWorkflows: EventProjectionWorkflowMessage[];
    activeBackgroundCommands: EventProjectionWorkflowMessage[];
  };
}

type EventProjectionItemActivityStatus =
  | "pending"
  | "completed"
  | "error"
  | "interrupted";

type EventProjectionWebActivityStatus = Exclude<
  EventProjectionItemActivityStatus,
  "error"
>;

export type EventProjectionApprovalLifecycleStatus =
  | "waiting_for_approval"
  | "denied";

export type EventProjectionPermissionGrantLifecycle =
  | "pending"
  | "resolving"
  | "granted"
  | "denied"
  | "interrupted";

export type EventProjectionUserQuestionLifecycle =
  | "pending"
  | "resolving"
  | "answered"
  | "interrupted";

export type EventProjectionPluginFormLifecycle =
  | "pending"
  | "submitted"
  | "cancelled";

export interface EventProjectionMessageBase {
  id: string;
  threadId: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  createdAt: number;
  scope: ThreadEventScope;
  startedAt?: number;
  parentToolCallId?: string;
}

interface EventProjectionPresentedMessage extends EventProjectionMessageBase {
  presentation?: ThreadEventItemPresentation;
}

export type EventProjectionTurnRequestKind = "message" | "steer";

export interface EventProjectionTurnRequest {
  isGrouped: boolean;
  kind: EventProjectionTurnRequestKind;
  status: "pending" | "accepted" | "rejected";
}

export interface EventProjectionUserMessage extends EventProjectionMessageBase {
  kind: "user";
  initiator: ThreadTurnInitiator;
  senderThreadId: string | null;
  systemMessageKind: SystemMessageKind;
  systemMessageSubject: SystemMessageSubject | null;
  turnRequest: EventProjectionTurnRequest;
  text: string;
  mentions: PromptTextMention[];
  attachments?: {
    webImages: number;
    localImages: number;
    localFiles: number;
    imageUrls?: string[];
    localImagePaths?: string[];
    localFilePaths?: string[];
  };
}

export interface EventProjectionAssistantTextMessage extends EventProjectionMessageBase {
  kind: "assistant-text";
  text: string;
  status: "streaming" | "completed";
}

export type EventProjectionToolParsedIntent =
  | { type: "read"; cmd: string; name: string; path: string | null }
  | { type: "list_files"; cmd: string; path: string | null }
  | { type: "search"; cmd: string; query: string | null; path: string | null }
  | { type: "unknown"; cmd: string };

export interface EventProjectionToolCallMessage extends EventProjectionPresentedMessage {
  kind: "tool-call";
  toolName: string;
  toolArgs: JsonObject | null;
  callId: string;
  output: string;
  completedAt: number | null;
  approvalStatus: EventProjectionApprovalLifecycleStatus | null;
  status: EventProjectionItemActivityStatus;
}

export interface EventProjectionCommandMessage extends EventProjectionPresentedMessage {
  kind: "command";
  callId: string;
  command: string;
  cwd: string | null;
  parsedIntents: EventProjectionToolParsedIntent[];
  source: string | null;
  output: string;
  exitCode: number | null;
  completedAt: number | null;
  approvalStatus: EventProjectionApprovalLifecycleStatus | null;
  status: EventProjectionItemActivityStatus;
}

export interface EventProjectionWebSearchMessage extends EventProjectionPresentedMessage {
  kind: "web-search";
  callId: string;
  queries: string[];
  completedAt: number | null;
  status: EventProjectionWebActivityStatus;
}

export interface EventProjectionWebFetchMessage extends EventProjectionPresentedMessage {
  kind: "web-fetch";
  callId: string;
  url: string;
  prompt: string | null;
  pattern: string | null;
  completedAt: number | null;
  status: EventProjectionWebActivityStatus;
}

export interface EventProjectionImageViewMessage extends EventProjectionPresentedMessage {
  kind: "image-view";
  callId: string;
  path: string;
  completedAt: number | null;
  status: EventProjectionWebActivityStatus;
}

export interface EventProjectionImageGenerationMessage extends EventProjectionPresentedMessage {
  kind: "image-generation";
  callId: string;
  prompt: string | null;
  path: string | null;
  error: string | null;
  transparentBackground: boolean;
  completedAt: number | null;
  status: EventProjectionItemActivityStatus;
}

export interface EventProjectionFileReadMessage extends EventProjectionPresentedMessage {
  kind: "file-read";
  callId: string;
  path: string;
  cmd: string | null;
  completedAt: number | null;
  status: EventProjectionItemActivityStatus;
}

export interface EventProjectionSearchMessage extends EventProjectionPresentedMessage {
  kind: "search";
  callId: string;
  mode: ThreadEventSearchMode;
  query: string;
  path: string | null;
  cmd: string | null;
  completedAt: number | null;
  status: EventProjectionItemActivityStatus;
}

export interface EventProjectionPlanStepsMessage extends EventProjectionPresentedMessage {
  kind: "plan-steps";
  callId: string;
  steps: ThreadEventPlanStep[];
  explanation: string | null;
  completedAt: number | null;
  status: EventProjectionItemActivityStatus;
}

export interface EventProjectionExtensionMessage extends EventProjectionMessageBase {
  kind: "extension";
  callId: string;
  extensionKind: ExtensionKind;
  payload: JsonValue;
  presentation: ThreadEventItemPresentation;
  completedAt: number | null;
  status: EventProjectionItemActivityStatus;
}

export interface EventProjectionFileEditChange {
  path: string;
  kind?: string;
  movePath?: string | null;
  diff?: string;
}

export interface EventProjectionFileEditMessage extends EventProjectionPresentedMessage {
  kind: "file-edit";
  callId: string;
  changes: EventProjectionFileEditChange[];
  stdout?: string;
  stderr?: string;
  approvalStatus: EventProjectionApprovalLifecycleStatus | null;
  status: EventProjectionItemActivityStatus;
}

export type EventProjectionThreadOperationKind = "ownership_change" | "other";

export type EventProjectionThreadOperationStatus =
  | "requested"
  | "queued"
  | "running"
  | "started"
  | "completed"
  | "failed"
  | "noop"
  | "other";

interface EventProjectionThreadOperationBase {
  rawOperation: string;
  status: EventProjectionThreadOperationStatus;
  rawStatus: string;
  operationId: string;
}

export interface EventProjectionOwnershipChangeThreadOperationMetadata extends EventProjectionThreadOperationBase {
  operation: "ownership_change";
  metadata: OwnershipChangeOperationMetadata | null;
}

export type EventProjectionThreadOperationMetadata =
  | EventProjectionOwnershipChangeThreadOperationMetadata
  | (EventProjectionThreadOperationBase & {
      operation: "other";
      metadata?: JsonObject;
    });

export interface EventProjectionProvisioningTranscriptEntry {
  type: "step" | "output";
  key: string;
  text: string;
  startedAt?: number;
  status?: "started" | "completed" | "failed";
  metadata?: Record<string, unknown>;
}

export interface EventProjectionProvisioningMetadata {
  environmentId?: string;
  provisioningId: string;
  transcript?: EventProjectionProvisioningTranscriptEntry[];
}

export type EventProjectionPermissionGrantGrantScope = "turn" | "session";

export interface EventProjectionOperationMessage extends EventProjectionMessageBase {
  kind: "operation";
  opType:
    | "reasoning"
    | "provider-unhandled"
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
  status?: EventProjectionItemActivityStatus;
  completedAt: number | null;
  provisioning?: EventProjectionProvisioningMetadata;
  threadOperation?: EventProjectionThreadOperationMetadata;
}

export interface EventProjectionPermissionGrantLifecycleMessage extends EventProjectionMessageBase {
  kind: "permission-grant-lifecycle";
  interactionId: string;
  lifecycle: EventProjectionPermissionGrantLifecycle;
  status: EventProjectionItemActivityStatus;
  approvalTarget: { itemId: string; toolName: string | null };
  grantScope: EventProjectionPermissionGrantGrantScope | null;
  statusReason: string | null;
}

export interface EventProjectionUserQuestionLifecycleMessage extends EventProjectionMessageBase {
  kind: "user-question-lifecycle";
  interactionId: string;
  lifecycle: EventProjectionUserQuestionLifecycle;
  status: EventProjectionItemActivityStatus;
  questions: PendingInteractionUserQuestionQuestion[];
  answers: Record<string, PendingInteractionUserAnswer> | null;
  statusReason: string | null;
}

export interface EventProjectionPluginFormLifecycleMessage extends EventProjectionMessageBase {
  kind: "plugin-form-lifecycle";
  interactionId: string;
  lifecycle: EventProjectionPluginFormLifecycle;
  status: EventProjectionItemActivityStatus;
  pluginId: string;
  rendererId: string;
  title: string;
  statusReason: string | null;
  presentation: ThreadEventItemPresentation;
  payload: JsonValue | null;
}

export interface EventProjectionDelegationMessage extends EventProjectionPresentedMessage {
  kind: "delegation";
  subagentType?: string;
  description?: string;
  model?: string;
  toolName: string;
  callId: string;
  childRef: string | null;
  background: boolean;
  output: string;
  completedAt: number | null;
  status: EventProjectionItemActivityStatus;
  childProjection: EventProjection;
}

export interface EventProjectionWorkflowMessage extends EventProjectionPresentedMessage {
  kind: "workflow";
  itemId: string;
  familyId: string | null;
  taskType: string;
  workflowName: string | null;
  description: string;
  model: string | null;
  status: EventProjectionItemActivityStatus;
  taskStatus: BackgroundTaskStatus;
  skipTranscript: boolean;
  workflow: WorkflowProgressSnapshot | null;
  usage: BackgroundTaskUsage | null;
  summary: string | null;
  error: string | null;
  completedAt: number | null;
}

export interface EventProjectionErrorMessage extends EventProjectionMessageBase {
  kind: "error";
  message: string;
  detail: string | null;
  rawType: string;
  providerErrorInfo?: ProviderErrorInfo;
  willRetry?: boolean;
}

export type EventProjectionMessage =
  | EventProjectionUserMessage
  | EventProjectionAssistantTextMessage
  | EventProjectionCommandMessage
  | EventProjectionToolCallMessage
  | EventProjectionWebSearchMessage
  | EventProjectionWebFetchMessage
  | EventProjectionImageViewMessage
  | EventProjectionImageGenerationMessage
  | EventProjectionFileReadMessage
  | EventProjectionSearchMessage
  | EventProjectionPlanStepsMessage
  | EventProjectionExtensionMessage
  | EventProjectionFileEditMessage
  | EventProjectionOperationMessage
  | EventProjectionPermissionGrantLifecycleMessage
  | EventProjectionUserQuestionLifecycleMessage
  | EventProjectionPluginFormLifecycleMessage
  | EventProjectionDelegationMessage
  | EventProjectionWorkflowMessage
  | EventProjectionErrorMessage;

export interface BuildEventProjectionMessagesOptions {
  includeDiagnosticOperations?: boolean;
  threadStatus?: Thread["status"];
  threadName: string;
  providerDisplayName?: string;
}

export function areThreadEventScopesEqual(
  left: ThreadEventScope,
  right: ThreadEventScope,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "thread") return true;
  return right.kind === "turn" && left.turnId === right.turnId;
}

export function haveCompatibleEventProjectionMessageScope(
  left: Pick<EventProjectionMessageBase, "scope">,
  right: Pick<EventProjectionMessageBase, "scope">,
): boolean {
  return areThreadEventScopesEqual(left.scope, right.scope);
}

export function getEventProjectionMessageScopeTurnId(
  message: Pick<EventProjectionMessageBase, "scope">,
): string | null {
  return message.scope.kind === "turn" ? message.scope.turnId : null;
}

export function eventProjectionMessageTurnScopeFields(
  turnId: string,
): Pick<EventProjectionMessageBase, "scope"> {
  return { scope: turnScope(turnId) };
}

export function eventProjectionMessageThreadScopeFields(): Pick<
  EventProjectionMessageBase,
  "scope"
> {
  return { scope: threadScope() };
}

export function emptyEventProjection(
  entries: EventProjectionEntry[] = [],
): EventProjection {
  return {
    state: {
      activeThinking: null,
      activeWorkflows: [],
      activeBackgroundCommands: [],
    },
    entries,
  };
}

export function getProjectionEntryMessages(
  entry: EventProjectionEntry,
): readonly EventProjectionMessage[] {
  if (entry.kind === "projected-message") return [entry.message];
  if (entry.turn.messages) return entry.turn.messages;
  if (entry.turn.terminalMessage) return [entry.turn.terminalMessage];
  return [];
}

export function extendMessageBounds(
  target: { sourceSeqEnd: number; createdAt: number },
  sourceSeqEnd: number,
  createdAt: number,
): void {
  target.sourceSeqEnd = Math.max(target.sourceSeqEnd, sourceSeqEnd);
  target.createdAt = Math.max(target.createdAt, createdAt);
}

export function isTimelineTerminalMessage(
  message: EventProjectionMessage,
): boolean {
  return message.kind === "assistant-text" || message.kind === "error";
}

function isTimelineSummaryGroupableSteerMessage(
  message: EventProjectionMessage,
): boolean {
  return (
    message.kind === "user" &&
    message.turnRequest.kind === "steer" &&
    (message.initiator === "agent" || message.initiator === "system")
  );
}

export function isTimelineUngroupableMessage(
  message: EventProjectionMessage,
): boolean {
  return (
    message.kind === "user" && !isTimelineSummaryGroupableSteerMessage(message)
  );
}

export function isSingletonContextManagementOperation(
  messages: readonly EventProjectionMessage[],
): boolean {
  const onlyMessage = messages.length === 1 ? messages[0] : undefined;
  return (
    onlyMessage?.kind === "operation" &&
    (onlyMessage.opType === "compaction" ||
      onlyMessage.opType === "context-clear")
  );
}

export function findLastTerminalTimelineMessage(
  messages: readonly EventProjectionMessage[],
): EventProjectionMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isTimelineTerminalMessage(message)) return message;
  }
  return undefined;
}
