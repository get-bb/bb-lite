import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { File as PierreFile, VirtualizerContext } from "@pierre/diffs/react";
import type { FileOptions } from "@pierre/diffs/react";
import {
  Virtualizer as PierreVirtualizer,
  type FileContents as PierreFileContents,
  type VirtualFileMetrics,
} from "@pierre/diffs";
import { Button } from "@bb/shared-ui/button";
import { usePreferredTheme } from "../../hooks/useTheme";
import { useCodeHighlighter } from "../../lib/code-theme-registration";
import { usePierreStrictModeRecoveryOptions } from "../../lib/pierre-strict-mode-recovery";
import { SourceLoadingSkeleton } from "./code-loading-skeletons";
import { truncateSourceCode } from "./source-code-budget";
import type { BbSourceCodeProps } from "./code-rendering";

const SOURCE_LINE_HEIGHT_PX = 18;
const SOURCE_GAP_BLOCK_PX = 16;
const TARGET_LINE_MAX_ATTEMPTS = 40;

const SOURCE_VIEW_STYLE = {
  "--diffs-font-size": "12px",
  "--diffs-line-height": `${SOURCE_LINE_HEIGHT_PX}px`,
  "--diffs-gap-block": `${SOURCE_GAP_BLOCK_PX}px`,
} as CSSProperties;

const SOURCE_VIRTUAL_FILE_METRICS: VirtualFileMetrics = {
  hunkLineCount: 50,
  lineHeight: SOURCE_LINE_HEIGHT_PX,
  diffHeaderHeight: 0,
  spacing: SOURCE_GAP_BLOCK_PX,
};

function queryLines(container: HTMLElement, selector: string): HTMLElement[] {
  const roots: ParentNode[] = [container];
  for (const host of container.querySelectorAll("diffs-container")) {
    if (host.shadowRoot !== null) roots.push(host.shadowRoot);
  }
  return roots.flatMap((root) =>
    Array.from(root.querySelectorAll<HTMLElement>(selector)),
  );
}

function clearTargetLine(container: HTMLElement) {
  for (const line of queryLines(
    container,
    "[data-bb-source-code-target-line]",
  )) {
    line.removeAttribute("data-bb-source-code-target-line");
    line.removeAttribute("data-selected-line");
  }
}

function findViewport(container: HTMLElement | null): HTMLElement | null {
  return (
    container?.querySelector<HTMLElement>("[data-bb-source-code-viewport]") ??
    null
  );
}

function approachTargetLine(container: HTMLElement, lineNumber: number) {
  const viewport = findViewport(container);
  if (viewport === null) return;
  const viewportRect = viewport.getBoundingClientRect();
  const centerOffset = viewportRect.height / 2;
  const rendered = queryLines(container, "[data-line][data-line-index]")
    .map((line) => ({ line, number: Number(line.dataset.line) }))
    .filter(({ number }) => Number.isFinite(number))
    .sort((left, right) => left.number - right.number);
  const first = rendered[0];
  const last = rendered.at(-1);
  if (first === undefined || last === undefined) {
    viewport.scrollTop = Math.max(
      0,
      SOURCE_GAP_BLOCK_PX +
        (lineNumber - 1) * SOURCE_LINE_HEIGHT_PX -
        centerOffset,
    );
  } else if (lineNumber > last.number) {
    const distance =
      last.line.getBoundingClientRect().bottom -
      viewportRect.top +
      (lineNumber - last.number - 1) * SOURCE_LINE_HEIGHT_PX;
    viewport.scrollTop += Math.max(0, distance - centerOffset);
  } else if (lineNumber < first.number) {
    const distance =
      viewportRect.top -
      first.line.getBoundingClientRect().top +
      (first.number - lineNumber) * SOURCE_LINE_HEIGHT_PX;
    viewport.scrollTop = Math.max(
      0,
      viewport.scrollTop - distance - centerOffset,
    );
  }
}

