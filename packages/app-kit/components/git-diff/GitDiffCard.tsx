import { memo } from "react";
import { useIntersectionObserver } from "usehooks-ts";
import { cn } from "@bb/shared-ui/lib/utils";
import type { DiffPresentation } from "../code/code-rendering";
import { GitDiffCardBody } from "./GitDiffCardBody";
import {
  GitDiffCardHeader,
  gitDiffCardHeaderWrapperClass,
} from "./GitDiffCardHeader";
import {
  formatGitDiffFileLabel,
  getGitDiffFileChangeKind,
  getOpenableGitDiffPath,
  normalizeGitDiffPath,
  summarizeGitDiffFile,
  type ParsedGitDiffFile,
} from "./git-diff-parsing";

interface GitDiffCardProps {
  fileDiff: ParsedGitDiffFile;
  presentation: DiffPresentation;
  patchText?: string;
  filePathRoot?: string | null;
  stickyHeader?: boolean;
  cardClassName?: string;
  showStuckHeaderEdge?: boolean;
}

export const GitDiffCard = memo(function GitDiffCard({
  fileDiff,
  presentation,
  patchText,
  filePathRoot,
  stickyHeader = false,
  cardClassName,
  showStuckHeaderEdge = true,
}: GitDiffCardProps) {
  const changeKind = getGitDiffFileChangeKind(fileDiff);
  const hasChanges = fileDiff.hunks.length > 0;
  const { ref: stickySentinelRef, isIntersecting } = useIntersectionObserver({
    initialIsIntersecting: true,
    threshold: 1,
  });

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-background",
        cardClassName,
      )}
    >
      {stickyHeader ? <div ref={stickySentinelRef} className="h-0" /> : null}
      <div
        className={gitDiffCardHeaderWrapperClass({
          stickyHeader,
          isBodyHidden: !hasChanges,
          isStuck: stickyHeader && !isIntersecting,
          showStuckHeaderEdge,
        })}
      >
        <GitDiffCardHeader
          model={{
            label: formatGitDiffFileLabel(fileDiff),
            path: normalizeGitDiffPath(fileDiff.name) ?? fileDiff.name,
            openablePath: getOpenableGitDiffPath(fileDiff),
            changeKind,
            ...summarizeGitDiffFile(fileDiff),
          }}
          previousPath={normalizeGitDiffPath(fileDiff.prevName) ?? null}
          filePathRoot={filePathRoot}
          hasChanges={hasChanges}
        />
      </div>
      {hasChanges ? (
        <GitDiffCardBody
          fileDiff={fileDiff}
          changeKind={changeKind}
          patchText={patchText}
          presentation={presentation}
          reservesCollapseGutter={false}
        />
      ) : null}
    </div>
  );
});
