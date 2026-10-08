import { memo, useMemo } from "react";
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import type { TimelineFileChange } from "@bb/server-contract";
import {
  getPlainDiffFallback,
  getRenderablePatchText,
  type RenderablePatchText,
} from "@bb/client-core";
import { GitDiffCard } from "@bb/app-kit/components/git-diff/GitDiffCard";
import { EventCodeBlock } from "@bb/app-kit/components/ui/event-code-block";
import type { DiffPresentation } from "@bb/app-kit/components/code/code-rendering";
import { TimelineDetailScroll } from "./TimelineDetailScroll";

interface RenderablePatch {
  disableLineNumbers: boolean;
  fileDiff: FileDiffMetadata;
  patch: string;
}

interface RenderedFileChange {
  plainDiff: string | null;
  renderablePatch: RenderablePatch | null;
}

const renderedFileChangeCache = new WeakMap<
  TimelineFileChange,
  RenderedFileChange
>();

function parseRenderablePatch(
  patchText: RenderablePatchText | null,
): RenderablePatch | null {
  if (patchText === null) {
    return null;
  }
  try {
    const parsedPatches = parsePatchFiles(patchText.patch);
    const fileDiff = parsedPatches[0]?.files[0];
    if (
      parsedPatches.length !== 1 ||
      parsedPatches[0]?.files.length !== 1 ||
      !fileDiff
    ) {
      return null;
    }
    return {
      disableLineNumbers: patchText.disableLineNumbers,
      fileDiff,
      patch: patchText.patch,
    };
  } catch {
    return null;
  }
}

function buildRenderedFileChange(
  change: TimelineFileChange,
): RenderedFileChange {
  let rendered = renderedFileChangeCache.get(change);
  if (!rendered) {
    const renderablePatch = parseRenderablePatch(
      getRenderablePatchText(change),
    );
    rendered = {
      renderablePatch,
      plainDiff: getPlainDiffFallback(change, renderablePatch !== null),
    };
    renderedFileChangeCache.set(change, rendered);
  }
  return rendered;
}

export const TimelineFileDiffBlock = memo(function TimelineFileDiffBlock({
  change,
  workspaceRootPath,
}: {
  change: TimelineFileChange;
  workspaceRootPath: string | undefined;
}) {
  const renderedChange = useMemo(
    () => buildRenderedFileChange(change),
    [change],
  );
  const renderablePatch = renderedChange.renderablePatch;
  const cardPresentation = useMemo<DiffPresentation | null>(
    () =>
      renderablePatch
        ? {
            view: "unified",
            overflow: "scroll",
            showLineNumbers: !renderablePatch.disableLineNumbers,
          }
        : null,
    [renderablePatch],
  );

  if (renderablePatch === null && renderedChange.plainDiff === null) {
    return (
      <div className="rounded-md border border-border bg-surface-raised px-2 py-1.5 text-xs text-muted-foreground">
        No diff available.
      </div>
    );
  }

  const diffContentKey = `${renderablePatch ? "p" : "n"}:${renderedChange.plainDiff?.length ?? 0}`;

  if (renderablePatch && cardPresentation) {
    return (
      <TimelineDetailScroll
        size="base"
        contentKey={diffContentKey}
        className="mt-1"
        scrollClassName="rounded-lg border border-border bg-background"
        showAboveFade={false}
      >
        <div data-timeline-file-diff="">
          <GitDiffCard
            fileDiff={renderablePatch.fileDiff}
            patchText={renderablePatch.patch}
            presentation={cardPresentation}
            filePathRoot={workspaceRootPath}
            cardClassName="rounded-none border-0 bg-transparent"
            showStuckHeaderEdge={false}
            stickyHeader
          />
        </div>
      </TimelineDetailScroll>
    );
  }

  return (
    <TimelineDetailScroll
      size="base"
      contentKey={diffContentKey}
      className="mt-1 rounded-md border border-border bg-surface-raised"
    >
      <div className="min-w-fit">
        <EventCodeBlock className="rounded-none border-0 bg-transparent">
          {renderedChange.plainDiff!}
        </EventCodeBlock>
      </div>
    </TimelineDetailScroll>
  );
});
