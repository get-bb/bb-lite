import { SourceLoadingSkeleton } from "@bb/app-kit/components/code/code-loading-skeletons";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@bb/shared-ui/dropdown-menu";
import { useElementWidth } from "@bb/app-kit/hooks/useElementWidth";
import BbSourceCode from "@bb/app-kit/components/code/BbSourceCode";
import { hashSourceContents } from "@bb/app-kit/components/code/source-code-budget";
import { COARSE_POINTER_TEXT_SM_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { CopyButton } from "@bb/app-kit/components/ui/copy-button";
import { Icon } from "@bb/shared-ui/icon";
import { OpenInEditorButton } from "@bb/app-kit/components/ui/open-in-editor-button";
import {
  useAppCommandHandler,
  useAppCommandShortcut,
} from "@bb/app-kit/components/commands/AppCommandProvider";
import { AppCommandShortcutHint } from "@bb/app-kit/components/commands/AppCommandShortcutHint";
import type { MarkdownLinkRouting } from "@bb/app-kit/components/ui/markdown-link-routing";
import { MarkdownPreview } from "@bb/app-kit/components/ui/markdown-preview";
import { ImageLightbox } from "@bb/app-kit/components/ui/image-lightbox";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import { TruncateStart } from "@bb/app-kit/components/ui/truncate-start";
import { copyToClipboardWithToast } from "@bb/app-kit/lib/clipboard";
import { openUrlInExternalBrowser } from "@bb/app-kit/lib/url-open-routing";
import { formatByteSize } from "@bb/app-kit/lib/format-byte-size";
import { asHttpError, getHttpErrorMessage } from "@bb/app-kit/lib/http-error";
import { extractErrorMessage } from "@bb/core-ui";
import {
  isHtmlFilePreview,
  isMarkdownFilePreview,
  type FilePreview as FilePreviewData,
  type FilePreviewLineRange,
  type WorkspaceFilePreviewStatusLabel,
} from "@bb/client-core";
import {
  DEFAULT_CODE_OVERFLOW_MODE,
  type CodeOverflowMode,
} from "@bb/app-kit/lib/code-overflow-mode";
import { cn } from "@bb/shared-ui/lib/utils";

interface FilePreviewFile {
  cacheKey: string;
  name: string;
  contents: string;
  url: string;
}

type RenderedFilePreviewKind = "markdown" | "html";

interface UnsupportedFilePreviewFile {
  mimeType: string;
  name: string;
  isTooLarge: boolean;
  sizeBytes: number | null;
  url: string;
}

export type FilePreviewState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "not-found" }
  | { kind: "error"; message?: string }
  | { kind: "unsupported"; file: UnsupportedFilePreviewFile }
  | { kind: "image"; url: string }
  | {
      kind: "ready";
      file: FilePreviewFile;
      rendered: RenderedFilePreviewKind | null;
    };

interface FilePreviewProps {
  state: FilePreviewState;
  path: string;
  copyPath?: string | null;
  lineRange?: FilePreviewLineRange | null;
  onOpenInEditor?: (path: string) => void;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  markdownLinkRouting?: MarkdownLinkRouting;
  statusLabel?: WorkspaceFilePreviewStatusLabel | null;
}

const FILE_PREVIEW_WRAPPER_STYLE = {
  "--md-content-w": "100cqi",
} as CSSProperties;
const LOADING_INDICATOR_DELAY_MS = 160;
const HEADER_ICON_BUTTON_CLASS =
  "h-5 w-5 rounded-sm p-0 [&_[data-icon-root]]:size-3 max-md:pointer-coarse:h-9 max-md:pointer-coarse:w-9 max-md:pointer-coarse:[&_[data-icon-root]]:size-5";
const VIEW_MODE_BUTTON_CLASS =
  "h-5 rounded-sm px-2 text-muted-foreground max-md:pointer-coarse:h-9";

