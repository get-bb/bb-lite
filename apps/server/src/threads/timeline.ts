import type {
  CompletedTurnDisplay,
  ProviderComposerCommand,
  ThreadEventItemType,
  ThreadStatus,
} from "@bb/domain";
import {
  computeTimelineRowDelta,
  type ThreadConversationOutlineResponse,
  type ThreadTimelineResponse,
  type TimelineRow,
  type TimelineTurnSummaryDetailsResponse,
} from "@bb/server-contract";
import {
  buildThreadTimelineFromEvents,
  buildThreadTimelineTurnDetailsFromEvents,
  compactThreadTimelineSummaryEvents,
  isExternalUserBoundaryForTurn,
  type ExternalUserBoundaryTurnSpan,
} from "@bb/thread-view";
import { z } from "zod";
import {
  contextClearSequence,
  decodeEventWithMeta,
  eventItem,
  firstParentedBoundary,
  hasSequence,
  latestSequence,
  listBackgroundTaskStates,
  listChildEvents,
  listContextWindowUsageEvents,
  listDelegatingItemEvents,
  listEvents,
  listGoalStateEvents,
  listItemEvents,
  listItemSpans,
  listOpenBackgroundTaskStates,
  listOrderingContext,
  listOutlineEvents,
  listRequestIdsInRange,
  listRequestOutcomes,
  listRootWindowTurnIds,
  listTodoSnapshotEvents,
  listTurnEvents,
  listTurnRequestsByIds,
  listTurnStarts,
  listWindowEvents,
  BUFFERED_TEXT_DELTA_TYPES,
  MAX_INLINE_OUTPUT_CHARS,
  mergeEventRows,
  requestSequencesDescending,
  scopedItemKey,
  windowBudgetFloor,
  type EventWindow,
  type ScopedItem,
  type StoredEventRow,
} from "../db/event-read.js";
import type { Db } from "../db/index.js";
import type { ThreadListRow } from "../db/thread-read.js";
import { invalidRequest } from "../http/errors.js";
import {
  bindCursor,
  limitResponseOutputs,
  paginateContents,
  paginateTimeline,
  snapshotFromCursor,
  splitsSurrogatePair,
  type TimelineContentCursor,
  type TimelinePage,
  type TimelineSnapshot,
} from "./timeline-pages.js";

export interface TimelineDisplay {
  completedTurnDisplay: CompletedTurnDisplay;
  includeDiagnosticOperations: boolean;
  providerDisplayName: string | undefined;
  planCommand: ProviderComposerCommand | null;
}

export interface TimelineRequest extends TimelineDisplay {
  page: TimelinePage;
  includeNestedRows: boolean;
  summaryOnly: boolean;
  eventBudget: number;
  afterSequence?: number;
}

export interface TurnDetailsRequest extends TimelineDisplay {
  turnId: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  beforeCursor?: string;
}

interface EventSelection {
  rows: StoredEventRow[];
  headStateRows: StoredEventRow[];
  contextOnlyInterruptions: ReadonlySet<number>;
  orderingBoundary: number | null;
  ownedSequenceStart: number;
  ownedSequenceEnd: number;
  knownHasOlderSegments: boolean | null;
  paginationPage: TimelinePage;
}

interface SelectionArgs {
  threadId: string;
  page: TimelinePage;
  eventBudget: number;
  epochStart: number;
  excludeDiagnostics: boolean;
  maxSeq: number;
  contentCursor: TimelineContentCursor | undefined;
}

interface ServedRows {
  maxSeq: number;
  rows: readonly TimelineRow[];
}

const MAX_EMPTY_WINDOWS = 8;
const RESPONSE_BYTE_LIMIT = 4 * 1024 * 1024;
const DETAIL_LEAF_LIMIT = 1_500;
const SERVED_KEY_LIMIT = 64;
const SERVED_RING_SIZE = 4;
const OUTLINE_CACHE_LIMIT = 128;
const OUTLINE_PREVIEW_CHARS = 200;
const REQUEST_CONTEXT_TYPES = [
  "client/turn/requested",
  "client/turn/rejected",
  "turn/input/accepted",
  "turn/started",
  "turn/completed",
  "system/thread/interrupted",
] as const;
const CROSS_TURN_TOOL_KINDS: ReadonlySet<ThreadEventItemType> = new Set([
  "commandExecution",
  "toolCall",
  "webSearch",
  "webFetch",
  "imageView",
  "fileRead",
  "search",
  "planSteps",
  "delegation",
  "extension",
]);
const BUFFERED_TEXT_KINDS = new Set(["agentMessage", "plan", "reasoning"]);
const requestRefSchema = z.object({
  requestId: z.string().optional(),
  clientRequestId: z.string().optional(),
});

