import { threadSearchSourceKindSchema } from "@bb/domain";
import type { ThreadSearchMatch } from "@bb/server-contract";
import type { Db } from "./index.js";

type HighlightRange = ThreadSearchMatch["highlightRanges"][number];

export interface ThreadSearchHit {
  threadId: string;
  matches: ThreadSearchMatch[];
}

export interface ThreadSearchGroup {
  total: number;
  hits: ThreadSearchHit[];
}

interface MatchRow {
  archived: number;
  total: number;
  sourceKind: string;
  sourceSeq: number | null;
  text: string;
  threadId: string;
}

export const SEARCH_LIMIT_PER_GROUP_DEFAULT = 20;
export const SEARCH_LIMIT_PER_GROUP_MAX = 50;
const TOKEN_PATTERN = /[\p{L}\p{N}_]+/gu;
const HIGHLIGHT_RANGE_LIMIT = 8;
const SNIPPET_MAX_CHARS = 160;
const SNIPPET_LEAD_CHARS = 40;
const IS_TITLE = "s.source_kind IN ('title', 'title_fallback')";
const FTS = "thread_search_segments_fts";

function foldText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase();
}

function highlightRanges(text: string, tokens: readonly string[]) {
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  for (const character of text) {
    const end = index + character.length;
    const foldedCharacter = foldText(character);
    folded += foldedCharacter;
    for (let unit = 0; unit < foldedCharacter.length; unit += 1) {
      starts.push(index);
      ends.push(end);
    }
    index = end;
  }
  const ranges: HighlightRange[] = [];
  for (const token of new Set(tokens.map(foldText).filter(Boolean))) {
    for (
      let at = folded.indexOf(token);
      at !== -1;
      at = folded.indexOf(token, at + token.length)
    ) {
      const end = ends[at + token.length - 1] ?? text.length;
      ranges.push({ start: starts[at] ?? 0, end });
    }
  }
  ranges.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged: HighlightRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous === undefined || range.start > previous.end) {
      merged.push({ ...range });
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }
  return merged.slice(0, HIGHLIGHT_RANGE_LIMIT);
}

function surrogateAt(text: string, index: number): number {
  return text.charCodeAt(index) & 0xfc00;
}

function snippet(text: string, tokens: readonly string[]) {
  const ranges = highlightRanges(text, tokens);
  if (text.length <= SNIPPET_MAX_CHARS)
    return { text, highlightRanges: ranges };
  const anchorStart = ranges[0]?.start ?? 0;
  const anchorEnd = ranges[0]?.end ?? 0;
  let start = Math.min(
    Math.max(0, anchorStart - SNIPPET_LEAD_CHARS),
    Math.max(0, text.length - SNIPPET_MAX_CHARS),
  );
  let end = Math.min(text.length, start + SNIPPET_MAX_CHARS);
  if (start > 0) {
    const boundary = text.slice(start, anchorStart).search(/\s/u);
    if (boundary !== -1) start += boundary + 1;
  }
  if (end < text.length) {
    const tailStart = Math.max(anchorEnd, start);
    const boundary = text.slice(tailStart, end).search(/\s\S*$/u);
    const near = end - (tailStart + boundary) <= SNIPPET_LEAD_CHARS;
    if (boundary > 0 && near) end = tailStart + boundary;
  }
  if (start > 0 && start < text.length && surrogateAt(text, start) === 0xdc00) {
    start += 1;
  }
  if (
    end > start &&
    end < text.length &&
    surrogateAt(text, end - 1) === 0xd800
  ) {
    end -= 1;
  }
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const shift = prefix.length - start;
  return {
    text: `${prefix}${text.slice(start, end)}${suffix}`,
    highlightRanges: ranges
      .map((range) => ({
        start: Math.max(range.start, start) + shift,
        end: Math.min(range.end, end) + shift,
      }))
      .filter((range) => range.end > range.start),
  };
}

