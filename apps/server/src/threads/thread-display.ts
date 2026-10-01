import {
  DEFAULT_COMPLETED_TURN_DISPLAY,
  resolvedThreadExecutionOptionsSchema,
  type AppSettings,
  type CompletedTurnDisplay,
  type ProviderComposerCommand,
  type ResolvedThreadExecutionOptions,
  type ThreadActivityState,
  type ThreadListEntry,
  type ThreadRuntimeDisplayStatus,
} from "@bb/domain";
import type { ThreadResponse } from "@bb/server-contract";
import {
  extractThreadTimelineActivePlanTurn,
  extractThreadTimelineGoal,
} from "@bb/thread-view";
import {
  activeBackgroundTaskCounts,
  decodeEvents,
  listEvents,
  listHeadStateEvents,
  mergeEventRows,
  OPEN_TURN,
} from "../db/event-read.js";
import type { Db } from "../db/index.js";
import {
  canThreadSpawnChild,
  findEnvironment,
  listQueueCounts,
  toThread,
  type ThreadListRow,
} from "../db/thread-read.js";

export interface ThreadDisplayDeps {
  db: Db;
  isHostConnected(hostId: string): boolean;
}

export interface ProviderDisplay {
  displayName: string | undefined;
  completedTurnDisplay: CompletedTurnDisplay;
  planCommand: ProviderComposerCommand | null;
}

const PLAN_COMMAND: ProviderComposerCommand = {
  trigger: "/",
  name: "plan",
  trailingText: " ",
};
const PROVIDER_DISPLAYS: Record<string, [string, CompletedTurnDisplay]> = {
  codex: ["Codex", "collapse"],
  "claude-code": ["Claude Code", "flat"],
};
const NO_ACTIVITY: ThreadActivityState = {
  activeBackgroundAgentCount: 0,
  activeBackgroundCommandCount: 0,
  activeGoalCount: 0,
  activePlanModeCount: 0,
  activeWorkflowCount: 0,
};

export function providerDisplay(
  providerId: string,
  settings?: AppSettings,
): ProviderDisplay {
  const known = PROVIDER_DISPLAYS[providerId];
  return {
    displayName: known?.[0],
    completedTurnDisplay:
      settings?.providerCompletedTurnDisplay[providerId] ??
      known?.[1] ??
      DEFAULT_COMPLETED_TURN_DISPLAY,
    planCommand: known === undefined ? null : PLAN_COMMAND,
  };
}

export function threadDisplayStatus(
  row: ThreadListRow,
  isHostConnected: (hostId: string) => boolean,
): ThreadRuntimeDisplayStatus {
  const { status, environmentHostId, environmentStatus } = row;
  const preparing =
    environmentStatus === "creating" || environmentStatus === "provisioning";
  if (status === "starting" && preparing) return "provisioning";
  const hostGone =
    environmentHostId !== null && !isHostConnected(environmentHostId);
  return status === "active" && hostGone ? "waiting-for-host" : status;
}

function hasActivePlanTurn(db: Db, thread: ThreadListRow): boolean {
  const { id: threadId, providerId, status: threadStatus } = thread;
  const { planCommand } = providerDisplay(providerId);
  if (threadStatus !== "active" || planCommand === null) return false;
  const types = ["turn/input/accepted"];
  const accepted = listEvents(db, { threadId, types, where: OPEN_TURN });
  const requestIds = decodeEvents(db, accepted).flatMap(({ event }) =>
    event.type === "turn/input/accepted" ? [event.clientRequestId] : [],
  );
  const requested = { threadId, requestIds, types: ["client/turn/requested"] };
  const rows = mergeEventRows([...listEvents(db, requested), ...accepted]);
  const events = decodeEvents(db, rows);
  const args = { events, planCommand, providerId, threadStatus };
  return extractThreadTimelineActivePlanTurn(args) !== null;
}

export function threadActivities(
  db: Db,
  threads: readonly ThreadListRow[],
): Map<string, ThreadActivityState> {
  const threadIds = threads.map((thread) => thread.id);
  const activities = new Map(
    activeBackgroundTaskCounts(db, threadIds).map(({ threadId, ...counts }) => [
      threadId,
      { ...NO_ACTIVITY, ...counts },
    ]),
  );
  const goals = listHeadStateEvents(db, threadIds, "goal");
  for (const thread of threads) {
    const states = goals.filter((row) => row.threadId === thread.id);
    const goal = extractThreadTimelineGoal(decodeEvents(db, states));
    const activeGoalCount = goal?.status === "active" ? 1 : 0;
    const activePlanModeCount = hasActivePlanTurn(db, thread) ? 1 : 0;
    if (activeGoalCount + activePlanModeCount === 0) continue;
    const activity = activities.get(thread.id) ?? NO_ACTIVITY;
    const merged = { ...activity, activeGoalCount, activePlanModeCount };
    activities.set(thread.id, merged);
  }
  return activities;
}

export function toThreadListEntries(
  deps: ThreadDisplayDeps,
  rows: readonly ThreadListRow[],
): ThreadListEntry[] {
  const threadIds = rows.map((row) => row.id);
  const activities = threadActivities(deps.db, rows);
  const failedQueues = new Map(
    listQueueCounts(deps.db, threadIds).map((queue) => [
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
      ...toThread(row),
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
      runtime: {
        displayStatus: threadDisplayStatus(row, deps.isHostConnected),
      },
    };
  });
}

function canRestoreEnvironment(db: Db, thread: ThreadListRow): boolean {
  const settled = thread.status === "idle" || thread.status === "error";
  const destroyed = thread.environmentStatus === "destroyed";
  if (thread.archivedAt !== null || !settled || !destroyed) return false;
  const environment = findEnvironment(db, thread.environmentId ?? "");
  return (
    environment?.environmentProviderId === "git-worktree" &&
    environment.environmentProviderSelection !== null &&
    environment.hostLifecycle === "active"
  );
}

export function toThreadResponse(
  deps: ThreadDisplayDeps,
  row: ThreadListRow,
): ThreadResponse {
  const { db } = deps;
  const [counts] = activeBackgroundTaskCounts(db, [row.id]);
  const [queue] = listQueueCounts(db, [row.id]);
  return {
    ...toThread(row),
    runtime: { displayStatus: threadDisplayStatus(row, deps.isHostConnected) },
    activeBackgroundAgentCount: counts?.activeBackgroundAgentCount ?? 0,
    canRestoreEnvironment: canRestoreEnvironment(db, row),
    canSpawnChild: canThreadSpawnChild(db, row.id),
    queuedMessageCount: queue?.queued ?? 0,
  };
}

export function threadDefaultExecution(
  thread: ThreadListRow,
  settings: AppSettings,
): ResolvedThreadExecutionOptions | null {
  const model = thread.modelOverride ?? thread.model;
  if (model === null) return null;
  const { reasoningLevelOverride, reasoningLevel, permissionMode } = thread;
  const tier = settings.allowFastServiceTier ? thread.serviceTier : null;
  return resolvedThreadExecutionOptionsSchema.parse({
    model,
    permissionMode: permissionMode ?? "auto",
    reasoningLevel: reasoningLevelOverride ?? reasoningLevel ?? "medium",
    serviceTier: tier ?? "default",
    source: "client/turn/requested",
  });
}
