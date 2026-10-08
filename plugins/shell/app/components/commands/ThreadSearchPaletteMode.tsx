import { useId, useLayoutEffect, useRef, useState } from "react";
import { useAtomValue, useStore } from "jotai";
import { isMacKeyboardPlatform } from "@bb/domain";
import { EmptyState } from "@bb/shared-ui/empty-state";
import { Icon } from "@bb/shared-ui/icon";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  ThreadTitle,
  useThreadTitleDisplayText,
} from "@bb/app-kit/components/thread/ThreadTitleMentions";
import { useSidebarNavigation } from "@bb/app-kit/hooks/queries/sidebar-navigation-query";
import { listSidebarNavigationThreads } from "@bb/app-kit/hooks/queries/thread-cache";
import {
  hasThreadSearchableQuery,
  useArchivedThreads,
  useThreadSearch,
} from "@bb/app-kit/hooks/queries/thread-queries";
import { useRouteNavigate } from "@bb/app-kit/components/ui/app-route-anchor";
import { getThreadRoutePath } from "@bb/app-kit/lib/route-paths";
import {
  openThreadInSplit,
  splitLayoutAtom,
} from "@bb/app-kit/lib/split-layout/atoms";
import {
  countPanes,
  findPaneByContent,
  MAX_PANES,
} from "@bb/app-kit/lib/split-layout";
import {
  buildPaletteThreadSearchRows,
  windowPaletteThreadSearchText,
  type PaletteThreadSearchRow,
} from "@bb/app-kit/lib/command-palette";
import {
  PALETTE_SECTION_LABEL_CLASS,
  PaletteShell,
  PaletteShortcut,
} from "./PaletteShell";

