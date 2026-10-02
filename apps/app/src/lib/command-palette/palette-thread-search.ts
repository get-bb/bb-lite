import { PERSONAL_PROJECT_ID, type ThreadListEntry } from "@bb/domain";
import type {
  ThreadSearchMatch,
  ThreadSearchResponse,
} from "@bb/server-contract";
import { formatRelativeTime } from "@/lib/relative-time";
import { getThreadDisplayTitle } from "@/lib/thread-title";

export interface PaletteThreadSearchRow {
  primaryText: string;
  highlightRanges: readonly ThreadSearchMatch["highlightRanges"][number][];
  secondaryTitle: string | null;
  projectName: string | null;
  relativeTime: string;
  projectId: string;
  threadId: string;
  messageSeq: number | null;
}

interface BuildPaletteThreadSearchRowsArgs {
  now: number;
  projectNamesById: ReadonlyMap<string, string>;
  query: string;
  recentThreads: readonly ThreadListEntry[];
  searchResponse: ThreadSearchResponse | undefined;
  searchResultsAreCurrent: boolean;
}

const RECENT_THREAD_LIMIT = 20;

function isTitleMatch(match: ThreadSearchMatch): boolean {
  return match.sourceKind === "title" || match.sourceKind === "title_fallback";
}

export function buildPaletteThreadSearchRows({
  now,
  projectNamesById,
  query,
  recentThreads,
  searchResponse,
  searchResultsAreCurrent,
}: BuildPaletteThreadSearchRowsArgs): PaletteThreadSearchRow[] {
  const trimmedQuery = query.trim();
  const row = (
    thread: ThreadListEntry,
    matches: readonly ThreadSearchMatch[],
  ): PaletteThreadSearchRow => {
    const title = getThreadDisplayTitle(thread);
    const snippetMatch = matches.find((match) => !isTitleMatch(match));
    const primaryMatch =
      snippetMatch ??
      matches.find((match) => isTitleMatch(match) && match.text === title);
    return {
      primaryText: primaryMatch?.text ?? title,
      highlightRanges: primaryMatch?.highlightRanges ?? [],
      secondaryTitle: snippetMatch === undefined ? null : title,
      projectName:
        thread.projectId === PERSONAL_PROJECT_ID
          ? null
          : (projectNamesById.get(thread.projectId) ?? null),
      relativeTime: formatRelativeTime({ timestamp: thread.updatedAt, now }),
      projectId: thread.projectId,
      threadId: thread.id,
      messageSeq: snippetMatch?.sourceSeq ?? null,
    };
  };
  if (trimmedQuery.length === 0) {
    return recentThreads
      .filter((thread) => thread.archivedAt === null)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, RECENT_THREAD_LIMIT)
      .map((thread) => row(thread, []));
  }
  return trimmedQuery.length >= 2 && searchResultsAreCurrent
    ? (searchResponse?.active.results ?? []).map((result) =>
        row(result.thread, result.matches),
      )
    : [];
}
