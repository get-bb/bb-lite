import { threadStatusSchema } from "@bb/domain";
import type {
  ThreadTimelineResponse,
  TimelinePaginationCursor,
  TimelineRow,
} from "@bb/server-contract";
import { z } from "zod";
import { MAX_INLINE_OUTPUT_CHARS } from "../db/event-read.js";
import { invalidRequest } from "../http/errors.js";

export type TimelinePage =
  | { kind: "latest"; segmentLimit: number }
  | {
      kind: "older";
      segmentLimit: number;
      beforeCursor: TimelinePaginationCursor;
    };

const snapshotSchema = z.object({
  version: z.literal(3),
  threadId: z.string(),
  maxSeq: z.number().int().nonnegative(),
  status: threadStatusSchema,
  surface: z.string(),
});
const contentCursorSchema = z.object({
  beforeSequence: z.number().int().positive(),
  beforeLeaf: z.number().int().positive(),
});
const cursorSchema = z.object({
  snapshot: snapshotSchema,
  anchorSeq: z.number().int().nonnegative(),
  anchorId: z.string().min(1),
  content: contentCursorSchema.optional(),
});
export type TimelineSnapshot = z.infer<typeof snapshotSchema>;
export type TimelineContentCursor = z.infer<typeof contentCursorSchema>;

export interface PaginateTimelineArgs {
  rows: readonly TimelineRow[];
  page: TimelinePage;
  contentCursor: TimelineContentCursor | undefined;
  maxLeaves: number;
  maxBytes: number;
  ownedSequenceStart: number;
  ownedSequenceEnd: number;
  knownHasOlderSegments: boolean | null;
}

const CURSOR_PREFIX = "timeline-v3:";
const TRUNCATION_TAIL = " more characters truncated]";
const PREVIEW_THRESHOLD_CHARS = 4_000;
const PREVIEW_HEAD_CHARS = 2_000;
const PREVIEW_TAIL_CHARS = 1_000;

function decodeCursor(anchorId: string): z.infer<typeof cursorSchema> | null {
  if (!anchorId.startsWith(CURSOR_PREFIX)) return null;
  const encoded = anchorId.slice(CURSOR_PREFIX.length);
  const json = Buffer.from(encoded, "base64url").toString("utf8");
  try {
    return cursorSchema.parse(JSON.parse(json));
  } catch {
    return null;
  }
}

export function snapshotFromCursor(
  cursor: TimelinePaginationCursor,
  threadId: string,
  surface: string,
): { snapshot: TimelineSnapshot; content?: TimelineContentCursor } {
  const decoded = decodeCursor(cursor.anchorId);
  const { snapshot, anchorSeq = -1, content } = decoded ?? {};
  const contentEnd = content?.beforeSequence ?? anchorSeq + 1;
  const matches =
    snapshot !== undefined &&
    anchorSeq === cursor.anchorSeq &&
    anchorSeq <= snapshot.maxSeq &&
    snapshot.threadId === threadId &&
    snapshot.surface === surface &&
    contentEnd <= snapshot.maxSeq + 1 &&
    contentEnd > anchorSeq;
  if (matches) return { snapshot, content };
  throw invalidRequest(
    "Timeline pagination cursor is no longer available; reload the latest page",
  );
}

export function bindCursor(
  cursor: TimelinePaginationCursor | null,
  snapshot: TimelineSnapshot,
  content?: TimelineContentCursor,
): TimelinePaginationCursor | null {
  if (cursor === null) return null;
  const payload = JSON.stringify({ snapshot, ...cursor, content });
  const encoded = Buffer.from(payload).toString("base64url");
  return { anchorSeq: cursor.anchorSeq, anchorId: CURSOR_PREFIX + encoded };
}

export function nestedTimelineRows(
  row: TimelineRow,
): readonly TimelineRow[] | null {
  if (row.kind === "turn" && row.children?.length) return row.children;
  const delegation = row.kind === "work" && row.workKind === "delegation";
  return delegation && row.childRows.length > 0 ? row.childRows : null;
}

function withNestedRows(row: TimelineRow, rows: TimelineRow[]): TimelineRow {
  if (row.kind === "turn") return { ...row, children: rows };
  if (row.kind === "work" && row.workKind === "delegation") {
    return { ...row, childRows: rows };
  }
  return row;
}

function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value));
}

