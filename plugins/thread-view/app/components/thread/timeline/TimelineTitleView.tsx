import { Fragment, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import {
  assertNever,
  durationToCompactString,
  formatDiffStatsText,
  type TimelineTitle,
  type TimelineTitleAction,
  type TimelineTitleDecoration,
  type TimelineTitleSegment,
  type TimelineTitleTone,
} from "@bb/thread-view";
import { cn } from "@bb/shared-ui/lib/utils";
import { Icon } from "@bb/shared-ui/icon";
import { DiffStatsTally } from "@bb/app-kit/components/ui/diff-stats-tally";
import { RouteAnchor } from "@bb/app-kit/components/ui/app-route-anchor";
import type { TimelineTitleLinkResolver } from "@bb/app-kit/lib/timeline-title-links";
import { LiveDurationText } from "@bb/app-kit/components/thread/timeline/LiveDurationText";
import {
  ThreadTitleMentions,
  useResolveThreadTitle,
} from "@bb/app-kit/components/thread/ThreadTitleMentions";
import {
  ConversationMessageOverflowToggle,
  useIsOverflowing,
} from "./conversation-message-overflow";

export type TimelineTitleActionResolver = (
  action: TimelineTitleAction,
) => (() => void) | null;

export type { TimelineTitleLinkResolver };

interface TimelineTitleViewProps {
  title: TimelineTitle;
  onTitleAction?: TimelineTitleActionResolver;
  resolveSegmentLinkHref?: TimelineTitleLinkResolver;
  wrap?: boolean;
}

const EM_TONE_CLASS: Record<TimelineTitleTone, string> = {
  default: "font-medium text-foreground opacity-70",
  summary: "text-subtle-foreground",
};
const PLAIN_TONE_CLASS: Record<TimelineTitleTone, string> = {
  default: "text-muted-foreground",
  summary: "text-subtle-foreground",
};
const STATUS_DECORATION_TONE_CLASS = "text-subtle-foreground";

function segmentToneClass(
  segment: TimelineTitleSegment,
  tone: TimelineTitleTone,
): string {
  switch (segment.accent) {
    case undefined:
      return segment.em ? EM_TONE_CLASS[tone] : PLAIN_TONE_CLASS[tone];
    case "muted":
      return "text-muted-foreground";
    case "subtle":
      return "text-subtle-foreground";
    case "file":
      return segment.em
        ? "font-medium text-timeline-accent"
        : "text-timeline-accent";
    default:
      return assertNever(segment.accent);
  }
}

function StatusDecorationText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "font-mono text-xs font-normal leading-none",
        STATUS_DECORATION_TONE_CLASS,
        "ml-px opacity-75",
        className,
      )}
    >
      {text}
    </span>
  );
}

function renderSegment(
  segment: TimelineTitleSegment,
  tone: TimelineTitleTone,
  onClick: (() => void) | null,
  linkHref: string | null,
  wrap: boolean,
): ReactNode {
  const baseClass = cn(
    wrap
      ? "whitespace-pre-wrap"
      : segment.truncate
        ? "min-w-0 truncate whitespace-pre"
        : "shrink-0 whitespace-pre",
    segmentToneClass(segment, tone),
    segment.shimmer ? "animate-shine" : null,
  );
  const content =
    segment.link?.kind === "thread" ? (
      <ThreadTitleMentions title={segment.text} />
    ) : (
      segment.text
    );

  if (linkHref !== null) {
    return (
      <RouteAnchor
        href={linkHref}
        className={cn(
          baseClass,
          "cursor-pointer text-left underline underline-offset-2 focus-visible:outline-none",
        )}
        onClick={(event) => {
          event.stopPropagation();
        }}
        onKeyDown={(event: KeyboardEvent<HTMLAnchorElement>) => {
          if (event.key === "Enter" || event.key === " ") {
            event.stopPropagation();
          }
        }}
      >
        {content}
      </RouteAnchor>
    );
  }

  if (segment.em && onClick) {
    return (
      <span
        role="link"
        tabIndex={0}
        className={cn(
          baseClass,
          "cursor-pointer text-left underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none",
        )}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            onClick();
          }
        }}
      >
        {content}
      </span>
    );
  }

  return <span className={baseClass}>{content}</span>;
}

