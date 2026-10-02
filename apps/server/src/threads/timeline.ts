import type {
  CompletedTurnDisplay,
  ProviderComposerCommand,
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
  compactThreadTimelineSummaryEvents,
  isExternalUserBoundaryForTurn,
  type ExternalUserBoundaryTurnSpan as TurnSpan,
} from "@bb/thread-view";
import { z } from "zod";
import {
  contextClearSequence,
  decodeEvents,
  firstParentedBoundary,
  latestSequence,
  listContextWindowUsageEvents,
  listEvents,
  listHeadStateEvents,
  listLatestItemStates,
  listOpenBackgroundTaskStates,
  listOrderingContext,
  listTurnIds,
  MAX_INLINE_OUTPUT_CHARS,
  mergeEventRows,
  OUTLINE_EVENT,
  ROOT_TURN_EVENT,
  UNBOUNDED,
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
  nestedTimelineRows,
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

interface Epoch {
  db: Db;
  threadId: string;
  start: number;
  maxSeq: number;
  excludeDiagnostics: boolean;
  outputs: "inline" | "full";
}

type Rows = readonly StoredEventRow[];
type LoadedWindow = ReturnType<typeof loadWindow>;

const MAX_EMPTY_WINDOWS = 8;
const RESPONSE_BYTE_LIMIT = 4 * 1024 * 1024;
const DETAIL_LEAF_LIMIT = 1_500;
const SERVED_KEY_LIMIT = 64;
const SERVED_RING_SIZE = 4;
const OUTLINE_CACHE_LIMIT = 128;
const OUTLINE_PREVIEW_CHARS = 200;
const REQUESTED = "client/turn/requested";
const ACCEPTED = "turn/input/accepted";
const REJECTED = "client/turn/rejected";
const INTERRUPTED = "system/thread/interrupted";
const TURN_BOUNDS = ["turn/started", "turn/completed"];
const CONTEXT_TYPES = [
  REQUESTED,
  REJECTED,
  ACCEPTED,
  INTERRUPTED,
  ...TURN_BOUNDS,
];
const requestRefSchema = z.object({
  requestId: z.string().optional(),
  clientRequestId: z.string().optional(),
});

function requestIds(rows: Rows, ...types: string[]): string[] {
  return rows.flatMap((row) => {
    if (!types.includes(row.type)) return [];
    const ref = requestRefSchema.parse(JSON.parse(row.data));
    return ref.clientRequestId ?? ref.requestId ?? [];
  });
}

function threadName(thread: ThreadListRow): string {
  return thread.title ?? thread.titleFallback ?? "";
}

function historyQuery(epoch: Epoch) {
  const { threadId, start, maxSeq, excludeDiagnostics, outputs } = epoch;
  const timeline = { excludeDiagnostics };
  return { threadId, after: start - 1, before: maxSeq + 1, timeline, outputs };
}

function delegatingItemId(row: StoredEventRow): string[] {
  const delegating =
    row.itemKind === "toolCall" || row.itemKind === "delegation";
  return delegating && row.itemId !== null ? [row.itemId] : [];
}

function withParentedRows(epoch: Epoch, input: Rows): StoredEventRow[] {
  const { db, threadId, outputs } = epoch;
  let rows = [...input];
  const known = new Set(rows.map((row) => row.id));
  const toolCallIds = new Set(rows.flatMap(delegatingItemId));
  const fetched = new Set<string>();
  for (;;) {
    const parentToolCallIds = [...toolCallIds].filter((id) => !fetched.has(id));
    if (parentToolCallIds.length === 0) break;
    for (const id of parentToolCallIds) fetched.add(id);
    const query = { ...historyQuery(epoch), parentToolCallIds };
    const children = listEvents(db, query).filter((row) => !known.has(row.id));
    for (const row of children) known.add(row.id);
    for (const id of children.flatMap(delegatingItemId)) toolCallIds.add(id);
    rows = mergeEventRows([...rows, ...children]);
  }
  const startedItemIds = rows.flatMap((row) => {
    const parent = row.parentToolCallId ?? "";
    return parent.length > 0 && !toolCallIds.has(parent) ? [parent] : [];
  });
  const where = "item_kind IN ('toolCall', 'delegation')";
  const missing = { threadId, startedItemIds, where, outputs };
  return mergeEventRows([...listEvents(db, missing), ...rows]);
}

function withTurnStarts(epoch: Epoch, rows: Rows): StoredEventRow[] {
  const started = new Set(
    rows.flatMap((row) => (row.type === "turn/started" ? [row.turnId] : [])),
  );
  const turnIds = rows.flatMap((row) =>
    row.turnId !== null && !started.has(row.turnId) ? [row.turnId] : [],
  );
  const cutoff = rows.reduce((max, row) => Math.max(max, row.sequence), 0);
  const { db, threadId } = epoch;
  const types = ["turn/started"];
  const query = { threadId, turnIds, types, before: cutoff + 1 };
  return mergeEventRows([...listEvents(db, query), ...rows]);
}

function withBackgroundTaskStates(epoch: Epoch, rows: Rows): StoredEventRow[] {
  const itemIds = rows.flatMap((row) => {
    const tracked =
      row.itemKind === "backgroundTask" || row.itemKind === "delegation";
    return tracked && row.itemId !== null ? [row.itemId] : [];
  });
  const { db, threadId, maxSeq } = epoch;
  const states = listLatestItemStates(db, threadId, itemIds, maxSeq + 1);
  return mergeEventRows([...rows, ...states]);
}

function groupingContext({ db, threadId, start, maxSeq }: Epoch) {
  const context = listOrderingContext(db, threadId, start, maxSeq);
  const spans = new Map<string, TurnSpan>();
  const accepted = new Map<string, { sequence: number; turnId: string }>();
  for (const row of context) {
    const { turnId, sequence } = row;
    if (turnId === null) continue;
    if (row.type === ACCEPTED && row.clientRequestId !== null) {
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
    (row) => row.type === REQUESTED && row.requestId !== null,
  );
  for (const row of requests) {
    const span = spans.get(accepted.get(row.requestId ?? "")?.turnId ?? "");
    if (span !== undefined) {
      span.sequenceStart = Math.min(span.sequenceStart, row.sequence);
    }
  }
  let boundary = firstParentedBoundary(db, threadId, start, maxSeq) ?? Infinity;
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
    const overlapsOtherTurn = [...spans.values()].some((span) =>
      isExternalUserBoundaryForTurn(span, message),
    );
    if (overlapsOtherTurn) boundary = message.sequence;
  }
  return {
    orderingBoundary: Number.isFinite(boundary) ? boundary : null,
    acceptedTurnIds: new Map(
      [...accepted].map(([requestId, entry]) => [requestId, entry.turnId]),
    ),
  };
}

function loadWindow(
  epoch: Epoch,
  after: number,
  before: number,
  latest: boolean,
) {
  const { db, threadId, maxSeq } = epoch;
  const history = historyQuery(epoch);
  const window = { ...history, after, before };
  const grouping = groupingContext(epoch);
  const known = (row: StoredEventRow): boolean => row.sequence <= maxSeq;
  let rows = listEvents(db, { ...window, where: "turn_id IS NULL" });
  const initialTurnIds = [
    ...listTurnIds(db, { ...window, where: ROOT_TURN_EVENT }),
    ...requestIds(rows, REQUESTED).flatMap(
      (requestId) => grouping.acceptedTurnIds.get(requestId) ?? [],
    ),
  ];
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
    const turnRows = listEvents(db, { ...history, turnIds });
    const merged = mergeEventRows([...rows, ...turnRows]);
    rows = withParentedRows(epoch, merged).filter(known);
  }
  rows = withBackgroundTaskStates(epoch, rows).filter(known);
  if (latest) {
    const open = listOpenBackgroundTaskStates(db, threadId);
    rows = mergeEventRows([...rows, ...open]).filter(known);
  }
  const contextStart = rows.reduce(
    (start, row) => Math.min(start, row.sequence),
    after + 1,
  );
  const contextEnd = rows.reduce(
    (end, row) => Math.max(end, row.sequence),
    before - 1,
  );
  const sinceContext = { threadId, after: contextStart - 1 };
  const contextRows = listEvents(db, {
    ...sinceContext,
    before: contextEnd + 1,
    types: CONTEXT_TYPES,
  });
  const visible = [...contextRows, ...rows];
  const requested = new Set(requestIds(visible, REQUESTED));
  const requestRows = listEvents(db, {
    threadId,
    types: [REQUESTED],
    requestIds: requestIds(rows, ACCEPTED).filter((id) => !requested.has(id)),
  }).filter(known);
  const requestContext = [...contextRows, ...requestRows, ...rows];
  const settled = new Set(requestIds(requestContext, ACCEPTED, REJECTED));
  const outcomes = listEvents(db, {
    ...sinceContext,
    types: [ACCEPTED, REJECTED],
    requestIds: requestIds(requestContext, REQUESTED).filter(
      (id) => !settled.has(id),
    ),
  }).filter(known);
  const { timeline: _filters, outputs: _outputs, ...wholeEpoch } = history;
  const interruptions = listEvents(db, { ...wholeEpoch, types: [INTERRUPTED] });
  const visibleSequences = new Set(visible.map((row) => row.sequence));
  const unseen = (row: StoredEventRow): boolean =>
    known(row) && !visibleSequences.has(row.sequence);
  const headState = latest
    ? [
        ...listHeadStateEvents(db, [threadId], "goal"),
        ...listHeadStateEvents(db, [threadId], "todos"),
      ]
    : [];
  return {
    headStateRows: mergeEventRows(headState).filter(unseen),
    contextOnlyInterruptions: new Set(
      interruptions.filter(unseen).map((row) => row.sequence),
    ),
    orderingBoundary: grouping.orderingBoundary,
    rows: withTurnStarts(
      epoch,
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

function selectPage(
  epoch: Epoch,
  page: TimelinePage,
  eventBudget: number,
  contentCursor: TimelineContentCursor | undefined,
) {
  const { db, threadId, start, maxSeq, excludeDiagnostics } = epoch;
  const older = page.kind === "older" ? page.beforeCursor.anchorSeq : null;
  const before = contentCursor?.beforeSequence ?? older ?? maxSeq + 1;
  const since = { threadId, after: start - 1 };
  const types = [REQUESTED];
  const limit = page.segmentLimit + 1;
  const hintQuery = { ...since, before, types, order: "desc" as const, limit };
  const hints = listEvents(db, hintQuery).map((row) => row.sequence);
  const anchor = {
    threadId,
    after: (older ?? 0) - 1,
    before: (older ?? 0) + 1,
  };
  const anchorGone =
    older !== null && older !== start && listEvents(db, anchor).length === 0;
  if (anchorGone) {
    throw invalidRequest("Timeline pagination cursor is no longer available");
  }
  const budgetFloor = (end: number, offset: number): number | undefined => {
    const timeline = { excludeDiagnostics, horizon: UNBOUNDED };
    const tail = { order: "desc" as const, limit: 1, offset };
    return listEvents(db, { ...since, before: end, timeline, ...tail })[0]
      ?.sequence;
  };
  const floor = budgetFloor(before, eventBudget);
  const sequenceStart =
    contentCursor !== undefined && older !== null
      ? older
      : windowStart(hints, floor, page.segmentLimit, start);
  const hasOlder =
    sequenceStart > start && budgetFloor(sequenceStart, 0) !== undefined;
  return {
    ...loadWindow(epoch, sequenceStart - 1, before, page.kind === "latest"),
    ownedSequenceStart: sequenceStart,
    ownedSequenceEnd: before,
    knownHasOlderSegments: hasOlder ? true : null,
    page: contentCursor === undefined ? page : { ...page, segmentLimit: 1 },
  };
}

function resolveSnapshot(
  db: Db,
  thread: ThreadListRow,
  surface: string,
  cursor: { anchorSeq: number; anchorId: string } | undefined,
): { snapshot: TimelineSnapshot; content?: TimelineContentCursor } {
  if (cursor !== undefined)
    return snapshotFromCursor(cursor, thread.id, surface);
  const { id: threadId, status } = thread;
  const maxSeq = latestSequence(db, threadId);
  return { snapshot: { version: 3, threadId, maxSeq, status, surface } };
}

function projectWindow(
  db: Db,
  thread: ThreadListRow,
  display: TimelineDisplay,
  threadStatus: ThreadStatus,
  loaded: { rows: Rows } & Partial<Omit<LoadedWindow, "rows">>,
  shape: { includeNestedRows: boolean; isLatestPage: boolean; usage?: Rows },
) {
  const { usage = [], ...shown } = shape;
  const timeline = buildThreadTimelineFromEvents({
    acceptedClientRequestContext: {
      acceptedClientRequestEvents: [],
      rejectedClientRequestEvents: [],
    },
    contextWindowEvents: decodeEvents(db, usage),
    headStateEvents: decodeEvents(db, loaded.headStateRows ?? []),
    events: compactThreadTimelineSummaryEvents(decodeEvents(db, loaded.rows)),
    options: {
      ...display,
      ...shown,
      threadStatus,
      threadName: threadName(thread),
      workspaceRoot: thread.environmentPath,
      providerId: thread.providerId,
    },
  });
  const rows = timeline.rows.filter(
    (row) =>
      !(
        row.kind === "system" &&
        row.systemKind === "operation" &&
        row.operationKind === "thread-interrupted" &&
        loaded.contextOnlyInterruptions?.has(row.sourceSeqStart)
      ),
  );
  const boundary = loaded.orderingBoundary ?? Infinity;
  const index = rows.findIndex((row) => row.sourceSeqStart >= boundary);
  const tail = rows
    .slice(index < 0 ? rows.length : index)
    .sort(
      (left, right) =>
        left.sourceSeqStart - right.sourceSeqStart ||
        left.sourceSeqEnd - right.sourceSeqEnd,
    );
  return {
    ...timeline,
    rows: [...rows.slice(0, rows.length - tail.length), ...tail],
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
  const latest = page.kind === "latest";
  const cursor = latest ? undefined : page.beforeCursor;
  const resolved = resolveSnapshot(db, thread, surface, cursor);
  const { snapshot, content: contentCursor } = resolved;
  const { maxSeq, threadId } = snapshot;
  const contextBoundarySeq = contextClearSequence(db, threadId, maxSeq);
  const start = contextBoundarySeq ?? 0;
  const excludeDiagnostics = !request.includeDiagnosticOperations;
  const outputs = "inline" as const;
  const epoch = { db, threadId, start, maxSeq, excludeDiagnostics, outputs };
  const selection = selectPage(epoch, page, request.eventBudget, contentCursor);
  const usage = listContextWindowUsageEvents(db, threadId, start);
  const shape = { includeNestedRows, isLatestPage: latest, usage };
  const { status } = snapshot;
  const timeline = projectWindow(db, thread, request, status, selection, shape);
  const paginated = paginateTimeline({
    ...selection,
    contentCursor,
    maxLeaves: Math.max(1, request.eventBudget),
    maxBytes: RESPONSE_BYTE_LIMIT,
    rows: timeline.rows,
  });
  const { summaryOnly } = request;
  const { olderCursor, contentCursor: nextContent } = paginated;
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
      olderCursor: bindCursor(olderCursor, snapshot, nextContent),
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
      ? undefined
      : { anchorId: beforeCursor, anchorSeq };
  const { snapshot, content } = resolveSnapshot(db, thread, surface, cursor);
  const { maxSeq, threadId } = snapshot;
  const start = contextClearSequence(db, threadId, maxSeq) ?? 0;
  const excludeDiagnostics = !request.includeDiagnosticOperations;
  const load = (outputs: "full" | "inline"): Rows => {
    const epoch = { db, threadId, start, maxSeq, excludeDiagnostics, outputs };
    const before = Math.min(sourceSeqEnd, maxSeq) + 1;
    return loadWindow(epoch, sourceSeqStart - 1, before, false).rows;
  };
  const full = load("full");
  const bytes = full.reduce((sum, row) => sum + Buffer.byteLength(row.data), 0);
  const rows = bytes <= RESPONSE_BYTE_LIMIT ? full : load("inline");
  const shape = { includeNestedRows: true, isLatestPage: false };
  const { status } = snapshot;
  const timeline = projectWindow(db, thread, request, status, { rows }, shape);
  const turn = timeline.rows.find(
    (row) =>
      row.kind === "turn" &&
      row.turnId === turnId &&
      row.sourceSeqEnd >= sourceSeqStart,
  );
  const collapsed = turn?.kind === "turn" ? turn.children : null;
  const within = (rows: readonly TimelineRow[]): TimelineRow[] =>
    rows.flatMap((row) => {
      const contained =
        row.turnId === turnId &&
        row.sourceSeqStart >= sourceSeqStart &&
        row.sourceSeqEnd <= sourceSeqEnd;
      return contained ? [row] : within(nestedTimelineRows(row) ?? []);
    });
  const found = collapsed ?? within(timeline.rows);
  if (found.length === 0) {
    const range = `${sourceSeqStart}-${sourceSeqEnd}`;
    throw invalidRequest(
      `Timeline turn summary details range ${range} does not include ` +
        `turn ${turnId}`,
    );
  }
  const page = paginateContents(
    found,
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
  const threadId = thread.id;
  const after = (contextClearSequence(db, threadId, maxSeq) ?? 0) - 1;
  const timeline = { excludeDiagnostics: false };
  const outline = { threadId, after, where: OUTLINE_EVENT, timeline };
  const loaded = { rows: listEvents(db, outline) };
  const shown = { ...display, includeDiagnosticOperations: false };
  const shape = { includeNestedRows: false, isLatestPage: true };
  const { status } = thread;
  const projected = projectWindow(db, thread, shown, status, loaded, shape);
  return projected.rows.flatMap((row) => {
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
  type Served = Pick<ThreadTimelineResponse, "maxSeq" | "rows">;
  const served = new Map<string, Served[]>();
  const outlines = new Map<string, ThreadConversationOutlineResponse>();
  return {
    forgetThread(threadId: string): void {
      for (const cache of [served, outlines]) {
        for (const key of cache.keys()) {
          if (key.startsWith(`${threadId}|`)) cache.delete(key);
        }
      }
    },
    timeline(
      thread: ThreadListRow,
      request: TimelineRequest,
    ): ThreadTimelineResponse {
      const { page, afterSequence, ...shown } = request;
      const full = buildThreadTimeline(db, thread, request);
      const { id, status, environmentId } = thread;
      const key = `${id}|${JSON.stringify([status, environmentId, page, shown])}`;
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
      const { id, status, title, titleFallback } = thread;
      const facts = [maxSeq, status, title, titleFallback, display];
      const key = `${id}|${JSON.stringify(facts)}`;
      const outline = outlines.get(key) ?? {
        items: buildOutline(db, thread, display, maxSeq),
        maxSeq,
      };
      remember(outlines, key, outline, OUTLINE_CACHE_LIMIT);
      return outline;
    },
  };
}