export function paginateContents(
  rows: readonly TimelineRow[],
  before: number | undefined,
  maxLeaves: number,
  maxBytes: number,
) {
  const costs: number[] = [];
  const measure = (items: readonly TimelineRow[], ancestors: number) => {
    for (const row of items) {
      const nested = nestedTimelineRows(row);
      if (nested === null) costs.push(jsonBytes(row) + ancestors);
      else measure(nested, ancestors + jsonBytes(withNestedRows(row, [])));
    }
  };
  measure(rows, 0);
  const end = Math.min(before ?? costs.length, costs.length);
  let start = end;
  let bytes = 0;
  while (start > 0 && end - start < Math.max(1, maxLeaves)) {
    const cost = costs[start - 1] ?? 0;
    if (start < end && bytes + cost > maxBytes) break;
    bytes += cost;
    start -= 1;
  }
  let index = 0;
  let olderRowsSourceSeqEnd: number | null = null;
  const recordOlder = (row: TimelineRow) => {
    olderRowsSourceSeqEnd = Math.max(
      olderRowsSourceSeqEnd ?? 0,
      row.sourceSeqEnd,
    );
  };
  const pick = (items: readonly TimelineRow[]): TimelineRow[] =>
    items.flatMap((row) => {
      const nested = nestedTimelineRows(row);
      if (nested === null) {
        const position = index++;
        if (position < start) recordOlder(row);
        return position >= start && position < end ? [row] : [];
      }
      const picked = pick(nested);
      if (picked.length === 0 && index <= start) recordOlder(row);
      return picked.length === 0 ? [] : [withNestedRows(row, picked)];
    });
  const picked = pick(rows);
  const total = costs.length;
  return { rows: picked, olderRowsSourceSeqEnd, start, end, total };
}

function logicalSegments(args: PaginateTimelineArgs) {
  const { ownedSequenceStart: start, ownedSequenceEnd: end } = args;
  const owned = args.rows.filter(
    (row) => row.sourceSeqStart >= start && row.sourceSeqStart < end,
  );
  const userStarts = owned.flatMap((row) =>
    row.kind === "conversation" &&
    row.role === "user" &&
    row.sourceSeqStart > start
      ? [row.sourceSeqStart]
      : [],
  );
  const bounds = [...new Set([start, ...userStarts])].sort(
    (left, right) => left - right,
  );
  const segments = bounds.map((sequenceStart) => {
    const rows: TimelineRow[] = [];
    return { rows, sequenceStart };
  });
  for (const row of owned) {
    const later = bounds.findIndex((bound) => bound > row.sourceSeqStart);
    segments.at(later === -1 ? -1 : later - 1)?.rows.push(row);
  }
  const populated = segments.filter((segment) => segment.rows.length > 0);
  if (populated[0] !== undefined) populated[0].sequenceStart = start;
  return populated;
}

function rowChangesFrom(row: TimelineRow, sequence: number): TimelineRow {
  const nested = nestedTimelineRows(row);
  return nested === null
    ? row
    : withNestedRows(row, rowsChangedFrom(nested, sequence));
}

function rowsChangedFrom(
  rows: readonly TimelineRow[],
  sequence: number,
): TimelineRow[] {
  const first = rows.findIndex((row) => row.sourceSeqEnd >= sequence);
  if (first === -1) return [];
  return rows.slice(first).map((row) => rowChangesFrom(row, sequence));
}

export function paginateTimeline(args: PaginateTimelineArgs) {
  const { knownHasOlderSegments, page, rows, ownedSequenceEnd } = args;
  const segments = logicalSegments(args);
  const selected = segments.slice(-page.segmentLimit);
  const returned = new Map<string, TimelineRow>();
  let remainingBytes = args.maxBytes;
  let remainingLeaves = args.maxLeaves;
  let returnedSegmentCount = 0;
  let windowStart = selected[0]?.sequenceStart ?? args.ownedSequenceStart;
  let hasOlderRows = knownHasOlderSegments ?? segments.length > selected.length;
  let contentSeqEnd: number | null = null;
  let contentCursor: TimelineContentCursor | undefined;
  let contentPage: ThreadTimelineResponse["timelinePage"]["contentPage"];
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const segment = selected[index];
    if (segment === undefined) continue;
    const contents = paginateContents(
      segment.rows,
      args.contentCursor?.beforeLeaf,
      remainingLeaves,
      remainingBytes,
    );
    for (const row of contents.rows) returned.set(row.id, row);
    returnedSegmentCount += 1;
    remainingLeaves -= contents.end - contents.start;
    remainingBytes -= jsonBytes(contents.rows);
    const { start, end, total } = contents;
    if (start === 0 && remainingLeaves > 0 && remainingBytes > 0) continue;
    windowStart = segment.sequenceStart;
    hasOlderRows = start > 0 || index > 0 || hasOlderRows;
    contentSeqEnd = contents.olderRowsSourceSeqEnd;
    const beforeSequence =
      selected[index + 1]?.sequenceStart ?? ownedSequenceEnd;
    contentCursor =
      start > 0 ? { beforeLeaf: start, beforeSequence } : undefined;
    contentPage = { anchorSeq: windowStart, start, end, total };
    break;
  }
  const missing = rows.filter(
    (row) => row.sourceSeqStart < ownedSequenceEnd && !returned.has(row.id),
  );
  const changed = missing.filter(
    (row) => page.kind === "latest" && row.sourceSeqEnd >= windowStart,
  );
  const updates = changed.map((row) => rowChangesFrom(row, windowStart));
  const reported = jsonBytes(updates) > remainingBytes ? [] : changed;
  const anchorId = `timeline-window:${windowStart}`;
  return {
    rows: [...new Set(rows.map((row) => row.id))].flatMap(
      (id) => returned.get(id) ?? [],
    ),
    returnedSegmentCount,
    hasOlderRows,
    olderCursor: hasOlderRows ? { anchorSeq: windowStart, anchorId } : null,
    olderRowsSourceSeqEnd: missing
      .filter((row) => !reported.includes(row))
      .reduce<number | null>(
        (seqEnd, row) => Math.max(seqEnd ?? 0, row.sourceSeqEnd),
        contentSeqEnd,
      ),
    olderRowUpdates: reported.length > 0 ? updates : undefined,
    contentCursor,
    contentPage,
  };
}