function BbSourceCode({
  content,
  path,
  cacheKey,
  overflow,
  highlightedLines,
}: BbSourceCodeProps) {
  const fileCacheKey = cacheKey ?? path;
  const preferredTheme = usePreferredTheme();
  const { theme: codeTheme, isReady } = useCodeHighlighter(path);
  const containerRef = useRef<HTMLDivElement>(null);
  const truncation = useMemo(() => truncateSourceCode(content), [content]);
  const [fullFileRequestedFor, setFullFileRequestedFor] = useState<
    string | null
  >(null);
  const baseOptions = useMemo<FileOptions<undefined>>(
    () => ({
      themeType: preferredTheme,
      theme: codeTheme,
      overflow,
      disableFileHeader: true,
      enableGutterUtility: false,
      enableLineSelection: highlightedLines !== null,
      lineHoverHighlight: "disabled",
    }),
    [codeTheme, highlightedLines, overflow, preferredTheme],
  );
  const options = usePierreStrictModeRecoveryOptions(baseOptions);
  const targetLineNumber = highlightedLines?.start ?? null;
  const showsFullFile =
    truncation === null ||
    fullFileRequestedFor === fileCacheKey ||
    (targetLineNumber !== null &&
      targetLineNumber > truncation.renderedLineCount);
  const renderedFileKey = showsFullFile ? fileCacheKey : `${fileCacheKey}:head`;
  const renderedFile = useMemo<PierreFileContents>(
    () => ({
      name: path,
      contents: showsFullFile ? content : (truncation?.contents ?? content),
      cacheKey: renderedFileKey,
    }),
    [content, path, renderedFileKey, showsFullFile, truncation],
  );
  const pendingScrollTopRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const scrollTop = pendingScrollTopRef.current;
    const viewport = findViewport(containerRef.current);
    pendingScrollTopRef.current = null;
    if (scrollTop === null || viewport === null) return;
    viewport.scrollTop = scrollTop;
    const frame = window.requestAnimationFrame(() => {
      viewport.scrollTop = scrollTop;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [renderedFileKey]);

  useEffect(() => {
    const container = containerRef.current;
    let frame: number | null = null;
    let attempts = 0;
    const scrollToLine = () => {
      if (container === null) return;
      clearTargetLine(container);
      if (targetLineNumber === null) return;
      const lines = queryLines(container, `[data-line="${targetLineNumber}"]`);
      const line =
        lines.find((item) => item.dataset.lineIndex !== undefined) ?? lines[0];
      const viewport = findViewport(container);
      if (line !== undefined && viewport !== null) {
        line.setAttribute("data-bb-source-code-target-line", "");
        line.setAttribute("data-selected-line", "single");
        const lineRect = line.getBoundingClientRect();
        const viewportRect = viewport.getBoundingClientRect();
        viewport.scrollTop +=
          lineRect.top +
          lineRect.height / 2 -
          (viewportRect.top + viewportRect.height / 2);
        return;
      }
      approachTargetLine(container, targetLineNumber);
      attempts += 1;
      if (attempts < TARGET_LINE_MAX_ATTEMPTS) {
        frame = window.requestAnimationFrame(scrollToLine);
      }
    };
    scrollToLine();
    return () => {
      if (container !== null) clearTargetLine(container);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [isReady, renderedFile, targetLineNumber]);

  if (!isReady) return <SourceLoadingSkeleton />;
  return (
    <div
      ref={containerRef}
      className="flex min-h-0 flex-1 flex-col"
      style={SOURCE_VIEW_STYLE}
      data-bb-source-code-line-number={targetLineNumber ?? undefined}
    >
      <SourceCodeViewport>
        <PierreFile
          key={renderedFileKey}
          file={renderedFile}
          metrics={SOURCE_VIRTUAL_FILE_METRICS}
          options={options}
          selectedLines={highlightedLines}
        />
        {truncation !== null && !showsFullFile ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-xs text-muted-foreground">
            <span>
              Showing the first {truncation.renderedLineCount.toLocaleString()}{" "}
              of {truncation.totalLineCount.toLocaleString()} lines.
            </span>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs underline underline-offset-4 hover:underline"
              onClick={() => {
                pendingScrollTopRef.current =
                  findViewport(containerRef.current)?.scrollTop ?? null;
                setFullFileRequestedFor(fileCacheKey);
              }}
            >
              Load full file
            </Button>
          </div>
        ) : null}
      </SourceCodeViewport>
    </div>
  );
}

function SourceCodeViewport({ children }: { children: ReactNode }) {
  const [virtualizer] = useState(() => new PierreVirtualizer());
  const viewportRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node !== null) virtualizer.setup(node);
      else virtualizer.cleanUp();
    },
    [virtualizer],
  );
  return (
    <VirtualizerContext.Provider value={virtualizer}>
      <div
        ref={viewportRef}
        className="min-h-0 flex-1 overflow-y-auto"
        data-bb-source-code-viewport
      >
        <div>{children}</div>
      </div>
    </VirtualizerContext.Provider>
  );
}

export default BbSourceCode;
