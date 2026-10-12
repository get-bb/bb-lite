import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { cn } from "@bb/shared-ui/lib/utils";
import { Skeleton } from "@bb/shared-ui/skeleton";
import {
  Icon,
  Markdown,
  sidePanel,
  threadView,
  useBbNavigate,
  useOp,
  type CodeFenceProps,
  type MessageDirectiveProps,
  type PluginAppApi,
  type SidePanelPanelProps,
} from "@bb/plugin/app";
import { inlineVis, type Preview } from "./contract";
import {
  FRAME_HEIGHT_BEFORE_FIRST_REPORT,
  FRAME_MAX_HEIGHT,
  FRAME_MIN_HEIGHT,
  frameDocument,
  frameHeight,
  frameResult,
  frameThemeMessage,
  readFrameContentHeight,
  readFrameLinkRequest,
} from "./frame";
import { appFontCss, useFrameTheme } from "./theme";

const MIN_HEIGHT_PX = FRAME_MIN_HEIGHT;
const MAX_HEIGHT_PX = FRAME_MAX_HEIGHT;
const PANEL_ID = "preview";
const MAX_REMEMBERED_FRAME_HEIGHTS = 200;
const MAX_REMEMBERED_EXPANDED_DOCUMENTS = 200;
const DOCUMENT_PREVIEW_HEIGHT_PX = 256;
const DOCUMENT_PREVIEW_SLACK_PX = 64;
const DOCUMENT_COPIED_MS = 1_500;

function rememberBounded<Value>(
  cache: Map<string, Value>,
  key: string,
  value: Value,
  limit: number,
): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function requestedHeight(value: string | undefined): number | null | "invalid" {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0) return null;
  if (!/^\d+$/.test(normalized)) return "invalid";
  const height = Number(normalized);
  return height >= MIN_HEIGHT_PX && height <= MAX_HEIGHT_PX
    ? height
    : "invalid";
}

const isHtmlFile = (file: string) => /\.html?$/i.test(file);

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

const DOCUMENT_ACTION_CLASS =
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function splitDocumentPath(file: string): { name: string; folder: string } {
  const separator = file.lastIndexOf("/");
  return separator === -1
    ? { name: file, folder: "" }
    : { name: file.slice(separator + 1), folder: file.slice(0, separator) };
}