function requestIdOf(row: StoredEventRow): string | null {
  const ref = requestRefSchema.parse(JSON.parse(row.data));
  return ref.clientRequestId ?? ref.requestId ?? null;
}

function requestIds(rows: readonly StoredEventRow[], ...types: string[]) {
  return rows.flatMap((row) =>
    types.includes(row.type) ? (requestIdOf(row) ?? []) : [],
  );
}

function threadName(thread: ThreadListRow): string {
  return thread.title ?? thread.titleFallback ?? "";
}

function isDelegatingItem(row: StoredEventRow): boolean {
  const delegating =
    row.itemKind === "toolCall" || row.itemKind === "delegation";
  return delegating && row.itemId !== null;
}

function withParentedRows(
  db: Db,
  window: EventWindow,
  input: readonly StoredEventRow[],
): StoredEventRow[] {
  let rows = [...input];
  const known = new Set(rows.map((row) => row.id));
  const toolCallIds = new Set(
    rows.flatMap((row) => (isDelegatingItem(row) ? (row.itemId ?? []) : [])),
  );
  const fetched = new Set<string>();
  for (;;) {
    const pending = [...toolCallIds].filter((id) => !fetched.has(id));
    if (pending.length === 0) break;
    for (const id of pending) fetched.add(id);
    const children = listChildEvents(db, window, pending).filter(
      (row) => !known.has(row.id),
    );
    for (const row of children) {
      known.add(row.id);
      if (isDelegatingItem(row) && row.itemId !== null) {
        toolCallIds.add(row.itemId);
      }
    }
    if (children.length > 0) rows = mergeEventRows([...rows, ...children]);
  }
  const missingParents = rows.flatMap((row) => {
    const parent = row.parentToolCallId ?? "";
    return parent.length > 0 && !toolCallIds.has(parent) ? [parent] : [];
  });
  const { threadId, fullOutputs } = window;
  const parents = listDelegatingItemEvents(
    db,
    threadId,
    missingParents,
    fullOutputs,
  ).filter((row) => !known.has(row.id));
  return parents.length > 0 ? mergeEventRows([...parents, ...rows]) : rows;
}

function withTurnStarts(
  db: Db,
  threadId: string,
  rows: readonly StoredEventRow[],
): StoredEventRow[] {
  const started = new Set(
    rows.flatMap((row) => (row.type === "turn/started" ? [row.turnId] : [])),
  );
  const missing = rows.flatMap((row) =>
    row.turnId !== null && !started.has(row.turnId) ? [row.turnId] : [],
  );
  const cutoff = rows.reduce((max, row) => Math.max(max, row.sequence), 0);
  const starts = listTurnStarts(db, threadId, missing, cutoff);
  return starts.length === 0 ? [...rows] : mergeEventRows([...starts, ...rows]);
}

function withBackgroundTaskStates(
  db: Db,
  threadId: string,
  rows: readonly StoredEventRow[],
  beforeSequence: number,
): StoredEventRow[] {
  const itemIds = rows.flatMap((row) => {
    const tracked =
      row.itemKind === "backgroundTask" || row.itemKind === "delegation";
    return tracked && row.itemId !== null ? [row.itemId] : [];
  });
  const states = listBackgroundTaskStates(
    db,
    threadId,
    itemIds,
    beforeSequence,
  );
  return states.length === 0 ? [...rows] : mergeEventRows([...rows, ...states]);
}

