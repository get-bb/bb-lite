import { Fzf } from "fzf";
import type { FzfResultItem, Selector } from "fzf";

interface FuzzyMatch<T> {
  item: T;
  score: number;
  positions: number[];
}

interface Ranked<T> extends FuzzyMatch<T> {
  text: string;
  start: number;
  textIndex: number;
  itemIndex: number;
}

interface PathItem<T> {
  item: T;
  text: string;
}

interface Segment {
  text: string;
  start: number;
  index: number;
  isFileName: boolean;
}

interface SegmentMatch {
  segment: Segment;
  positions: number[];
  score: number;
  start: number;
}

const QUERY_MAX_LENGTH = 256;
const RANK_UNIT = 1_000_000;
const DIRECTORY_SEGMENT_RANK = 1;
const STRUCTURED_PATH_RANK = 2;
const EXACT_DIRECTORY_PREFIX_RANK = 3;

function byStartAsc<T>(left: FzfResultItem<T>, right: FzfResultItem<T>) {
  return left.start - right.start;
}

function byLengthAsc<T>(
  left: FzfResultItem<T>,
  right: FzfResultItem<T>,
  selector: Selector<T>,
): number {
  return selector(left.item).length - selector(right.item).length;
}

function find<T extends { text: string }>(
  list: readonly T[],
  query: string,
  casing: "smart-case" | "case-insensitive" = "smart-case",
): FzfResultItem<T>[] {
  const texts: readonly { text: string }[] = list;
  const matches = new Fzf(texts, {
    selector: (entry: { text: string }) => entry.text,
    casing,
    forward: true,
    tiebreakers: [byStartAsc, byLengthAsc],
  }).find(query);
  return matches as FzfResultItem<T>[];
}

function sorted(positions: Iterable<number>): number[] {
  return [...new Set(positions)].sort((left, right) => left - right);
}

function smartCase(query: string, value: string): string {
  return query === query.toLowerCase() ? value.toLowerCase() : value;
}

