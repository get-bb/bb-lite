import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { WorkspaceDiffTarget } from "@bb/domain";
import type {
  DiffFileEntry,
  EnvironmentDiffFilesResponse,
} from "@bb/server-contract";
import type { EnvironmentDiffFileArgs } from "@bb/sdk/browser";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { cn } from "@bb/shared-ui/lib/utils";
import type { DiffPresentation } from "@/components/code/code-rendering";
import type { RequestDiffFileContents } from "@/components/git-diff/GitDiffCardBody";
import {
  useEnvironmentDiffFiles,
  useEnvironmentWorkStatus,
} from "@/hooks/queries/environment-queries";
import { environmentDiffFileQueryKey } from "@/hooks/queries/query-keys";
import { useEnvironmentDiffPatches } from "@/hooks/queries/use-environment-diff-patches";
import { useElementWidth } from "@/hooks/useElementWidth";
import {
  useGitDiffDisplayModePreference,
  useGitDiffLineOverflowModePreference,
} from "@/lib/git-diff-view-preferences";
import { sdk } from "@/lib/sdk";
import { GitDiffToolbar, type GitDiffDisplayMode } from "../GitDiffToolbar";
import { DiffFileCard } from "./DiffFileCard";
import {
  ALL_GIT_DIFF_SELECTION,
  buildGitDiffIdentity,
  buildGitDiffSelectionOptions,
  buildGitDiffTarget,
  filterDiffFilesByPath,
  GIT_DIFF_AUTO_COLLAPSE_FILE_THRESHOLD,
  shouldResetGitDiffSelection,
} from "./gitDiffPanelHelpers";

const GIT_DIFF_SPLIT_VIEW_MIN_WIDTH_PX = 760;
const EMPTY_DIFF_FILES: readonly DiffFileEntry[] = [];
const MESSAGE_SLOT_CLASS =
  "min-h-0 flex-1 overflow-x-auto overflow-y-auto px-4 pb-3";
const NOTICE_CLASS =
  "rounded-lg border border-border bg-surface-raised px-3 py-2 text-xs text-muted-foreground";

interface UseGitDiffTabArgs {
  environmentId: string | undefined;
  isActive: boolean;
  requestedMergeBaseBranch: string | undefined;
  pendingCommitSha: string | null;
  pendingScrollPath: string | null;
  onClearPending: () => void;
  workspaceRootPath: string | null | undefined;
  onOpenFileInEditor?: (path: string) => void;
  onOpenFilePreview: (path: string) => void;
}

function useDiffFileContentsRequester(
  environmentId: string | undefined,
  target: WorkspaceDiffTarget | undefined,
  mergeBaseRef: string | null,
): RequestDiffFileContents | undefined {
  const queryClient = useQueryClient();
  return useMemo(() => {
    if (!environmentId || target === undefined) return undefined;
    const usesMergeBase =
      target.type === "branch_committed" || target.type === "all";
    if (usesMergeBase && mergeBaseRef === null) return undefined;
    const targetKey =
      target.type === "commit"
        ? target.sha
        : usesMergeBase
          ? mergeBaseRef
          : null;
    return async (path, side) => {
      const response = await queryClient.fetchQuery({
        queryKey: environmentDiffFileQueryKey(
          environmentId,
          target.type,
          targetKey,
          path,
          side,
        ),
        queryFn: ({ signal }) =>
          sdk.environments.diffFile({
            environmentId,
            path,
            side,
            signal,
            target: target.type,
            ...(target.type === "commit" ? { sha: target.sha } : {}),
            ...(usesMergeBase ? { mergeBaseRef } : {}),
          } as EnvironmentDiffFileArgs),
        staleTime: 5_000,
      });
      return response.contentEncoding === "utf8"
        ? { name: path, contents: response.content }
        : null;
    };
  }, [environmentId, mergeBaseRef, queryClient, target]);
}

