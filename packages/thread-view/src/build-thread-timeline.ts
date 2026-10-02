import {
  type ProviderErrorCategory,
  isBackgroundAgentTaskType,
  readTerminalOutputLines,
  type ActiveThinking,
  type CompletedTurnDisplay,
  type Thread,
  type ThreadEventItemPresentation,
  type ThreadTimelineActivePromptMode,
  type ThreadTimelineGoal,
  type ThreadTimelineModelFallback,
  type ThreadTimelinePendingTodos,
} from "@bb/domain";
import {
  type EventProjectionErrorMessage,
  type EventProjectionFileEditChange,
  type EventProjectionMessage,
  type EventProjection,
  type EventProjectionToolParsedIntent,
  type EventProjectionUserMessage,
  type EventProjectionWorkflowMessage,
  getEventProjectionMessageScopeTurnId,
} from "./event-projection-types.js";
import type {
  ThreadContextWindowUsage,
  TimelineActivityIntent,
  TimelineConversationAttachments,
  TimelineFileChange,
  TimelineParentChange,
  TimelineRow,
  TimelineRowBase,
  TimelineRowStatus,
  TimelineSourceRow,
  TimelineUserConversationRow,
  TimelineWorkflowWorkRow,
} from "@bb/server-contract";
import {
  assertNever,
  durationToCompactString,
  getMessageStartedAt,
  getFileChangeDiffStats,
} from "./timeline-format.js";
import {
  buildEventProjection,
  buildEventProjectionEntries,
  type ThreadEventWithMeta,
} from "./build-event-projection.js";
import {
  buildAcceptedClientRequestById,
  buildRejectedClientRequestById,
  type AcceptedClientRequestContext,
  parsePendingSteersFromClientRequest,
  parseRejectedUsersFromClientRequest,
} from "./user-message-parsing.js";
import {
  getOrderedThreadEvents,
  planTimelineRows,
  type TimelineRowPlan,
} from "./group-event-projection-turns.js";
import {
  extractThreadContextWindowUsage,
  extractThreadTimelineActivePromptMode,
  type PlanCommand,
  extractThreadTimelineGoal,
  extractThreadTimelineModelFallback,
  extractThreadTimelinePendingTodos,
} from "./thread-state-extraction.js";

type TimelineErrorDisplay = { title: string; detail: string | null };

const providerErrorCategoryTitles = {
  "active-turn-not-steerable": "Turn is not steerable",
  "bad-request": "Provider rejected request",
  billing: "Provider billing issue",
  "budget-exceeded": "Provider budget exceeded",
  "connection-failed": "Provider connection failed",
  "context-window-exceeded": "Context window exceeded",
  internal: "Provider internal error",
  "max-output-tokens": "Provider output token limit reached",
  "max-turns": "Maximum turns reached",
  overloaded: "Provider overloaded",
  policy: "Provider policy blocked request",
  "rate-limit": "Provider rate limit reached",
  sandbox: "Provider sandbox error",
  "stream-disconnected": "Provider stream disconnected",
  "structured-output-retries": "Structured output retries exhausted",
  "thread-rollback-failed": "Thread rollback failed",
  "too-many-failed-attempts": "Provider failed after too many attempts",
  unauthorized: "Provider authorization failed",
  unknown: "Provider error",
} satisfies Record<ProviderErrorCategory, string>;

const MAX_ERROR_TITLE_LENGTH = 80;

const reconnectProgressPattern = /^Reconnecting\.\.\.\s+\d+\/\d+$/u;

function reconnectDisplay(
  message: EventProjectionErrorMessage,
): { progress: string; cause: string | null } | null {
  if (message.detail === null) return null;
  const [first, ...rest] = message.detail.split("\n");
  if (first === undefined || !reconnectProgressPattern.test(first.trim())) {
    return null;
  }
  return { progress: first.trim(), cause: nonEmpty(rest.join("\n")) };
}

export function buildTimelineErrorDisplay(
  message: EventProjectionErrorMessage,
): TimelineErrorDisplay {
  const reconnect = reconnectDisplay(message);
  if (reconnect) return { title: reconnect.progress, detail: reconnect.cause };
  const { title, detail } = resolveErrorTitleDetail(message);
  if (title.length <= MAX_ERROR_TITLE_LENGTH) return { title, detail };
  return { title: genericErrorTitle(message.rawType), detail: detail ?? title };
}

