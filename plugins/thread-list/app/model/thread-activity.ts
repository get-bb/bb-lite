import {
  isRunningThreadRuntimeDisplayStatus,
  type ThreadListIndicatorState,
} from "@bb/client-core";
import type { PluginSidebarThread } from "@bb/plugin/app";

const NO_THREAD_ACTIVITY: ThreadListIndicatorState = {
  hasPendingInteraction: false,
  hasUnsubmittedDraft: false,
  hasUnreadError: false,
  hasUnreadSuccess: false,
  isBackgroundAgentActive: false,
  isBackgroundCommandActive: false,
  isGoalActive: false,
  isRuntimeActive: false,
  isWorkflowActive: false,
  queuedWork: "none",
};

export function threadIndicatorState(
  thread: PluginSidebarThread,
  hasUnsubmittedDraft: boolean,
): ThreadListIndicatorState {
  const unreadDone =
    thread.parentThreadId === null &&
    thread.isUnread &&
    (thread.status === "error" || thread.status === "idle");
  return {
    hasPendingInteraction: thread.hasPendingInteraction,
    hasUnsubmittedDraft,
    hasUnreadError: unreadDone && thread.status === "error",
    hasUnreadSuccess: unreadDone && thread.status !== "error",
    isBackgroundAgentActive: thread.activity.backgroundAgents > 0,
    isBackgroundCommandActive: thread.activity.backgroundCommands > 0,
    isGoalActive: thread.activity.goals > 0,
    isRuntimeActive: isRunningThreadRuntimeDisplayStatus(thread.runtimeStatus),
    isWorkflowActive: thread.activity.workflows > 0,
    queuedWork: thread.queuedWork,
  };
}

export function mergeThreadActivity(
  base: ThreadListIndicatorState,
  extra: ThreadListIndicatorState,
): ThreadListIndicatorState {
  return {
    hasPendingInteraction:
      base.hasPendingInteraction || extra.hasPendingInteraction,
    hasUnsubmittedDraft: base.hasUnsubmittedDraft || extra.hasUnsubmittedDraft,
    hasUnreadError: base.hasUnreadError || extra.hasUnreadError,
    hasUnreadSuccess: base.hasUnreadSuccess || extra.hasUnreadSuccess,
    isBackgroundAgentActive:
      base.isBackgroundAgentActive || extra.isBackgroundAgentActive,
    isBackgroundCommandActive:
      base.isBackgroundCommandActive || extra.isBackgroundCommandActive,
    isGoalActive: base.isGoalActive || extra.isGoalActive,
    isRuntimeActive: base.isRuntimeActive || extra.isRuntimeActive,
    isWorkflowActive: base.isWorkflowActive || extra.isWorkflowActive,
    queuedWork: base.queuedWork,
  };
}

const NO_DRAFT_THREAD_IDS: ReadonlySet<string> = new Set();

export function rollupThreadActivity(
  threads: readonly PluginSidebarThread[],
  draftThreadIds: ReadonlySet<string> = NO_DRAFT_THREAD_IDS,
): ThreadListIndicatorState {
  return threads.reduce(
    (rollup, thread) =>
      mergeThreadActivity(
        rollup,
        threadIndicatorState(thread, draftThreadIds.has(thread.id)),
      ),
    NO_THREAD_ACTIVITY,
  );
}
