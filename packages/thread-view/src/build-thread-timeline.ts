import {
  isBackgroundAgentTaskType,
  readTerminalOutputLines,
  type ActiveThinking,
  type CompletedTurnDisplay,
  type ProviderErrorCategory,
  type Thread,
  type ThreadTimelineActivePromptMode,
  type ThreadTimelineGoal,
  type ThreadTimelineModelFallback,
  type ThreadTimelinePendingTodos,
} from "@bb/domain";
import type {
  ThreadContextWindowUsage,
  TimelineFileChange,
  TimelineRow,
  TimelineRowBase,
  TimelineSourceRow,
  TimelineWorkflowWorkRow,
} from "@bb/server-contract";
import { buildEventProjection } from "./build-event-projection.js";
import type {
  ErrorMessage,
  FileEditChange,
  Message,
  OperationMessage,
  ProjectionEntry,
  ThreadEventWithMeta,
  UserMessage,
  WorkflowMessage,
} from "./event-projection-types.js";
import {
  getOrderedThreadEvents,
  planTimelineRows,
} from "./group-event-projection-turns.js";
import { provisioningTitleForStatus } from "./parse-operation-message.js";
import * as extraction from "./thread-state-extraction.js";
import {
  durationToCompactString,
  getFileChangeDiffStats,
  getMessageStartedAt,
} from "./timeline-format.js";
import * as requests from "./user-message-parsing.js";

type TimelineErrorDisplay = { title: string; detail: string | null };

