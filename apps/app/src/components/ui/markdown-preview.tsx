import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  memo,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type ExtraProps,
  type Options as ReactMarkdownOptions,
  type UrlTransform,
} from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@bb/shared-ui/context-menu";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { usePreferredTheme } from "@/hooks/useTheme";
import {
  rewriteLocalhostLinkHref,
  useRewriteLocalhostLinksPreference,
} from "@/lib/localhost-link-rewrite-preference";
import { resolveRouteHref } from "@/lib/route-paths";
import { RawThreadMentionBatchProvider } from "@/components/thread/ThreadTitleMentions.js";
import { RouteAnchor } from "./app-route-anchor.js";
import { CopyButton } from "./copy-button.js";
import { ImageLightbox, getWrappedImageIndex } from "./image-lightbox.js";
import { InlineImageGalleryContext } from "./inline-image-gallery-context.js";
import { highlightMarkdownCode } from "./markdown-code-highlight.js";
import "./markdown-code-highlight.css";
import {
  createMarkdownPieceCache,
  resolveMarkdownPieces,
  type MarkdownPieceRenderConfig,
} from "./markdown-incremental-pieces.js";
import {
  MarkdownLocalFileContextMenuContext,
  type MarkdownLinkRouting,
  type MarkdownLocalFileContextMenuItem,
} from "./markdown-link-routing.js";
import {
  buildLocalFileAnchorHref,
  parseLocalFileHref,
  resolveRelativeLocalFileHref,
  type MarkdownAbsoluteLocalFileLinkRouting,
  type MarkdownPreviewLocalFileLink,
  type MarkdownRelativeLocalFileLinkRouting,
} from "./markdown-local-file-link.js";
import {
  MESSAGE_DIRECTIVE_MOUNT_LIMIT,
  MessageDirectiveElement,
  MessageDirectiveMountsContext,
  remarkMessageDirectives,
  type MarkdownMessageDirectives,
  type MountedMessageDirective,
} from "./markdown-message-directives.js";
import { normalizePromptBlockquoteBoundaries } from "./markdown-prompt-blockquote-boundaries.js";
import {
  buildPromptMentionComponent,
  remarkPromptMentions,
  substitutePromptMentions,
  type MarkdownPromptMentions,
} from "./markdown-prompt-mentions.js";
import {
  MarkdownThreadMentionsContext,
  remarkThreadMentions,
  ThreadMentionElement,
  type MarkdownThreadMentions,
} from "./markdown-thread-mentions.js";

type MarkdownImagePolicy = "alt-text" | "render";

interface MarkdownPreviewProps {
  allowHtml?: boolean;
  className?: string;
  content: string;
  sourcePrefix?: string;
  imagePolicy?: MarkdownImagePolicy;
  incrementalBlocks?: boolean;
  linkRouting?: MarkdownLinkRouting;
  threadMentions?: MarkdownThreadMentions;
  promptMentions?: MarkdownPromptMentions;
  messageDirectives?: MarkdownMessageDirectives;
}

interface ExpandedMarkdownImage {
  imageSources: readonly string[];
  index: number;
  url: string;
}

interface MarkdownRenderContextValue {
  imagePolicy: MarkdownImagePolicy;
  imageSourceOffset: number;
  linkRouting: MarkdownLinkRouting | undefined;
  setExpandedImage: (image: ExpandedMarkdownImage | null) => void;
}

type MarkdownPlugins = NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
type ElementProps<Tag extends keyof JSX.IntrinsicElements> =
  ComponentPropsWithoutRef<Tag> & ExtraProps;

const MarkdownRenderContext = createContext<MarkdownRenderContextValue>({
  imagePolicy: "render",
  imageSourceOffset: 0,
  linkRouting: undefined,
  setExpandedImage: () => {},
});

const TABLE_BREAKOUT_LIMIT_VARIABLE = "--md-table-breakout-max";
const TABLE_BREAKOUT_WIDTH = `max(100%, min(1100px, 100cqw - 2rem, var(${TABLE_BREAKOUT_LIMIT_VARIABLE}, 100cqw)))`;
const CONTENT_WIDTH_VARIABLE = "--md-content-w";
const SOURCE_COLOR_SCHEME_MEDIA_PATTERN =
  /^\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)$/iu;
