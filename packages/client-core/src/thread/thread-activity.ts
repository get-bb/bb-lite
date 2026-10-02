import type { ThreadListEntry, ThreadQueuedWork } from "@bb/domain";
import { isRunningThreadRuntimeDisplayStatus } from "../timeline/thread-runtime-status.js";
import { isThreadRead } from "./thread-read-state.js";

export interface ThreadListIndicatorState {
  hasPendingInteraction: boolean;
  hasUnsubmittedDraft: boolean;
  hasUnreadError: boolean;
  hasUnreadSuccess: boolean;
  isBackgroundAgentActive: boolean;
  isBackgroundCommandActive: boolean;
  isGoalActive: boolean;
  isRuntimeActive: boolean;
  isWorkflowActive: boolean;
  queuedWork: ThreadQueuedWork;
}

const THREAD_LIST_INDICATOR_LABELS = {
  "unread-error": "Unread thread failed",
  "waiting-for-input": "Thread needs user input",
  "working-draft": "Thread working with unsubmitted draft",
  workflow: "Workflow running",
  "background-agent": "Background agent running",
  "background-command": "Background command running",
  goal: "Goal active",
  runtime: "Thread working",
  "queued-failed": "Queued message failed to send",
  "queued-waiting": "Thread has a message waiting to send",
  draft: "Thread has unsubmitted draft",
  "unread-success": "Unread thread succeeded",
};

export type ThreadListIndicatorKind =
  | keyof typeof THREAD_LIST_INDICATOR_LABELS
  | "none";

export function getThreadListIndicatorLabel(
  kind: ThreadListIndicatorKind,
): string | null {
  return kind === "none" ? null : THREAD_LIST_INDICATOR_LABELS[kind];
}

export function hasThreadListWorkingActivity(
  state: ThreadListIndicatorState,
): boolean {
  return (
    state.isRuntimeActive ||
    state.isWorkflowActive ||
    state.isBackgroundAgentActive ||
    state.isBackgroundCommandActive ||
    state.isGoalActive
  );
}

export function threadListIndicatorStateForThread(
  thread: ThreadListEntry,
  hasUnsubmittedDraft: boolean,
): ThreadListIndicatorState {
  const { activity, status } = thread;
  const unreadDone =
    thread.parentThreadId == null &&
    (status === "error" || status === "idle") &&
    !isThreadRead(thread);
  return {
    hasPendingInteraction: thread.hasPendingInteraction,
    hasUnsubmittedDraft,
    hasUnreadError: unreadDone && status === "error",
    hasUnreadSuccess: unreadDone && status !== "error",
    isBackgroundAgentActive: activity.activeBackgroundAgentCount > 0,
    isBackgroundCommandActive: activity.activeBackgroundCommandCount > 0,
    isGoalActive: activity.activeGoalCount > 0,
    queuedWork: thread.queuedWork,
    isRuntimeActive: isRunningThreadRuntimeDisplayStatus(
      thread.runtime.displayStatus,
    ),
    isWorkflowActive: activity.activeWorkflowCount > 0,
  };
}

export function resolveThreadListIndicator(
  state: ThreadListIndicatorState,
): ThreadListIndicatorKind {
  if (state.hasUnreadError) return "unread-error";
  if (state.hasPendingInteraction) return "waiting-for-input";
  if (state.hasUnsubmittedDraft && hasThreadListWorkingActivity(state)) {
    return "working-draft";
  }
  if (state.isGoalActive) return "goal";
  if (state.isRuntimeActive) return "runtime";
  if (state.isWorkflowActive) return "workflow";
  if (state.isBackgroundAgentActive) return "background-agent";
  if (state.isBackgroundCommandActive) return "background-command";
  if (state.queuedWork === "failed") return "queued-failed";
  if (state.hasUnreadSuccess) return "unread-success";
  if (state.queuedWork === "waiting") return "queued-waiting";
  if (state.hasUnsubmittedDraft) return "draft";
  return "none";
}