function resolveErrorTitleDetail(
  message: EventProjectionErrorMessage,
): TimelineErrorDisplay {
  if (
    message.rawType === "provider/error" &&
    message.providerErrorInfo &&
    message.providerErrorInfo.category !== "unknown"
  ) {
    const title =
      providerErrorCategoryTitles[message.providerErrorInfo.category];
    return { title, detail: detailBeyondTitle(message.detail, title) };
  }
  if (message.rawType === "provider/error") {
    const content = message.detail ?? message.message;
    return { title: content, detail: null };
  }
  return {
    title: message.message,
    detail: detailBeyondTitle(message.detail, message.message),
  };
}

function genericErrorTitle(rawType: string): string {
  return rawType === "provider/error" ? "Provider error" : "System error";
}

function detailBeyondTitle(
  detail: string | null,
  title: string,
): string | null {
  if (detail === null || detail.trim() === title.trim()) return null;
  return detail;
}

function nonEmpty(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface ThreadTimelineFromEventsOptions {
  completedTurnDisplay: CompletedTurnDisplay;
  includeDiagnosticOperations: boolean;
  includeNestedRows: boolean;
  isLatestPage: boolean;
  providerId?: string;
  providerDisplayName?: string;
  planCommand?: PlanCommand | null;
  threadStatus: Thread["status"];
  threadName: string;
  workspaceRoot: string | null;
}

export interface ThreadTimelineFromEventsResult {
  activePromptMode: ThreadTimelineActivePromptMode | null;
  activeThinking: ActiveThinking | null;
  activeWorkflows: TimelineWorkflowWorkRow[];
  activeBackgroundCommands: TimelineWorkflowWorkRow[];
  contextWindowUsage: ThreadContextWindowUsage | null;
  goal: ThreadTimelineGoal | null;
  modelFallback: ThreadTimelineModelFallback | null;
  pendingTodos: ThreadTimelinePendingTodos | null;
  rows: TimelineRow[];
}

type BuildTimelineRowsOptions = Pick<
  ThreadTimelineFromEventsOptions,
  "completedTurnDisplay" | "includeNestedRows" | "workspaceRoot"
> & { rowIdPrefix: string };

const ROOT_TIMELINE_ROW_ID_PREFIX = "";

type TimelineOperationMessage = Extract<
  EventProjectionMessage,
  { kind: "operation" }
>;

function parentChangeForMessage(
  message: TimelineOperationMessage,
): TimelineParentChange | null {
  if (
    message.opType !== "operation" ||
    message.threadOperation?.operation !== "ownership_change"
  ) {
    return null;
  }
  const metadata = message.threadOperation.metadata;
  if (metadata === null) return null;
  return {
    action: metadata.action,
    previousParentThreadId: metadata.previousParentThreadId,
    previousParentThreadTitle: metadata.previousParentThreadTitle,
    nextParentThreadId: metadata.nextParentThreadId,
    nextParentThreadTitle: metadata.nextParentThreadTitle,
  };
}

function buildTimelineRowBase(
  message: EventProjectionMessage,
  rowIdPrefix: string,
): TimelineRowBase {
  return {
    id: `${rowIdPrefix}${message.id}`,
    threadId: message.threadId,
    turnId: getEventProjectionMessageScopeTurnId(message),
    sourceSeqStart: message.sourceSeqStart,
    sourceSeqEnd: message.sourceSeqEnd,
    startedAt: getMessageStartedAt(message),
    createdAt: message.createdAt,
  };
}

function buildWorkflowWorkRows(
  messages: readonly EventProjectionWorkflowMessage[],
  rowIdPrefix: string,
): TimelineWorkflowWorkRow[] {
  return messages
    .filter((message) => !message.skipTranscript)
    .map((message) => ({
      ...buildTimelineRowBase(message, rowIdPrefix),
      kind: "work",
      workKind: "workflow",
      status: message.status,
      itemId: message.itemId,
      taskType: message.taskType,
      workflowName: message.workflowName,
      description: message.description,
      model: message.model,
      taskStatus: message.taskStatus,
      workflow: message.workflow,
      usage: message.usage,
      summary: message.summary,
      error: message.error,
      completedAt: message.completedAt,
      ...rowPresentation(message),
    }));
}

function toConversationAttachments(
  attachments: EventProjectionUserMessage["attachments"],
): TimelineConversationAttachments | null {
  if (!attachments) return null;
  return {
    webImages: attachments.webImages,
    localImages: attachments.localImages,
    localFiles: attachments.localFiles,
    imageUrls: attachments.imageUrls ?? [],
    localImagePaths: attachments.localImagePaths ?? [],
    localFilePaths: attachments.localFilePaths ?? [],
  };
}

function rowPresentation(message: {
  presentation?: ThreadEventItemPresentation;
}): { presentation?: ThreadEventItemPresentation } {
  return message.presentation ? { presentation: message.presentation } : {};
}

function convertActivityIntent(
  intent: EventProjectionToolParsedIntent,
): TimelineActivityIntent {
  switch (intent.type) {
    case "read":
      return {
        type: "read",
        command: intent.cmd,
        name: intent.name,
        path: intent.path,
      };
    case "list_files":
      return { type: "list_files", command: intent.cmd, path: intent.path };
    case "search":
      return {
        type: "search",
        command: intent.cmd,
        query: intent.query,
        path: intent.path,
      };
    case "unknown":
      return { type: "unknown", command: intent.cmd };
    default:
      return assertNever(intent);
  }
}

function relativizeWorkspacePath(
  path: string,
  workspaceRoot: string | null,
): string {
  if (!workspaceRoot) return path;
  const normalizedRoot = workspaceRoot.replace(/\/+$/u, "");
  if (normalizedRoot.length === 0) return path;
  if (path.startsWith(`${normalizedRoot}/`)) {
    return path.slice(normalizedRoot.length + 1);
  }
  return path;
}

function toTimelineFileChange(
  change: EventProjectionFileEditChange,
  workspaceRoot: string | null,
): TimelineFileChange {
  return {
    path: relativizeWorkspacePath(change.path, workspaceRoot),
    kind: change.kind ?? null,
    movePath:
      change.movePath == null
        ? null
        : relativizeWorkspacePath(change.movePath, workspaceRoot),
    diff: change.diff ?? null,
    diffStats: getFileChangeDiffStats(change),
  };
}

function provisioningTerminalDetailLine(
  message: TimelineOperationMessage,
): string | null {
  if (
    message.opType !== "thread-provisioning" ||
    message.status === "pending" ||
    message.status === undefined ||
    message.startedAt === undefined ||
    message.createdAt < message.startedAt
  ) {
    return null;
  }
  const elapsedMs = message.createdAt - message.startedAt;
  if (elapsedMs <= 1_000) return null;
  const label =
    message.status === "completed"
      ? "Provisioned thread"
      : message.status === "error"
        ? "Provisioning thread failed"
        : "Provisioning thread interrupted";
  return `${label} (${durationToCompactString(elapsedMs)})`;
}

function buildTimelineOperationDetail(
  message: TimelineOperationMessage,
): string | null {
  if (message.opType !== "thread-provisioning") return message.detail ?? null;
  const lines =
    message.provisioning?.transcript?.flatMap((entry) => {
      const durationMs = entry.metadata?.durationMs;
      return readTerminalOutputLines(
        typeof durationMs === "number" &&
          (entry.status === "completed" || entry.status === "failed")
          ? `${entry.text} (${durationToCompactString(durationMs)})`
          : entry.text,
      );
    }) ?? [];
  const terminalLine = provisioningTerminalDetailLine(message);
  if (terminalLine) lines.push(terminalLine);
  for (const part of (message.detail ?? "").split(/\n|•/u)) {
    const line = part.trim();
    if (line.length > 0 && !lines.includes(line)) lines.push(line);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

function userConversationRow(
  message: EventProjectionUserMessage,
  rowIdPrefix: string,
): TimelineUserConversationRow {
  return {
    ...buildTimelineRowBase(message, rowIdPrefix),
    kind: "conversation",
    role: "user",
    text: message.text,
    mentions: message.mentions,
    attachments: toConversationAttachments(message.attachments),
    initiator: message.initiator,
    senderThreadId: message.senderThreadId,
    systemMessageKind: message.systemMessageKind,
    systemMessageSubject: message.systemMessageSubject,
    turnRequest: message.turnRequest,
  };
}

function itemActivityRow<TWorkKind extends string, TFields extends object>(
  message: EventProjectionMessage & {
    callId: string;
    completedAt: number | null;
    presentation?: ThreadEventItemPresentation;
    status: TimelineRowStatus;
  },
  rowIdPrefix: string,
  workKind: TWorkKind,
  fields: TFields,
) {
  return {
    ...buildTimelineRowBase(message, rowIdPrefix),
    kind: "work" as const,
    workKind,
    status: message.status,
    callId: message.callId,
    ...fields,
    completedAt: message.completedAt,
    ...rowPresentation(message),
  };
}

function convertMessage(
  message: EventProjectionMessage,
  options: BuildTimelineRowsOptions,
): TimelineSourceRow[] {
  const base = buildTimelineRowBase(message, options.rowIdPrefix);
  switch (message.kind) {
    case "user":
      return isSuppressedSystemMessage(message)
        ? []
        : [userConversationRow(message, options.rowIdPrefix)];
    case "assistant-text":
      return [
        {
          ...base,
          kind: "conversation",
          role: "assistant",
          text: message.text,
          attachments: null,
          turnRequest: null,
        },
      ];
    case "command":
      return [
        {
          ...base,
          kind: "work",
          workKind: "command",
          status: message.status,
          callId: message.callId,
          command: message.command,
          cwd: message.cwd,
          source: message.source,
          output: message.output,
          exitCode: message.exitCode,
          completedAt: message.completedAt,
          approvalStatus: message.approvalStatus,
          activityIntents: message.parsedIntents.map(convertActivityIntent),
          ...rowPresentation(message),
        },
      ];
    case "tool-call":
      return [
        {
          ...base,
          kind: "work",
          workKind: "tool",
          status: message.status,
          callId: message.callId,
          toolName: message.toolName,
          toolArgs: message.toolArgs,
          output: message.output,
          completedAt: message.completedAt,
          approvalStatus: message.approvalStatus,
          ...rowPresentation(message),
        },
      ];
    case "file-edit":
      if (message.changes.length === 0 && message.approvalStatus !== null) {
        return [
          {
            ...base,
            kind: "work",
            workKind: "approval",
            status: message.status,
            interactionId: message.callId,
            approvalKind: "file-edit",
            lifecycle:
              message.approvalStatus === "denied" ? "denied" : "waiting",
            target: { itemId: message.callId, toolName: null },
          },
        ];
      }
      return message.changes.map((change, index) => ({
        ...base,
        id: `${base.id}:file-change:${index}`,
        kind: "work",
        workKind: "file-change",
        status: message.status,
        callId: message.callId,
        change: toTimelineFileChange(change, options.workspaceRoot),
        stdout: message.stdout ?? null,
        stderr: message.stderr ?? null,
        approvalStatus: message.approvalStatus,
        ...rowPresentation(message),
      }));
    case "web-search":
      return [
        itemActivityRow(message, options.rowIdPrefix, "web-search", {
          queries: message.queries,
        }),
      ];
    case "web-fetch":
      return [
        itemActivityRow(message, options.rowIdPrefix, "web-fetch", {
          url: message.url,
          prompt: message.prompt,
          pattern: message.pattern,
        }),
      ];
    case "image-view":
      return [
        itemActivityRow(message, options.rowIdPrefix, "image-view", {
          path: message.path,
        }),
      ];
    case "image-generation":
      return [
        itemActivityRow(message, options.rowIdPrefix, "image-generation", {
          prompt: message.prompt,
          path: message.path,
          error: message.error,
          transparentBackground: message.transparentBackground,
        }),
      ];
    case "file-read":
      return [
        itemActivityRow(message, options.rowIdPrefix, "file-read", {
          path: message.path,
          cmd: message.cmd,
        }),
      ];
    case "search":
      return [
        itemActivityRow(message, options.rowIdPrefix, "search", {
          mode: message.mode,
          query: message.query,
          path: message.path,
          cmd: message.cmd,
        }),
      ];
    case "plan-steps":
      return [
        itemActivityRow(message, options.rowIdPrefix, "plan-steps", {
          steps: message.steps,
          explanation: message.explanation,
        }),
      ];
    case "extension":
      return [
        {
          ...base,
          kind: "work",
          workKind: "extension",
          status: message.status,
          callId: message.callId,
          extensionKind: message.extensionKind,
          payload: message.payload,
          completedAt: message.completedAt,
          presentation: message.presentation,
        },
      ];
    case "delegation":
      return [
        {
          ...base,
          kind: "work",
          workKind: "delegation",
          status: message.status,
          callId: message.callId,
          toolName: message.toolName,
          childRef: message.childRef,
          background: message.background,
          subagentType: message.subagentType ?? null,
          description: message.description ?? null,
          output: message.output,
          completedAt: message.completedAt,
          childRows: buildTimelineRows(message.childProjection, {
            ...options,
            includeNestedRows: true,
            rowIdPrefix: `${base.id}:child:`,
          }).filter(
            (row) =>
              !(
                row.kind === "work" &&
                row.workKind === "workflow" &&
                isBackgroundAgentTaskType(row.taskType)
              ),
          ),
          ...rowPresentation(message),
        },
      ];
    case "workflow":
      return buildWorkflowWorkRows([message], options.rowIdPrefix);
    case "permission-grant-lifecycle":
      return [
        {
          ...base,
          kind: "work",
          workKind: "approval",
          status: message.status,
          interactionId: message.interactionId,
          approvalKind: "permission-grant",
          lifecycle: message.lifecycle,
          grantScope: message.grantScope,
          statusReason: message.statusReason,
          target: message.approvalTarget,
        },
      ];
    case "user-question-lifecycle":
      return [
        {
          ...base,
          kind: "work",
          workKind: "question",
          status: message.status,
          interactionId: message.interactionId,
          lifecycle: message.lifecycle,
          questions: message.questions,
          answers: message.answers,
          statusReason: message.statusReason,
        },
      ];
    case "plugin-form-lifecycle":
      return [
        {
          ...base,
          kind: "work",
          workKind: "form",
          status: message.status,
          interactionId: message.interactionId,
          lifecycle: message.lifecycle,
          pluginId: message.pluginId,
          rendererId: message.rendererId,
          title: message.title,
          statusReason: message.statusReason,
          presentation: message.presentation,
          payload: message.payload,
        },
      ];
    case "operation": {
      const parentChange = parentChangeForMessage(message);
      const detail = buildTimelineOperationDetail(message);
      if (parentChange !== null) {
        if (message.status === undefined) {
          throw new Error("Parent change operation message requires a status");
        }
        return [
          {
            ...base,
            kind: "system",
            systemKind: "operation",
            operationKind: "parent-change",
            parentChange,
            title: message.title,
            detail,
            status: message.status,
            completedAt: message.completedAt,
          },
        ];
      }
      const operationKind =
        message.opType === "provider-environment" ||
        message.opType === "operation"
          ? "generic"
          : message.opType;
      return [
        {
          ...base,
          kind: "system",
          systemKind: "operation",
          operationKind,
          ...(operationKind === "reasoning" ? { reasoningId: message.id } : {}),
          title: message.title,
          detail,
          status: message.status ?? null,
          completedAt: message.completedAt,
        },
      ];
    }
    case "error": {
      const errorDisplay = buildTimelineErrorDisplay(message);
      const isReconnect = message.willRetry === true;
      return [
        {
          ...base,
          kind: "system",
          systemKind: isReconnect ? "reconnect" : "error",
          title: errorDisplay.title,
          detail: errorDisplay.detail,
          status: isReconnect ? null : "error",
        },
      ];
    }
    default:
      return assertNever(message);
  }
}

function isSuppressedSystemMessage(
  message: EventProjectionUserMessage,
): boolean {
  return (
    message.initiator === "system" &&
    message.systemMessageSubject?.kind === "tool-call" &&
    message.systemMessageSubject.suppress
  );
}

function buildPendingSteerRowsFromEvents(
  acceptedClientRequestContext: AcceptedClientRequestContext,
  events: ThreadEventWithMeta[],
  options: ThreadTimelineFromEventsOptions,
): TimelineUserConversationRow[] {
  const orderedEvents = getOrderedThreadEvents(events);
  const acceptedClientRequestById = buildAcceptedClientRequestById({
    context: acceptedClientRequestContext,
    events: orderedEvents,
  });
  const rejectedClientRequestById = buildRejectedClientRequestById(
    acceptedClientRequestContext,
    orderedEvents,
  );
  const inWindowRejectedClientRequestIds = new Set(
    orderedEvents.flatMap(({ event }) =>
      event.type === "client/turn/rejected" ? [event.requestId] : [],
    ),
  );
  const pendingSteerRows: TimelineUserConversationRow[] = [];
  for (const { event, meta } of orderedEvents) {
    if (
      event.type !== "client/turn/requested" ||
      inWindowRejectedClientRequestIds.has(event.requestId)
    ) {
      continue;
    }
    const acceptedClientRequest = acceptedClientRequestById.get(
      event.requestId,
    );
    const rejectedMeta = rejectedClientRequestById.get(event.requestId);
    const steers =
      acceptedClientRequest === undefined && rejectedMeta
        ? parseRejectedUsersFromClientRequest({
            decoded: event,
            meta: rejectedMeta,
            options,
          })
        : parsePendingSteersFromClientRequest({
            acceptedClientRequest,
            decoded: event,
            meta,
            options,
          });
    for (const steer of steers) {
      if (isSuppressedSystemMessage(steer)) continue;
      if (steer.turnRequest.kind !== "steer") {
        throw new Error(`Expected steer message, received ${steer.kind}`);
      }
      pendingSteerRows.push(
        userConversationRow(steer, ROOT_TIMELINE_ROW_ID_PREFIX),
      );
    }
  }
  return pendingSteerRows;
}

function isCompanionThreadInterruptedRow(
  previous: TimelineRow,
  row: TimelineRow,
): boolean {
  return (
    previous.kind === "system" &&
    previous.systemKind === "error" &&
    row.kind === "system" &&
    row.systemKind === "operation" &&
    row.operationKind === "thread-interrupted" &&
    previous.threadId === row.threadId &&
    previous.createdAt === row.createdAt &&
    previous.startedAt === row.startedAt &&
    previous.sourceSeqEnd + 1 === row.sourceSeqStart
  );
}

function isReconnectSystemRow(row: TimelineRow | undefined): boolean {
  return row?.kind === "system" && row.systemKind === "reconnect";
}

function appendRows(target: TimelineRow[], rows: readonly TimelineRow[]): void {
  for (const row of rows) {
    const previous = target[target.length - 1];
    if (isReconnectSystemRow(previous) && isReconnectSystemRow(row)) {
      target[target.length - 1] = row;
    } else if (!previous || !isCompanionThreadInterruptedRow(previous, row)) {
      target.push(row);
    }
  }
}

function orderRowsAfterExternalUserBoundary(
  rows: TimelineRow[],
  projection: EventProjection,
): TimelineRow[] {
  const boundarySeqs = projection.entries.flatMap((entry) =>
    entry.kind === "turn" ? (entry.turn.externalUserBoundarySeqs ?? []) : [],
  );
  const firstBoundarySeq = boundarySeqs.reduce(
    (first, seq) => Math.min(first, seq),
    Infinity,
  );
  const suffixStartIndex =
    boundarySeqs.length === 0
      ? -1
      : rows.findIndex((row) => row.sourceSeqStart >= firstBoundarySeq);
  if (suffixStartIndex === -1) return rows;
  const orderedSuffix = rows
    .slice(suffixStartIndex)
    .map((row, index) => ({ index, row }))
    .sort(
      (left, right) =>
        left.row.sourceSeqStart - right.row.sourceSeqStart ||
        left.row.sourceSeqEnd - right.row.sourceSeqEnd ||
        left.index - right.index,
    )
    .map(({ row }) => row);
  return [...rows.slice(0, suffixStartIndex), ...orderedSuffix];
}

function buildTimelineRows(
  projection: EventProjection,
  options: BuildTimelineRowsOptions,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const item of planTimelineRows(
    projection,
    options.completedTurnDisplay,
    options.rowIdPrefix,
  )) {
    if (item.kind === "message") {
      appendRows(rows, convertMessage(item.message, options));
    } else if (options.includeNestedRows) {
      const children = item.messages.flatMap((message) =>
        convertMessage(message, options),
      );
      appendRows(rows, [{ ...item.row, children }]);
    } else {
      appendRows(rows, [item.row]);
    }
  }
  return orderRowsAfterExternalUserBoundary(rows, projection);
}

export function buildThreadTimelineFromEvents(args: {
  acceptedClientRequestContext: AcceptedClientRequestContext;
  contextWindowEvents: ThreadEventWithMeta[];
  headStateEvents?: ThreadEventWithMeta[];
  events: ThreadEventWithMeta[];
  options: ThreadTimelineFromEventsOptions;
}): ThreadTimelineFromEventsResult {
  const { events, options } = args;
  const stateEvents = args.headStateEvents?.length
    ? getOrderedThreadEvents([...events, ...args.headStateEvents])
    : events;
  const projection = buildEventProjection(events, {
    acceptedClientRequestContext: args.acceptedClientRequestContext,
    includeDiagnosticOperations: options.includeDiagnosticOperations,
    providerDisplayName: options.providerDisplayName,
    threadStatus: options.threadStatus,
    threadName: options.threadName,
    turnMessageDetail: "full",
  });
  const rows = [
    ...buildTimelineRows(projection, {
      completedTurnDisplay: options.completedTurnDisplay,
      includeNestedRows: options.includeNestedRows,
      rowIdPrefix: ROOT_TIMELINE_ROW_ID_PREFIX,
      workspaceRoot: options.workspaceRoot,
    }),
    ...buildPendingSteerRowsFromEvents(
      args.acceptedClientRequestContext,
      events,
      options,
    ),
  ];
  const latest = options.isLatestPage;
  return {
    activePromptMode: latest
      ? extractThreadTimelineActivePromptMode({
          events,
          planCommand: options.planCommand,
          providerId: options.providerId,
          threadStatus: options.threadStatus,
        })
      : null,
    activeThinking: projection.state.activeThinking,
    activeWorkflows: buildWorkflowWorkRows(
      projection.state.activeWorkflows,
      ROOT_TIMELINE_ROW_ID_PREFIX,
    ),
    activeBackgroundCommands: buildWorkflowWorkRows(
      projection.state.activeBackgroundCommands,
      ROOT_TIMELINE_ROW_ID_PREFIX,
    ),
    contextWindowUsage: extractThreadContextWindowUsage(
      args.contextWindowEvents,
    ),
    goal: latest ? extractThreadTimelineGoal(stateEvents) : null,
    modelFallback: latest ? extractThreadTimelineModelFallback(events) : null,
    pendingTodos: latest
      ? extractThreadTimelinePendingTodos(options.threadStatus, stateEvents)
      : null,
    rows,
  };
}

function findTurnSummaryStartingAt(
  plan: readonly TimelineRowPlan[],
  turnId: string,
  sourceSeqStart: number,
): Extract<TimelineRowPlan, { kind: "summary" }> | undefined {
  let match: Extract<TimelineRowPlan, { kind: "summary" }> | undefined;
  let matchSeq = Infinity;
  for (const item of plan) {
    if (item.kind !== "summary" || item.row.turnId !== turnId) continue;
    for (const message of item.messages) {
      if (
        message.sourceSeqStart >= sourceSeqStart &&
        message.sourceSeqStart < matchSeq
      ) {
        match = item;
        matchSeq = message.sourceSeqStart;
      }
    }
  }
  return match;
}

export function buildThreadTimelineTurnDetailsFromEvents(args: {
  events: ThreadEventWithMeta[];
  options: Pick<
    ThreadTimelineFromEventsOptions,
    | "completedTurnDisplay"
    | "includeDiagnosticOperations"
    | "providerDisplayName"
    | "threadStatus"
    | "threadName"
    | "workspaceRoot"
  > & { sourceSeqStart: number; turnId: string };
}):
  | { kind: "matched"; rows: TimelineRow[] }
  | { kind: "missing-match" }
  | { kind: "ungrouped"; rows: TimelineRow[] } {
  const projection = buildEventProjectionEntries(args.events, {
    includeDiagnosticOperations: args.options.includeDiagnosticOperations,
    providerDisplayName: args.options.providerDisplayName,
    threadStatus: args.options.threadStatus,
    threadName: args.options.threadName,
    turnMessageDetail: "full",
  });
  const options: BuildTimelineRowsOptions = {
    completedTurnDisplay: args.options.completedTurnDisplay,
    includeNestedRows: true,
    rowIdPrefix: ROOT_TIMELINE_ROW_ID_PREFIX,
    workspaceRoot: args.options.workspaceRoot,
  };
  const plan = planTimelineRows(
    projection,
    options.completedTurnDisplay,
    options.rowIdPrefix,
  );
  const matchingSummary = findTurnSummaryStartingAt(
    plan,
    args.options.turnId,
    args.options.sourceSeqStart,
  );
  if (matchingSummary) {
    return {
      kind: "matched",
      rows: matchingSummary.messages.flatMap((message) =>
        convertMessage(message, options),
      ),
    };
  }
  if (plan.some((item) => item.kind === "summary")) {
    return { kind: "missing-match" };
  }
  return {
    kind: "ungrouped",
    rows: buildTimelineRows(projection, options).filter(
      (row) =>
        !(
          row.kind === "conversation" &&
          row.role === "user" &&
          row.initiator === "user" &&
          row.turnRequest?.kind === "steer"
        ),
    ),
  };
}