function groupingContext(
  db: Db,
  threadId: string,
  sequenceStart: number,
  maxSeq: number,
) {
  const context = listOrderingContext(db, threadId, sequenceStart, maxSeq);
  const spans = new Map<string, ExternalUserBoundaryTurnSpan>();
  const accepted = new Map<string, { sequence: number; turnId: string }>();
  for (const row of context) {
    const { turnId, sequence } = row;
    if (turnId === null) continue;
    if (row.type === "turn/input/accepted" && row.clientRequestId !== null) {
      accepted.set(row.clientRequestId, { sequence, turnId });
    }
    const rootStart =
      row.type === "turn/started" && row.parentToolCallId === null;
    if (rootStart && !spans.has(turnId)) {
      const completionSequence = null;
      spans.set(turnId, {
        completionSequence,
        sequenceStart: sequence,
        turnId,
      });
    }
    const span = spans.get(turnId);
    if (row.type === "turn/completed" && span?.completionSequence === null) {
      span.completionSequence = sequence;
    }
  }
  const requests = context.filter(
    (row) => row.type === "client/turn/requested" && row.requestId !== null,
  );
  for (const row of requests) {
    const span = spans.get(accepted.get(row.requestId ?? "")?.turnId ?? "");
    if (span !== undefined) {
      span.sequenceStart = Math.min(span.sequenceStart, row.sequence);
    }
  }
  let boundary =
    firstParentedBoundary(db, threadId, sequenceStart, maxSeq) ?? Infinity;
  const ordered = [...spans.values()].sort(
    (left, right) => left.sequenceStart - right.sequenceStart,
  );
  const spanEnd = (span: ExternalUserBoundaryTurnSpan | null): number =>
    span === null ? -Infinity : (span.completionSequence ?? Infinity);
  let next = 0;
  let longest: ExternalUserBoundaryTurnSpan | null = null;
  let runnerUp: ExternalUserBoundaryTurnSpan | null = null;
  for (const row of requests) {
    if (row.initiator !== "user" || row.hasInput !== 1) continue;
    const acceptance = accepted.get(row.requestId ?? "");
    const steered =
      acceptance !== undefined &&
      row.expectedTurnId !== null &&
      acceptance.turnId === row.expectedTurnId;
    const message = {
      sequence: steered ? acceptance.sequence : row.sequence,
      turnId: acceptance?.turnId ?? row.expectedTurnId,
    };
    if (message.sequence >= boundary) break;
    for (; next < ordered.length; next += 1) {
      const span = ordered[next];
      if (span === undefined || span.sequenceStart >= message.sequence) break;
      if (spanEnd(span) > spanEnd(longest)) {
        runnerUp = longest;
        longest = span;
      } else if (spanEnd(span) > spanEnd(runnerUp)) {
        runnerUp = span;
      }
    }
    const candidate = longest?.turnId === message.turnId ? runnerUp : longest;
    if (
      candidate !== null &&
      isExternalUserBoundaryForTurn(candidate, message)
    ) {
      boundary = message.sequence;
      break;
    }
  }
  return {
    orderingBoundary: Number.isFinite(boundary) ? boundary : null,
    acceptedTurnIds: new Map(
      [...accepted].map(([requestId, entry]) => [requestId, entry.turnId]),
    ),
  };
}

function windowStart(
  hints: readonly number[],
  budgetFloor: number | undefined,
  segmentLimit: number,
  epochStart: number,
): number {
  if (budgetFloor === undefined && hints.length <= segmentLimit) {
    return epochStart;
  }
  const affordable = hints.filter(
    (sequence) => budgetFloor === undefined || sequence >= budgetFloor,
  );
  const last = affordable[Math.min(segmentLimit, affordable.length) - 1];
  return last ?? hints[0] ?? budgetFloor ?? epochStart;
}