function renderDecoration(
  decoration: TimelineTitleDecoration,
  tone: TimelineTitleTone,
): ReactNode {
  const baseClass = cn("shrink-0 whitespace-pre", PLAIN_TONE_CLASS[tone]);

  switch (decoration.kind) {
    case "duration":
      return (
        <span
          className={
            decoration.em
              ? cn("shrink-0 whitespace-pre tabular-nums", EM_TONE_CLASS[tone])
              : cn(baseClass, "tabular-nums")
          }
        >
          {decoration.completedAt !== null ? (
            durationToCompactString(
              decoration.completedAt - decoration.startedAt,
            )
          ) : (
            <LiveDurationText startedAt={decoration.startedAt} />
          )}
        </span>
      );
    case "status":
      return (
        <span
          className={cn(
            "shrink-0 whitespace-pre",
            STATUS_DECORATION_TONE_CLASS,
            "inline-flex items-baseline gap-1",
          )}
        >
          {decoration.durationMs !== null ? (
            <span className="tabular-nums">
              {durationToCompactString(decoration.durationMs)}
            </span>
          ) : null}
          <StatusDecorationText
            text={decoration.status}
            className={
              decoration.status === "error" && decoration.emphasis
                ? "text-destructive-text"
                : undefined
            }
          />
        </span>
      );
    case "summary-status": {
      const { errorCount, interruptedCount } = decoration;
      const text = [
        errorCount > 0
          ? `${errorCount} ${errorCount === 1 ? "error" : "errors"}`
          : null,
        interruptedCount > 0 ? `${interruptedCount} interrupted` : null,
      ]
        .filter((part) => part !== null)
        .join(", ");
      return text.length === 0 ? null : (
        <span className="shrink-0 whitespace-pre">
          <StatusDecorationText text={text} />
        </span>
      );
    }
    case "diff-stats": {
      if (tone !== "summary") {
        return (
          <DiffStatsTally
            insertions={decoration.added}
            deletions={decoration.removed}
            hideZero
            className="shrink-0"
          />
        );
      }
      const text = formatDiffStatsText({
        added: decoration.added,
        removed: decoration.removed,
        hideZero: true,
      });
      return text.length === 0 ? null : (
        <span className={baseClass}>{text}</span>
      );
    }
    case "badge":
      return (
        <span
          className="inline-flex shrink-0 items-center"
          title={decoration.hint}
        >
          <Icon
            name={decoration.glyph}
            className={cn(
              "size-3.5",
              decoration.tone === "destructive"
                ? "text-destructive-text"
                : "text-muted-foreground",
            )}
            aria-label={decoration.hint}
          />
        </span>
      );
    default:
      return assertNever(decoration);
  }
}

export function TimelineTitleView({
  title,
  onTitleAction,
  resolveSegmentLinkHref,
  wrap = false,
}: TimelineTitleViewProps) {
  const onClick =
    title.action && onTitleAction ? onTitleAction(title.action) : null;
  const resolveTitle = useResolveThreadTitle();
  const plainTitle = title.segments.some((segment) => segment.link)
    ? resolveTitle(title.plain)
    : title.plain;

  return (
    <span
      className={cn(
        "min-w-0 max-w-full text-xs leading-5 tabular-nums",
        wrap
          ? "whitespace-pre-wrap [overflow-wrap:anywhere]"
          : "inline-flex items-baseline gap-1 overflow-hidden whitespace-nowrap",
      )}
      title={plainTitle}
    >
      {title.segments.map((segment, index) => (
        <Fragment key={`segment-${index}`}>
          {index > 0 ? " " : null}
          {renderSegment(
            segment,
            title.tone,
            onClick,
            segment.link && resolveSegmentLinkHref
              ? resolveSegmentLinkHref(segment.link)
              : null,
            wrap,
          )}
        </Fragment>
      ))}
      {title.decorations.map((decoration, index) => (
        <Fragment key={`decoration-${index}`}>
          {" "}
          {renderDecoration(decoration, title.tone)}
        </Fragment>
      ))}
    </span>
  );
}

export function ExpandableTimelineTitle(props: TimelineTitleViewProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  const overflowing = useIsOverflowing({
    elementRef: ref,
    enabled: !expanded,
    measurementKey: props.title.plain,
  });

  return (
    <span className="block min-w-0 flex-1">
      <span
        ref={ref}
        className={cn("block text-xs leading-5", !expanded && "line-clamp-2")}
      >
        <TimelineTitleView {...props} wrap />
      </span>
      {expanded || overflowing ? (
        <ConversationMessageOverflowToggle
          expanded={expanded}
          onToggle={() => setExpanded((value) => !value)}
        />
      ) : null}
    </span>
  );
}
