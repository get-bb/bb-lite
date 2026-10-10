import { DiffLoadingSkeleton } from "@bb/app-kit/components/code/code-loading-skeletons";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { useIntersectionObserver } from "usehooks-ts";
import type { DiffFileEntry } from "@bb/server-contract";
import type { DiffPresentation } from "@bb/app-kit/components/code/code-rendering";
import {
  GitDiffCardBody,
  type RequestDiffFileContents,
} from "@bb/app-kit/components/git-diff/GitDiffCardBody";
import {
  GitDiffCardHeader,
  gitDiffCardHeaderWrapperClass,
} from "@bb/app-kit/components/git-diff/GitDiffCardHeader";
import { parseGitDiffFiles } from "@bb/app-kit/components/git-diff/git-diff-parsing";
import { Button } from "@bb/shared-ui/button";
import { FilePathLink } from "@bb/app-kit/components/ui/file-path-link";
import type { DiffPatchState } from "../../../hooks/queries/use-environment-diff-patches";
import { cn } from "@bb/shared-ui/lib/utils";

interface DiffFileCardProps {
  entry: DiffFileEntry;
  presentation: DiffPresentation;
  filePathRoot?: string | null;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  patchState: DiffPatchState;
  onLoadPatch: (path: string) => void;
  onRetry: (path: string) => void;
  onOpenFileInEditor?: (path: string) => void;
  onOpenFilePreview: (path: string) => void;
  onRequestFileContents?: RequestDiffFileContents;
  loadVersion: number;
}

const NOTICE_CLASS =
  "flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-3 text-xs text-muted-foreground";
const NOTICE_LINK_CLASS =
  "h-auto p-0 text-xs underline underline-offset-4 hover:underline";

export function DiffFileCard({
  entry,
  presentation,
  filePathRoot,
  isCollapsed,
  onToggleCollapsed,
  patchState,
  onLoadPatch,
  onRetry,
  onOpenFileInEditor,
  onOpenFilePreview,
  onRequestFileContents,
  loadVersion,
}: DiffFileCardProps) {
  const label =
    (entry.changeKind === "renamed" || entry.changeKind === "copied") &&
    entry.previousPath &&
    entry.previousPath !== entry.path
      ? `${entry.previousPath} -> ${entry.path}`
      : entry.path;
  const patch = patchState.status === "loaded" ? patchState.patch : undefined;
  const parsedFile = useMemo(
    () => (patch === undefined ? null : (parseGitDiffFiles(patch)[0] ?? null)),
    [patch],
  );
  const changedLines = entry.additions + entry.deletions;
  const { ref: stickySentinelRef, isIntersecting } = useIntersectionObserver({
    initialIsIntersecting: true,
    threshold: 1,
  });
  const { ref: cardRef, isIntersecting: isNearViewport } =
    useIntersectionObserver({ rootMargin: "400px" });
  const loadPatchRef = useRef(onLoadPatch);
  loadPatchRef.current = onLoadPatch;
  const shouldAutoLoad =
    loadVersion > 0 &&
    isNearViewport &&
    !isCollapsed &&
    entry.loadMode === "auto";
  useEffect(() => {
    if (shouldAutoLoad) loadPatchRef.current(entry.path);
  }, [entry.path, loadVersion, shouldAutoLoad]);

  const notice = (text: ReactNode, action?: ReactNode) => (
    <div className={NOTICE_CLASS}>
      {text}
      {action}
    </div>
  );
  const linkButton = (text: string, onClick: () => void) => (
    <Button
      type="button"
      variant="link"
      size="sm"
      className={NOTICE_LINK_CLASS}
      onClick={onClick}
    >
      {text}
    </Button>
  );
  const openFileLink = (displayName: string) => (
    <FilePathLink
      path={entry.path}
      displayName={displayName}
      onClick={() => onOpenFilePreview(entry.path)}
      className="text-xs underline underline-offset-4"
    />
  );
  const renderBody = () => {
    if (patchState.status === "error") {
      return notice(
        <span className="text-destructive">
          {patchState.error ?? "Failed to load this file's diff."}
        </span>,
        linkButton("Retry", () => onRetry(entry.path)),
      );
    }
    if (entry.loadMode === "too_large") {
      return notice(
        <span>
          Too large to display ({changedLines.toLocaleString()} changed lines).
        </span>,
        openFileLink("Open file"),
      );
    }
    if (entry.loadMode === "on_demand" && patchState.status === "idle") {
      return notice(
        <span>
          {entry.binary
            ? "Binary file."
            : `${changedLines.toLocaleString()} changed lines.`}
        </span>,
        linkButton("Load diff", () => onLoadPatch(entry.path)),
      );
    }
    if (parsedFile === null) {
      return patchState.status === "loaded" ? (
        notice(
          <span>No renderable diff for this file.</span>,
          openFileLink("Open file"),
        )
      ) : (
        <DiffLoadingSkeleton />
      );
    }
    return (
      <>
        <GitDiffCardBody
          fileDiff={parsedFile}
          changeKind={entry.changeKind}
          onRequestFileContents={onRequestFileContents}
          patchText={patchState.truncated ? undefined : patch}
          presentation={presentation}
          reservesCollapseGutter
        />
        {patchState.truncated
          ? notice(
              <span>This diff was truncated for display.</span>,
              openFileLink("Show full diff"),
            )
          : null}
      </>
    );
  };

  return (
    <div
      ref={cardRef}
      data-diff-file-path={entry.path}
      className="overflow-clip rounded-lg border border-border bg-background"
    >
      <div ref={stickySentinelRef} className="h-0" />
      <div
        className={cn(
          gitDiffCardHeaderWrapperClass({
            stickyHeader: true,
            isBodyHidden: isCollapsed,
            isStuck: !isIntersecting,
            showStuckHeaderEdge: false,
          }),
          "-mt-px border-t border-border",
        )}
      >
        <GitDiffCardHeader
          model={{
            label,
            path: entry.path,
            openablePath: entry.path,
            changeKind: entry.changeKind,
            insertions: entry.additions,
            deletions: entry.deletions,
          }}
          previousPath={entry.previousPath}
          filePathRoot={filePathRoot}
          onOpenFileInEditor={onOpenFileInEditor}
          onOpenFilePreview={onOpenFilePreview}
          isCollapsed={isCollapsed}
          onToggleCollapsed={onToggleCollapsed}
          hasChanges
        />
      </div>
      {isCollapsed ? null : renderBody()}
    </div>
  );
}
