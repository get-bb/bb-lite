import { useState, type MouseEvent, type ReactNode } from "react";
import {
  CONTEXT_CARD_CHEVRON_CLASS,
  CONTEXT_CARD_CLASS,
  CONTEXT_CARD_INSET_CLASS,
  CONTEXT_CARD_SEGMENT_CLASS,
} from "@bb/shared-ui/chrome-style-tokens";
import { cn } from "@bb/shared-ui/lib/utils";
import { Skeleton } from "@bb/shared-ui/skeleton";
import {
  Icon,
  Markdown,
  threadView,
  useBbNavigate,
  useOp,
  type MessageDirectiveProps,
  type PluginAppApi,
} from "@bb/plugin/app";
import { inlineVis, type Preview } from "./contract";

const DEFAULT_HEIGHT_PX = 224;
const MIN_HEIGHT_PX = 120;
const MAX_HEIGHT_PX = 1_200;
const COLLAPSED_STORAGE_KEY = "bb.inline-vis.collapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    return;
  }
}

function previewHeight(value: string | undefined): number | null {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0) return DEFAULT_HEIGHT_PX;
  if (!/^\d+$/.test(normalized)) return null;
  const height = Number(normalized);
  return height >= MIN_HEIGHT_PX && height <= MAX_HEIGHT_PX ? height : null;
}

function Notice({
  source,
  error = false,
  children,
}: {
  source: string;
  error?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      role="alert"
      title={source}
      className={cn(
        "my-2 rounded-md border px-3 py-2 text-sm",
        error
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-border bg-muted text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

function PreviewCard({
  file,
  action,
  children,
}: {
  file: string;
  action: ReactNode;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () => {
    setCollapsed(!collapsed);
    writeCollapsed(!collapsed);
  };
  return (
    <div className={cn("my-2 overflow-hidden", CONTEXT_CARD_CLASS)}>
      <div
        className={cn(
          "flex items-stretch text-xs text-muted-foreground",
          !collapsed && "border-b border-border",
        )}
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} visualization ${file}`}
          title={collapsed ? "Expand preview here" : "Collapse preview"}
          className={cn(
            "flex cursor-pointer items-center text-xs",
            CONTEXT_CARD_SEGMENT_CLASS,
            "min-w-0 flex-1 gap-1.5 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
            collapsed ? "text-muted-foreground" : "text-foreground",
          )}
          onClick={toggle}
        >
          <span className="shrink-0">inline-vis</span>
          <span className="truncate">{file}</span>
          <Icon
            name="ChevronDown"
            aria-hidden
            className={cn(
              CONTEXT_CARD_CHEVRON_CLASS,
              !collapsed && "rotate-180",
            )}
          />
        </button>
        <div
          className={cn("flex shrink-0 items-center", CONTEXT_CARD_INSET_CLASS)}
        >
          {action}
        </div>
      </div>
      {collapsed ? null : children}
    </div>
  );
}

const OPEN_ACTION_CLASS = cn(
  "flex cursor-pointer items-center text-xs",
  CONTEXT_CARD_SEGMENT_CLASS,
  "shrink-0 justify-center text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
);

const isModifiedClick = (event: MouseEvent<HTMLAnchorElement>) =>
  event.button !== 0 ||
  event.altKey ||
  event.ctrlKey ||
  event.metaKey ||
  event.shiftKey;

function OpenAction({
  preview,
  open,
}: {
  preview: Exclude<Preview, { kind: "not-found" }>;
  open: (() => void) | null;
}) {
  const icon = <Icon name="ExternalLink" aria-hidden className="size-3" />;
  const sidebar = `Open ${preview.file} in sidebar`;
  if (preview.kind === "html") {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    return (
      <a
        href={preview.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={open === null ? `Open ${preview.file}` : sidebar}
        title={
          open === null
            ? "Open in the browser"
            : `Open in sidebar\n${mac ? "⌘-click" : "Ctrl-click"} to open in the browser`
        }
        className={OPEN_ACTION_CLASS}
        onClick={(event) => {
          if (open === null || event.defaultPrevented) return;
          if (isModifiedClick(event)) return;
          event.preventDefault();
          open();
        }}
      >
        {icon}
      </a>
    );
  }
  if (open === null) return <span aria-hidden className="h-6 w-7 shrink-0" />;
  return (
    <button
      type="button"
      aria-label={sidebar}
      title="Open in sidebar"
      className={OPEN_ACTION_CLASS}
      onClick={open}
    >
      {icon}
    </button>
  );
}

function InlineVisDirective({
  attributes,
  source,
  message,
}: MessageDirectiveProps) {
  const navigate = useBbNavigate();
  const file = attributes.file?.trim() ?? "";
  const height = previewHeight(attributes.height);
  const query = useOp(
    inlineVis.preview,
    {
      threadId: message.threadId,
      file,
      ...(attributes.source === undefined ? {} : { source: attributes.source }),
    },
    { enabled: file.length > 0 && height !== null },
  );

  if (height === null) {
    return (
      <Notice source={source}>
        inline-vis height must be a whole number from {MIN_HEIGHT_PX} to{" "}
        {MAX_HEIGHT_PX} pixels.
      </Notice>
    );
  }
  if (file.length === 0) {
    return (
      <Notice source={source}>
        inline-vis requires a file attribute, e.g.{" "}
        <code>::inline-vis{'{file="demo.html"}'}</code>
      </Notice>
    );
  }
  const preview = query.data;
  if (preview === undefined) {
    if (query.error !== null) {
      return (
        <Notice source={source} error>
          Failed to load {file}: {query.error.message}
        </Notice>
      );
    }
    return (
      <PreviewCard
        file={file}
        action={<span aria-hidden className="h-6 w-7 shrink-0" />}
      >
        <div
          role="status"
          aria-busy="true"
          aria-label={`Loading visualization ${file}`}
          style={{ height }}
          className="w-full p-3"
        >
          <Skeleton className="size-full" />
        </div>
      </PreviewCard>
    );
  }
  if (preview.kind === "not-found") {
    return (
      <Notice source={source} error>
        Failed to load {preview.file}: Preview file not found: {preview.file}
      </Notice>
    );
  }
  const document = {
    threadId: message.threadId,
    path: preview.file,
    source: preview.source,
  };
  const open = () => {
    navigate.openFile(document);
  };
  return (
    <PreviewCard
      file={preview.file}
      action={<OpenAction preview={preview} open={open} />}
    >
      {preview.kind === "markdown" ? (
        <div style={{ height }} className="overflow-auto p-3">
          <Markdown content={preview.content} allowHtml document={document} />
        </div>
      ) : (
        <iframe
          title={`inline-vis: ${preview.file}`}
          src={preview.url}
          sandbox="allow-scripts"
          style={{ height }}
          className="block w-full border-0 bg-background"
        />
      )}
    </PreviewCard>
  );
}

export default function inlineVisApp(bb: PluginAppApi): void {
  bb.add(threadView.messageDirective, {
    id: "inline-vis",
    view: InlineVisDirective,
  });
}
