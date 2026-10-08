import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ActiveThinking, ThreadRuntimeDisplayStatus } from "@bb/domain";
import type { TimelineRow } from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import { ConversationTimeline } from "../../ui/conversation";
import { HeightTransition } from "../../ui/height-transition";
import { Icon } from "@bb/shared-ui/icon";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { TimelineReasoningExpansionContext } from "./ExpandableTimelineRow";
import { ThreadTimelineRows } from "./ThreadTimelineRows";
import { useAutoLoadOlderRows } from "./useAutoLoadOlderRows";
import {
  TimelineStatusIndicator,
  TimelineWorkingIndicator,
} from "./TimelineWorkingIndicator";
import type {
  ThreadTimelineUnreadDividerPlacement,
  TimelineHandlers,
} from "./timeline-context";

export interface HostConnectionNotice {
  label: string;
}

export interface ThreadTimelineSurfaceProps extends TimelineHandlers {
  activeThinking: ActiveThinking | null;
  contextBoundarySeq: number | null;
  hasOlderTimelineRows?: boolean;
  hostConnectionNotice?: HostConnectionNotice | null;
  isLoadingOlderTimelineRows?: boolean;
  isThreadTimelinePending: boolean;
  timelineError: boolean;
  loadingContent?: ReactNode;
  leadingContent?: ReactNode;
  onLoadOlderRows?: () => Promise<void> | void;
  showOngoingIndicator: boolean;
  ongoingIndicatorLabel?: string;
  isStopping?: boolean;
  stoppingAnchorAt?: number;
  timelineErrorClassName?: string;
  timelineRows: TimelineRow[];
  threadId: string;
  threadRuntimeDisplayStatus: ThreadRuntimeDisplayStatus;
  unreadDividerAutoScroll?: boolean;
  unreadDividerPlacement?: ThreadTimelineUnreadDividerPlacement | null;
}

const LOADING_INDICATOR_REVEAL_DELAY_MS = 200;

function isStopRow(row: TimelineRow): boolean {
  return (
    row.kind === "system" &&
    row.systemKind === "operation" &&
    row.operationKind === "thread-interrupted"
  );
}

export function ThreadTimelineSurface({
  activeThinking,
  contextBoundarySeq,
  hasOlderTimelineRows = false,
  hostConnectionNotice,
  isLoadingOlderTimelineRows = false,
  isThreadTimelinePending,
  timelineError,
  loadingContent,
  leadingContent,
  onLoadOlderRows,
  showOngoingIndicator,
  ongoingIndicatorLabel,
  isStopping = false,
  stoppingAnchorAt = 0,
  timelineErrorClassName = "mt-6 text-destructive",
  timelineRows,
  threadId,
  ...rowsProps
}: ThreadTimelineSurfaceProps) {
  const [reasoningOverrides] = useState(() => new Map<string, boolean>());
  const showActiveThinking =
    activeThinking !== null && ongoingIndicatorLabel === undefined;
  const rows = useMemo<TimelineRow[]>(
    () =>
      !isStopping || timelineRows.some(isStopRow)
        ? timelineRows
        : [
            ...timelineRows,
            {
              id: `${threadId}:pending-stop`,
              threadId,
              turnId: null,
              sourceSeqStart: 0,
              sourceSeqEnd: 0,
              startedAt: stoppingAnchorAt,
              createdAt: stoppingAnchorAt,
              kind: "system",
              systemKind: "operation",
              operationKind: "thread-interrupted",
              title: "Stop requested",
              detail: null,
              status: "pending",
              completedAt: null,
            },
          ],
    [timelineRows, isStopping, stoppingAnchorAt, threadId],
  );

  return (
    <TimelineReasoningExpansionContext.Provider
      key={threadId}
      value={reasoningOverrides}
    >
      <ConversationTimeline className="flex-1">
        {leadingContent}
        {hasOlderTimelineRows &&
        onLoadOlderRows !== undefined &&
        !isThreadTimelinePending &&
        !timelineError ? (
          <LoadOlderMessages
            key={`context-boundary:${contextBoundarySeq}`}
            isLoadingOlderTimelineRows={isLoadingOlderTimelineRows}
            onLoadOlderRows={onLoadOlderRows}
          />
        ) : null}
        {isThreadTimelinePending ? (
          (loadingContent ?? <DelayedThreadLoadingIndicator />)
        ) : timelineError ? (
          <TimelineStatusIndicator
            label="Failed to load timeline"
            className={timelineErrorClassName}
          />
        ) : rows.length > 0 ? (
          <ThreadTimelineRows
            {...rowsProps}
            hasOlderTimelineRows={hasOlderTimelineRows}
            isLoadingOlderTimelineRows={isLoadingOlderTimelineRows}
            onLoadOlderRows={onLoadOlderRows}
            timelineRows={rows}
            threadId={threadId}
          />
        ) : null}
        {hostConnectionNotice ? (
          <TimelineStatusIndicator
            label={hostConnectionNotice.label}
            className="mt-4 text-destructive"
          />
        ) : null}
        <HeightTransition visible={showOngoingIndicator}>
          <TimelineWorkingIndicator
            key={
              showActiveThinking
                ? activeThinking.id
                : (ongoingIndicatorLabel ?? "working")
            }
            details={
              showActiveThinking && activeThinking.text.trim().length > 0
                ? activeThinking.text
                : undefined
            }
            reasoningId={activeThinking?.id}
            isThinking={showActiveThinking}
            label={ongoingIndicatorLabel}
          />
        </HeightTransition>
      </ConversationTimeline>
    </TimelineReasoningExpansionContext.Provider>
  );
}