const CLIPPING_OVERFLOW_VALUES = new Set(["hidden", "clip", "auto", "scroll"]);
const FRONTMATTER_PATTERN =
  /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const HTML_REHYPE_PLUGINS: NonNullable<ReactMarkdownOptions["rehypePlugins"]> =
  [
    rehypeRaw,
    [
      rehypeSanitize,
      {
        ...defaultSchema,
        tagNames: [
          ...(defaultSchema.tagNames ?? []),
          "video",
          "bb-thread-mention",
          "bb-prompt-mention",
          "bb-message-directive",
        ],
        protocols: { ...defaultSchema.protocols, poster: ["http", "https"] },
        attributes: {
          ...defaultSchema.attributes,
          source: [
            ...(defaultSchema.attributes?.source ?? []),
            "src",
            "type",
            "media",
          ],
          video: [
            "src",
            "controls",
            "playsInline",
            "preload",
            "poster",
            "width",
            "height",
            "title",
            "ariaLabel",
          ],
          "bb-thread-mention": [
            "dataThreadId",
            "dataRawThreadId",
            "dataRawThreadInlineCode",
          ],
          "bb-prompt-mention": ["dataMentionIndex"],
          "bb-message-directive": ["dataDirectiveIndex"],
        },
      },
    ],
  ];

function resolveLocalFileTarget(
  value: string,
  absolute: MarkdownAbsoluteLocalFileLinkRouting,
  relative: MarkdownRelativeLocalFileLinkRouting | undefined,
): {
  href: string;
  link: MarkdownPreviewLocalFileLink;
  sourceKind: "absolute" | "relative";
} | null {
  const absoluteLink = parseLocalFileHref({
    absoluteLinks: absolute,
    href: value,
  });
  if (absoluteLink !== null) {
    return { href: value, link: absoluteLink, sourceKind: "absolute" };
  }
  const href =
    relative === undefined
      ? null
      : resolveRelativeLocalFileHref({ href: value, ...relative });
  const link =
    href === null
      ? null
      : parseLocalFileHref({ absoluteLinks: absolute, href });
  return href === null || link === null
    ? null
    : { href, link, sourceKind: "relative" };
}

function buildLocalAwareUrlTransform({
  localFile,
  localImage,
}: MarkdownLinkRouting): UrlTransform {
  return (value, key, node) => {
    if (key === "href" && localFile !== undefined) {
      const target = resolveLocalFileTarget(
        value,
        localFile.absoluteLinks,
        localFile.relativeLinks,
      );
      if (target !== null) {
        return target.href;
      }
    }
    if (
      (key === "src" || (key === "poster" && node.tagName === "video")) &&
      localImage !== undefined
    ) {
      const target = resolveLocalFileTarget(
        value,
        localImage.absolutePaths,
        localImage.relativePaths,
      );
      if (target !== null) {
        return localImage.resolveSrc(target.link, target.sourceKind);
      }
    }
    return defaultUrlTransform(value);
  };
}

const markdownLinkGraphemes = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function appendMarkdownLinkIcon(children: ReactNode): ReactNode {
  const icon = (
    <Icon
      name="ExternalLink"
      aria-hidden
      className="ml-1 inline size-3 align-[-0.125em] text-subtle-foreground"
    />
  );
  let appended = false;
  const append = (node: ReactNode): ReactNode => {
    if (typeof node === "string" || typeof node === "number") {
      const text = String(node);
      const last = markdownLinkGraphemes
        .segment(text)
        .containing(text.trimEnd().length - 1);
      if (!last) return node;
      appended = true;
      return (
        <>
          {text.slice(0, last.index)}
          <span className="whitespace-nowrap">
            {text.slice(last.index)}
            {icon}
          </span>
        </>
      );
    }
    if (isValidElement<{ children?: ReactNode }>(node)) {
      const content = append(node.props.children);
      return appended ? cloneElement(node, undefined, content) : node;
    }
    const nodes: ReactNode[] = Children.toArray(node);
    for (let index = nodes.length - 1; index >= 0 && !appended; index--) {
      nodes[index] = append(nodes[index]);
    }
    return nodes;
  };
  const content = append(children);
  return appended ? (
    content
  ) : (
    <span className="whitespace-nowrap">
      {children}
      {icon}
    </span>
  );
}