export function ThreadSearchPaletteMode({
  onExit,
  runAfterClose,
}: {
  onExit: () => void;
  runAfterClose: (run: () => void) => void;
}) {
  const idPrefix = useId();
  const navigate = useRouteNavigate();
  const store = useStore();
  const splitLayout = useAtomValue(splitLayoutAtom);
  const isCompact = useIsCompactViewport();
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<{
    index: number;
    threadId: string | null;
  }>({ index: 0, threadId: null });
  const [now] = useState(() => Date.now());
  const navigation = useSidebarNavigation();
  const threadSearch = useThreadSearch({ active: true, query });
  const trimmedQuery = query.trim();
  const isRecent = trimmedQuery.length === 0;
  const archived = useArchivedThreads({ enabled: isRecent });
  const searchable = hasThreadSearchableQuery(trimmedQuery);
  const searchResultsAreCurrent =
    !searchable || threadSearch.debouncedQuery === trimmedQuery;
  const projects = navigation.data
    ? [...navigation.data.projects, navigation.data.personalProject]
    : [];
  const rows = buildPaletteThreadSearchRows({
    now,
    projectNamesById: new Map(
      projects.map((project) => [project.id, project.name]),
    ),
    query,
    recentThreads: [
      ...(navigation.data ? listSidebarNavigationThreads(navigation.data) : []),
      ...(archived.data?.pages[0]?.slice(0, 20) ?? []),
    ],
    searchResponse: threadSearch.data,
    searchResultsAreCurrent,
  });
  const retainedIndex = rows.findIndex(
    (row) => row.threadId === highlighted.threadId,
  );
  const activeIndex =
    retainedIndex >= 0
      ? retainedIndex
      : Math.min(highlighted.index, rows.length - 1);
  const activeRow = rows[activeIndex];
  const activeThreadId = activeRow?.threadId ?? null;
  useLayoutEffect(() => {
    const index = Math.max(activeIndex, 0);
    setHighlighted((current) =>
      current.index === index && current.threadId === activeThreadId
        ? current
        : { index, threadId: activeThreadId },
    );
  }, [activeIndex, activeThreadId]);
  const isRecentLoading =
    isRecent && (navigation.isLoading || archived.isLoading);
  const hasLoadError = isRecent
    ? navigation.isError || archived.isError
    : searchResultsAreCurrent && threadSearch.isError;
  const isLoading =
    searchable &&
    (!searchResultsAreCurrent ||
      threadSearch.isDebouncing ||
      threadSearch.isLoading);
  const canSplit =
    activeRow !== undefined &&
    !isCompact &&
    splitLayout !== null &&
    findPaneByContent(splitLayout.root, {
      kind: "thread",
      projectId: activeRow.projectId,
      threadId: activeRow.threadId,
    }) === null &&
    countPanes(splitLayout.root) < MAX_PANES;
  const splitModifier = isMacKeyboardPlatform(navigator.platform)
    ? "⌘"
    : "Ctrl";

  const choose = (index: number, split: boolean) => {
    const row = rows[index];
    if (row === undefined) return;
    const { projectId, threadId, messageSeq } = row;
    runAfterClose(() => {
      const state =
        messageSeq === null
          ? undefined
          : { searchMessageSeq: messageSeq, searchThreadId: threadId };
      if (split) {
        openThreadInSplit({
          store,
          navigate,
          projectId,
          threadId,
          isCompact,
          state,
        });
      } else {
        navigate(getThreadRoutePath({ projectId, threadId }), { state });
      }
    });
  };

  const emptyMessage =
    rows.length > 0
      ? null
      : isLoading || isRecentLoading
        ? isRecent
          ? "Loading threads"
          : "Searching threads"
        : hasLoadError
          ? "Couldn’t load threads"
          : trimmedQuery.length === 1
            ? "Type at least 2 characters"
            : isRecent
              ? "No threads"
              : "No matching threads";

  return (
    <PaletteShell
      activeIndex={activeIndex}
      idPrefix={idPrefix}
      inputDescription={
        canSplit
          ? `Use ${splitModifier}+Enter to open in split. Use Escape to return to commands.`
          : "Use Escape to return to commands."
      }
      inputLabel="Search threads"
      listLabel="Threads"
      modeLabel="Threads"
      onActiveIndexChange={(index) =>
        setHighlighted({ index, threadId: rows[index]?.threadId ?? null })
      }
      onChoose={choose}
      onExitMode={onExit}
      onInputChange={(value) => {
        setQuery(value);
        setHighlighted({ index: 0, threadId: null });
      }}
      optionCount={rows.length}
      placeholder="Search title, project, or message…"
      value={query}
    >
      {emptyMessage === null ? (
        [false, true].map((isArchivedGroup) =>
          rows.some((row) => row.archived === isArchivedGroup) ? (
            <div
              key={String(isArchivedGroup)}
              role="group"
              aria-labelledby={`${idPrefix}-${isArchivedGroup}-label`}
              className="not-last:mb-2"
            >
              <div
                id={`${idPrefix}-${isArchivedGroup}-label`}
                className={PALETTE_SECTION_LABEL_CLASS}
              >
                {isArchivedGroup ? "Archived" : "Active"}
              </div>
              {rows.map((row, index) =>
                row.archived !== isArchivedGroup ? null : (
                  <div
                    key={`${row.threadId}:${row.primaryText}`}
                    className={cn(
                      "flex min-w-0 items-center rounded-md",
                      index === activeIndex && "bg-state-hover text-foreground",
                    )}
                    onPointerMove={() =>
                      setHighlighted({ index, threadId: row.threadId })
                    }
                  >
                    <div
                      id={`${idPrefix}-${index}`}
                      role="option"
                      aria-selected={index === activeIndex}
                      className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm"
                      onClick={() => choose(index, false)}
                    >
                      <ThreadSearchPaletteRow row={row} />
                    </div>
                    {index === activeIndex && canSplit ? (
                      <button
                        type="button"
                        aria-label="Open in split"
                        className="mr-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-sm px-1 text-xs text-subtle-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                        onClick={() => choose(index, true)}
                      >
                        <span className="mr-1">Open in split</span>
                        <PaletteShortcut>{`${splitModifier} ↵`}</PaletteShortcut>
                      </button>
                    ) : null}
                  </div>
                ),
              )}
            </div>
          ) : null,
        )
      ) : !hasLoadError &&
        (isRecent ? !isRecentLoading : searchable && !isLoading) ? (
        <EmptyState
          message={emptyMessage}
          icon="MessageSquare"
          className="justify-center px-3 py-4"
          iconClassName="size-3.5 text-subtle-foreground/50"
          messageClassName="text-xs leading-4 text-subtle-foreground/60"
        />
      ) : (
        <p className="px-3 py-4 text-center text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      )}
    </PaletteShell>
  );
}

function ThreadSearchPaletteRow({ row }: { row: PaletteThreadSearchRow }) {
  const primaryRef = useRef<HTMLSpanElement | null>(null);
  const matchKey = `${row.primaryText}\u0000${row.highlightRanges
    .map((range) => `${range.start}:${range.end}`)
    .join(",")}`;
  const [windowedMatchKey, setWindowedMatchKey] = useState<string | null>(null);
  const isWindowed = windowedMatchKey === matchKey;
  const primary = isWindowed
    ? windowPaletteThreadSearchText({
        text: row.primaryText,
        highlightRanges: row.highlightRanges,
      })
    : { text: row.primaryText, highlightRanges: row.highlightRanges };
  useLayoutEffect(() => {
    const container = primaryRef.current;
    const firstMatch = container?.querySelector("mark");
    if (isWindowed || !container || !firstMatch) return;
    const bounds = container.getBoundingClientRect();
    const match = firstMatch.getBoundingClientRect();
    if (match.left < bounds.left || match.right > bounds.right) {
      setWindowedMatchKey(matchKey);
    }
  }, [matchKey, isWindowed]);
  const secondaryTitle = useThreadTitleDisplayText(row.secondaryTitle ?? "");
  const metadata = [
    row.secondaryTitle === null ? null : secondaryTitle,
    row.projectName,
    row.relativeTime,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className="min-w-0 flex-1">
      <ThreadTitle
        ref={primaryRef}
        title={primary.text}
        highlightRanges={primary.highlightRanges}
        className="text-foreground"
      />
      <span
        className="flex min-h-4 items-center gap-1.5"
        data-palette-thread-details
      >
        {metadata.length === 0 ? null : (
          <span
            className="min-w-0 truncate text-xs leading-4 text-subtle-foreground"
            data-palette-thread-metadata
            title={metadata}
          >
            {row.secondaryTitle === null ? null : `${secondaryTitle} · `}
            {row.projectName === null ? null : (
              <>
                <Icon
                  name="Folder"
                  className="mr-1 inline-block size-3.5 align-text-bottom"
                  aria-hidden
                />
                {`${row.projectName} · `}
              </>
            )}
            {row.relativeTime}
          </span>
        )}
      </span>
    </span>
  );
}
