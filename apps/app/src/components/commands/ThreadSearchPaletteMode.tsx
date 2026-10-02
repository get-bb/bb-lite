import { useId, useLayoutEffect, useRef, useState } from "react";
import { useAtom, useAtomValue, useStore } from "jotai";
import { isMacKeyboardPlatform } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { EmptyState } from "@bb/shared-ui/empty-state";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  getThreadListIndicatorLabel,
  resolveThreadListIndicator,
  threadListIndicatorStateForThread,
  type ThreadListIndicatorKind,
} from "@bb/client-core";
import { usePromptDraftHasInput } from "@/hooks/usePromptDraftStorage";
import {
  ThreadTitle,
  useThreadTitleDisplayText,
} from "@/components/thread/ThreadTitleMentions";
import { paletteThreadLifecyclesAtom } from "@/lib/command-palette/palette-preferences";
import {
  normalizeThreadLifecycleFilter,
  type ThreadArchiveFilter,
} from "@/lib/thread-lifecycle-filter";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { listSidebarNavigationThreads } from "@/hooks/cache-owners/query-cache";
import { usePaletteRecentArchivedThreads } from "@/hooks/queries/palette-thread-queries";
import {
  hasThreadSearchableQuery,
  useThreadSearch,
} from "@/hooks/queries/thread-queries";
import { useRouteNavigate } from "@/components/ui/app-route-anchor";
import { getThreadRoutePath } from "@/lib/route-paths";
import { openThreadInSplit } from "@/lib/split-layout/openThreadInSplit";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import { countPanes, findPaneByContent, MAX_PANES } from "@/lib/split-layout";
import {
  buildPaletteThreadSearchRows,
  type PaletteThreadSearchRow,
} from "@/lib/command-palette/palette-thread-search";
import { windowPaletteThreadSearchText } from "@/lib/command-palette/palette-thread-search-window";
import {
  PALETTE_SECTION_LABEL_CLASS,
  PaletteShell,
  PaletteShortcut,
} from "./PaletteShell";

const LIFECYCLE_LABELS: Record<ThreadArchiveFilter, string> = {
  active: "Active",
  archived: "Archived",
};
const LIFECYCLES: readonly ThreadArchiveFilter[] = ["active", "archived"];
const WORKING_CLASS = "animate-shine-icon text-muted-foreground/50 size-3.5";
const WAITING_CLASS = "text-muted-foreground/75 size-3.5";
const DRAFT_CLASS = "pointer-events-none shrink-0 size-3.5";
const STATUS_GLYPHS: Partial<
  Record<ThreadListIndicatorKind, [IconName, string]>
> = {
  "unread-error": ["CircleX", "text-destructive size-3.5"],
  "queued-failed": ["CircleX", "text-destructive size-3.5"],
  "waiting-for-input": ["CircleQuestion", WAITING_CLASS],
  "queued-waiting": ["Clock", WAITING_CLASS],
  "working-draft": [
    "Edit",
    `${DRAFT_CLASS} animate-shine-icon text-muted-foreground/50`,
  ],
  workflow: ["Workflow", WORKING_CLASS],
  "background-agent": ["UserRoundPlus", WORKING_CLASS],
  "background-command": ["Terminal", WORKING_CLASS],
  "plan-mode": ["ListTodo", WORKING_CLASS],
  goal: ["Target", WORKING_CLASS],
  runtime: [
    "Loading",
    "animate-spin motion-reduce:animate-none text-muted-foreground/50 size-3.5",
  ],
  draft: ["Edit", `${DRAFT_CLASS} text-muted-foreground`],
};

interface ThreadSearchOption {
  key: string;
  lifecycle: ThreadArchiveFilter;
  row: PaletteThreadSearchRow | null;
}

