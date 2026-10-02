import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import type { ThreadRuntimeDisplayStatus } from "@bb/domain";
import type { TimelineRow } from "@bb/server-contract";
import {
  activityIntentTitleGlyph,
  assertNever,
  buildTimelineActivityIntentTitles,
  buildTimelineRowTitle,
  buildTimelineViewRows,
  createTimelineViewRowsCache,
  findActiveLatestBundleId,
  workRowGlyph,
  workRowPresentation,
  type ThreadTimelineViewRow,
  type TimelineViewTurnRow,
} from "@bb/thread-view";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  collectTimelineAutoExpansionRowIds,
  isNonExpandableSummary,
  isRowExpandable,
  isRunningThreadRuntimeDisplayStatus,
} from "@bb/client-core";
import { Button } from "@bb/shared-ui/button";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { AutoHeightContainer } from "../../ui/height-transition.js";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body.js";
import { getThreadRoutePath } from "@/lib/route-paths";
import { useThreadTimelineTurnSummaryDetails } from "@/hooks/queries/thread-queries";
import { useSenderThreadMetadataById } from "@/hooks/useSenderThreadMetadataById";
import {
  AssistantConversationMessage,
  UserConversationMessage,
} from "./ConversationMessageContent.js";
import {
  ExpandableTimelineRow,
  TimelineLeadingIcon,
  TimelineStaticRowHeader,
} from "./ExpandableTimelineRow.js";
import { TimelineImageGallery } from "./TimelineImageGallery.js";
import { TimelineDetailScroll } from "./TimelineDetailScroll.js";
import { TimelineReasoningDetail } from "./TimelineWorkingIndicator.js";
import { WorkRowBody } from "./TimelineRowDetails.js";
import {
  ExpandableTimelineTitle,
  TimelineTitleView,
} from "./TimelineTitleView.js";
import { presentationTintStyle } from "./presentation-display.js";
import { NESTED_TIMELINE_GROUP_LINE_CLASS_NAME } from "./timeline-nested-group-line.js";
import {
  TimelineContext,
  useTimeline,
  type ThreadTimelineUnreadDividerPlacement,
  type TimelineContextValue,
  type TimelineHandlers,
} from "./timeline-context.js";
import { useSearchedMessage } from "./useScrollToSearchedMessage.js";

export interface ThreadTimelineRowsProps extends TimelineHandlers {
  hasOlderTimelineRows?: boolean;
  isLoadingOlderTimelineRows?: boolean;
  onLoadOlderRows?: () => Promise<void> | void;
  timelineRows: TimelineRow[];
  threadId?: string;
  threadRuntimeDisplayStatus: ThreadRuntimeDisplayStatus;
  unreadDividerAutoScroll?: boolean;
  unreadDividerPlacement?: ThreadTimelineUnreadDividerPlacement | null;
}

type TimelineRowsListSpacing = "top-level" | "nested" | "bundle";

interface TimelineRowsListProps {
  compactActivityIntents: boolean;
  rows: readonly ThreadTimelineViewRow[];
  scopeActive: boolean;
  showAssistantMessageActions: boolean;
  spacing: TimelineRowsListSpacing;
  className?: string;
  pagination?: Pick<
    ThreadTimelineRowsProps,
    "hasOlderTimelineRows" | "isLoadingOlderTimelineRows" | "onLoadOlderRows"
  >;
  unreadDivider?: {
    autoScroll: boolean;
    placement: ThreadTimelineUnreadDividerPlacement | null;
  };
}

interface TimelineRowViewProps extends Pick<
  TimelineRowsListProps,
  | "compactActivityIntents"
  | "scopeActive"
  | "showAssistantMessageActions"
  | "spacing"
> {
  forceExpanded: boolean;
  isLatestBundle: boolean;
  row: ThreadTimelineViewRow;
}

const PAST_ROW_DIM_CLASS_NAME = "opacity-40";
const viewRowsCache = createTimelineViewRowsCache();

function useStableSet(values: ReadonlySet<string>): ReadonlySet<string> {
  const [stable, setStable] = useState(values);
  if (
    stable !== values &&
    (stable.size !== values.size ||
      [...values].some((value) => !stable.has(value)))
  ) {
    setStable(values);
    return values;
  }
  return stable;
}