export function useGitDiffTab({
  environmentId,
  isActive,
  requestedMergeBaseBranch,
  pendingCommitSha,
  pendingScrollPath,
  onClearPending,
  workspaceRootPath,
  onOpenFileInEditor,
  onOpenFilePreview,
}: UseGitDiffTabArgs): { toolbar: ReactNode; content: ReactNode } {
  const [selection, setSelection] = useState<string | null>(null);
  const [fileFilter, setFileFilter] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<{
    identity: string;
    byPath: Record<string, boolean>;
  }>({ identity: "", byPath: {} });
  const target = useMemo(
    () => buildGitDiffTarget(selection, requestedMergeBaseBranch),
    [requestedMergeBaseBranch, selection],
  );
  const workStatus = useEnvironmentWorkStatus(
    environmentId ?? "",
    requestedMergeBaseBranch,
    {
      enabled:
        Boolean(environmentId) && Boolean(requestedMergeBaseBranch) && isActive,
    },
  ).data;
  const workspace =
    workStatus?.outcome === "available" ? workStatus.workspace : undefined;
  const commits = workspace?.mergeBase?.commits;
  const hasUncommittedChanges = (workspace?.workingTree.files.length ?? 0) > 0;
  useEffect(() => {
    setSelection(null);
    setFileFilter(null);
  }, [environmentId, pendingScrollPath]);
  useEffect(() => {
    if (pendingCommitSha === null) return;
    setSelection(pendingCommitSha);
    onClearPending();
  }, [onClearPending, pendingCommitSha]);
  useEffect(() => {
    if (
      shouldResetGitDiffSelection(
        selection,
        commits ?? [],
        hasUncommittedChanges,
      )
    ) {
      setSelection(null);
    }
  }, [commits, hasUncommittedChanges, selection]);

  const filesQuery = useEnvironmentDiffFiles(environmentId ?? "", {
    enabled: isActive && Boolean(environmentId) && target !== undefined,
    target,
  });
  const response = filesQuery.data;
  const available = response?.outcome === "available" ? response : null;
  const files = available?.files ?? EMPTY_DIFF_FILES;
  const mergeBaseRef = available?.mergeBaseRef ?? null;
  const identity = buildGitDiffIdentity(environmentId, mergeBaseRef, target);
  const visibleFiles = useMemo(
    () => filterDiffFilesByPath(files, fileFilter ?? ""),
    [files, fileFilter],
  );
  const collapsedByPath =
    collapsed.identity === identity ? collapsed.byPath : {};
  const isCollapsed = (entry: DiffFileEntry) =>
    collapsedByPath[entry.path] ??
    (files.length > GIT_DIFF_AUTO_COLLAPSE_FILE_THRESHOLD ||
      entry.changeKind === "deleted");
  const setFilesCollapsed = (
    entries: readonly DiffFileEntry[],
    value: boolean,
  ) =>
    setCollapsed({
      identity,
      byPath: {
        ...collapsedByPath,
        ...Object.fromEntries(entries.map((entry) => [entry.path, value])),
      },
    });
  const areAllCollapsed =
    visibleFiles.length > 0 && visibleFiles.every(isCollapsed);

  const [displayModePreference, setDisplayModePreference] =
    useGitDiffDisplayModePreference();
  const [lineOverflowMode, setLineOverflowMode] =
    useGitDiffLineOverflowModePreference();
  const { ref: toolbarRef, width: panelWidth } = useElementWidth();
  const isCompactViewport = useIsCompactViewport();
  const [compactDisplayMode, setCompactDisplayMode] =
    useState<GitDiffDisplayMode | null>(null);
  const displayMode = isCompactViewport
    ? (compactDisplayMode ?? "unified")
    : (displayModePreference ??
      (panelWidth >= GIT_DIFF_SPLIT_VIEW_MIN_WIDTH_PX ? "split" : "unified"));
  const presentation = useMemo<DiffPresentation>(
    () => ({
      view: displayMode,
      overflow: lineOverflowMode,
      showLineNumbers: true,
    }),
    [displayMode, lineOverflowMode],
  );
  const onRequestFileContents = useDiffFileContentsRequester(
    environmentId,
    target,
    mergeBaseRef,
  );

  let insertions = 0;
  let deletions = 0;
  for (const file of visibleFiles) {
    insertions += file.additions;
    deletions += file.deletions;
  }
  const toolbar = (
    <GitDiffToolbar
      rootRef={toolbarRef}
      panelWidthPx={Math.max(0, panelWidth - 32)}
      selectionValue={selection ?? ALL_GIT_DIFF_SELECTION}
      selectionOptions={buildGitDiffSelectionOptions(
        commits ?? [],
        hasUncommittedChanges,
      )}
      onSelectionChange={(value) =>
        setSelection(value === ALL_GIT_DIFF_SELECTION ? null : value)
      }
      isSelectorDisabled={filesQuery.isLoading || target === undefined}
      stats={{ filesCount: visibleFiles.length, insertions, deletions }}
      totalFilesCount={files.length}
      isTruncated={available?.truncated === true}
      fileFilter={fileFilter}
      onFileFilterChange={setFileFilter}
      areAllFilesCollapsed={areAllCollapsed}
      isCollapseAllDisabled={visibleFiles.length === 0 || filesQuery.isLoading}
      onToggleAllCollapsed={() =>
        setFilesCollapsed(visibleFiles, !areAllCollapsed)
      }
      displayMode={displayMode}
      onDisplayModeChange={
        isCompactViewport ? setCompactDisplayMode : setDisplayModePreference
      }
      lineOverflowMode={lineOverflowMode}
      onLineOverflowModeChange={setLineOverflowMode}
    />
  );

  const isQueryEnabled =
    isActive && Boolean(environmentId) && target !== undefined;
  const message = resolveGitDiffMessage(
    response,
    filesQuery.error,
    isQueryEnabled &&
      (filesQuery.isLoading ||
        filesQuery.isPlaceholderData ||
        response === undefined),
  );
  const content =
    message !== null ||
    available === null ||
    !environmentId ||
    target === undefined ? (
      <div className={MESSAGE_SLOT_CLASS}>{message}</div>
    ) : (
      <div className="flex min-h-0 flex-1 flex-col">
        {available.truncated ? (
          <div role="status" className={cn("mx-4 mb-2", NOTICE_CLASS)}>
            Showing the first {files.length} changed files. Additional changes
            are omitted.
          </div>
        ) : null}
        <DiffFilesList
          environmentId={environmentId}
          target={target}
          response={available}
          refreshKey={filesQuery.dataUpdatedAt}
          visibleFiles={visibleFiles}
          fileFilter={fileFilter ?? ""}
          presentation={presentation}
          filePathRoot={workspaceRootPath}
          isCollapsed={isCollapsed}
          onToggleCollapsed={(entry) =>
            setFilesCollapsed([entry], !isCollapsed(entry))
          }
          scrollToPath={pendingScrollPath}
          onScrolledToPath={onClearPending}
          onOpenFileInEditor={onOpenFileInEditor}
          onOpenFilePreview={onOpenFilePreview}
          onRequestFileContents={onRequestFileContents}
        />
      </div>
    );
  return { toolbar, content };
}