function renderLocalFileContextMenuItem(
  item: MarkdownLocalFileContextMenuItem,
) {
  if (item.type === "separator") {
    return <ContextMenuSeparator key={item.id} />;
  }
  if (item.type === "submenu") {
    return (
      <ContextMenuSub key={item.id}>
        <ContextMenuSubTrigger>{item.label}</ContextMenuSubTrigger>
        <ContextMenuSubContent className="min-w-44">
          {item.items.map(renderLocalFileContextMenuItem)}
        </ContextMenuSubContent>
      </ContextMenuSub>
    );
  }
  return (
    <ContextMenuItem key={item.id} onSelect={item.onSelect}>
      {item.label}
    </ContextMenuItem>
  );
}

function MarkdownAnchor({
  children,
  href,
  node: _node,
  ...anchorProps
}: ElementProps<"a">) {
  const { linkRouting } = useContext(MarkdownRenderContext);
  const [rewriteLocalhostLinks] = useRewriteLocalhostLinksPreference();
  const getContextMenuItems = useContext(MarkdownLocalFileContextMenuContext);
  const localFileRouting = linkRouting?.localFile;
  const rewrittenHref = rewriteLocalhostLinkHref({
    currentHostname: window.location.hostname,
    enabled: rewriteLocalhostLinks,
    href,
  });
  const isAppRouteHref =
    !!rewrittenHref &&
    resolveRouteHref({
      currentOrigin: window.location.origin,
      href: rewrittenHref,
    }) !== null;
  const localFileLink =
    !isAppRouteHref && localFileRouting
      ? parseLocalFileHref({
          absoluteLinks: localFileRouting.absoluteLinks,
          href: rewrittenHref,
        })
      : null;
  const contextMenuItems =
    localFileLink !== null && getContextMenuItems !== null
      ? getContextMenuItems(localFileLink)
      : null;
  const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (localFileLink && localFileRouting) {
      if (localFileRouting.onOpenLink(localFileLink)) {
        event.preventDefault();
      }
      return;
    }
    if (
      !isAppRouteHref &&
      rewrittenHref &&
      linkRouting?.onOpenLink?.({ href: rewrittenHref })
    ) {
      event.preventDefault();
    }
  };
  const anchor = (
    <RouteAnchor
      {...anchorProps}
      href={buildLocalFileAnchorHref(localFileLink, rewrittenHref)}
      className="break-words [overflow-wrap:anywhere] underline underline-offset-2"
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
    >
      {localFileLink ? appendMarkdownLinkIcon(children) : children}
    </RouteAnchor>
  );
  if (contextMenuItems === null || contextMenuItems.length === 0) {
    return anchor;
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{anchor}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        {contextMenuItems.map(renderLocalFileContextMenuItem)}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function MarkdownCode({
  className,
  children,
  node: _node,
  ...props
}: ElementProps<"code">) {
  const { linkRouting } = useContext(MarkdownRenderContext);
  const codeText =
    typeof children === "string" ? children.replace(/\n$/, "") : "";
  const language =
    /(?:^|\s)language-(\S+)/u.exec(className ?? "")?.[1]?.toLowerCase() ?? null;
  const isBlock = language !== null || codeText.includes("\n");
  const [softWrap, setSoftWrap] = useState(false);
  const highlightedMarkup = useMemo(
    () =>
      isBlock ? { __html: highlightMarkdownCode(codeText, language) } : null,
    [isBlock, language, codeText],
  );
  if (highlightedMarkup !== null) {
    return (
      <div className="my-2 overflow-hidden rounded-md border border-border bg-surface-recessed">
        <div className="flex items-center justify-between pl-3 pr-1.5 pt-1.5">
          <span className="font-mono text-xs uppercase text-muted-foreground">
            {language ?? ""}
          </span>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              aria-pressed={softWrap}
              aria-label={softWrap ? "Disable line wrap" : "Wrap long lines"}
              onClick={() => {
                setSoftWrap((value) => !value);
              }}
              className="inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground aria-pressed:text-foreground"
            >
              <Icon name="TextWrap" className="size-3" />
            </button>
            <CopyButton text={codeText} label="Copy code" />
          </div>
        </div>
        <pre
          className={cn(
            "bb-code-highlight px-3 pb-3 pt-1",
            softWrap
              ? "whitespace-pre-wrap [overflow-wrap:anywhere]"
              : "overflow-x-auto",
          )}
        >
          <code
            className={cn(
              "font-mono text-xs",
              language ? `language-${language}` : "",
            )}
            dangerouslySetInnerHTML={highlightedMarkup}
            {...props}
          />
        </pre>
      </div>
    );
  }

  const localFile = linkRouting?.localFile;
  const markdownFile =
    localFile === undefined || codeText.length === 0 || /\s/u.test(codeText)
      ? null
      : resolveLocalFileTarget(
          codeText,
          localFile.absoluteLinks,
          localFile.relativeLinks,
        );
  if (
    markdownFile !== null &&
    /\.(?:md|markdown)$/iu.test(markdownFile.link.path)
  ) {
    return <MarkdownAnchor href={markdownFile.href}>{codeText}</MarkdownAnchor>;
  }
  return (
    <code
      className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-xs"
      {...props}
    >
      {children}
    </code>
  );
}

function useMarkdownTableBreakout() {
  const breakoutRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const breakout = breakoutRef.current;
    const content = breakout?.closest<HTMLElement>("[data-markdown-preview]");
    const parent = breakout?.parentElement;
    if (!breakout || !content || !parent) {
      return;
    }
    let clip: HTMLElement | null = content;
    while (
      clip &&
      clip !== document.body &&
      !CLIPPING_OVERFLOW_VALUES.has(getComputedStyle(clip).overflowX)
    ) {
      clip = clip.parentElement;
    }
    const clipElement = clip === document.body ? null : clip;
    const measure = () => {
      const contentWidth = content.getBoundingClientRect().width;
      if (contentWidth > 0) {
        breakout.style.setProperty(CONTENT_WIDTH_VARIABLE, `${contentWidth}px`);
      }
      if (clipElement === null) {
        breakout.style.removeProperty(TABLE_BREAKOUT_LIMIT_VARIABLE);
        return;
      }
      const parentStyle = getComputedStyle(parent);
      const paddingLeft = Number.parseFloat(parentStyle.paddingLeft) || 0;
      const paddingRight = Number.parseFloat(parentStyle.paddingRight) || 0;
      const parentLeft =
        parent.getBoundingClientRect().left +
        parent.clientLeft +
        clipElement.scrollLeft +
        paddingLeft;
      const parentWidth = parent.clientWidth - paddingLeft - paddingRight;
      if (parentWidth <= 0) {
        return;
      }
      const clipLeft =
        clipElement.getBoundingClientRect().left + clipElement.clientLeft;
      const room = Math.max(
        0,
        Math.min(
          parentLeft - clipLeft,
          clipLeft + clipElement.clientWidth - parentLeft - parentWidth,
        ),
      );
      breakout.style.setProperty(
        TABLE_BREAKOUT_LIMIT_VARIABLE,
        `${parentWidth + 2 * room}px`,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    if (clipElement !== null && clipElement !== content) {
      observer.observe(clipElement);
    }
    return () => observer.disconnect();
  }, []);

  return breakoutRef;
}

function MarkdownTable({ children }: ElementProps<"table">) {
  const breakoutRef = useMarkdownTableBreakout();
  return (
    <div
      ref={breakoutRef}
      className="my-2 flex justify-center"
      style={{
        width: TABLE_BREAKOUT_WIDTH,
        marginInline: `calc((100% - ${TABLE_BREAKOUT_WIDTH}) / 2)`,
      }}
    >
      <div
        className="w-max max-w-full overflow-x-auto"
        style={{
          minWidth: `min(var(${CONTENT_WIDTH_VARIABLE}, 100%), 100%)`,
        }}
      >
        <table className="border border-border">{children}</table>
      </div>
    </div>
  );
}

function MarkdownImage({
  src,
  alt,
  className: _className,
  node,
  "data-markdown-image-offset": pieceOffset,
  ...imageAttributes
}: ElementProps<"img"> & { "data-markdown-image-offset"?: number }) {
  const { imagePolicy, imageSourceOffset, setExpandedImage } = useContext(
    MarkdownRenderContext,
  );
  const openGallery = useContext(InlineImageGalleryContext);
  if (imagePolicy === "alt-text") {
    return (
      <span data-markdown-image-fallback="">
        [Image: {typeof alt === "string" && alt.length > 0 ? alt : "image"}]
      </span>
    );
  }
  const imageUrl = typeof src === "string" ? src : "";
  if (!imageUrl) return null;
  const sourceOffset = pieceOffset ?? node?.position?.start.offset;
  return (
    <img
      {...imageAttributes}
      src={imageUrl}
      alt={typeof alt === "string" ? alt : "Image"}
      className="my-2 max-h-[max(384px,50vh)] max-w-full cursor-zoom-in object-contain"
      loading="lazy"
      data-markdown-image=""
      data-markdown-image-offset={
        sourceOffset === undefined
          ? undefined
          : imageSourceOffset + sourceOffset
      }
      onClick={(event) => {
        if (openGallery) {
          openGallery(event.currentTarget);
          return;
        }
        const images = Array.from(
          event.currentTarget
            .closest("[data-markdown-preview]")
            ?.querySelectorAll("img") ?? [],
        );
        setExpandedImage({
          imageSources: images.map(
            (image) => image.getAttribute("src") ?? image.src,
          ),
          index: images.indexOf(event.currentTarget),
          url: event.currentTarget.getAttribute("src") ?? imageUrl,
        });
      }}
    />
  );
}

function MarkdownVideo({
  node: _node,
  children,
  src,
  poster,
  controls = true,
  playsInline = true,
  preload = "metadata",
  width,
  height,
  title,
  "aria-label": label,
}: ElementProps<"video">) {
  const { imagePolicy } = useContext(MarkdownRenderContext);
  if (imagePolicy === "alt-text") {
    return <span>[Video: {label || title || "video"}]</span>;
  }
  return (
    <video
      src={src}
      poster={poster}
      aria-label={label || title || "Video"}
      controls={controls}
      playsInline={playsInline}
      preload={preload}
      width={width}
      height={height}
      className="my-2 max-h-[max(384px,50vh)] max-w-full"
    >
      {children}
    </video>
  );
}

function MarkdownSource({
  media,
  node: _node,
  ...props
}: ElementProps<"source">) {
  const { imagePolicy } = useContext(MarkdownRenderContext);
  const preferredTheme = usePreferredTheme();
  if (imagePolicy === "alt-text") {
    return null;
  }
  const colorScheme = SOURCE_COLOR_SCHEME_MEDIA_PATTERN.exec(
    media ?? "",
  )?.[1]?.toLowerCase();
  return (
    <source
      {...props}
      media={
        colorScheme === undefined
          ? media
          : colorScheme === preferredTheme
            ? "all"
            : "not all"
      }
    />
  );
}

const MARKDOWN_COMPONENTS: Components = {
  a: MarkdownAnchor,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-surface-selected-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  code: MarkdownCode,
  h1: ({ children }) => (
    <h1 className="mb-2 mt-4 text-lg font-semibold text-foreground first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-4 text-base font-semibold text-foreground first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-3 text-sm font-semibold text-foreground first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1 mt-3 text-sm font-medium text-foreground first:mt-0">
      {children}
    </h4>
  ),
  h5: ({ children }) => (
    <h5 className="mb-1 mt-2 text-sm font-semibold uppercase text-muted-foreground first:mt-0">
      {children}
    </h5>
  ),
  h6: ({ children }) => (
    <h6 className="mb-1 mt-2 text-xs font-semibold uppercase text-muted-foreground first:mt-0">
      {children}
    </h6>
  ),
  hr: () => <hr className="my-4 border-t border-border" />,
  img: MarkdownImage,
  li: ({ children }) => <li className="mb-1 text-foreground">{children}</li>,
  ol: ({ children, className: _className, node: _node, ...props }) => (
    <ol {...props} className="mb-2 list-decimal pl-5 text-foreground">
      {children}
    </ol>
  ),
  p: ({ children, className: _className, node: _node, ...props }) => (
    <p {...props} className="mb-2 text-foreground last:mb-0">
      {children}
    </p>
  ),
  pre: ({ children }) => <>{children}</>,
  source: MarkdownSource,
  video: MarkdownVideo,
  table: MarkdownTable,
  td: ({ children }) => (
    <td className="border border-border px-2 py-1">{children}</td>
  ),
  th: ({ children }) => (
    <th className="border border-border px-2 py-1 text-left font-medium">
      {children}
    </th>
  ),
  thead: ({ children }) => (
    <thead className="bg-surface-recessed">{children}</thead>
  ),
  ul: ({ children }) => (
    <ul className="mb-2 list-disc pl-5 text-foreground">{children}</ul>
  ),
  "bb-thread-mention": ThreadMentionElement,
  "bb-message-directive": MessageDirectiveElement,
};

function splitMarkdownFrontmatter(markdown: string): {
  frontmatter: string | null;
  body: string;
} {
  const match = FRONTMATTER_PATTERN.exec(markdown);
  return match === null
    ? { frontmatter: null, body: markdown }
    : { frontmatter: match[1]!, body: markdown.slice(match[0].length) };
}

function MarkdownFrontmatter({ source }: { source: string }) {
  const lines = source.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }
  return (
    <div className="mb-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground">
      {lines.map((line, index) => {
        const separator = line.indexOf(":");
        if (separator > 0 && !/^[\s-]/.test(line)) {
          return (
            <div key={index} className="contents">
              <span className="font-medium text-muted-foreground/70">
                {line.slice(0, separator).trim()}
              </span>
              <span className="min-w-0 break-words">
                {line.slice(separator + 1).trim()}
              </span>
            </div>
          );
        }
        return (
          <div
            key={index}
            className="col-span-2 whitespace-pre-wrap break-words text-muted-foreground/80"
          >
            {line}
          </div>
        );
      })}
    </div>
  );
}

