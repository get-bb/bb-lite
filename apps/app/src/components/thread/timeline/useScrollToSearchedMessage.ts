import { useEffect, useMemo, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body.js";

interface SeqAnchoredRow {
  id: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  childRows?: readonly SeqAnchoredRow[];
  children?: readonly SeqAnchoredRow[] | null;
}

interface SearchPagination {
  hasOlderRows?: boolean;
  isLoadingOlderRows?: boolean;
  onLoadOlderRows?: () => Promise<void> | void;
}

const FLASH_CLASS_NAME = "bb-search-flash";
const FLASH_DURATION_MS = 1700;
const REVEAL_DELAYS_MS = [16, 320, 800];
const EMPTY_ROW_IDS: ReadonlySet<string> = new Set<string>();

function readSearchTarget(
  state: unknown,
  threadId: string | undefined,
): number | null {
  const { searchMessageSeq, searchThreadId } = (state ?? {}) as {
    searchMessageSeq?: unknown;
    searchThreadId?: unknown;
  };
  if (
    typeof searchMessageSeq !== "number" ||
    (threadId !== undefined &&
      typeof searchThreadId === "string" &&
      searchThreadId !== threadId)
  ) {
    return null;
  }
  return searchMessageSeq;
}

function findSearchedRowPath(
  rows: readonly SeqAnchoredRow[],
  seq: number,
): SeqAnchoredRow[] {
  const row = rows.find(
    (candidate) =>
      candidate.sourceSeqStart <= seq && seq <= candidate.sourceSeqEnd,
  );
  if (row === undefined) {
    return [];
  }
  const nested = row.childRows ?? row.children ?? [];
  return [row, ...findSearchedRowPath(nested, seq)];
}

export function useSearchedMessage(
  rows: readonly SeqAnchoredRow[],
  threadId: string | undefined,
  { hasOlderRows, isLoadingOlderRows, onLoadOlderRows }: SearchPagination = {},
): ReadonlySet<string> {
  const location = useLocation();
  const scrollElementIntoView =
    useBottomAnchoredScroll()?.scrollElementIntoView;
  const olderLoadAttemptRef = useRef<string | null>(null);
  const targetSeq = readSearchTarget(location.state, threadId);
  const locationKey = location.key;
  const path = useMemo(
    () => (targetSeq === null ? [] : findSearchedRowPath(rows, targetSeq)),
    [rows, targetSeq],
  );
  const leaf = path.at(-1);
  const leafId = leaf !== undefined && leaf.children !== null ? leaf.id : null;
  const firstLoadedSeq = rows[0]?.sourceSeqStart;
  const needsOlderRows =
    targetSeq !== null &&
    leaf === undefined &&
    firstLoadedSeq !== undefined &&
    targetSeq < firstLoadedSeq &&
    hasOlderRows === true &&
    !isLoadingOlderRows;

  useEffect(() => {
    const attempt = `${locationKey}:${firstLoadedSeq}`;
    if (!needsOlderRows || olderLoadAttemptRef.current === attempt) {
      return;
    }
    olderLoadAttemptRef.current = attempt;
    void Promise.resolve(onLoadOlderRows?.()).catch(() => undefined);
  }, [firstLoadedSeq, locationKey, needsOlderRows, onLoadOlderRows]);

  useEffect(() => {
    const findElement = () =>
      [
        ...document.querySelectorAll<HTMLElement>("[data-timeline-row-id]"),
      ].find((element) => element.dataset.timelineRowId === leafId) ?? null;
    if (leafId === null || findElement() === null) {
      return;
    }
    const timers = REVEAL_DELAYS_MS.map((delayMs, index) =>
      window.setTimeout(() => {
        const element = findElement();
        const currentKey: unknown = window.history.state?.key;
        if (
          element === null ||
          (currentKey !== undefined && currentKey !== locationKey)
        ) {
          return;
        }
        if (scrollElementIntoView !== undefined) {
          scrollElementIntoView({ element, options: { block: "center" } });
        } else {
          element.scrollIntoView({ block: "center" });
        }
        if (index === 0) {
          element.classList.add(FLASH_CLASS_NAME);
          window.setTimeout(() => {
            element.classList.remove(FLASH_CLASS_NAME);
          }, FLASH_DURATION_MS);
        }
      }, delayMs),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [leafId, locationKey, scrollElementIntoView]);

  return useMemo(
    () =>
      path.length === 0 ? EMPTY_ROW_IDS : new Set(path.map((row) => row.id)),
    [path],
  );
}
