import { DiffLoadingSkeleton } from "../code/code-loading-skeletons";
import { type CSSProperties, useEffect, useState } from "react";
import type { FileContents } from "@pierre/diffs";
import type { GitDiffFileChangeKind } from "@bb/server-contract";
import { useIntersectionObserver } from "usehooks-ts";
import { Button } from "@bb/shared-ui/button";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import BbDiff from "../code/BbDiff";
import type {
  DiffFullFileContents,
  DiffPresentation,
} from "../code/code-rendering";
import {
  normalizeGitDiffPath,
  type ParsedGitDiffFile,
} from "./git-diff-parsing";

export type RequestDiffFileContents = (
  path: string,
  side: "old" | "new",
) => Promise<FileContents | null>;

const GIT_DIFF_CARD_BODY_STYLE: CSSProperties = {
  contain: "layout paint style",
  contentVisibility: "auto",
  containIntrinsicSize: "0 600px",
};
const NOTICE_LINK_CLASS =
  "h-auto p-0 text-xs underline underline-offset-4 hover:underline";

interface ContextState {
  identity: string;
  request: RequestDiffFileContents | undefined;
  status: "loading" | "error" | "unavailable" | "ready";
  contents?: DiffFullFileContents;
}

interface GitDiffCardBodyProps {
  fileDiff: ParsedGitDiffFile;
  changeKind: GitDiffFileChangeKind;
  onRequestFileContents?: RequestDiffFileContents;
  patchText?: string;
  presentation: DiffPresentation;
  reservesCollapseGutter: boolean;
}

export function GitDiffCardBody({
  fileDiff,
  changeKind,
  onRequestFileContents,
  patchText,
  presentation,
  reservesCollapseGutter,
}: GitDiffCardBodyProps) {
  const { ref: bodySentinelRef, isIntersecting } = useIntersectionObserver({
    initialIsIntersecting: false,
    rootMargin: "200px",
  });
  const [hasEnteredViewport, setHasEnteredViewport] = useState(false);
  const [loadedDeletedFor, setLoadedDeletedFor] = useState<string | null>(null);
  const [loadedContext, setContext] = useState<ContextState | null>(null);
  const [contextAttempt, setContextAttempt] = useState(0);
  const [requestedContextFor, setRequestedContextFor] = useState<string | null>(
    null,
  );
  const isPointerCoarse = usePointerCoarse();
  const newPath = normalizeGitDiffPath(fileDiff.name) ?? fileDiff.name;
  const oldPath =
    changeKind === "renamed"
      ? (normalizeGitDiffPath(fileDiff.prevName) ?? newPath)
      : newPath;
  const identity = `${changeKind}:${oldPath}:${newPath}:${patchText ?? ""}`;
  const context =
    loadedContext?.identity === identity &&
    loadedContext.request === onRequestFileContents
      ? loadedContext
      : null;
  useEffect(() => {
    if (isIntersecting) setHasEnteredViewport(true);
  }, [isIntersecting]);
  const shouldGateDeletedDiff =
    changeKind === "deleted" && loadedDeletedFor !== identity;
  const shouldRenderDiffView = hasEnteredViewport && !shouldGateDeletedDiff;
  const canExpandContext =
    shouldRenderDiffView &&
    onRequestFileContents !== undefined &&
    patchText !== undefined &&
    fileDiff.hunks.length > 0 &&
    (changeKind === "modified" ||
      changeKind === "renamed" ||
      changeKind === "copied");
  const shouldLoadContext =
    canExpandContext && (!isPointerCoarse || requestedContextFor === identity);
  useEffect(() => {
    if (!shouldLoadContext || onRequestFileContents === undefined) return;
    const key = { identity, request: onRequestFileContents };
    let cancelled = false;
    setContext({ ...key, status: "loading" });
    Promise.all([
      onRequestFileContents(oldPath, "old"),
      onRequestFileContents(newPath, "new"),
    ]).then(
      ([oldFile, newFile]) => {
        if (cancelled) return;
        setContext(
          oldFile === null || newFile === null
            ? { ...key, status: "unavailable" }
            : {
                ...key,
                status: "ready",
                contents: {
                  old: { path: oldFile.name, content: oldFile.contents },
                  new: { path: newFile.name, content: newFile.contents },
                },
              },
        );
      },
      () => {
        if (!cancelled) setContext({ ...key, status: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    contextAttempt,
    identity,
    newPath,
    oldPath,
    onRequestFileContents,
    shouldLoadContext,
  ]);
  const gutter = reservesCollapseGutter ? (
    <span aria-hidden className="w-8 shrink-0" />
  ) : null;

  return (
    <div
      ref={bodySentinelRef}
      className="overflow-hidden rounded-b-lg bg-background"
      style={GIT_DIFF_CARD_BODY_STYLE}
    >
      {shouldGateDeletedDiff ? (
        <div className="flex items-center py-3 pl-2 pr-3 text-xs text-muted-foreground">
          {gutter}
          <span className="pl-[1ch]">
            <span>This file was deleted.</span>{" "}
            <Button
              type="button"
              variant="link"
              size="sm"
              className={NOTICE_LINK_CLASS}
              onClick={() => {
                setLoadedDeletedFor(identity);
                setHasEnteredViewport(true);
              }}
            >
              Load diff
            </Button>
          </span>
        </div>
      ) : !shouldRenderDiffView ? (
        <DiffLoadingSkeleton />
      ) : (
        <>
          <BbDiff
            file={fileDiff}
            patchText={patchText}
            fullFileContents={context?.contents ?? null}
            {...presentation}
          />
          {canExpandContext && !shouldLoadContext ? (
            <div className="flex items-center py-2 pl-2 pr-3 text-xs text-muted-foreground">
              {gutter}
              <span className="pl-[1ch]">
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className={NOTICE_LINK_CLASS}
                  onClick={() => setRequestedContextFor(identity)}
                >
                  Expand context
                </Button>
              </span>
            </div>
          ) : context?.status === "loading" || context?.status === "error" ? (
            <div className="flex items-center py-2 pl-2 pr-3 text-xs text-muted-foreground">
              {gutter}
              <span className="pl-[1ch]">
                {context.status === "loading" ? (
                  <span role="status">Loading context…</span>
                ) : (
                  <>
                    <span className="text-destructive">
                      Couldn&apos;t load surrounding context.
                    </span>{" "}
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className={NOTICE_LINK_CLASS}
                      onClick={() =>
                        setContextAttempt((attempt) => attempt + 1)
                      }
                    >
                      Retry
                    </Button>
                  </>
                )}
              </span>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