function LoadOlderMessages({
  isLoadingOlderTimelineRows,
  onLoadOlderRows,
}: {
  isLoadingOlderTimelineRows: boolean;
  onLoadOlderRows: () => Promise<void> | void;
}) {
  const { sentinelRef, isAutoLoadEnabled, loadOlderRows } =
    useAutoLoadOlderRows({
      hasOlderTimelineRows: true,
      isLoadingOlderTimelineRows,
      onLoadOlderRows,
    });

  return (
    <div ref={sentinelRef} className="flex justify-center pt-2 mb-3">
      {isAutoLoadEnabled ? (
        <span
          className="text-muted-foreground text-xs"
          aria-live="polite"
          role="status"
        >
          {isLoadingOlderTimelineRows ? "Loading older messages…" : "\u00a0"}
        </span>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={loadOlderRows}
          disabled={isLoadingOlderTimelineRows}
        >
          <Icon name="ChevronUp" aria-hidden="true" />
          {isLoadingOlderTimelineRows
            ? "Loading older messages..."
            : "Load older messages"}
        </Button>
      )}
    </div>
  );
}

function DelayedThreadLoadingIndicator() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(
      () => setVisible(true),
      LOADING_INDICATOR_REVEAL_DELAY_MS,
    );
    return () => window.clearTimeout(id);
  }, []);

  if (!visible) {
    return null;
  }

  return (
    <div className="mt-6 space-y-5" role="status" aria-label="Loading thread">
      <div className="flex justify-end px-2">
        <Skeleton className="h-12 w-3/5" />
      </div>
      <div className="space-y-2 px-2">
        <Skeleton className="h-3.5 w-11/12" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-3/4" />
      </div>
      <div className="space-y-2.5 px-2">
        {["w-2/5", "w-1/2", "w-1/3"].map((width) => (
          <div key={width} className="flex items-center gap-2">
            <Skeleton className="size-3.5 shrink-0 rounded" />
            <Skeleton className={`h-3 ${width}`} />
          </div>
        ))}
      </div>
      <div className="space-y-2 px-2">
        <Skeleton className="h-3.5 w-5/6" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
    </div>
  );
}
