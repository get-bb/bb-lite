import { Icon, type IconName } from "./icon.js";
import { cn } from "../../lib/utils";
import {
  getThreadListIndicatorLabel,
  resolveThreadListIndicator,
  type ThreadListIndicatorKind,
  type ThreadListIndicatorState,
} from "@bb/client-core";
import {
  SIDEBAR_STATUS_ICON_CLASS,
  SIDEBAR_SUCCESS_STATUS_DOT_CLASS,
  SIDEBAR_WORKING_STATUS_COLOR_CLASS,
} from "./sidebar-row-classes.js";

const WORKING_ACTIVITY_ICONS = {
  workflow: "Workflow",
  "background-agent": "UserRoundPlus",
  "background-command": "Terminal",
  "plan-mode": "ListTodo",
  goal: "Target",
} satisfies Partial<Record<ThreadListIndicatorKind, IconName>>;

const WAITING_ICONS = {
  "waiting-for-input": "CircleQuestion",
  "queued-waiting": "Clock",
} satisfies Partial<Record<ThreadListIndicatorKind, IconName>>;

function ThreadDraftIndicator({
  hideIdleLabel = false,
  isWorking,
  size,
}: {
  hideIdleLabel?: boolean;
  isWorking: boolean;
  size: "default" | "compact";
}) {
  const label = getThreadListIndicatorLabel(
    isWorking ? "working-draft" : "draft",
  );
  return (
    <Icon
      name="Edit"
      className={cn(
        "pointer-events-none shrink-0",
        size === "compact" ? "size-3.5" : SIDEBAR_STATUS_ICON_CLASS,
        isWorking
          ? ["animate-shine-icon", SIDEBAR_WORKING_STATUS_COLOR_CLASS]
          : "text-muted-foreground",
      )}
      {...(!isWorking && hideIdleLabel
        ? { "aria-hidden": true }
        : { "aria-label": label ?? undefined })}
    />
  );
}

interface ThreadStatusResolution {
  accessibleLabel: string | null;
  indicatorKind: ThreadListIndicatorKind | "archived";
}

export function resolveThreadStatus(
  statusProps: ThreadListIndicatorState,
  archived = false,
): ThreadStatusResolution {
  const indicatorKind = archived
    ? "archived"
    : resolveThreadListIndicator(statusProps);
  return {
    accessibleLabel:
      indicatorKind === "archived"
        ? "Archived thread"
        : getThreadListIndicatorLabel(indicatorKind),
    indicatorKind,
  };
}

export interface ThreadStatusGlyphProps extends ThreadListIndicatorState {
  archived?: boolean;
  hideIdleDraftLabel?: boolean;
  size?: "default" | "compact";
}

export function ThreadStatusGlyph({
  archived = false,
  hasPendingInteraction,
  hasUnsubmittedDraft,
  hasUnreadError,
  hasUnreadSuccess,
  hideIdleDraftLabel = false,
  isBackgroundAgentActive,
  isBackgroundCommandActive,
  isGoalActive,
  isPlanModeActive,
  isRuntimeActive,
  isWorkflowActive,
  queuedWork,
  size = "default",
}: ThreadStatusGlyphProps) {
  const iconSizeClass =
    size === "compact" ? "size-3.5" : SIDEBAR_STATUS_ICON_CLASS;
  const { indicatorKind: kind } = resolveThreadStatus(
    {
      hasPendingInteraction,
      hasUnsubmittedDraft,
      hasUnreadError,
      hasUnreadSuccess,
      isBackgroundAgentActive,
      isBackgroundCommandActive,
      isGoalActive,
      isPlanModeActive,
      isRuntimeActive,
      isWorkflowActive,
      queuedWork,
    },
    archived,
  );

  switch (kind) {
    case "archived":
      return (
        <Icon
          name="Archive"
          className={iconSizeClass}
          aria-label="Archived thread"
        />
      );
    case "unread-error":
    case "queued-failed":
      return (
        <Icon
          name="CircleX"
          className={cn("text-destructive", iconSizeClass)}
          aria-label={getThreadListIndicatorLabel(kind) ?? undefined}
        />
      );
    case "waiting-for-input":
    case "queued-waiting":
      return (
        <Icon
          name={WAITING_ICONS[kind]}
          className={cn("text-muted-foreground/75", iconSizeClass)}
          aria-label={getThreadListIndicatorLabel(kind) ?? undefined}
        />
      );
    case "working-draft":
      return <ThreadDraftIndicator isWorking size={size} />;
    case "workflow":
    case "background-agent":
    case "background-command":
    case "plan-mode":
    case "goal":
      return (
        <Icon
          name={WORKING_ACTIVITY_ICONS[kind]}
          className={cn(
            "animate-shine-icon",
            SIDEBAR_WORKING_STATUS_COLOR_CLASS,
            iconSizeClass,
          )}
          aria-label={getThreadListIndicatorLabel(kind) ?? undefined}
        />
      );
    case "runtime":
      return (
        <Icon
          name="Loading"
          className={cn(
            "animate-spin motion-reduce:animate-none",
            SIDEBAR_WORKING_STATUS_COLOR_CLASS,
            iconSizeClass,
          )}
          aria-label={getThreadListIndicatorLabel(kind) ?? undefined}
        />
      );
    case "draft":
      return (
        <ThreadDraftIndicator
          hideIdleLabel={hideIdleDraftLabel}
          isWorking={false}
          size={size}
        />
      );
    case "unread-success":
      return (
        <span
          className={SIDEBAR_SUCCESS_STATUS_DOT_CLASS}
          aria-label={getThreadListIndicatorLabel(kind) ?? undefined}
        />
      );
    case "none":
      return null;
  }
}