function truncateText(value: string, max: number) {
  if (value.length <= max || value.endsWith(TRUNCATION_TAIL)) return value;
  const dropped = (value.length - max).toLocaleString("en-US");
  return `${value.slice(0, max)}\n…[${dropped}${TRUNCATION_TAIL}`;
}

function splitsSurrogatePair(value: string, index: number) {
  const high = value.charCodeAt(index - 1) & 0xfc00;
  return high === 0xd800 && (value.charCodeAt(index) & 0xfc00) === 0xdc00;
}

function previewText(output: string) {
  const headEnd = PREVIEW_HEAD_CHARS;
  const tailStart = output.length - PREVIEW_TAIL_CHARS;
  const head = output.slice(
    0,
    splitsSurrogatePair(output, headEnd) ? headEnd - 1 : headEnd,
  );
  const tail = output.slice(
    splitsSurrogatePair(output, tailStart) ? tailStart + 1 : tailStart,
  );
  const omitted = output.length - head.length - tail.length;
  const count = omitted.toLocaleString("en-US");
  return `${head}\n…[${count} characters omitted from preview]\n${tail}`;
}

function mapRows(
  rows: readonly TimelineRow[],
  map: (row: TimelineRow) => TimelineRow,
): TimelineRow[] {
  return rows.map((row) => {
    if (row.kind === "turn" && row.children !== null) {
      return map({ ...row, children: mapRows(row.children, map) });
    }
    if (row.kind === "work" && row.workKind === "delegation") {
      return map({ ...row, childRows: mapRows(row.childRows, map) });
    }
    return map(row);
  });
}

function truncateRow(row: TimelineRow): TimelineRow {
  const max = MAX_INLINE_OUTPUT_CHARS;
  if (row.kind !== "work") return row;
  if (
    row.workKind === "command" ||
    row.workKind === "tool" ||
    row.workKind === "delegation"
  ) {
    return { ...row, output: truncateText(row.output, max) };
  }
  if (row.workKind !== "file-change") return row;
  const cut = (text: string | null) =>
    text === null ? null : truncateText(text, max);
  const change = { ...row.change, diff: cut(row.change.diff) };
  return { ...row, change, stdout: cut(row.stdout), stderr: cut(row.stderr) };
}

function previewRow(row: TimelineRow) {
  const previewable =
    row.kind === "work" &&
    (row.workKind === "command" || row.workKind === "tool") &&
    row.output.length > PREVIEW_THRESHOLD_CHARS;
  if (!previewable) return row;
  const outputPreview = row.outputPreview ?? {
    experimental_fullOutputAvailability: "available" as const,
    totalChars: row.output.length,
  };
  return { ...row, output: previewText(row.output), outputPreview };
}

export function limitResponseOutputs(
  response: ThreadTimelineResponse,
  preview: boolean,
): ThreadTimelineResponse {
  const limit = (rows: readonly TimelineRow[]): TimelineRow[] => {
    const truncated = mapRows(rows, truncateRow);
    return preview ? truncated.map(previewRow) : truncated;
  };
  const { timelinePage } = response;
  const updates = timelinePage.olderRowUpdates;
  return {
    ...response,
    rows: limit(response.rows),
    timelinePage:
      updates === undefined
        ? timelinePage
        : { ...timelinePage, olderRowUpdates: limit(updates) },
  };
}