function DocumentCard({
  file,
  actions,
  footer,
  children,
}: {
  file: string;
  actions: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const { name, folder } = splitDocumentPath(file);
  return (
    <section
      aria-label={file}
      className="my-2 min-w-0 overflow-hidden rounded-lg border border-border bg-background"
    >
      <header className="flex items-center gap-2 border-b border-border py-1.5 pl-3 pr-1.5">
        <Icon
          name="FileText"
          aria-hidden
          className="size-3.5 shrink-0 text-subtle-foreground"
        />
        <div className="flex min-w-0 flex-1 items-baseline gap-2 text-xs">
          <span className="truncate font-medium text-foreground">{name}</span>
          {folder.length === 0 ? null : (
            <span className="truncate text-subtle-foreground">{folder}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
      </header>
      {children}
      {footer}
    </section>
  );
}

function CopyDocumentAction({
  file,
  content,
}: {
  file: string;
  content: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), DOCUMENT_COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      aria-label={`Copy ${file}`}
      title={copied ? "Copied" : "Copy Markdown"}
      className={DOCUMENT_ACTION_CLASS}
      onClick={() => {
        void navigator.clipboard.writeText(content).then(
          () => setCopied(true),
          () => undefined,
        );
      }}
    >
      <Icon name={copied ? "Check" : "Copy"} aria-hidden className="size-3.5" />
    </button>
  );
}

const expandedDocuments = new Map<string, true>();

function MarkdownDocument({
  file,
  content,
  previewHeight,
  rememberKey,
  actions,
  children,
}: {
  file: string;
  content: string;
  previewHeight: number;
  rememberKey: string;
  actions: ReactNode;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(() =>
    expandedDocuments.has(rememberKey),
  );
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setContentHeight(element.getBoundingClientRect().height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const collapsible =
    contentHeight !== null &&
    contentHeight > previewHeight + DOCUMENT_PREVIEW_SLACK_PX;
  const clamped = contentHeight === null || (collapsible && !expanded);
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) {
      rememberBounded(
        expandedDocuments,
        rememberKey,
        true,
        MAX_REMEMBERED_EXPANDED_DOCUMENTS,
      );
    } else {
      expandedDocuments.delete(rememberKey);
    }
  };

  return (
    <DocumentCard
      file={file}
      actions={
        <>
          <CopyDocumentAction file={file} content={content} />
          {actions}
        </>
      }
      footer={
        collapsible ? (
          <button
            type="button"
            aria-expanded={expanded}
            className="flex w-full cursor-pointer items-center justify-center gap-1 border-t border-border py-1.5 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={toggle}
          >
            {expanded ? "Show less" : "Show more"}
            <Icon
              name="ChevronDown"
              aria-hidden
              className={cn(
                "size-3.5 transition-transform duration-200",
                expanded && "rotate-180",
              )}
            />
          </button>
        ) : undefined
      }
    >
      <div
        data-inline-vis-document=""
        className="relative overflow-hidden"
        style={clamped ? { maxHeight: previewHeight } : undefined}
      >
        <div ref={contentRef} className="px-4 py-3">
          {children}
        </div>
        {collapsible && !expanded ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background to-transparent"
          />
        ) : null}
      </div>
    </DocumentCard>
  );
}

const isModifiedClick = (event: MouseEvent<HTMLAnchorElement>) =>
  event.button !== 0 ||
  event.altKey ||
  event.ctrlKey ||
  event.metaKey ||
  event.shiftKey;

function OpenAction({
  preview,
  open,
  label = "Open in sidebar",
  icon,
  className,
}: {
  preview: Exclude<Preview, { kind: "not-found" }>;
  open: () => void;
  label?: string;
  icon: "ExternalLink" | "Maximize2" | "PanelRight";
  className: string;
}) {
  const glyph = (
    <Icon
      name={icon}
      aria-hidden
      className={preview.kind === "html" ? "size-3" : "size-3.5"}
    />
  );
  const sidebar = `${label}: ${preview.file}`;
  if (preview.kind === "html") {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    return (
      <a
        href={preview.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={sidebar}
        title={`${label}\n${mac ? "⌘-click" : "Ctrl-click"} to open in the browser`}
        className={className}
        onClick={(event) => {
          if (event.defaultPrevented || isModifiedClick(event)) return;
          event.preventDefault();
          open();
        }}
      >
        {glyph}
      </a>
    );
  }
  return (
    <button
      type="button"
      aria-label={sidebar}
      title={label}
      className={className}
      onClick={open}
    >
      {glyph}
    </button>
  );
}

const rememberedFrameHeights = new Map<string, number>();

const FRAME_OPEN_ACTION_CLASS =
  "flex size-6 cursor-pointer items-center justify-center rounded-md border border-border-raised bg-background/90 text-muted-foreground shadow-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function HtmlFrame({
  title,
  content,
  baseHref,
  heightKey,
  requested,
  fill = false,
  action,
}: {
  title: string;
  content: string;
  baseHref: string;
  heightKey: string;
  requested: number | null;
  fill?: boolean;
  action: ReactNode;
}) {
  const theme = useFrameTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const latestTheme = useRef(theme);
  latestTheme.current = theme;
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void appFontCss().then((fontCss) => {
      if (!live) return;
      const options = { theme: latestTheme.current, baseHref, fontCss };
      setSrcDoc(frameDocument(content, options));
    });
    return () => {
      live = false;
    };
  }, [content, baseHref]);
  const [loaded, setLoaded] = useState(false);
  const [contentHeight, setContentHeight] = useState<number>();
  const height = frameHeight({
    requested,
    contentHeight,
    remembered: rememberedFrameHeights.get(heightKey),
  });

  const postTheme = () => {
    const message = frameThemeMessage(theme);
    frameRef.current?.contentWindow?.postMessage(message, "*");
  };
  useEffect(postTheme, [theme]);

  useLayoutEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (frame === null || event.source !== frame.contentWindow) return;
      const reported = readFrameContentHeight(event.data);
      if (reported !== undefined) {
        if (!fill) {
          rememberBounded(
            rememberedFrameHeights,
            heightKey,
            reported,
            MAX_REMEMBERED_FRAME_HEIGHTS,
          );
        }
        setContentHeight(reported);
        return;
      }
      const link = readFrameLinkRequest(event.data);
      if (
        link === undefined ||
        document.activeElement !== frame ||
        navigator.userActivation?.isActive === false
      ) {
        return;
      }
      window.open(link.url, "_blank", "noopener,noreferrer");
      frame.contentWindow?.postMessage(frameResult(link.id), "*");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [heightKey, fill]);

  return (
    <div
      data-inline-vis-frame=""
      className={cn(
        "group/inline-vis relative",
        fill ? "size-full bg-background p-4" : "my-2",
      )}
      style={fill ? undefined : { height }}
    >
      {srcDoc === null ? null : (
        <iframe
          ref={frameRef}
          title={title}
          srcDoc={srcDoc}
          sandbox="allow-scripts allow-forms"
          onLoad={() => {
            setLoaded(true);
            postTheme();
          }}
          className="block size-full border-0"
          style={{ colorScheme: loaded ? theme.appearance : "light" }}
        />
      )}
      <div
        className={cn(
          "absolute opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/inline-vis:opacity-100 pointer-coarse:opacity-100",
          fill ? "right-6 top-6" : "right-2 top-2",
        )}
      >
        {action}
      </div>
    </div>
  );
}