function selectTimelineEvents(db: Db, args: SelectionArgs): EventSelection {
  const { threadId, page, epochStart, maxSeq, contentCursor } = args;
  const { excludeDiagnostics } = args;
  const older = page.kind === "older" ? page.beforeCursor.anchorSeq : null;
  const beforeSequence = contentCursor?.beforeSequence ?? older ?? maxSeq + 1;
  const epoch = { threadId, sequenceStart: epochStart, excludeDiagnostics };
  const hints = requestSequencesDescending(
    db,
    { ...epoch, beforeSequence },
    page.segmentLimit + 1,
  );
  const anchorGone =
    older !== null && older !== epochStart && !hasSequence(db, threadId, older);
  if (anchorGone) {
    throw invalidRequest("Timeline pagination cursor is no longer available");
  }
  const floor = windowBudgetFloor(
    db,
    { ...epoch, beforeSequence },
    args.eventBudget,
  );
  const sequenceStart =
    contentCursor !== undefined && older !== null
      ? older
      : windowStart(hints, floor, page.segmentLimit, epochStart);
  const hasOlder =
    sequenceStart > epochStart &&
    windowBudgetFloor(db, { ...epoch, beforeSequence: sequenceStart }, 0) !==
      undefined;
  const window = { ...epoch, sequenceStart, beforeSequence };
  const history = { ...epoch, beforeSequence: maxSeq + 1 };
  const grouping = groupingContext(db, threadId, epochStart, maxSeq);
  let rows = listWindowEvents(db, window, "thread-scoped");
  const initialTurnIds = [
    ...listRootWindowTurnIds(db, window),
    ...requestIds(rows, "client/turn/requested").flatMap(
      (requestId) => grouping.acceptedTurnIds.get(requestId) ?? [],
    ),
  ];
  const known = (row: StoredEventRow): boolean => row.sequence <= maxSeq;
  const fetched = new Set<string>();
  for (;;) {
    const turnIds = [
      ...new Set([
        ...initialTurnIds,
        ...rows.flatMap((row) => row.turnId ?? []),
      ]),
    ].filter((turnId) => !fetched.has(turnId));
    if (turnIds.length === 0) break;
    for (const turnId of turnIds) fetched.add(turnId);
    const turnRows = listTurnEvents(db, history, turnIds);
    rows = withParentedRows(
      db,
      history,
      mergeEventRows([...rows, ...turnRows]),
    ).filter(known);
  }
  rows = withBackgroundTaskStates(db, threadId, rows, maxSeq + 1);
  if (page.kind === "latest") {
    const open = listOpenBackgroundTaskStates(db, threadId);
    rows = mergeEventRows([...rows.filter(known), ...open]);
  }
  rows = rows.filter(known);
  const contextStart = rows.reduce(
    (start, row) => Math.min(start, row.sequence),
    sequenceStart,
  );
  const contextEnd = rows.reduce(
    (end, row) => Math.max(end, row.sequence),
    beforeSequence - 1,
  );
  const contextRows = listEvents(db, {
    threadId,
    afterSequence: contextStart - 1,
    beforeSequence: contextEnd + 1,
    types: REQUEST_CONTEXT_TYPES,
  });
  const visible = [...contextRows, ...rows];
  const requested = new Set(requestIds(visible, "client/turn/requested"));
  const requestRows = listTurnRequestsByIds(
    db,
    threadId,
    requestIds(rows, "turn/input/accepted").filter((id) => !requested.has(id)),
  ).filter(known);
  const requestContext = [...contextRows, ...requestRows, ...rows];
  const settled = new Set(
    requestIds(requestContext, "turn/input/accepted", "client/turn/rejected"),
  );
  const outcomes = listRequestOutcomes(
    db,
    threadId,
    requestIds(requestContext, "client/turn/requested").filter(
      (id) => !settled.has(id),
    ),
    contextStart - 1,
  ).filter(known);
  const interruptions = listEvents(db, {
    threadId,
    afterSequence: epochStart - 1,
    beforeSequence: maxSeq + 1,
    types: ["system/thread/interrupted"],
  });
  const visibleSequences = new Set(visible.map((row) => row.sequence));
  const unseen = (row: StoredEventRow): boolean =>
    known(row) && !visibleSequences.has(row.sequence);
  const headState =
    page.kind === "latest"
      ? [
          ...listGoalStateEvents(db, [threadId]),
          ...listTodoSnapshotEvents(db, threadId),
        ]
      : [];
  return {
    headStateRows: mergeEventRows(headState).filter(unseen),
    contextOnlyInterruptions: new Set(
      interruptions.filter(unseen).map((row) => row.sequence),
    ),
    orderingBoundary: grouping.orderingBoundary,
    ownedSequenceStart: sequenceStart,
    ownedSequenceEnd: beforeSequence,
    knownHasOlderSegments: hasOlder ? true : null,
    paginationPage:
      contentCursor === undefined ? page : { ...page, segmentLimit: 1 },
    rows: withTurnStarts(
      db,
      threadId,
      mergeEventRows([
        ...interruptions,
        ...outcomes,
        ...contextRows,
        ...requestRows,
        ...rows,
      ]),
    ),
  };
}

function orderAfterBoundary(
  rows: readonly TimelineRow[],
  boundary: number | null,
): TimelineRow[] {
  const index =
    boundary === null
      ? -1
      : rows.findIndex((row) => row.sourceSeqStart >= boundary);
  if (index < 0) return [...rows];
  const tail = rows
    .slice(index)
    .sort(
      (left, right) =>
        left.sourceSeqStart - right.sourceSeqStart ||
        left.sourceSeqEnd - right.sourceSeqEnd,
    );
  return [...rows.slice(0, index), ...tail];
}

function latestSnapshot(
  db: Db,
  thread: ThreadListRow,
  surface: string,
): TimelineSnapshot {
  const { id: threadId, status } = thread;
  const maxSeq = latestSequence(db, threadId);
  return { version: 3, threadId, maxSeq, status, surface };
}

function projectionOptions(
  thread: ThreadListRow,
  display: TimelineDisplay,
  threadStatus: ThreadStatus,
) {
  return {
    completedTurnDisplay: display.completedTurnDisplay,
    includeDiagnosticOperations: display.includeDiagnosticOperations,
    providerDisplayName: display.providerDisplayName,
    threadStatus,
    threadName: threadName(thread),
    workspaceRoot: thread.environmentPath,
  };
}

