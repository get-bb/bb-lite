import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
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
  sidePanel,
  threadView,
  useBbNavigate,
  useOp,
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
  label = "Open in sidebar",
  icon = "ExternalLink",
  className = OPEN_ACTION_CLASS,
}: {
  preview: Exclude<Preview, { kind: "not-found" }>;
  open: () => void;
  label?: string;
  icon?: "ExternalLink" | "Maximize2";
  className?: string;
}) {
  const glyph = <Icon name={icon} aria-hidden className="size-3" />;
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

const lastReportedHeightByPage = new Map<string, number>();

const FRAME_OPEN_ACTION_CLASS =
  "flex size-6 cursor-pointer items-center justify-center rounded-md border border-border-raised bg-background/90 text-muted-foreground shadow-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

type HtmlPreview = Extract<Preview, { kind: "html" }>;

function HtmlFrame({
  preview,
  requested,
  fill = false,
  action,
}: {
  preview: HtmlPreview;
  requested: number | null;
  fill?: boolean;
  action: ReactNode;
}) {
  const theme = useFrameTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const latestTheme = useRef(theme);
  latestTheme.current = theme;
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const { content, url } = preview;
  useEffect(() => {
    let live = true;
    void appFontCss().then((fontCss) => {
      if (!live) return;
      const baseHref = new URL(url, window.location.href).href;
      const options = { theme: latestTheme.current, baseHref, fontCss };
      setSrcDoc(frameDocument(content, options));
    });
    return () => {
      live = false;
    };
  }, [content, url]);
  const [loaded, setLoaded] = useState(false);
  const [contentHeight, setContentHeight] = useState<number>();
  const height = frameHeight({
    requested,
    contentHeight,
    remembered: lastReportedHeightByPage.get(preview.sha256),
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
        if (!fill) lastReportedHeightByPage.set(preview.sha256, reported);
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
  }, [preview.sha256, fill]);

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
          title={`inline-vis: ${preview.file}`}
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
      preview={preview}
      requested={null}
      fill
      action={
        <OpenAction
          preview={preview}
          label="Open the file"
          open={() => navigate.openFile({ threadId, path, source })}
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
  const height = requested ?? FRAME_HEIGHT_BEFORE_FIRST_REPORT;
  const preview = query.data;
  if (preview === undefined) {
    if (query.error !== null) {
      return (
        <Notice source={source} error>
          Failed to load {file}: {query.error.message}
        </Notice>
      );
    }
    const loading = {
      role: "status",
      "aria-busy": true,
      "aria-label": `Loading visualization ${file}`,
      style: { height },
    } as const;
    if (isHtmlFile(file)) return <div {...loading} className="my-2" />;
    return (
      <PreviewCard
        file={file}
        action={<span aria-hidden className="h-6 w-7 shrink-0" />}
      >
        <div {...loading} className="w-full p-3">
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
        preview={preview}
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
    <PreviewCard
      file={preview.file}
      action={<OpenAction preview={preview} open={open} />}
    >
      <div style={{ height }} className="overflow-auto p-3">
        <Markdown content={preview.content} allowHtml document={document} />
      </div>
    </PreviewCard>
  );
}

export default function inlineVisApp(bb: PluginAppApi): void {
  bb.add(threadView.messageDirective, {
    id: "inline-vis",
    view: InlineVisDirective,
  });
  bb.add(sidePanel.panel, {
    id: PANEL_ID,
    title: "Preview",
    icon: "AppWindow",
    layout: "flush",
    view: PreviewPanel,
  });
}