function frameOf(preview: Extract<Preview, { kind: "html" }>) {
  return {
    title: `inline-vis: ${preview.file}`,
    content: preview.content,
    baseHref: new URL(preview.url, window.location.href).href,
    heightKey: preview.sha256,
  };
}

interface PanelTarget {
  file: string;
  source?: string;
}

function panelTarget(
  params: SidePanelPanelProps["params"],
): PanelTarget | null {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return null;
  }
  const { file, source } = params;
  if (typeof file !== "string" || file.length === 0) return null;
  return typeof source === "string" ? { file, source } : { file };
}

function PreviewPanel({ threadId, params }: SidePanelPanelProps) {
  const navigate = useBbNavigate();
  const target = panelTarget(params);
  const query = useOp(
    inlineVis.preview,
    { threadId, file: target?.file ?? "", source: target?.source },
    { enabled: target !== null },
  );
  const preview = query.data;
  if (target === null || preview?.kind === "not-found") {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {target === null
          ? "Open a preview from a message to see it here."
          : `Preview file not found: ${target.file}`}
      </p>
    );
  }
  if (preview === undefined) {
    return query.error === null ? null : (
      <p role="alert" className="p-4 text-sm text-destructive-text">
        Failed to load {target.file}: {query.error.message}
      </p>
    );
  }
  if (preview.kind !== "html") return null;
  const { file: path, source } = preview;
  return (
    <HtmlFrame
      key={preview.sha256}
      {...frameOf(preview)}
      requested={null}
      fill
      action={
        <OpenAction
          preview={preview}
          label="Open the file"
          open={() => navigate.openFile({ threadId, path, source })}
          icon="ExternalLink"
          className={FRAME_OPEN_ACTION_CLASS}
        />
      }
    />
  );
}

