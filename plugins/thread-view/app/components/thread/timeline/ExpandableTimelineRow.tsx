import {
  createContext,
  memo,
  useContext,
  useEffect,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import type { TimelineTitle } from "@bb/thread-view";
import {
  COLLAPSIBLE_HEADER_STATIC_TONE_CLASS,
  CollapsibleHeader,
  ExpandablePanel,
  getCollapsibleHeaderToneClass,
} from "@bb/app-kit/components/ui/disclosure";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  TimelineTitleView,
  type TimelineTitleActionResolver,
  type TimelineTitleLinkResolver,
} from "./TimelineTitleView";

export type TimelineRowHorizontalPadding = "default" | "flush";

const ROW_HEADER_CONTENT_CLASS_NAME = "min-w-0 max-w-full";
const ROW_HEADER_CONTROL_CLASS_NAME =
  "flex w-full max-w-full justify-start py-0 leading-5";

export const TimelineReasoningExpansionContext = createContext<Map<
  string,
  boolean
> | null>(null);

function paddingClassName(padding: TimelineRowHorizontalPadding): string {
  return padding === "flush" ? "px-0" : "px-2";
}

export function TimelineLeadingIcon({
  icon,
  fallback,
  style,
}: {
  icon: IconName | undefined;
  fallback?: IconName;
  style: CSSProperties | undefined;
}) {
  return icon ? (
    <Icon
      name={icon}
      fallback={fallback}
      className="size-3.5 shrink-0 text-muted-foreground"
      style={style}
      aria-hidden
    />
  ) : null;
}

export function TimelineStaticRowHeader({
  children,
  className,
  horizontalPadding = "default",
}: {
  children: ReactNode;
  className?: string;
  horizontalPadding?: TimelineRowHorizontalPadding;
}) {
  return (
    <div className={cn("w-full rounded-md text-muted-foreground", className)}>
      <CollapsibleHeader
        toneClassName={COLLAPSIBLE_HEADER_STATIC_TONE_CLASS}
        className={cn(
          paddingClassName(horizontalPadding),
          ROW_HEADER_CONTROL_CLASS_NAME,
        )}
        summaryClassName={ROW_HEADER_CONTENT_CLASS_NAME}
        summaryContent={children}
      />
    </div>
  );
}

interface ExpandableTimelineRowProps {
  reasoningExpansionKey?: string;
  autoExpanded?: boolean;
  forceExpanded?: boolean;
  terminalAutoExpanded?: boolean;
  renderBody: () => ReactNode;
  title: TimelineTitle;
  titleContent?: ReactNode;
  collapsedPreview?: ReactNode;
  expandable?: boolean;
  horizontalPadding?: TimelineRowHorizontalPadding;
  leadingIcon?: IconName;
  leadingIconFallback?: IconName;
  leadingIconStyle?: CSSProperties;
  headerClassName?: string;
  summaryClassName?: string;
  onTitleAction?: TimelineTitleActionResolver;
  resolveSegmentLinkHref?: TimelineTitleLinkResolver;
}

export const ExpandableTimelineRow = memo(function ExpandableTimelineRow({
  autoExpanded = false,
  collapsedPreview,
  expandable = true,
  forceExpanded = false,
  headerClassName,
  horizontalPadding = "default",
  leadingIcon,
  leadingIconFallback,
  leadingIconStyle,
  onTitleAction,
  renderBody,
  reasoningExpansionKey,
  resolveSegmentLinkHref,
  summaryClassName,
  terminalAutoExpanded = false,
  title,
  titleContent,
}: ExpandableTimelineRowProps) {
  const reasoningOverrides = useContext(TimelineReasoningExpansionContext);
  const [manualExpansion, setManualExpansion] = useState<boolean | null>(() =>
    reasoningExpansionKey === undefined
      ? null
      : (reasoningOverrides?.get(reasoningExpansionKey) ?? null),
  );
  const [terminalLatch, setTerminalLatch] = useState(terminalAutoExpanded);
  const [previewActive, setPreviewActive] = useState(false);
  useEffect(() => {
    if (terminalAutoExpanded) {
      setTerminalLatch(true);
    }
  }, [terminalAutoExpanded]);
  const isExpanded =
    expandable &&
    (forceExpanded ||
      (manualExpansion ??
        (autoExpanded || terminalAutoExpanded || terminalLatch)));
  useEffect(() => {
    if (isExpanded) {
      setPreviewActive(false);
    }
  }, [isExpanded]);
  const handleToggle = (): void => {
    if (reasoningExpansionKey !== undefined) {
      reasoningOverrides?.set(reasoningExpansionKey, !isExpanded);
    }
    setManualExpansion(!isExpanded);
  };
  const horizontalPaddingClass = paddingClassName(horizontalPadding);
  const previewToggleProps: HTMLAttributes<HTMLDivElement> = expandable
    ? {
        role: "button",
        tabIndex: 0,
        "aria-expanded": isExpanded,
        onClick: (event) => {
          if (
            event.target === event.currentTarget ||
            !(event.target instanceof Element) ||
            !event.target.closest("a,button,input,select,textarea")
          ) {
            handleToggle();
          }
        },
        onMouseEnter: () => setPreviewActive(true),
        onMouseLeave: () => setPreviewActive(false),
        onFocus: () => setPreviewActive(true),
        onBlur: (event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          ) {
            setPreviewActive(false);
          }
        },
        onKeyDown: (event) => {
          if (
            event.target === event.currentTarget &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.preventDefault();
            handleToggle();
          }
        },
      }
    : {};

  return (
    <ExpandablePanel
      isExpanded={isExpanded}
      onToggle={expandable ? handleToggle : undefined}
      headerToneClass={
        !expandable
          ? COLLAPSIBLE_HEADER_STATIC_TONE_CLASS
          : title.tone === "summary"
            ? "text-subtle-foreground transition-colors hover:text-muted-foreground focus-visible:text-muted-foreground"
            : getCollapsibleHeaderToneClass(isExpanded)
      }
      collapsedContent={
        collapsedPreview ? (
          <div
            className={cn(
              horizontalPaddingClass,
              "pb-1 pt-0.5",
              expandable ? "cursor-pointer focus-visible:outline-none" : null,
            )}
            {...previewToggleProps}
          >
            {collapsedPreview}
          </div>
        ) : null
      }
      summaryContent={
        <span
          className={cn(
            "inline-flex min-w-0 max-w-full items-center gap-1.5",
            summaryClassName,
          )}
        >
          <TimelineLeadingIcon
            icon={leadingIcon}
            fallback={leadingIconFallback}
            style={leadingIconStyle}
          />
          {titleContent ?? (
            <TimelineTitleView
              title={title}
              onTitleAction={onTitleAction}
              resolveSegmentLinkHref={resolveSegmentLinkHref}
            />
          )}
        </span>
      }
      summaryContentClassName={ROW_HEADER_CONTENT_CLASS_NAME}
      forceHeaderChevronVisible={expandable && !isExpanded && previewActive}
      className="w-full"
      headerClassName={cn(
        horizontalPaddingClass,
        ROW_HEADER_CONTROL_CLASS_NAME,
        headerClassName,
      )}
      contentClassName={cn(horizontalPaddingClass, "pb-1 pt-0.5")}
      renderBody={renderBody}
    />
  );
});