function MarkdownPreviewComponent({
  allowHtml = false,
  className,
  content,
  sourcePrefix = "",
  imagePolicy = "render",
  incrementalBlocks = false,
  linkRouting,
  threadMentions,
  promptMentions,
  messageDirectives,
}: MarkdownPreviewProps) {
  const [expandedImage, setExpandedImage] =
    useState<ExpandedMarkdownImage | null>(null);
  const [pieceCache] = useState(createMarkdownPieceCache);
  const [directiveMounts] = useState<MountedMessageDirective[]>(() => []);
  const rendersHtml = allowHtml && content.includes("<");
  const hasThreadMentions = threadMentions !== undefined;
  const hasPromptMentions = promptMentions !== undefined;
  const preserveSoftBreaks =
    threadMentions?.preserveSoftBreaks === true || hasPromptMentions;
  const directiveRegistry = messageDirectives?.registry ?? null;
  const imageSourceOffset = useMemo(
    () => splitMarkdownFrontmatter(sourcePrefix).body.length,
    [sourcePrefix],
  );
  const substitution = useMemo(
    () =>
      promptMentions
        ? substitutePromptMentions(content, promptMentions.mentions)
        : null,
    [content, promptMentions],
  );
  const { frontmatter, body } = useMemo(
    () =>
      splitMarkdownFrontmatter(
        substitution === null
          ? content
          : normalizePromptBlockquoteBoundaries(substitution.content),
      ),
    [content, substitution],
  );
  const components = useMemo<Components>(
    () =>
      substitution === null
        ? MARKDOWN_COMPONENTS
        : {
            ...MARKDOWN_COMPONENTS,
            "bb-prompt-mention": buildPromptMentionComponent({
              mentions: substitution.mentions,
              resolveLinkHref: promptMentions?.resolveLinkHref,
              resolveMentionLink: promptMentions?.resolveMentionLink,
            }),
          },
    [substitution, promptMentions],
  );
  const baseRemarkPlugins = useMemo(() => {
    const plugins: MarkdownPlugins = [remarkGfm];
    if (preserveSoftBreaks) plugins.push(remarkBreaks);
    if (hasThreadMentions) plugins.push(remarkThreadMentions);
    if (hasPromptMentions) plugins.push(remarkPromptMentions);
    if (directiveRegistry !== null) plugins.push(remarkDirective);
    return plugins;
  }, [
    preserveSoftBreaks,
    hasThreadMentions,
    hasPromptMentions,
    directiveRegistry,
  ]);
  const urlTransform = useMemo(
    () =>
      linkRouting?.localFile || linkRouting?.localImage
        ? buildLocalAwareUrlTransform(linkRouting)
        : undefined,
    [linkRouting],
  );
  const pieceConfig = useMemo<MarkdownPieceRenderConfig>(
    () => ({
      components,
      messageDirectiveRegistry: directiveRegistry,
      remarkPlugins: baseRemarkPlugins,
      urlTransform,
    }),
    [components, directiveRegistry, baseRemarkPlugins, urlTransform],
  );
  const pieces =
    incrementalBlocks && !rendersHtml && !hasPromptMentions
      ? resolveMarkdownPieces(pieceCache, pieceConfig, body)
      : null;
  const renderContext = useMemo<MarkdownRenderContextValue>(
    () => ({ imagePolicy, imageSourceOffset, linkRouting, setExpandedImage }),
    [imagePolicy, imageSourceOffset, linkRouting],
  );
  const mounts = pieces?.mounts ?? directiveMounts;
  const directiveContext = useMemo(
    () =>
      messageDirectives === undefined
        ? null
        : { directives: messageDirectives, mounts },
    [messageDirectives, mounts],
  );

  const renderedMarkdown =
    pieces === null ? (
      <ReactMarkdown
        rehypePlugins={rendersHtml ? HTML_REHYPE_PLUGINS : undefined}
        remarkPlugins={
          directiveRegistry === null
            ? baseRemarkPlugins
            : [
                ...baseRemarkPlugins,
                [
                  remarkMessageDirectives,
                  {
                    indexBase: 0,
                    limit: MESSAGE_DIRECTIVE_MOUNT_LIMIT,
                    mounts: directiveMounts,
                    registry: directiveRegistry,
                  },
                ],
              ]
        }
        components={components}
        urlTransform={urlTransform}
      >
        {body}
      </ReactMarkdown>
    ) : (
      pieces.children
    );

  const imageSources = expandedImage?.imageSources ?? [];
  const expandedImageIndex = expandedImage?.index ?? -1;
  const stepExpandedImage = (direction: "previous" | "next") => {
    if (expandedImageIndex === -1) return;
    const index = getWrappedImageIndex({
      currentIndex: expandedImageIndex,
      direction,
      itemCount: imageSources.length,
    });
    const url = imageSources[index];
    setExpandedImage(url === undefined ? null : { imageSources, index, url });
  };

  return (
    <>
      <div
        data-markdown-preview=""
        className={cn(
          "max-w-none break-words text-sm leading-relaxed text-foreground",
          className,
        )}
      >
        {frontmatter !== null ? (
          <MarkdownFrontmatter source={frontmatter} />
        ) : null}
        <MarkdownRenderContext.Provider value={renderContext}>
          <MarkdownThreadMentionsContext.Provider
            value={threadMentions ?? null}
          >
            <MessageDirectiveMountsContext.Provider value={directiveContext}>
              {hasThreadMentions ? (
                <RawThreadMentionBatchProvider>
                  {renderedMarkdown}
                </RawThreadMentionBatchProvider>
              ) : (
                renderedMarkdown
              )}
            </MessageDirectiveMountsContext.Provider>
          </MarkdownThreadMentionsContext.Provider>
        </MarkdownRenderContext.Provider>
      </div>

      <ImageLightbox
        imageSrc={expandedImage?.url ?? null}
        imageAlt="Expanded image"
        title="Expanded image preview"
        hasMultipleImages={expandedImageIndex !== -1 && imageSources.length > 1}
        onPrevious={() => stepExpandedImage("previous")}
        onNext={() => stepExpandedImage("next")}
        onClose={() => setExpandedImage(null)}
      />
    </>
  );
}

export const MarkdownPreview = memo(MarkdownPreviewComponent);
MarkdownPreview.displayName = "MarkdownPreview";