function buildTimelinePage(
  db: Db,
  thread: ThreadListRow,
  request: TimelineRequest,
): ThreadTimelineResponse {
  const { page, includeNestedRows, completedTurnDisplay } = request;
  const surface = JSON.stringify([
    request.includeDiagnosticOperations,
    includeNestedRows,
    MAX_INLINE_OUTPUT_CHARS,
    request.providerDisplayName ?? null,
    threadName(thread),
    thread.environmentPath,
    completedTurnDisplay,
  ]);
  const cursor =
    page.kind === "latest"
      ? { snapshot: latestSnapshot(db, thread, surface), content: undefined }
      : snapshotFromCursor(page.beforeCursor, thread.id, surface);
  const { snapshot, content: contentCursor } = cursor;
  const { maxSeq } = snapshot;
  const contextBoundarySeq = contextClearSequence(db, thread.id, maxSeq);
  const epochStart = contextBoundarySeq ?? 0;
  const selection = selectTimelineEvents(db, {
    threadId: thread.id,
    page,
    eventBudget: request.eventBudget,
    epochStart,
    excludeDiagnostics: !request.includeDiagnosticOperations,
    maxSeq,
    contentCursor,
  });
  const latest = page.kind === "latest";
  const timeline = buildThreadTimelineFromEvents({
    acceptedClientRequestContext: {
      acceptedClientRequestEvents: [],
      rejectedClientRequestEvents: [],
    },
    contextWindowEvents: listContextWindowUsageEvents(
      db,
      thread.id,
      epochStart,
    ).map(decodeEventWithMeta),
    headStateEvents: selection.headStateRows.map(decodeEventWithMeta),
    events: compactThreadTimelineSummaryEvents(
      selection.rows.map(decodeEventWithMeta),
    ),
    options: {
      ...projectionOptions(thread, request, snapshot.status),
      includeNestedRows,
      isLatestPage: latest,
      planCommand: request.planCommand,
      providerId: thread.providerId,
    },
  });
  const projected = timeline.rows.filter(
    (row) =>
      !(
        row.kind === "system" &&
        row.systemKind === "operation" &&
        row.operationKind === "thread-interrupted" &&
        selection.contextOnlyInterruptions.has(row.sourceSeqStart)
      ),
  );
  const paginated = paginateTimeline({
    contentCursor,
    maxLeaves: Math.max(1, request.eventBudget),
    maxBytes: RESPONSE_BYTE_LIMIT,
    ownedSequenceStart: selection.ownedSequenceStart,
    ownedSequenceEnd: selection.ownedSequenceEnd,
    knownHasOlderSegments: selection.knownHasOlderSegments,
    page: selection.paginationPage,
    rows: orderAfterBoundary(projected, selection.orderingBoundary),
  });
  const { summaryOnly } = request;
  return {
    maxSeq,
    rows: summaryOnly ? [] : paginated.rows,
    contextBoundarySeq,
    completedTurnDisplay,
    activePromptMode: latest ? timeline.activePromptMode : null,
    activeThinking: latest ? timeline.activeThinking : null,
    activeWorkflows: latest ? timeline.activeWorkflows : [],
    activeBackgroundCommands: latest ? timeline.activeBackgroundCommands : [],
    pendingTodos: timeline.pendingTodos,
    goal: timeline.goal,
    modelFallback: latest ? timeline.modelFallback : null,
    contextWindowUsage: latest
      ? (timeline.contextWindowUsage ?? undefined)
      : undefined,
    timelinePage: {
      kind: page.kind,
      segmentLimit: page.segmentLimit,
      returnedSegmentCount: paginated.returnedSegmentCount,
      hasOlderRows: paginated.hasOlderRows,
      olderCursor: bindCursor(
        paginated.olderCursor,
        snapshot,
        paginated.contentCursor,
      ),
      historySnapshot: JSON.stringify(snapshot),
      olderRowsSourceSeqEnd: paginated.olderRowsSourceSeqEnd,
      olderRowUpdates: summaryOnly ? undefined : paginated.olderRowUpdates,
      contentPage: paginated.contentPage,
    },
  };
}