export function resolveFilePreviewState(
  query: Pick<UseQueryResult<FilePreviewData>, "data" | "error" | "isLoading">,
  path: string,
): FilePreviewState {
  const { data, error } = query;
  if (error) {
    const httpError = asHttpError(error);
    if (httpError?.status === 404) return { kind: "not-found" };
    const message =
      httpError === null
        ? extractErrorMessage(error.message)
        : getHttpErrorMessage(httpError);
    return message === null ? { kind: "error" } : { kind: "error", message };
  }
  if (query.isLoading || !data || data.path !== path) {
    return { kind: "loading" };
  }
  const name = data.name ?? path.split("/").at(-1) ?? path;
  if (data.kind === "image") return { kind: "image", url: data.url };
  if (data.kind !== "text") {
    return {
      kind: "unsupported",
      file: {
        mimeType: data.mimeType,
        name,
        isTooLarge: data.kind === "unsupported" && data.reason === "too-large",
        sizeBytes: data.kind === "unsupported" ? data.sizeBytes : null,
        url: data.url,
      },
    };
  }
  if (data.content.length === 0) return { kind: "empty" };
  return {
    kind: "ready",
    rendered: isHtmlFilePreview(data)
      ? "html"
      : isMarkdownFilePreview(data)
        ? "markdown"
        : null,
    file: {
      cacheKey: [
        "file-preview",
        data.url,
        data.path,
        data.name ?? path,
        data.mimeType,
        hashSourceContents(data.content),
      ].join(":"),
      name: data.name ?? path,
      contents: data.content,
      url: data.url,
    },
  };
}