function resolveGitDiffMessage(
  response: EnvironmentDiffFilesResponse | undefined,
  error: Error | null,
  isPreparing: boolean,
): ReactNode {
  if (isPreparing && error === null) {
    return (
      <div className="space-y-2 pt-2">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="rounded-lg border border-border bg-surface-raised"
          >
            <div className="border-b border-border bg-surface-recessed px-3 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <Skeleton className="size-4 shrink-0 rounded-sm" />
                  <Skeleton className="h-3 w-48 max-w-full rounded-sm" />
                </div>
                <Skeleton className="h-3 w-14 shrink-0 rounded-sm" />
              </div>
            </div>
            <div className="space-y-1.5 px-2.5 py-2">
              <Skeleton className="h-3 w-full rounded-sm" />
              <Skeleton className="h-3 w-[94%] rounded-sm" />
              <Skeleton className="h-3 w-[90%] rounded-sm" />
              <Skeleton className="h-3 w-[86%] rounded-sm" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (error !== null) {
    return (
      <div className="rounded-lg border border-surface-destructive-border bg-surface-destructive px-3 py-2 text-xs text-destructive">
        <p>{error.message || "Failed to load git diff"}</p>
      </div>
    );
  }
  if (response?.outcome === "unavailable") {
    return (
      <div className={NOTICE_CLASS}>
        <p className="font-medium text-foreground">Workspace unavailable</p>
        <p className="mt-1 leading-5">{response.failure.message}</p>
      </div>
    );
  }
  if (response?.outcome === "not_applicable") {
    return (
      <div className={NOTICE_CLASS}>
        <p className="mt-1 leading-5">{response.message}</p>
      </div>
    );
  }
  if (response === undefined || response.files.length === 0) {
    return (
      <EmptyStatePanel className="rounded-lg">
        No diff to display.
      </EmptyStatePanel>
    );
  }
  return null;
}

interface DiffFilesListProps {
  environmentId: string;
  target: WorkspaceDiffTarget;
  response: Extract<EnvironmentDiffFilesResponse, { outcome: "available" }>;
  refreshKey: number;
  visibleFiles: readonly DiffFileEntry[];
  fileFilter: string;
  presentation: DiffPresentation;
  filePathRoot?: string | null;
  isCollapsed: (entry: DiffFileEntry) => boolean;
  onToggleCollapsed: (entry: DiffFileEntry) => void;
  scrollToPath: string | null;
  onScrolledToPath: () => void;
  onOpenFileInEditor?: (path: string) => void;
  onOpenFilePreview: (path: string) => void;
  onRequestFileContents?: RequestDiffFileContents;
}

function DiffFilesList({
  environmentId,
  target,
  response,
  refreshKey,
  visibleFiles,
  fileFilter,
  presentation,
  filePathRoot,
  isCollapsed,
  onToggleCollapsed,
  scrollToPath,
  onScrolledToPath,
  onOpenFileInEditor,
  onOpenFilePreview,
  onRequestFileContents,
}: DiffFilesListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { getPatchState, retry, loadPath, seedInitialPatches, prunePaths } =
    useEnvironmentDiffPatches(environmentId, { target });
  const { files, initialPatches } = response;
  const [seedVersion, setSeedVersion] = useState(0);
  useEffect(() => {
    seedInitialPatches(initialPatches);
    setSeedVersion((version) => version + 1);
  }, [seedInitialPatches, initialPatches, refreshKey]);
  useEffect(() => {
    prunePaths(files.map((file) => file.path));
  }, [files, prunePaths]);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scrollToPath === null || scroller === null) return;
    const scroll = () => {
      const card = Array.from(
        scroller.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
      ).find((element) => element.dataset.diffFilePath === scrollToPath);
      if (card === undefined) return;
      scroller.scrollTop +=
        card.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    };
    scroll();
    const observer = new ResizeObserver(scroll);
    if (scroller.firstElementChild !== null) {
      observer.observe(scroller.firstElementChild);
    }
    const timeout = window.setTimeout(onScrolledToPath, 1_500);
    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
    };
  }, [onScrolledToPath, scrollToPath]);

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pb-3"
    >
      {visibleFiles.length === 0 ? (
        <EmptyStatePanel className="rounded-lg">
          No changed files match “{fileFilter.trim()}”.
        </EmptyStatePanel>
      ) : (
        <div className="flex w-full flex-col gap-2 pb-2">
          {visibleFiles.map((entry) => (
            <DiffFileCard
              key={entry.path}
              entry={entry}
              presentation={presentation}
              filePathRoot={filePathRoot}
              isCollapsed={isCollapsed(entry)}
              onToggleCollapsed={() => onToggleCollapsed(entry)}
              patchState={getPatchState(entry.path)}
              onLoadPatch={loadPath}
              onRetry={retry}
              onOpenFileInEditor={onOpenFileInEditor}
              onOpenFilePreview={onOpenFilePreview}
              onRequestFileContents={onRequestFileContents}
              loadVersion={seedVersion}
            />
          ))}
        </div>
      )}
    </div>
  );
}