export function ThreadSearchPaletteMode({
  onExit,
  runAfterClose,
}: {
  onExit: () => void;
  runAfterClose: (run: () => void) => void;
}) {
  const idPrefix = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useRouteNavigate();
  const store = useStore();
  const splitLayout = useAtomValue(splitLayoutAtom);
  const [storedLifecycles, setLifecycles] = useAtom(
    paletteThreadLifecyclesAtom,
  );
  const lifecycles = normalizeThreadLifecycleFilter(storedLifecycles);
  const showsArchived = lifecycles.includes("archived");
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<{
    index: number;
    key: string | null;
  }>({ index: 0, key: null });
  const [expanded, setExpanded] = useState<{
    filterKey: string;
    groups: readonly ThreadArchiveFilter[];
  }>({ filterKey: "", groups: [] });
  const filterKey = lifecycles.join(",");
  const expandedGroups =
    expanded.filterKey === filterKey ? expanded.groups : [];
  const [now] = useState(() => Date.now());
  const navigation = useSidebarNavigation();
  const threadSearch = useThreadSearch({ active: true, query });
  const trimmedQuery = query.trim();
  const archived = usePaletteRecentArchivedThreads({
    enabled: trimmedQuery.length === 0 && showsArchived,
  });
  const searchable = hasThreadSearchableQuery(trimmedQuery);
  const searchResultsAreCurrent =
    !searchable || threadSearch.debouncedQuery === trimmedQuery;
  const projects = navigation.data
    ? [...navigation.data.projects, navigation.data.personalProject]
    : [];
  const result = buildPaletteThreadSearchRows({
    lifecycles,
    now,
    projectNamesById: new Map(
      projects.map((project) => [project.id, project.name]),
    ),
    query,
    recentThreads: [
      ...(navigation.data ? listSidebarNavigationThreads(navigation.data) : []),
      ...(showsArchived ? (archived.data ?? []) : []),
    ],
    searchResponse: threadSearch.data,
    searchResultsAreCurrent,
  });
  const rowsOf = (lifecycle: ThreadArchiveFilter) =>
    result.rows.filter((row) => row.lifecycle === lifecycle);
  const groups = lifecycles.filter((lifecycle) => rowsOf(lifecycle).length > 0);
  const options = groups.flatMap((lifecycle): ThreadSearchOption[] => {
    const rows = rowsOf(lifecycle);
    const visible = expandedGroups.includes(lifecycle)
      ? rows
      : rows.slice(0, groups.length === 2 ? 3 : 6);
    return [
      ...visible.map((row) => ({ key: row.id, lifecycle, row })),
      ...(visible.length < rows.length
        ? [{ key: `more:${lifecycle}`, lifecycle, row: null }]
        : []),
    ];
  });
  const retainedIndex = options.findIndex(
    (option) => option.key === highlighted.key,
  );
  const activeIndex =
    retainedIndex >= 0
      ? retainedIndex
      : Math.min(highlighted.index, options.length - 1);
  const activeKey = options[activeIndex]?.key ?? null;
  useLayoutEffect(() => {
    const index = Math.max(activeIndex, 0);
    setHighlighted((current) =>
      current.index === index && current.key === activeKey
        ? current
        : { index, key: activeKey },
    );
  }, [activeIndex, activeKey]);
  const recentQueries = lifecycles.map((lifecycle) =>
    lifecycle === "active" ? navigation : archived,
  );
  const isRecentLoading =
    result.isRecent && recentQueries.some((recent) => recent.isLoading);
  const hasLoadError = result.isRecent
    ? recentQueries.some((recent) => recent.isError)
    : searchResultsAreCurrent && threadSearch.isError;
  const isLoading =
    searchable &&
    (!searchResultsAreCurrent ||
      threadSearch.isDebouncing ||
      threadSearch.isLoading);
  const activeRow = options[activeIndex]?.row;
  const canSplit =
    activeRow != null &&
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
    const option = options[index];
    if (option === undefined) return;
    const { row, lifecycle } = option;
    if (row === null) {
      setExpanded({ filterKey, groups: [...expandedGroups, lifecycle] });
      setHighlighted({ index, key: null });
      inputRef.current?.focus();
      return;
    }
    const { projectId, threadId, messageSeq } = row;
    runAfterClose(() => {
      const state =
        messageSeq === null
          ? undefined
          : { searchMessageSeq: messageSeq, searchThreadId: threadId };
      if (split) {
        openThreadInSplit({ store, navigate, projectId, threadId, state });
      } else {
        navigate(getThreadRoutePath({ projectId, threadId }), { state });
      }
    });
  };

  const emptyMessage =
    result.rows.length > 0
      ? null
      : isLoading || isRecentLoading
        ? result.isRecent
          ? "Loading threads"
          : "Searching threads"
        : hasLoadError
          ? "Couldn’t load threads"
          : trimmedQuery.length === 1
            ? "Type at least 2 characters"
            : result.isRecent
              ? "No threads"
              : "No matching threads";
  const filterLabel =
    lifecycles.length === 2
      ? "All"
      : lifecycles.map((lifecycle) => LIFECYCLE_LABELS[lifecycle]).join(", ");

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
      inputAccessory={
        <div className="max-w-[45%] shrink-0">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="min-w-0 max-w-full justify-start font-normal text-subtle-foreground"
                aria-label={`Filter: ${filterLabel}`}
              >
                <Icon
                  name="SlidersHorizontal"
                  className="size-3.5 shrink-0"
                  aria-hidden
                />
                <span className="truncate">{filterLabel}</span>
                <Icon name="ChevronDown" className="size-3.5 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuGroup aria-label="Filter">
                <DropdownMenuLabel>Filter</DropdownMenuLabel>
                {LIFECYCLES.map((lifecycle) => {
                  const checked = lifecycles.includes(lifecycle);
                  const required = checked && lifecycles.length === 1;
                  return (
                    <DropdownMenuItem
                      key={lifecycle}
                      role="menuitemcheckbox"
                      aria-checked={checked}
                      title={
                        required
                          ? "Keep at least one filter selected"
                          : undefined
                      }
                      onSelect={(event) => {
                        event.preventDefault();
                        if (required) return;
                        setLifecycles(
                          LIFECYCLES.filter((candidate) =>
                            candidate === lifecycle
                              ? !checked
                              : lifecycles.includes(candidate),
                          ),
                        );
                      }}
                    >
                      {LIFECYCLE_LABELS[lifecycle]}
                      <span className="ml-auto inline-flex size-4 items-center justify-center">
                        {checked && <Icon name="Check" className="size-4" />}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
      inputRef={inputRef}
      listLabel="Threads"
      modeLabel="Threads"
      onActiveIndexChange={(index) =>
        setHighlighted({ index, key: options[index]?.key ?? null })
      }
      onChoose={choose}
      onExitMode={onExit}
      onInputChange={(value) => {
        setQuery(value);
        setHighlighted({ index: 0, key: null });
        setExpanded({ filterKey, groups: [] });
      }}
      optionCount={options.length}
      placeholder="Search title, project, or message…"
      value={query}
    >
      {emptyMessage === null ? (
        groups.map((lifecycle) => (
          <div
            key={lifecycle}
            role="group"
            aria-labelledby={`${idPrefix}-${lifecycle}-label`}
            className="not-last:mb-2"
          >
            <div
              id={`${idPrefix}-${lifecycle}-label`}
              className={PALETTE_SECTION_LABEL_CLASS}
            >
              {LIFECYCLE_LABELS[lifecycle]}
            </div>
            {options.map((option, index) =>
              option.lifecycle !== lifecycle ? null : (
                <div
                  key={
                    option.row === null
                      ? option.key
                      : `${option.key}:${option.row.primaryText}`
                  }
                  className={cn(
                    "flex min-w-0 items-center rounded-md",
                    index === activeIndex && "bg-state-hover text-foreground",
                  )}
                  onPointerMove={() =>
                    setHighlighted({ index, key: option.key })
                  }
                >
                  <div
                    id={`${idPrefix}-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    aria-label={
                      option.row !== null
                        ? undefined
                        : lifecycle === "archived"
                          ? "Show more archived threads"
                          : "Show more threads"
                    }
                    className={cn(
                      "flex min-w-0 flex-1 cursor-pointer items-center rounded-md px-2 py-1.5",
                      option.row === null
                        ? "gap-1.5 text-xs text-subtle-foreground"
                        : "min-h-11 gap-3 text-left text-sm",
                    )}
                    onClick={() => choose(index, false)}
                  >
                    {option.row === null ? (
                      <>
                        Show more
                        <Icon
                          name="ChevronDown"
                          className="size-3.5"
                          aria-hidden
                        />
                      </>
                    ) : (
                      <ThreadSearchPaletteRow row={option.row} />
                    )}
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
        ))
      ) : !hasLoadError &&
        (result.isRecent ? !isRecentLoading : searchable && !isLoading) ? (
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
  const hasUnsubmittedDraft = usePromptDraftHasInput({
    kind: "thread",
    projectId: row.projectId,
    threadId: row.threadId,
  });
  const status = resolveThreadListIndicator(
    threadListIndicatorStateForThread(row.thread, hasUnsubmittedDraft),
  );
  const statusLabel = getThreadListIndicatorLabel(status);
  const glyph = STATUS_GLYPHS[status];
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
        {statusLabel === null ? null : (
          <>
            <span
              aria-hidden="true"
              className="shrink-0 text-xs leading-4 text-subtle-foreground"
              data-palette-thread-status-separator
            >
              ·
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  role="img"
                  aria-label={statusLabel}
                  className="inline-flex size-3.5 shrink-0 cursor-default items-center justify-center text-subtle-foreground"
                  data-palette-thread-status
                >
                  {glyph ? (
                    <Icon
                      name={glyph[0]}
                      className={glyph[1]}
                      aria-label={statusLabel}
                    />
                  ) : (
                    <span
                      className="size-[5px] rounded-full bg-muted-foreground/60"
                      aria-label={statusLabel}
                    />
                  )}
                </span>
              </TooltipTrigger>
              <TooltipContent side="left">{statusLabel}</TooltipContent>
            </Tooltip>
          </>
        )}
      </span>
    </span>
  );
}
