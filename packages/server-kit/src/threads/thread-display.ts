import * as domain from "@bb/domain";
import type { ThreadResponse } from "@bb/server-contract";
import { extractThreadTimelineGoal } from "@bb/thread-view";
import type { ServerContext } from "../context.js";
import * as eventRead from "../db/event-read.js";
import type { Db } from "../db/index.js";
import { getProjectExecutionDefaults, withSources } from "../db/projects.js";
import {
  listQueueCounts,
  listSidebarThreadRows,
  type ThreadListRow,
} from "../db/thread-read.js";
import { ancestry, MAX_THREAD_HIERARCHY_DEPTH } from "../db/threads.js";

type DisplayContext = Pick<ServerContext, "db" | "runners">;

const NO_ACTIVITY: domain.ThreadActivityState = {
  activeBackgroundAgentCount: 0,
  activeBackgroundCommandCount: 0,
  activeGoalCount: 0,
  activePlanModeCount: 0,
  activeWorkflowCount: 0,
};

function threadDisplayStatus(
  { runners }: DisplayContext,
  row: ThreadListRow,
): domain.ThreadRuntimeDisplayStatus {
  const { status, environmentHostId, environmentStatus } = row;
  const preparing =
    environmentStatus === "creating" || environmentStatus === "provisioning";
  if (status === "starting" && preparing) return "provisioning";
  const hostGone =
    environmentHostId !== null && !runners.isConnected(environmentHostId);
  return status === "active" && hostGone ? "waiting-for-host" : status;
}

function threadActivities(db: Db, threads: readonly ThreadListRow[]) {
  const threadIds = threads.map((thread) => thread.id);
  const activities = new Map(
    eventRead
      .activeBackgroundTaskCounts(db, threadIds)
      .map(({ threadId, ...counts }) => [
        threadId,
        { ...NO_ACTIVITY, ...counts },
      ]),
  );
  const goals = eventRead.listHeadStateEvents(db, threadIds, "goal");
  for (const thread of threads) {
    const states = goals.filter((row) => row.threadId === thread.id);
    const goal = extractThreadTimelineGoal(eventRead.decodeEvents(db, states));
    if (goal?.status !== "active") continue;
    const activity = activities.get(thread.id) ?? NO_ACTIVITY;
    activities.set(thread.id, { ...activity, activeGoalCount: 1 });
  }
  return activities;
}

export function toThreadListEntries(
  ctx: DisplayContext,
  rows: readonly ThreadListRow[],
): domain.ThreadListEntry[] {
  const threadIds = rows.map((row) => row.id);
  const activities = threadActivities(ctx.db, rows);
  const failedQueues = new Map(
    listQueueCounts(ctx.db, threadIds).map((queue) => [
      queue.threadId,
      queue.failed > 0,
    ]),
  );
  return rows.map((row) => {
    const worktree = row.environmentIsWorktree;
    const managed = row.environmentProviderId === "git-worktree";
    const unmanaged = worktree === 1 ? "unmanaged-worktree" : "other";
    const failed = failedQueues.get(row.id);
    const queued = failed === true ? "failed" : "waiting";
    return {
      ...domain.threadSchema.parse(row),
      activity: activities.get(row.id) ?? NO_ACTIVITY,
      queuedWork: failed === undefined ? "none" : queued,
      pinSortKey: row.pinSortKey,
      environmentBranchName: row.environmentBranchName,
      environmentHostId: row.environmentHostId,
      environmentName: row.environmentName,
      environmentPath: row.environmentPath,
      environmentProviderId: row.environmentProviderId,
      environmentIsWorktree: worktree === null ? null : worktree === 1,
      environmentWorkspaceDisplayKind: managed ? "managed-worktree" : unmanaged,
      hasPendingInteraction: row.hasPendingInteraction === 1,
      runtime: { displayStatus: threadDisplayStatus(ctx, row) },
    };
  });
}

export function toThreadResponse(
  ctx: DisplayContext,
  row: ThreadListRow,
): ThreadResponse {
  const { db } = ctx;
  const [counts] = eventRead.activeBackgroundTaskCounts(db, [row.id]);
  const [queue] = listQueueCounts(db, [row.id]);
  return {
    ...domain.threadSchema.parse(row),
    runtime: { displayStatus: threadDisplayStatus(ctx, row) },
    activeBackgroundAgentCount: counts?.activeBackgroundAgentCount ?? 0,
    canRestoreEnvironment: false,
    canSpawnChild: ancestry(db, row).length < MAX_THREAD_HIERARCHY_DEPTH,
    queuedMessageCount: queue?.queued ?? 0,
  };
}

export function listProjectsWithThreads(
  ctx: DisplayContext,
  projects: domain.Project[],
) {
  const { db } = ctx;
  const entries = toThreadListEntries(ctx, listSidebarThreadRows(db));
  return withSources(db, projects).map((project) => ({
    ...project,
    threads: entries.filter((thread) => thread.projectId === project.id),
    defaultExecutionOptions: getProjectExecutionDefaults(db, project.id),
  }));
}