export function buildThreadTimeline(
  db: Db,
  thread: ThreadListRow,
  request: TimelineRequest,
): ThreadTimelineResponse {
  const response = db.transaction(() => {
    const result = buildTimelinePage(db, thread, request);
    for (let skipped = 0; skipped < MAX_EMPTY_WINDOWS; skipped += 1) {
      const beforeCursor = result.timelinePage.olderCursor;
      const { segmentLimit } = request.page;
      if (request.summaryOnly || beforeCursor === null) break;
      if (result.rows.length > 0) break;
      const page: TimelinePage = { kind: "older", beforeCursor, segmentLimit };
      const older = buildTimelinePage(db, thread, { ...request, page });
      result.rows = older.rows;
      result.timelinePage = { ...older.timelinePage, kind: request.page.kind };
    }
    return result;
  });
  return limitResponseOutputs(response, !request.includeNestedRows);
}

function bytesOf(rows: readonly StoredEventRow[]): number {
  return rows.reduce((sum, row) => sum + Buffer.byteLength(row.data), 0);
}

function turnRowsOnly(
  rows: readonly StoredEventRow[],
  turnId: string,
  requestsOfOtherTurns: ReadonlySet<string>,
): StoredEventRow[] {
  const openToolCalls = new Set<string>();
  return rows.filter((row) => {
    const { itemId, itemKind } = row;
    if (row.turnId !== null && row.turnId !== turnId) {
      const continues = row.type.startsWith("item/") && itemId !== null;
      if (!continues || !openToolCalls.has(itemId)) return false;
    } else if (
      row.type === "item/started" &&
      itemId !== null &&
      itemKind !== null &&
      CROSS_TURN_TOOL_KINDS.has(itemKind)
    ) {
      openToolCalls.add(itemId);
    }
    if (row.type === "item/completed" && itemId !== null) {
      openToolCalls.delete(itemId);
    }
    const [requestId] = requestIds([row], "client/turn/requested");
    return requestId === undefined || !requestsOfOtherTurns.has(requestId);
  });
}

function identifiesBufferedText(row: StoredEventRow): boolean {
  if (row.type === "item/started") {
    return BUFFERED_TEXT_KINDS.has(row.itemKind ?? "");
  }
  return BUFFERED_TEXT_DELTA_TYPES.includes(row.type);
}

function withWholeItems(
  db: Db,
  window: EventWindow,
  input: readonly StoredEventRow[],
): StoredEventRow[] {
  const { threadId, sequenceStart, beforeSequence, fullOutputs } = window;
  const items = new Map<string, ScopedItem>();
  for (const row of input) {
    const inWindow = row.itemId !== null && row.sequence >= sequenceStart;
    if (!inWindow || row.itemKind === "backgroundTask") continue;
    items.set(scopedItemKey(eventItem(row)), eventItem(row));
  }
  const newer = new Set<string>();
  const earlier = new Map<string, ScopedItem>();
  for (const span of listItemSpans(db, threadId, [...items.values()])) {
    const key = scopedItemKey(span);
    if (span.maxSequence >= beforeSequence) newer.add(key);
    else if (span.minSequence < sequenceStart) earlier.set(key, span);
  }
  const rows = input.filter(
    (row) => row.itemId === null || !newer.has(scopedItemKey(eventItem(row))),
  );
  const backfill = listItemEvents(
    db,
    threadId,
    [...earlier.values()],
    "lifecycle",
    sequenceStart,
    fullOutputs,
  );
  const known = [...backfill, ...rows];
  const completed = new Set(
    known.flatMap((row) =>
      row.type === "item/completed" ? [scopedItemKey(eventItem(row))] : [],
    ),
  );
  const streaming = known.filter((row) => {
    const key = scopedItemKey(eventItem(row));
    const open = earlier.has(key) && !completed.has(key);
    return row.itemId !== null && identifiesBufferedText(row) && open;
  });
  const deltas = listItemEvents(
    db,
    threadId,
    streaming.map(eventItem),
    "text-deltas",
    sequenceStart,
  );
  return mergeEventRows([...backfill, ...deltas, ...rows]);
}