function InlineVisDirective({
  attributes,
  source,
  message,
}: MessageDirectiveProps) {
  const navigate = useBbNavigate();
  const file = attributes.file?.trim() ?? "";
  const requested = requestedHeight(attributes.height);
  const query = useOp(
    inlineVis.preview,
    {
      threadId: message.threadId,
      file,
      ...(attributes.source === undefined ? {} : { source: attributes.source }),
    },
    { enabled: file.length > 0 && requested !== "invalid" },
  );

  if (requested === "invalid") {
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
    if (isHtmlFile(file)) {
      return (
        <div
          role="status"
          aria-busy="true"
          aria-label={`Loading visualization ${file}`}
          style={{ height: requested ?? FRAME_HEIGHT_BEFORE_FIRST_REPORT }}
          className="my-2"
        />
      );
    }
    return (
      <DocumentCard
        file={file}
        actions={<span aria-hidden className="size-6 shrink-0" />}
      >
        <div
          role="status"
          aria-busy="true"
          aria-label={`Loading document ${file}`}
          className="flex flex-col gap-2.5 px-4 py-4"
        >
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-3/5" />
        </div>
      </DocumentCard>
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
  if (preview.kind === "html") {
    const { file: path, source: from } = preview;
    const openPanel = () => {
      const title = path.split("/").pop() ?? path;
      const params = { file: path, source: from };
      if (!navigate.openThreadPanel({ actionId: PANEL_ID, title, params })) {
        open();
      }
    };
    return (
      <HtmlFrame
        key={preview.sha256}
        {...frameOf(preview)}
        requested={requested}
        action={
          <OpenAction
            preview={preview}
            open={openPanel}
            icon="Maximize2"
            className={FRAME_OPEN_ACTION_CLASS}
          />
        }
      />
    );
  }
  return (
    <MarkdownDocument
      file={preview.file}
      content={preview.content}
      previewHeight={requested ?? DOCUMENT_PREVIEW_HEIGHT_PX}
      rememberKey={JSON.stringify([
        message.threadId,
        message.id,
        preview.source,
        preview.file,
      ])}
      actions={
        <OpenAction
          preview={preview}
          open={open}
          icon="PanelRight"
          className={DOCUMENT_ACTION_CLASS}
        />
      }
    >
      <Markdown content={preview.content} allowHtml document={document} />
    </MarkdownDocument>
  );
}

function InlineVisFence({
  code,
  status,
  index,
  message,
  Original,
}: CodeFenceProps) {
  const [sourceShown, setSourceShown] = useState(false);

  if (status === "streaming") {
    return (
      <div role="status" className="my-2 text-xs text-muted-foreground">
        Writing visualization…
      </div>
    );
  }
  if (status === "unclosed" || code.trim().length === 0) {
    return <Original />;
  }

  const sourceLabel = sourceShown ? "Hide source" : "Show source";
  return (
    <>
      <HtmlFrame
        title="inline-vis"
        content={code}
        baseHref={new URL("/", window.location.href).href}
        heightKey={`fence:${message.id}:${index}`}
        requested={null}
        action={
          <button
            type="button"
            aria-pressed={sourceShown}
            aria-label={sourceLabel}
            title={sourceLabel}
            className={FRAME_OPEN_ACTION_CLASS}
            onClick={() => setSourceShown(!sourceShown)}
          >
            <Icon name="Code" aria-hidden className="size-3" />
          </button>
        }
      />
      {sourceShown ? <Original /> : null}
    </>
  );
}

export default function inlineVisApp(bb: PluginAppApi): void {
  bb.add(threadView.messageDirective, {
    id: "inline-vis",
    view: InlineVisDirective,
  });
  bb.add(threadView.codeFence, {
    id: "inline-vis",
    languages: ["inline-vis"],
    view: InlineVisFence,
  });
  bb.add(sidePanel.panel, {
    id: PANEL_ID,
    title: "Preview",
    icon: "AppWindow",
    layout: "flush",
    view: PreviewPanel,
  });
}