const PROVIDER_ERROR_CATEGORY_TITLES = {
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

const RECONNECT_PROGRESS_PATTERN = /^Reconnecting\.\.\.\s+\d+\/\d+$/u;

function detailBeyondTitle(
  detail: string | null,
  title: string,
): string | null {
  return detail === null || detail.trim() === title.trim() ? null : detail;
}

function resolveErrorTitleDetail(message: ErrorMessage): TimelineErrorDisplay {
  const { detail } = message;
  if (message.rawType !== "provider/error") {
    const title = message.message;
    return { title, detail: detailBeyondTitle(detail, title) };
  }
  const category = message.providerErrorInfo?.category ?? "unknown";
  if (category === "unknown") {
    return { title: detail ?? message.message, detail: null };
  }
  const title = PROVIDER_ERROR_CATEGORY_TITLES[category];
  return { title, detail: detailBeyondTitle(detail, title) };
}

function buildTimelineErrorDisplay(
  message: ErrorMessage,
): TimelineErrorDisplay {
  const [first = "", ...rest] = message.detail?.split("\n") ?? [];
  if (RECONNECT_PROGRESS_PATTERN.test(first.trim())) {
    return { title: first.trim(), detail: rest.join("\n").trim() || null };
  }
  const { title, detail } = resolveErrorTitleDetail(message);
  if (title.length <= MAX_ERROR_TITLE_LENGTH) return { title, detail };
  const generic =
    message.rawType === "provider/error" ? "Provider error" : "System error";
  return { title: generic, detail: detail ?? title };
}

interface ThreadTimelineFromEventsOptions {
  completedTurnDisplay: CompletedTurnDisplay;
  includeDiagnosticOperations: boolean;
  includeNestedRows: boolean;
  isLatestPage: boolean;
  providerId?: string;
  planCommand?: extraction.PlanCommand | null;
  threadStatus: Thread["status"];
  threadName: string;
  workspaceRoot: string | null;
}

interface ThreadTimelineFromEventsResult {
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

function buildTimelineRowBase(
  message: Message,
  rowIdPrefix: string,
): TimelineRowBase {
  return {
    id: `${rowIdPrefix}${message.id}`,
    threadId: message.threadId,
    turnId: message.scope.kind === "turn" ? message.scope.turnId : null,
    sourceSeqStart: message.sourceSeqStart,
    sourceSeqEnd: message.sourceSeqEnd,
    startedAt: getMessageStartedAt(message),
    createdAt: message.createdAt,
  };
}

function rowPresentation({
  presentation,
}: Pick<WorkflowMessage, "presentation">) {
  return presentation ? { presentation } : {};
}

function buildWorkflowWorkRows(
  messages: readonly WorkflowMessage[],
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

function relativizeWorkspacePath(
  path: string,
  workspaceRoot: string | null,
): string {
  const root = workspaceRoot?.replace(/\/+$/u, "");
  return root && path.startsWith(`${root}/`)
    ? path.slice(root.length + 1)
    : path;
}

function toTimelineFileChange(
  change: FileEditChange,
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

function buildTimelineOperationDetail(
  message: OperationMessage,
): string | null {
  if (message.opType !== "thread-provisioning") return message.detail ?? null;
  const lines =
    message.transcript?.flatMap((entry) => {
      const durationMs = entry.metadata?.durationMs;
      return readTerminalOutputLines(
        typeof durationMs === "number" &&
          (entry.status === "completed" || entry.status === "failed")
          ? `${entry.text} (${durationToCompactString(durationMs)})`
          : entry.text,
      );
    }) ?? [];
  const elapsedMs = message.createdAt - getMessageStartedAt(message);
  if (message.status !== "pending" && elapsedMs > 1_000) {
    const label = provisioningTitleForStatus(message.status);
    lines.push(`${label} (${durationToCompactString(elapsedMs)})`);
  }
  for (const part of (message.detail ?? "").split(/\n|•/u)) {
    const line = part.trim();
    if (line.length > 0 && !lines.includes(line)) lines.push(line);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

function isSuppressedSystemMessage(message: UserMessage): boolean {
  return (
    message.initiator === "system" &&
    message.systemMessageSubject?.kind === "tool-call" &&
    message.systemMessageSubject.suppress
  );
}

function operationRows(
  message: OperationMessage,
  base: TimelineRowBase,
): TimelineSourceRow[] {
  const { opType, title, status, completedAt, parentChange } = message;
  const detail = buildTimelineOperationDetail(message);
  const common = { ...base, kind: "system", systemKind: "operation" } as const;
  if (parentChange) {
    const operationKind = "parent-change";
    return [
      {
        ...common,
        operationKind,
        parentChange,
        title,
        detail,
        status,
        completedAt,
      },
    ];
  }
  const operationKind =
    opType === "provider-environment" || opType === "operation"
      ? "generic"
      : opType;
  return [
    {
      ...common,
      operationKind,
      ...(operationKind === "reasoning" ? { reasoningId: message.id } : {}),
      title,
      detail,
      status,
      completedAt,
    },
  ];
}

function convertMessage(
  message: Message,
  options: BuildTimelineRowsOptions,
): TimelineSourceRow[] {
  const base = buildTimelineRowBase(message, options.rowIdPrefix);
  if (message.kind === "assistant-text") {
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
  }
  if (message.kind === "file-edit") {
    const { status, callId, approvalStatus } = message;
    if (message.changes.length === 0 && approvalStatus !== null) {
      return [
        {
          ...base,
          kind: "work",
          workKind: "approval",
          status,
          interactionId: callId,
          approvalKind: "file-edit",
          lifecycle: approvalStatus === "denied" ? "denied" : "waiting",
          target: { itemId: callId, toolName: null },
        },
      ];
    }
    return message.changes.map((change, index) => ({
      ...base,
      id: `${base.id}:file-change:${index}`,
      kind: "work",
      workKind: "file-change",
      status,
      callId,
      change: toTimelineFileChange(change, options.workspaceRoot),
      stdout: message.stdout ?? null,
      stderr: null,
      approvalStatus,
      ...rowPresentation(message),
    }));
  }
  if (message.kind === "workflow") {
    return buildWorkflowWorkRows([message], options.rowIdPrefix);
  }
  if (message.kind === "operation") return operationRows(message, base);
  if (message.kind === "error") {
    const { title, detail } = buildTimelineErrorDisplay(message);
    const reconnect = message.willRetry === true;
    return [
      {
        ...base,
        kind: "system",
        systemKind: reconnect ? "reconnect" : "error",
        title,
        detail,
        status: reconnect ? null : "error",
      },
    ];
  }
  if (message.kind === "exec" && message.workKind === "delegation") {
    const childOptions = {
      ...options,
      includeNestedRows: true,
      rowIdPrefix: `${base.id}:child:`,
    };
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
        childRows: messageRows(message.children, childOptions).filter(
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
  }
  if (message.kind === "user" && isSuppressedSystemMessage(message)) return [];
  const {
    id,
    threadId,
    sourceSeqStart,
    sourceSeqEnd,
    createdAt,
    scope,
    startedAt,
    parentToolCallId,
    kind,
    ...fields
  } = message;
  return "role" in fields
    ? [{ ...base, kind: "conversation", ...fields }]
    : [{ ...base, kind: "work", ...fields }];
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

function messageRows(
  messages: readonly Message[],
  options: BuildTimelineRowsOptions,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const message of messages) {
    appendRows(rows, convertMessage(message, options));
  }
  return rows;
}

function orderRowsAfterExternalUserBoundary(
  rows: TimelineRow[],
  entries: readonly ProjectionEntry[],
): TimelineRow[] {
  const boundarySeqs = entries.flatMap((entry) =>
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
  entries: readonly ProjectionEntry[],
  options: BuildTimelineRowsOptions,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const { completedTurnDisplay, rowIdPrefix } = options;
  for (const item of planTimelineRows(
    entries,
    completedTurnDisplay,
    rowIdPrefix,
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
  return orderRowsAfterExternalUserBoundary(rows, entries);
}

function buildPendingSteerRows(
  events: ThreadEventWithMeta[],
  options: BuildTimelineRowsOptions,
  threadStatus: Thread["status"],
): TimelineSourceRow[] {
  if (!requests.shouldPreservePendingMessages(threadStatus)) return [];
  const orderedEvents = getOrderedThreadEvents(events);
  const acceptedById = requests.buildAcceptedClientRequestById(orderedEvents);
  const rejectedIds = new Set(
    orderedEvents.flatMap(({ event }) =>
      event.type === "client/turn/rejected" ? [event.requestId] : [],
    ),
  );
  return orderedEvents.flatMap(({ event, meta }) => {
    const pendingSteer =
      event.type === "client/turn/requested" &&
      !rejectedIds.has(event.requestId) &&
      !acceptedById.has(event.requestId) &&
      requests.turnRequestKind(event, undefined) === "steer";
    return pendingSteer
      ? requests
          .clientRequestUserMessages(event, meta, "pending")
          .flatMap((steer) => convertMessage(steer, options))
      : [];
  });
}

export function buildThreadTimelineFromEvents(args: {
  contextWindowEvents: ThreadEventWithMeta[];
  headStateEvents?: ThreadEventWithMeta[];
  events: ThreadEventWithMeta[];
  options: ThreadTimelineFromEventsOptions;
}): ThreadTimelineFromEventsResult {
  const { events, options } = args;
  const { threadStatus, providerId, planCommand } = options;
  const stateEvents = args.headStateEvents?.length
    ? getOrderedThreadEvents([...events, ...args.headStateEvents])
    : events;
  const projection = buildEventProjection(events, options);
  const rowOptions = { ...options, rowIdPrefix: "" };
  const latest = options.isLatestPage;
  return {
    activePromptMode: latest
      ? (extraction.extractThreadTimelineActivePlanTurn({
          events,
          planCommand,
          providerId,
          threadStatus,
        })?.promptMode ?? null)
      : null,
    activeThinking: projection.activeThinking,
    activeWorkflows: buildWorkflowWorkRows(projection.activeWorkflows, ""),
    activeBackgroundCommands: buildWorkflowWorkRows(
      projection.activeBackgroundCommands,
      "",
    ),
    contextWindowUsage: extraction.extractThreadContextWindowUsage(
      args.contextWindowEvents,
    ),
    goal: latest ? extraction.extractThreadTimelineGoal(stateEvents) : null,
    modelFallback: latest
      ? extraction.extractThreadTimelineModelFallback(events)
      : null,
    pendingTodos: latest
      ? extraction.extractThreadTimelinePendingTodos(threadStatus, stateEvents)
      : null,
    rows: [
      ...buildTimelineRows(projection.entries, rowOptions),
      ...buildPendingSteerRows(events, rowOptions, threadStatus),
    ],
  };
}