function listMatchRows(
  db: Db,
  tokenQueries: readonly string[],
  limitPerGroup: number,
): MatchRow[] {
  const tokenMatches = tokenQueries.map(
    (_query, index) => `SELECT s.thread_id AS thread_id, ${index} AS token,
       MIN(${FTS}.rank) AS token_rank
     FROM ${FTS} JOIN thread_search_segments AS s ON s.rowid = ${FTS}.rowid
     WHERE ${FTS} MATCH ? GROUP BY s.thread_id`,
  );
  return db.all<MatchRow>(
    `WITH token_matches AS (${tokenMatches.join(" UNION ALL ")}),
     ranked_threads AS (
       SELECT m.thread_id, MIN(m.token_rank) AS best_rank,
         MAX(t.updated_at) AS updated_at,
         MAX(t.archived_at IS NOT NULL) AS archived
       FROM token_matches AS m JOIN threads AS t ON t.id = m.thread_id
       WHERE t.deleted_at IS NULL AND t.visibility = 'visible'
       GROUP BY m.thread_id HAVING COUNT(*) = ${tokenQueries.length}),
     ordered_threads AS (
       SELECT thread_id, archived, ROW_NUMBER() OVER (PARTITION BY archived
           ORDER BY best_rank, updated_at DESC, thread_id DESC) AS thread_order,
         COUNT(*) OVER (PARTITION BY archived) AS total
       FROM ranked_threads),
     ranked_segments AS (
       SELECT o.archived, o.thread_order, o.total, ${IS_TITLE} AS is_title,
         ROW_NUMBER() OVER (PARTITION BY s.thread_id, ${IS_TITLE}
           ORDER BY ${FTS}.rank, COALESCE(s.source_seq, -1), s.id)
           AS segment_order,
         s.source_kind, s.source_seq, s.text, s.thread_id
       FROM ${FTS} JOIN thread_search_segments AS s ON s.rowid = ${FTS}.rowid
         JOIN ordered_threads AS o ON o.thread_id = s.thread_id
       WHERE ${FTS} MATCH ? AND o.thread_order <= ?)
     SELECT archived, total, source_kind, source_seq, text, thread_id
     FROM ranked_segments WHERE is_title = 1 OR segment_order <= 1
     ORDER BY archived, thread_order, is_title DESC, segment_order`,
    ...tokenQueries,
    tokenQueries.join(" OR "),
    limitPerGroup,
  );
}

function toGroup(rows: MatchRow[], tokens: readonly string[]) {
  const hits = new Map<string, ThreadSearchMatch[]>();
  for (const row of rows) {
    const sourceKind = threadSearchSourceKindSchema.parse(row.sourceKind);
    const { text, sourceSeq } = row;
    const shown = sourceKind.startsWith("title")
      ? { text, highlightRanges: highlightRanges(text, tokens) }
      : snippet(text, tokens);
    const matches = hits.get(row.threadId) ?? [];
    matches.push({ sourceKind, ...shown, sourceSeq });
    hits.set(row.threadId, matches);
  }
  return {
    total: rows[0]?.total ?? 0,
    hits: [...hits].map(([threadId, matches]) => ({ threadId, matches })),
  };
}

export function searchThreads(
  db: Db,
  query: string,
  limitPerGroup: number,
): { active: ThreadSearchGroup; archived: ThreadSearchGroup } {
  const tokens = query.match(TOKEN_PATTERN) ?? [];
  const tokenQueries = [...new Set(tokens.map((token) => `"${token}"*`))];
  const rows =
    tokenQueries.length === 0
      ? []
      : listMatchRows(db, tokenQueries, limitPerGroup);
  return {
    active: toGroup(
      rows.filter((row) => row.archived === 0),
      tokens,
    ),
    archived: toGroup(
      rows.filter((row) => row.archived === 1),
      tokens,
    ),
  };
}