function buildTurnDetails(
  db: Db,
  thread: ThreadListRow,
  request: TurnDetailsRequest,
): TimelineTurnSummaryDetailsResponse {
  const { turnId, sourceSeqStart, sourceSeqEnd, beforeCursor } = request;
  if (sourceSeqStart > sourceSeqEnd) {
    throw invalidRequest(
      "sourceSeqStart must be less than or equal to sourceSeqEnd",
    );
  }
  const range = `${sourceSeqStart}-${sourceSeqEnd}`;
  const surface = JSON.stringify([
    "turn-details",
    turnId,
    sourceSeqStart,
    sourceSeqEnd,
    request.includeDiagnosticOperations,
    request.providerDisplayName ?? null,
    threadName(thread),
    thread.environmentPath,
    request.completedTurnDisplay,
  ]);
  const anchorSeq = Math.max(1, sourceSeqStart);
  const cursor =
    beforeCursor === undefined
      ? { snapshot: latestSnapshot(db, thread, surface), content: undefined }
      : snapshotFromCursor(
          { anchorId: beforeCursor, anchorSeq },
          thread.id,
          surface,
        );
  const { snapshot, content } = cursor;
  const { maxSeq } = snapshot;
  const threadId = thread.id;
  const base = {
    threadId,
    sequenceStart: sourceSeqStart,
    beforeSequence: Math.min(sourceSeqEnd, maxSeq) + 1,
    excludeDiagnostics: !request.includeDiagnosticOperations,
  };
  const full = listWindowEvents(db, { ...base, fullOutputs: true }, "all");
  const fullOutputs = bytesOf(full) <= RESPONSE_BYTE_LIMIT;
  const window = { ...base, fullOutputs };
  const exact = fullOutputs ? full : listWindowEvents(db, window, "all");
  const accepted = [
    ...exact.filter((row) => row.type === "turn/input/accepted"),
    ...listRequestOutcomes(
      db,
      threadId,
      listRequestIdsInRange(db, threadId, sourceSeqStart, sourceSeqEnd),
      sourceSeqEnd,
      ["turn/input/accepted"],
    ).filter((row) => row.sequence <= maxSeq),
  ];
  const ofOtherTurns = new Set(
    requestIds(
      accepted.filter((row) => row.turnId !== turnId),
      "turn/input/accepted",
    ),
  );
  const turnRows = mergeEventRows([
    ...turnRowsOnly(exact, turnId, ofOtherTurns),
    ...accepted.filter((row) => row.turnId === turnId),
  ]);
  if (!turnRows.some((row) => row.turnId === turnId)) {
    throw invalidRequest(
      `Timeline turn summary details range ${range} does not include ` +
        `turn ${turnId}`,
    );
  }
  const hasStart = turnRows.some(
    (row) => row.type === "turn/started" && row.turnId === turnId,
  );
  const cutoff = turnRows.reduce(
    (max, row) => Math.max(max, row.sequence),
    sourceSeqEnd,
  );
  const start = hasStart ? [] : listTurnStarts(db, threadId, [turnId], cutoff);
  if (!hasStart && start.length === 0) {
    throw invalidRequest(
      `Timeline turn summary details range ${range} cannot resolve ` +
        `turn/started for ${turnId}`,
    );
  }
  const anchored = mergeEventRows([...start, ...turnRows]);
  const history = { ...window, beforeSequence: maxSeq + 1 };
  const rows = withBackgroundTaskStates(
    db,
    threadId,
    withTurnStarts(
      db,
      threadId,
      withParentedRows(db, history, withWholeItems(db, window, anchored)),
    ),
    maxSeq + 1,
  );
  const events = rows
    .filter((row) => row.sequence <= maxSeq)
    .map(decodeEventWithMeta);
  const details = buildThreadTimelineTurnDetailsFromEvents({
    events,
    options: {
      ...projectionOptions(thread, request, snapshot.status),
      sourceSeqStart,
      turnId,
    },
  });
  if (details.kind === "missing-match") {
    throw new Error(`Timeline turn summary details could not match ${range}`);
  }
  const page = paginateContents(
    details.rows,
    content?.beforeLeaf,
    DETAIL_LEAF_LIMIT,
    RESPONSE_BYTE_LIMIT,
  );
  const older =
    page.start === 0
      ? null
      : bindCursor({ anchorId: turnId, anchorSeq }, snapshot, {
          beforeLeaf: page.start,
          beforeSequence: maxSeq + 1,
        });
  return {
    rows: page.rows,
    olderCursor: older?.anchorId ?? null,
    historySnapshot: JSON.stringify(snapshot),
  };
}

function outlinePreview(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length <= OUTLINE_PREVIEW_CHARS) return normalized;
  const split = splitsSurrogatePair(normalized, OUTLINE_PREVIEW_CHARS);
  return normalized.slice(0, OUTLINE_PREVIEW_CHARS - (split ? 1 : 0)).trimEnd();
}