function findStreamingAssistantMessageId(
  rows: readonly ThreadTimelineViewRow[],
): string | null {
  const lastRow = rows.at(-1);
  if (lastRow === undefined) {
    return null;
  }
  if (lastRow.kind === "conversation") {
    return lastRow.role === "assistant" ? lastRow.id : null;
  }
  if (
    lastRow.kind === "turn" &&
    lastRow.status === "pending" &&
    lastRow.children !== null
  ) {
    return findStreamingAssistantMessageId(lastRow.children);
  }
  if (
    lastRow.kind === "work" &&
    lastRow.workKind === "delegation" &&
    lastRow.status === "pending"
  ) {
    return findStreamingAssistantMessageId(lastRow.childRows);
  }
  return null;
}

function heightSnapRevision(rows: readonly TimelineRow[]): string {
  const lastTurn = rows.filter((row) => row.kind === "turn").at(-1);
  return lastTurn
    ? `${rows[0]?.id}:${lastTurn.id}:${lastTurn.sourceSeqStart}:${lastTurn.sourceSeqEnd}`
    : `${rows[0]?.id}:active`;
}

function rowsContentKey(rows: readonly ThreadTimelineViewRow[]): string {
  const last = rows.at(-1);
  return `${rows.length}:${last?.id}:${last?.sourceSeqEnd}`;
}

function pastRowDimClassName(row: ThreadTimelineViewRow): string | undefined {
  switch (row.kind) {
    case "system":
      return row.status === "completed" &&
        !(
          row.systemKind === "operation" &&
          (row.operationKind === "warning" ||
            row.operationKind === "deprecation")
        )
        ? PAST_ROW_DIM_CLASS_NAME
        : undefined;
    case "work":
      return row.status === "completed" || row.status === "error"
        ? PAST_ROW_DIM_CLASS_NAME
        : undefined;
    case "turn":
    case "bundle-summary":
    case "step-summary":
      return row.status === "completed" ? PAST_ROW_DIM_CLASS_NAME : undefined;
    case "conversation":
      return undefined;
  }
}

function leadingIconForRow(row: ThreadTimelineViewRow): IconName | undefined {
  if (row.kind === "work") {
    return workRowGlyph(row, (glyph): glyph is string => glyph.length > 0);
  }
  if (row.kind !== "system" || row.systemKind !== "operation") {
    return undefined;
  }
  switch (row.operationKind) {
    case "reasoning":
      return "AiBrain01";
    case "parent-change":
      return row.parentChange.action === "release"
        ? "UserRound"
        : "UserRoundPlus";
    case "thread-provisioning":
      return "Terminal";
    case "thread-interrupted":
      return "AlertCircle";
    case "compaction":
      return "CircleArrowShrink";
    case "context-clear":
      return "Clean";
    default:
      return undefined;
  }
}

function TimelineUnreadDivider({ autoScroll }: { autoScroll: boolean }) {
  const scrollIntoView =
    useBottomAnchoredScroll()?.scrollElementIntoViewClampedToMaxScroll;
  const dividerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!autoScroll || !scrollIntoView) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      if (dividerRef.current) {
        scrollIntoView({ element: dividerRef.current });
      }
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [autoScroll, scrollIntoView]);

  return (
    <div
      ref={dividerRef}
      role="separator"
      aria-label="New messages"
      className="flex items-center gap-2 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-timeline-accent"
      data-testid="thread-unread-divider"
    >
      <span className="shrink-0">New</span>
      <span className="h-px min-w-0 flex-1 bg-timeline-accent" aria-hidden />
    </div>
  );
}

function TurnRowBody({
  compactActivityIntents,
  row,
  showAssistantMessageActions,
}: Pick<
  TimelineRowsListProps,
  "compactActivityIntents" | "showAssistantMessageActions"
> & { row: TimelineViewTurnRow }) {
  const { threadId } = useTimeline();
  const {
    data: detail,
    isError,
    refetch,
  } = useThreadTimelineTurnSummaryDetails(
    {
      sourceSeqEnd: row.sourceSeqEnd,
      sourceSeqStart: row.sourceSeqStart,
      threadId: threadId ?? row.threadId,
      turnId: row.turnId,
    },
    { enabled: row.children === null },
  );
  const rows =
    row.children ??
    (detail
      ? buildTimelineViewRows(detail.rows, {
          cache: viewRowsCache,
          closedScope: true,
        })
      : null);

  if (rows) {
    return (
      <TimelineRowsList
        rows={rows}
        scopeActive={false}
        showAssistantMessageActions={showAssistantMessageActions}
        compactActivityIntents={compactActivityIntents}
        spacing="nested"
        className={NESTED_TIMELINE_GROUP_LINE_CLASS_NAME}
      />
    );
  }
  if (isError) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive-text">
        <span>Failed to load turn details.</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void refetch()}
          className="h-7 cursor-pointer border-destructive px-2 text-destructive hover:text-destructive"
        >
          <Icon name="RotateCcw" />
          Retry
        </Button>
      </div>
    );
  }
  return (
    <div className="text-sm text-muted-foreground">Loading turn details...</div>
  );
}