export function FilePreview({
  state,
  path,
  copyPath = null,
  lineRange = null,
  onOpenInEditor,
  onRefresh,
  isRefreshing = false,
  markdownLinkRouting,
  statusLabel = null,
}: FilePreviewProps) {
  const rendered = state.kind === "ready" ? state.rendered : null;
  const [isRaw, setIsRaw] = useState(false);
  const [loadedFrameKey, setLoadedFrameKey] = useState<string | null>(null);
  const [lineOverflowMode, setLineOverflowMode] = useState<CodeOverflowMode>(
    DEFAULT_CODE_OVERFLOW_MODE,
  );
  useEffect(() => {
    setIsRaw(false);
  }, [lineRange, path, rendered]);
  const showsCode = state.kind === "ready" && (rendered === null || isRaw);
  const htmlFile =
    state.kind === "ready" && rendered === "html" ? state.file : null;
  const showsFrame = htmlFile !== null && !isRaw;
  const highlightedLines = useMemo(
    () =>
      lineRange === null
        ? null
        : { start: lineRange.startLineNumber, end: lineRange.endLineNumber },
    [lineRange],
  );
  useAppCommandHandler(
    "workspace.openPreferred",
    () => {
      onOpenInEditor?.(path);
      return onOpenInEditor !== undefined;
    },
    1,
  );

  return (
    <div
      className={
        showsCode || showsFrame
          ? "@container/page flex h-full min-h-0 flex-col"
          : rendered === "markdown"
            ? "@container/page flex min-h-full flex-col"
            : "@container/page min-h-full"
      }
      style={FILE_PREVIEW_WRAPPER_STYLE}
    >
      <FilePreviewHeader
        isLoading={
          state.kind === "loading" ||
          isRefreshing ||
          (showsFrame && loadedFrameKey !== htmlFile.cacheKey)
        }
        path={path}
        copyPath={copyPath}
        rawContents={state.kind === "ready" ? state.file.contents : null}
        externalUrl={htmlFile?.url ?? null}
        onOpenInEditor={onOpenInEditor}
        onRefresh={onRefresh}
        isRefreshing={isRefreshing}
        statusLabel={statusLabel}
        rendered={rendered}
        showLineOverflowToggle={showsCode}
        lineOverflowMode={lineOverflowMode}
        onLineOverflowModeChange={setLineOverflowMode}
        isRaw={isRaw}
        onRawChange={setIsRaw}
      />
      {state.kind === "loading" ? (
        <SourceLoadingSkeleton />
      ) : state.kind === "empty" ? (
        <FilePreviewMessage message="Empty file." />
      ) : state.kind === "not-found" ? (
        <FilePreviewMessage message="File not found." role="alert" />
      ) : state.kind === "error" ? (
        <FilePreviewMessage
          message={state.message ?? "Failed to load file"}
          role="alert"
        />
      ) : state.kind === "unsupported" ? (
        <UnsupportedFilePreview file={state.file} />
      ) : state.kind === "image" ? (
        <FilePreviewImage url={state.url} alt={path} />
      ) : (
        <>
          {htmlFile === null ? null : (
            <div
              className={cn(
                "min-h-0 flex-1 overflow-hidden",
                isRaw && "hidden",
              )}
            >
              <iframe
                key={htmlFile.cacheKey}
                title={path}
                src={htmlFile.url}
                sandbox="allow-scripts"
                className="size-full border-0"
                onLoad={() => setLoadedFrameKey(htmlFile.cacheKey)}
              />
            </div>
          )}
          {showsCode ? (
            <BbSourceCode
              content={state.file.contents}
              path={path}
              cacheKey={state.file.cacheKey}
              overflow={lineOverflowMode}
              highlightedLines={highlightedLines}
            />
          ) : rendered === "markdown" ? (
            <div className="flex-auto bg-background px-4 py-4">
              <MarkdownPreview
                allowHtml
                content={state.file.contents}
                linkRouting={markdownLinkRouting}
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

interface FilePreviewHeaderProps {
  isLoading: boolean;
  path: string;
  copyPath: string | null;
  rawContents: string | null;
  externalUrl: string | null;
  onOpenInEditor?: (path: string) => void;
  onRefresh?: () => void;
  isRefreshing: boolean;
  statusLabel: WorkspaceFilePreviewStatusLabel | null;
  rendered: RenderedFilePreviewKind | null;
  showLineOverflowToggle: boolean;
  lineOverflowMode: CodeOverflowMode;
  onLineOverflowModeChange: (mode: CodeOverflowMode) => void;
  isRaw: boolean;
  onRawChange: (isRaw: boolean) => void;
}

function FilePreviewHeader({
  isLoading,
  path,
  copyPath,
  rawContents,
  externalUrl,
  onOpenInEditor,
  onRefresh,
  isRefreshing,
  statusLabel,
  rendered,
  showLineOverflowToggle,
  lineOverflowMode,
  onLineOverflowModeChange,
  isRaw,
  onRawChange,
}: FilePreviewHeaderProps) {
  const openShortcut = useAppCommandShortcut("workspace.openPreferred");
  const { ref: headerRef, width } = useElementWidth();
  const isCompactViewport = useIsCompactViewport();
  const isNarrow = width > 0 ? width < 560 : isCompactViewport;
  const copyContentsLabel =
    rendered === "markdown"
      ? "Copy markdown"
      : rendered === "html"
        ? "Copy HTML source"
        : "Copy file contents";
  const externalLabel = "Open in external browser";
  const refreshLabel = isRefreshing ? "Refreshing file" : "Refresh file";
  const openLabel = openShortcut
    ? `Open in editor (${openShortcut.label})`
    : "Open in editor";
  const wrapLabel =
    lineOverflowMode === "wrap" ? "Disable line wrap" : "Wrap lines";
  const copyPathToClipboard = () => {
    void copyToClipboardWithToast(copyPath ?? path, {
      successMessage: "File path copied",
      errorMessage: "Failed to copy file path",
    });
  };
  const viewModeButton = (label: string, raw: boolean) => (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(VIEW_MODE_BUTTON_CLASS, COARSE_POINTER_TEXT_SM_CLASS)}
      onClick={() => onRawChange(raw)}
      aria-pressed={isRaw === raw}
    >
      {label}
    </Button>
  );

  return (
    <div ref={headerRef} className="sticky top-0 z-10 bg-sidebar">
      <TooltipProvider delayDuration={300}>
        <div
          className={cn(
            "flex items-center gap-2 bg-surface-raised",
            isNarrow ? "h-12 px-3" : "h-9 px-4",
          )}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <FilePreviewIcon key={path} loading={isLoading} />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "min-w-0 font-mono font-medium leading-5 text-file-accent",
                    COARSE_POINTER_TEXT_SM_CLASS,
                    "cursor-pointer rounded-sm text-left underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  )}
                  aria-label="Copy file path"
                  onClick={copyPathToClipboard}
                >
                  <TruncateStart>{path}</TruncateStart>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Copy file path</TooltipContent>
            </Tooltip>
            {statusLabel === null ? null : (
              <span
                className={cn(
                  "shrink-0 leading-5 text-muted-foreground",
                  COARSE_POINTER_TEXT_SM_CLASS,
                )}
              >
                ({statusLabel})
              </span>
            )}
            {isNarrow ? null : (
              <>
                {onRefresh ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={cn(
                          HEADER_ICON_BUTTON_CLASS,
                          "shrink-0 text-muted-foreground hover:bg-state-hover hover:text-foreground",
                        )}
                        onClick={onRefresh}
                        disabled={isRefreshing}
                        aria-label={refreshLabel}
                      >
                        <Icon name="RotateCcw" aria-hidden />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {refreshLabel}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                {rawContents === null ? null : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <CopyButton
                        text={rawContents}
                        label={copyContentsLabel}
                        className={cn(
                          HEADER_ICON_BUTTON_CLASS,
                          "shrink-0 rounded-md hover:bg-state-hover hover:text-foreground",
                        )}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {copyContentsLabel}
                    </TooltipContent>
                  </Tooltip>
                )}
                {externalUrl === null ? null : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={cn(
                          HEADER_ICON_BUTTON_CLASS,
                          "shrink-0 text-muted-foreground hover:bg-state-hover hover:text-foreground",
                        )}
                        onClick={() => openUrlInExternalBrowser(externalUrl)}
                        aria-label={externalLabel}
                      >
                        <Icon name="Globe" aria-hidden />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {externalLabel}
                    </TooltipContent>
                  </Tooltip>
                )}
                {onOpenInEditor ? (
                  <>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <OpenInEditorButton
                          onClick={() => onOpenInEditor(path)}
                          className={HEADER_ICON_BUTTON_CLASS}
                          label={openLabel}
                          aria-keyshortcuts={openShortcut?.ariaKeyshortcuts}
                        />
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{openLabel}</TooltipContent>
                    </Tooltip>
                    <AppCommandShortcutHint shortcut={openShortcut} />
                  </>
                ) : null}
              </>
            )}
          </div>
          {showLineOverflowToggle || rendered !== null || isNarrow ? (
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {showLineOverflowToggle && !isNarrow ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={cn(
                        HEADER_ICON_BUTTON_CLASS,
                        "text-muted-foreground",
                      )}
                      aria-label={wrapLabel}
                      aria-pressed={lineOverflowMode === "wrap"}
                      onClick={() =>
                        onLineOverflowModeChange(
                          lineOverflowMode === "wrap" ? "scroll" : "wrap",
                        )
                      }
                    >
                      <Icon name="TextWrap" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{wrapLabel}</TooltipContent>
                </Tooltip>
              ) : null}
              {rendered !== null ? (
                <div
                  className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5"
                  role="tablist"
                  aria-label={
                    rendered === "html"
                      ? "HTML view mode"
                      : "Markdown view mode"
                  }
                >
                  {viewModeButton("Preview", false)}
                  {viewModeButton("Raw", true)}
                </div>
              ) : null}
              {isNarrow ? (
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-10 shrink-0 [&_[data-icon-root]]:size-5"
                      aria-label="File actions"
                    >
                      <Icon name="MoreHorizontal" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    mobileTitle="File actions"
                    className="[&_[role=menuitem]]:min-h-11 [&_[role=menuitem]]:text-sm [&_[role=menuitemcheckbox]]:min-h-11 [&_[role=menuitemcheckbox]]:text-sm"
                  >
                    <DropdownMenuLabel className="max-w-80 break-all font-mono">
                      {path}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={copyPathToClipboard}>
                      <Icon name="Copy" aria-hidden /> Copy file path
                    </DropdownMenuItem>
                    {rawContents !== null ? (
                      <DropdownMenuItem
                        onSelect={() => {
                          void copyToClipboardWithToast(rawContents, {
                            successMessage: "Copied to clipboard",
                            errorMessage: "Failed to copy file contents",
                          });
                        }}
                      >
                        <Icon name="Copy" aria-hidden /> {copyContentsLabel}
                      </DropdownMenuItem>
                    ) : null}
                    {onRefresh ? (
                      <DropdownMenuItem
                        disabled={isRefreshing}
                        onSelect={onRefresh}
                      >
                        <Icon name="RotateCcw" aria-hidden /> {refreshLabel}
                      </DropdownMenuItem>
                    ) : null}
                    {externalUrl !== null ? (
                      <DropdownMenuItem
                        onSelect={() => openUrlInExternalBrowser(externalUrl)}
                      >
                        <Icon name="Globe" aria-hidden /> {externalLabel}
                      </DropdownMenuItem>
                    ) : null}
                    {onOpenInEditor ? (
                      <DropdownMenuItem onSelect={() => onOpenInEditor(path)}>
                        <Icon name="ExternalLink" aria-hidden /> Open in editor
                      </DropdownMenuItem>
                    ) : null}
                    {showLineOverflowToggle ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuCheckboxItem
                          className="gap-2 [&>[data-icon-root]]:size-4 [&>[data-icon-root]]:shrink-0"
                          checked={lineOverflowMode === "wrap"}
                          onCheckedChange={(checked) =>
                            onLineOverflowModeChange(
                              checked ? "wrap" : "scroll",
                            )
                          }
                        >
                          <Icon name="TextWrap" aria-hidden /> Wrap lines
                        </DropdownMenuCheckboxItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          ) : null}
        </div>
      </TooltipProvider>
    </div>
  );
}

function FilePreviewIcon({ loading }: { loading: boolean }) {
  const [showLoading, setShowLoading] = useState(false);
  useEffect(() => {
    if (!loading) {
      setShowLoading(false);
      return;
    }
    const timeout = window.setTimeout(
      () => setShowLoading(true),
      LOADING_INDICATOR_DELAY_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [loading]);
  const spinning = loading && showLoading;
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center text-subtle-foreground @max-[560px]/page:size-5">
      <Icon
        name={spinning ? "Spinner" : "File"}
        className={cn(
          "size-full",
          spinning && "animate-spin motion-reduce:animate-none",
        )}
        aria-hidden
      />
      {spinning ? (
        <span role="status" className="sr-only">
          Loading preview…
        </span>
      ) : null}
    </span>
  );
}

function FilePreviewImage({ url, alt }: { url: string; alt: string }) {
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  return (
    <div className="pt-4">
      <button
        type="button"
        className="block w-full cursor-zoom-in"
        aria-label={`Open ${alt} in full screen preview`}
        onClick={() => setIsLightboxOpen(true)}
      >
        <img src={url} alt={alt} className="mx-auto block h-auto max-w-full" />
      </button>
      <ImageLightbox
        title={alt}
        imageSrc={isLightboxOpen ? url : null}
        imageAlt={alt}
        onClose={() => setIsLightboxOpen(false)}
      />
    </div>
  );
}

function UnsupportedFilePreview({
  file,
}: {
  file: UnsupportedFilePreviewFile;
}) {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-lg bg-surface-raised text-muted-foreground">
        <Icon name="File" className="size-6" aria-hidden />
      </div>
      <div className="flex max-w-full min-w-0 flex-col gap-1">
        <p className="truncate text-sm font-medium text-foreground">
          {file.name}
        </p>
        <p className="text-xs text-muted-foreground">
          {file.sizeBytes === null
            ? file.mimeType
            : `${file.mimeType} · ${formatByteSize(file.sizeBytes)}`}
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        {file.isTooLarge
          ? "This file is too large to preview."
          : "This file type can't be previewed."}
      </p>
      <Button asChild variant="outline" size="sm">
        <a href={file.url} download={file.name}>
          <Icon name="Download" aria-hidden />
          Download
        </a>
      </Button>
    </div>
  );
}

function FilePreviewMessage({
  message,
  role,
}: {
  message: string;
  role?: "alert";
}) {
  return (
    <EmptyStatePanel role={role} className="mx-4 mt-4 rounded-lg">
      {message}
    </EmptyStatePanel>
  );
}