function buildOutline(
  db: Db,
  thread: ThreadListRow,
  display: TimelineDisplay,
  maxSeq: number,
): ThreadConversationOutlineResponse["items"] {
  const epochStart = contextClearSequence(db, thread.id, maxSeq) ?? 0;
  const rows = listOutlineEvents(db, thread.id, epochStart);
  const events = rows.map(decodeEventWithMeta);
  const accepted = new Set(requestIds(rows, "turn/input/accepted"));
  const openSteers = events.flatMap(({ event, meta }) => {
    if (event.type !== "client/turn/requested") return [];
    const { target, requestId } = event;
    const steers =
      (target.kind === "auto" || target.kind === "steer") &&
      target.expectedTurnId !== null;
    return steers && !accepted.has(requestId) ? [{ requestId, ...meta }] : [];
  });
  const outcomes = listRequestOutcomes(
    db,
    thread.id,
    openSteers.map((steer) => steer.requestId),
    Math.min(...openSteers.map((steer) => steer.seq)),
  ).map(decodeEventWithMeta);
  const outcomesOf = (type: string) =>
    outcomes.filter(({ event }) => event.type === type);
  const timeline = buildThreadTimelineFromEvents({
    acceptedClientRequestContext: {
      acceptedClientRequestEvents: outcomesOf("turn/input/accepted"),
      rejectedClientRequestEvents: outcomesOf("client/turn/rejected"),
    },
    contextWindowEvents: [],
    events: compactThreadTimelineSummaryEvents(events),
    options: {
      ...projectionOptions(
        thread,
        { ...display, includeDiagnosticOperations: false },
        thread.status,
      ),
      includeNestedRows: false,
      isLatestPage: true,
      providerId: thread.providerId,
    },
  });
  return timeline.rows.flatMap((row) => {
    if (row.kind !== "conversation") return [];
    const { webImages = 0, localImages = 0 } = row.attachments ?? {};
    const imageCount = webImages + localImages;
    const fileCount = row.attachments?.localFiles ?? 0;
    const attachmentSummary =
      imageCount + fileCount === 0 ? null : { imageCount, fileCount };
    const preview = outlinePreview(row.text);
    return [{ id: row.id, role: row.role, preview, attachmentSummary }];
  });
}

function remember<Value>(
  cache: Map<string, Value>,
  key: string,
  value: Value,
  limit: number,
): void {
  cache.delete(key);
  cache.set(key, value);
  for (const oldest of cache.keys()) {
    if (cache.size <= limit) break;
    cache.delete(oldest);
  }
}

export function createTimelineReader(db: Db) {
  const served = new Map<string, ServedRows[]>();
  const outlines = new Map<string, ThreadConversationOutlineResponse>();
  const forgetThread = (threadId: string): void => {
    for (const cache of [served, outlines]) {
      for (const key of cache.keys()) {
        if (key.startsWith(`${threadId}|`)) cache.delete(key);
      }
    }
  };
  return {
    forgetThread,
    timeline(
      thread: ThreadListRow,
      request: TimelineRequest,
    ): ThreadTimelineResponse {
      const { page, afterSequence } = request;
      const full = buildThreadTimeline(db, thread, request);
      const key = [
        thread.id,
        thread.status,
        thread.environmentId,
        request.providerDisplayName,
        page.segmentLimit,
        page.kind === "older" ? page.beforeCursor.anchorId : "latest",
        request.includeNestedRows,
        request.summaryOnly,
        request.includeDiagnosticOperations,
        request.completedTurnDisplay,
      ].join("|");
      const ring = served.get(key) ?? [];
      const previous = ring.find((entry) => entry.maxSeq === afterSequence);
      const { maxSeq, rows } = full;
      const kept = ring.filter((entry) => entry.maxSeq !== maxSeq);
      const next = [...kept, { maxSeq, rows }].slice(-SERVED_RING_SIZE);
      remember(served, key, next, SERVED_KEY_LIMIT);
      if (previous === undefined) return full;
      const delta = computeTimelineRowDelta(previous.rows, rows);
      return { ...full, rows: [], delta };
    },
    turnDetails(
      thread: ThreadListRow,
      request: TurnDetailsRequest,
    ): TimelineTurnSummaryDetailsResponse {
      return db.transaction(() => buildTurnDetails(db, thread, request));
    },
    outline(
      thread: ThreadListRow,
      display: TimelineDisplay,
    ): ThreadConversationOutlineResponse {
      const maxSeq = latestSequence(db, thread.id);
      const { status, title, titleFallback } = thread;
      const { completedTurnDisplay, providerDisplayName } = display;
      const facts = [maxSeq, status, title, titleFallback];
      const shown = [completedTurnDisplay, providerDisplayName];
      const key = `${thread.id}|${JSON.stringify([...facts, ...shown])}`;
      const cached = outlines.get(key);
      const outline = cached ?? {
        items: buildOutline(db, thread, display, maxSeq),
        maxSeq,
      };
      remember(outlines, key, outline, OUTLINE_CACHE_LIMIT);
      return outline;
    },
  };
}

export type TimelineReader = ReturnType<typeof createTimelineReader>;