function TimelineRowBody({
  compactActivityIntents,
  isLatestBundle,
  row,
  showAssistantMessageActions,
}: Omit<TimelineRowViewProps, "forceExpanded" | "scopeActive" | "spacing">) {
  switch (row.kind) {
    case "bundle-summary":
    case "step-summary": {
      const list = (
        <TimelineRowsList
          rows={row.children}
          scopeActive={false}
          showAssistantMessageActions={showAssistantMessageActions}
          compactActivityIntents={true}
          spacing="bundle"
        />
      );
      return isNonExpandableSummary(row.children) ? (
        <TimelineDetailScroll
          size="summary"
          streaming={row.kind === "bundle-summary" && isLatestBundle}
          contentKey={rowsContentKey(row.children)}
        >
          {list}
        </TimelineDetailScroll>
      ) : (
        list
      );
    }
    case "turn":
      return (
        <TurnRowBody
          row={row}
          compactActivityIntents={compactActivityIntents}
          showAssistantMessageActions={
            showAssistantMessageActions && row.status === "pending"
          }
        />
      );
    case "work": {
      if (row.workKind !== "delegation") {
        return <WorkRowBody row={row} />;
      }
      const delegationActive = row.status === "pending";
      return (
        <TimelineDetailScroll
          size="delegation"
          streaming={delegationActive}
          contentKey={`${rowsContentKey(row.childRows)}|${row.output.length}`}
          className={NESTED_TIMELINE_GROUP_LINE_CLASS_NAME}
        >
          <div className="flex flex-col gap-3">
            {row.childRows.length > 0 ? (
              <TimelineRowsList
                rows={row.childRows}
                scopeActive={delegationActive}
                showAssistantMessageActions={false}
                compactActivityIntents={false}
                spacing="nested"
              />
            ) : null}
            {row.output.trim().length > 0 ? (
              <AssistantConversationMessage
                attachments={null}
                id={row.id}
                showActions={false}
                streaming={delegationActive}
                text={row.output}
                threadId={row.threadId}
                turnId={row.turnId}
              />
            ) : null}
          </div>
        </TimelineDetailScroll>
      );
    }
    case "system":
      if (!row.detail) {
        return null;
      }
      if (row.systemKind === "operation" && row.operationKind === "reasoning") {
        return <TimelineReasoningDetail text={row.detail} />;
      }
      return (
        <TimelineDetailScroll
          size="base"
          streaming={row.status === "pending"}
          contentKey={row.detail}
          className="overflow-hidden rounded-lg border border-border bg-card"
        >
          <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-tight text-subtle-foreground opacity-70">
            {row.detail}
          </pre>
        </TimelineDetailScroll>
      );
    case "conversation":
      return null;
    default:
      return assertNever(row);
  }
}