function isSubsequence(query: string, value: string): boolean {
  let queryIndex = 0;
  for (const char of value) {
    if (char === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return true;
  }
  return query.length === 0;
}

function pathRelevanceBonus(path: string, query: string): number {
  const value = smartCase(query, path);
  const baseName = value.slice(value.lastIndexOf("/") + 1);
  let bonus = 0;
  if (baseName.includes(query)) bonus += 10_000;
  if (isSubsequence(query, baseName)) bonus += 5_000;
  if (value.includes(query)) bonus += 1_000;
  return bonus + (query ? value.split(query).length - 1 : 0) * 500;
}

function compareRanked<T>(left: Ranked<T>, right: Ranked<T>): number {
  return (
    right.score - left.score ||
    left.start - right.start ||
    left.textIndex - right.textIndex ||
    left.text.length - right.text.length ||
    (left.text < right.text ? -1 : left.text > right.text ? 1 : 0) ||
    left.itemIndex - right.itemIndex
  );
}

function mergeRanked<T, K>(
  matches: readonly Ranked<T>[],
  keyOf: (match: Ranked<T>) => K,
): Ranked<T>[] {
  const best = new Map<K, Ranked<T>>();
  for (const match of matches) {
    const existing = best.get(keyOf(match));
    if (!existing || compareRanked(match, existing) < 0) {
      best.set(keyOf(match), match);
    }
  }
  return [...best.values()].sort(compareRanked);
}

function rankedPath<T>(
  item: PathItem<T>,
  rank: number,
  match: { positions: number[]; score: number; start: number },
): Ranked<T> {
  const score = rank * RANK_UNIT + match.score;
  return { ...item, ...match, score, textIndex: 0, itemIndex: 0 };
}

function splitPathSegments(path: string): Segment[] {
  const names = path.split("/");
  let start = 0;
  return names.map((text, index) => {
    const isFileName = index === names.length - 1;
    const segment = { text, start, index, isFileName };
    start += text.length + 1;
    return segment;
  });
}

function segmentMatch(
  query: string,
  segments: readonly Segment[],
): SegmentMatch | null {
  const match = find(segments, query)[0];
  if (!match) return null;
  const { start } = match.item;
  return {
    segment: match.item,
    positions: sorted([...match.positions].map((position) => start + position)),
    score: match.score,
    start: start + match.start,
  };
}

function directorySegmentMatch<T>(
  item: PathItem<T>,
  query: string,
): Ranked<T> | null {
  if (query.length < 2) return null;
  let best: { positions: number[]; score: number; start: number } | null = null;
  for (const segment of splitPathSegments(item.text)) {
    if (segment.isFileName) continue;
    const value = smartCase(query, segment.text);
    if (!value.startsWith(query)) continue;
    const score =
      (value === query
        ? 30_000
        : 25_000 - Math.max(segment.text.length - query.length, 0)) +
      (segment.start === 0 ? 5_000 : 0);
    if (best && best.score >= score) continue;
    const positions = Array.from(
      { length: query.length },
      (_, index) => segment.start + index,
    );
    best = { positions, score, start: segment.start };
  }
  return best && rankedPath(item, DIRECTORY_SEGMENT_RANK, best);
}

function exactDirectoryPrefixMatch<T>(
  item: PathItem<T>,
  query: string,
): Ranked<T> | null {
  const prefix = query.slice(0, query.lastIndexOf("/") + 1);
  const leafQuery = query.slice(prefix.length);
  if (!prefix || !smartCase(prefix, item.text).startsWith(prefix)) return null;
  const prefixPositions = Array.from(
    { length: prefix.length },
    (_, index) => index,
  );
  if (!leafQuery) {
    const match = { positions: prefixPositions, score: 0, start: 0 };
    return rankedPath(item, EXACT_DIRECTORY_PREFIX_RANK, match);
  }
  const tail = item.text.slice(prefix.length);
  const tailMatch = find([{ text: tail }], leafQuery)[0];
  if (!tailMatch) return null;
  return rankedPath(item, EXACT_DIRECTORY_PREFIX_RANK, {
    positions: sorted([
      ...prefixPositions,
      ...[...tailMatch.positions].map((position) => prefix.length + position),
    ]),
    score: tailMatch.score + pathRelevanceBonus(tail, leafQuery),
    start: 0,
  });
}

function structuredPathMatch<T>(
  item: PathItem<T>,
  query: string,
): Ranked<T> | null {
  const querySegments = query.split("/").filter((segment) => segment);
  if (querySegments.length === 0 || querySegments.length > 8) return null;
  const leafQuery = querySegments[querySegments.length - 1];
  const pathSegments = splitPathSegments(item.text);
  const positions: number[] = [];
  let score = 0;
  let firstStart: number | null = null;
  let nextIndex = 0;
  for (const [queryIndex, querySegment] of querySegments.entries()) {
    const skipFileName =
      query.endsWith("/") && queryIndex === querySegments.length - 1;
    const match = segmentMatch(
      querySegment,
      pathSegments.filter(
        (segment) =>
          segment.index >= nextIndex && !(skipFileName && segment.isFileName),
      ),
    );
    if (!match) return null;
    positions.push(...match.positions);
    firstStart = Math.min(firstStart ?? match.start, match.start);
    score += match.score + (match.segment.index === nextIndex ? 5_000 : 0);
    nextIndex = match.segment.index + 1;
  }
  const leafSegment = pathSegments[pathSegments.length - 1];
  const leafMatch = leafSegment && segmentMatch(leafQuery, [leafSegment]);
  if (leafMatch) {
    score +=
      50_000 +
      leafMatch.score -
      Math.max(leafSegment.text.length - leafQuery.length, 0);
  }
  const match = { positions: sorted(positions), score, start: firstStart ?? 0 };
  return rankedPath(item, STRUCTURED_PATH_RANK, match);
}

function plainPathMatches<T>(
  items: readonly PathItem<T>[],
  query: string,
): Ranked<T>[] {
  return find(items, query)
    .map((match) =>
      rankedPath<T>(match.item, 0, {
        positions: sorted(match.positions),
        score: match.score + pathRelevanceBonus(match.item.text, query),
        start: match.start,
      }),
    )
    .sort(compareRanked);
}

function rankPathMatches<T>(
  items: readonly PathItem<T>[],
  query: string,
): Ranked<T>[] {
  if (query.split("/").every((segment) => !segment)) return [];
  const collect = (
    match: (item: PathItem<T>, query: string) => Ranked<T> | null,
  ) => items.flatMap((item) => match(item, query) ?? []);
  if (!query.includes("/")) {
    return plainPathMatches(items, query).concat(
      collect(directorySegmentMatch),
    );
  }
  const exact = collect(exactDirectoryPrefixMatch);
  if (exact.length > 0 && query.endsWith("/")) return exact;
  const structured = collect(structuredPathMatch);
  const base = exact.length > 0 ? exact : plainPathMatches(items, query);
  return base.concat(structured);
}

function textRelevanceBonus(text: string, query: string): number {
  const value = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (value === lowerQuery) return 20_000;
  if (value.startsWith(lowerQuery)) return 15_000;
  if (value.includes(lowerQuery)) return 10_000;
  return isSubsequence(lowerQuery, value) ? 5_000 : 0;
}

function finish<T>(matches: Ranked<T>[], limit: number): FuzzyMatch<T>[] {
  return matches
    .slice(0, limit)
    .map(({ item, score, positions }) => ({ item, score, positions }));
}

function unranked<T>(items: readonly T[], limit: number): FuzzyMatch<T>[] {
  return items
    .slice(0, limit)
    .map((item) => ({ item, score: 0, positions: [] }));
}

export function fuzzyMatchPaths<T>(args: {
  items: readonly T[];
  query: string;
  getPath: (item: T) => string;
  limit: number;
}): FuzzyMatch<T>[] {
  if (args.limit <= 0) return [];
  if (!args.query) return unranked(args.items, args.limit);
  const query = args.query.replaceAll("\\", "/");
  if (query.length > QUERY_MAX_LENGTH) return [];
  const items = args.items.map((item) => ({
    item,
    text: args.getPath(item).replaceAll("\\", "/"),
  }));
  const matches = rankPathMatches(items, query);
  return finish(
    mergeRanked(matches, (match) => match.text),
    args.limit,
  );
}

export function fuzzyMatchText<T>(args: {
  items: readonly T[];
  query: string;
  getText: (item: T) => string;
  getAliases?: (item: T) => readonly string[];
  limit: number;
}): FuzzyMatch<T>[] {
  if (args.limit <= 0) return [];
  const query = args.query.trim();
  if (!query) return unranked(args.items, args.limit);
  if (query.length > QUERY_MAX_LENGTH) return [];
  const candidates = args.items.flatMap((item, itemIndex) =>
    [args.getText(item), ...(args.getAliases?.(item) ?? [])]
      .map((text, textIndex) => ({ item, itemIndex, text, textIndex }))
      .filter((candidate) => candidate.text.length > 0),
  );
  const matches = find(candidates, query, "case-insensitive")
    .map((match) => ({
      ...match.item,
      positions: sorted(match.positions),
      score:
        match.score +
        textRelevanceBonus(match.item.text, query) +
        (match.item.textIndex === 0 ? RANK_UNIT : 0),
      start: match.start,
    }))
    .sort(compareRanked);
  return finish(
    mergeRanked(matches, (match) => match.itemIndex),
    args.limit,
  );
}