const TimelineRowView = memo(function TimelineRowView({
  compactActivityIntents,
  forceExpanded,
  isLatestBundle,
  row,
  scopeActive,
  showAssistantMessageActions,
  spacing,
}: TimelineRowViewProps) {
  const {
    liveExpandedRowIds,
    onTitleAction,
    resolveSegmentLinkHref,
    streamingMessageId,
    terminalExpandedRowIds,
  } = useTimeline();

  if (row.kind === "conversation") {
    return row.role === "user" ? (
      <UserConversationMessage row={row} />
    ) : (
      <AssistantConversationMessage
        attachments={row.attachments}
        id={row.id}
        showActions={showAssistantMessageActions}
        streaming={row.id === streamingMessageId}
        text={row.text}
        threadId={row.threadId}
        turnId={row.turnId}
      />
    );
  }

  const horizontalPadding = spacing === "bundle" ? "flush" : "default";
  const isActiveLatestBundle =
    row.kind === "bundle-summary" && scopeActive && isLatestBundle;
  const dimClassName = isActiveLatestBundle
    ? undefined
    : pastRowDimClassName(row);
  const intentTitles =
    compactActivityIntents &&
    row.kind === "work" &&
    row.workKind === "command" &&
    row.approvalStatus === null
      ? buildTimelineActivityIntentTitles(row)
      : [];
  if (intentTitles.length > 0) {
    return intentTitles.map((entry) => (
      <TimelineStaticRowHeader
        key={entry.id}
        horizontalPadding={horizontalPadding}
        className={dimClassName}
      >
        <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
          <Icon
            name={activityIntentTitleGlyph(entry)}
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <TimelineTitleView
            title={entry.title}
            onTitleAction={onTitleAction}
            resolveSegmentLinkHref={resolveSegmentLinkHref}
          />
        </span>
      </TimelineStaticRowHeader>
    ));
  }

  const title = buildTimelineRowTitle(row, {
    summaryStyle: row.kind === "step-summary" ? "background" : "bundle",
    workStyle: row.kind === "work" && row.inClosedStep ? "summary" : "default",
    isActiveLatestBundle,
  });
  const leadingIcon = leadingIconForRow(row);
  const leadingIconStyle =
    row.kind === "work"
      ? presentationTintStyle(workRowPresentation(row))
      : undefined;

  if (!isRowExpandable(row)) {
    const TitleView =
      row.kind === "system" ? ExpandableTimelineTitle : TimelineTitleView;
    return (
      <TimelineStaticRowHeader
        horizontalPadding={horizontalPadding}
        className={dimClassName}
      >
        <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
          <TimelineLeadingIcon icon={leadingIcon} style={leadingIconStyle} />
          <TitleView
            title={title}
            onTitleAction={onTitleAction}
            resolveSegmentLinkHref={resolveSegmentLinkHref}
          />
        </span>
      </TimelineStaticRowHeader>
    );
  }

  return (
    <ExpandableTimelineRow
      reasoningExpansionKey={
        row.kind === "system" &&
        row.systemKind === "operation" &&
        row.operationKind === "reasoning"
          ? (row.reasoningId ?? row.id)
          : undefined
      }
      title={title}
      summaryClassName={dimClassName}
      horizontalPadding={horizontalPadding}
      leadingIcon={leadingIcon}
      leadingIconFallback={
        row.kind === "work"
          ? workRowGlyph(row, (glyph): glyph is never => false)
          : undefined
      }
      leadingIconStyle={leadingIconStyle}
      autoExpanded={liveExpandedRowIds.has(row.id)}
      forceExpanded={forceExpanded}
      terminalAutoExpanded={terminalExpandedRowIds.has(row.id)}
      onTitleAction={onTitleAction}
      resolveSegmentLinkHref={resolveSegmentLinkHref}
      renderBody={() => (
        <TimelineRowBody
          isLatestBundle={isLatestBundle}
          row={row}
          compactActivityIntents={compactActivityIntents}
          showAssistantMessageActions={showAssistantMessageActions}
        />
      )}
    />
  );
});

function findUnreadDividerIndex(
  rows: readonly ThreadTimelineViewRow[],
  placement: ThreadTimelineUnreadDividerPlacement | null | undefined,
): number {
  if (!placement) {
    return -1;
  }
  if (placement.kind === "before-first") {
    return rows.length > 0 ? 0 : -1;
  }
  return rows.findIndex(
    (row) =>
      row.startedAt > placement.cutoffAt &&
      !(
        row.kind === "conversation" &&
        row.role === "user" &&
        row.initiator === "user"
      ),
  );
}

function TimelineRowsList({
  compactActivityIntents,
  pagination,
  rows,
  scopeActive,
  showAssistantMessageActions,
  spacing,
  className,
  unreadDivider,
}: TimelineRowsListProps) {
  const { threadId } = useTimeline();
  const searchExpandedRowIds = useSearchedMessage(rows, threadId, {
    hasOlderRows: pagination?.hasOlderTimelineRows,
    isLoadingOlderRows: pagination?.isLoadingOlderTimelineRows,
    onLoadOlderRows: pagination?.onLoadOlderRows,
  });
  const activeLatestBundleId = findActiveLatestBundleId(rows);
  const dividerIndex = findUnreadDividerIndex(rows, unreadDivider?.placement);
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col [&_button:not(:disabled)]:cursor-pointer",
        spacing === "bundle" ? "gap-0" : "gap-2",
        className,
      )}
      data-timeline-row-list={spacing}
    >
      {rows.map((row, index) => (
        <Fragment key={row.id}>
          {index === dividerIndex ? (
            <TimelineUnreadDivider
              autoScroll={unreadDivider?.autoScroll ?? false}
            />
          ) : null}
          <div data-timeline-row-id={row.id}>
            <TimelineRowView
              isLatestBundle={row.id === activeLatestBundleId}
              forceExpanded={searchExpandedRowIds.has(row.id)}
              row={row}
              scopeActive={scopeActive}
              showAssistantMessageActions={showAssistantMessageActions}
              spacing={spacing}
              compactActivityIntents={compactActivityIntents}
            />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

export const ThreadTimelineRows = memo(function ThreadTimelineRows({
  hasOlderTimelineRows,
  isLoadingOlderTimelineRows,
  onLoadOlderRows,
  onMessageAddToChat,
  onOpenLink,
  onOpenLocalFileLink,
  onOpenPluginPanel,
  onTitleAction,
  projectId,
  resolveMentionLink,
  threadId,
  threadOriginKind,
  timelineRows,
  threadRuntimeDisplayStatus,
  unreadDividerAutoScroll = true,
  unreadDividerPlacement = null,
  workspaceRootPath,
}: ThreadTimelineRowsProps) {
  const rows = useMemo(
    () => buildTimelineViewRows(timelineRows, { cache: viewRowsCache }),
    [timelineRows],
  );
  const scopeActive = isRunningThreadRuntimeDisplayStatus(
    threadRuntimeDisplayStatus,
  );
  const autoExpansion = useMemo(
    () => collectTimelineAutoExpansionRowIds({ rows, scopeActive }),
    [rows, scopeActive],
  );
  const liveExpandedRowIds = useStableSet(autoExpansion.liveExpandedRowIds);
  const terminalExpandedRowIds = useStableSet(
    autoExpansion.terminalFrontierRowIds,
  );
  const senderThreads = useSenderThreadMetadataById();
  const streamingMessageId = scopeActive
    ? findStreamingAssistantMessageId(rows)
    : null;
  const contextValue = useMemo<TimelineContextValue>(
    () => ({
      liveExpandedRowIds,
      onMessageAddToChat,
      onOpenLink,
      onOpenLocalFileLink,
      onOpenPluginPanel,
      onTitleAction,
      projectId,
      resolveMentionLink,
      resolveSegmentLinkHref: (link) =>
        projectId !== undefined
          ? getThreadRoutePath({ projectId, threadId: link.threadId })
          : null,
      senderThreads,
      streamingMessageId,
      terminalExpandedRowIds,
      threadId,
      threadOriginKind,
      workspaceRootPath,
    }),
    [
      liveExpandedRowIds,
      onMessageAddToChat,
      onOpenLink,
      onOpenLocalFileLink,
      onOpenPluginPanel,
      onTitleAction,
      projectId,
      resolveMentionLink,
      senderThreads,
      streamingMessageId,
      terminalExpandedRowIds,
      threadId,
      threadOriginKind,
      workspaceRootPath,
    ],
  );

  return (
    <TimelineImageGallery key={threadId ?? timelineRows[0]?.threadId ?? ""}>
      <TimelineContext.Provider value={contextValue}>
        <AutoHeightContainer
          snapRevision={heightSnapRevision(timelineRows)}
          animateGrowth={!scopeActive}
        >
          <TimelineRowsList
            pagination={{
              hasOlderTimelineRows,
              isLoadingOlderTimelineRows,
              onLoadOlderRows,
            }}
            rows={rows}
            scopeActive={scopeActive}
            showAssistantMessageActions={true}
            compactActivityIntents={false}
            spacing="top-level"
            unreadDivider={{
              autoScroll: unreadDividerAutoScroll,
              placement: unreadDividerPlacement,
            }}
          />
        </AutoHeightContainer>
      </TimelineContext.Provider>
    </TimelineImageGallery>
  );
});
