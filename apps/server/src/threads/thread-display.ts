import {
  clampPermissionModeToCeiling,
  DEFAULT_COMPLETED_TURN_DISPLAY,
  permissionModeSchema,
  reasoningLevelSchema,
  serviceTierSchema,
  type AppSettings,
  type CompletedTurnDisplay,
  type EnvironmentWorkspaceDisplayKind,
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
  type ThreadEventWithMeta,
} from "@bb/thread-view";
import {
  activeBackgroundTaskCounts,
  decodeEventWithMeta,
  listGoalStateEvents,
  listOpenAcceptedInputs,
  listTurnRequestsByIds,
} from "../db/event-read.js";
import type { Db } from "../db/index.js";
import {
  canRestoreEnvironment,
  canThreadSpawnChild,
  getProjectExecutionDefaults,
  hostPermissionCeiling,
  listQueueCounts,
  toThread,
  type ThreadListRow,
  type ThreadRow,
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
const PROVIDER_DISPLAYS: Record<string, ProviderDisplay> = {
  codex: {
    displayName: "Codex",
    completedTurnDisplay: "collapse",
    planCommand: PLAN_COMMAND,
  },
  "claude-code": {
    displayName: "Claude Code",
    completedTurnDisplay: "flat",
    planCommand: PLAN_COMMAND,
  },
  echo: {
    displayName: "Echo",
    completedTurnDisplay: "collapse",
    planCommand: null,
  },
};
const UNKNOWN_PROVIDER_DISPLAY: ProviderDisplay = {
  displayName: undefined,
  completedTurnDisplay: DEFAULT_COMPLETED_TURN_DISPLAY,
  planCommand: null,
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
  const display = PROVIDER_DISPLAYS[providerId] ?? UNKNOWN_PROVIDER_DISPLAY;
  const chosen = settings?.providerCompletedTurnDisplay[providerId];
  return chosen === undefined
    ? display
    : { ...display, completedTurnDisplay: chosen };
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

function workspaceDisplayKind(
  row: ThreadListRow,
): EnvironmentWorkspaceDisplayKind {
  if (row.environmentProviderId === "git-worktree") return "managed-worktree";
  return row.environmentIsWorktree === 1 ? "unmanaged-worktree" : "other";
}

function eventsByThread(
  rows: ReturnType<typeof listGoalStateEvents>,
): Map<string, ThreadEventWithMeta[]> {
  const grouped = new Map<string, ThreadEventWithMeta[]>();
  for (const row of rows) {
    const events = grouped.get(row.threadId) ?? [];
    events.push(decodeEventWithMeta(row));
    grouped.set(row.threadId, events);
  }
  return grouped;
}

function hasActivePlanTurn(db: Db, thread: ThreadRow): boolean {
  const { planCommand } = providerDisplay(thread.providerId);
  if (thread.status !== "active" || planCommand === null) return false;
  const accepted = listOpenAcceptedInputs(db, [thread.id]);
  const requestIds = accepted.flatMap((row) => {
    const { event } = decodeEventWithMeta(row);
    return event.type === "turn/input/accepted" ? [event.clientRequestId] : [];
  });
  const requests = listTurnRequestsByIds(db, thread.id, requestIds);
  const events = [...requests, ...accepted]
    .sort((left, right) => left.sequence - right.sequence)
    .map(decodeEventWithMeta);
  const { providerId, status: threadStatus } = thread;
  const args = { events, planCommand, providerId, threadStatus };
  return extractThreadTimelineActivePlanTurn(args) !== null;
}

export function threadActivities(
  db: Db,
  threads: readonly ThreadRow[],
): Map<string, ThreadActivityState> {
  const threadIds = threads.map((thread) => thread.id);
  const activities = new Map<string, ThreadActivityState>();
  for (const { threadId, ...counts } of activeBackgroundTaskCounts(
    db,
    threadIds,
  )) {
    activities.set(threadId, { ...NO_ACTIVITY, ...counts });
  }
  const goals = eventsByThread(listGoalStateEvents(db, threadIds));
  for (const thread of threads) {
    const goal = extractThreadTimelineGoal(goals.get(thread.id) ?? []);
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
  const queues = new Map(
    listQueueCounts(deps.db, threadIds).map((counts) => [
      counts.threadId,
      counts.failed > 0 ? ("failed" as const) : ("waiting" as const),
    ]),
  );
  return rows.map((row) => ({
    ...toThread(row),
    activity: activities.get(row.id) ?? NO_ACTIVITY,
    queuedWork: queues.get(row.id) ?? "none",
    pinSortKey: row.pinSortKey,
    environmentBranchName: row.environmentBranchName,
    environmentHostId: row.environmentHostId,
    environmentName: row.environmentName,
    environmentPath: row.environmentPath,
    environmentProviderId: row.environmentProviderId,
    environmentIsWorktree:
      row.environmentIsWorktree === null
        ? null
        : row.environmentIsWorktree === 1,
    environmentWorkspaceDisplayKind: workspaceDisplayKind(row),
    hasPendingInteraction: row.hasPendingInteraction === 1,
    runtime: { displayStatus: threadDisplayStatus(row, deps.isHostConnected) },
  }));
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
    canSpawnChild: canThreadSpawnChild(db, row),
    queuedMessageCount: queue?.queued ?? 0,
  };
}

function parentPermissionMode(db: Db, thread: ThreadRow): string | null {
  if (thread.parentThreadId === null) return null;
  const parent = db.get<{ permissionMode: string | null }>(
    `SELECT permission_mode FROM threads
     WHERE id = ? AND archived_at IS NULL AND deleted_at IS NULL`,
    thread.parentThreadId,
  );
  return parent?.permissionMode ?? null;
}

export function threadDefaultExecution(
  db: Db,
  thread: ThreadListRow,
  settings: AppSettings,
): ResolvedThreadExecutionOptions | null {
  const stored = getProjectExecutionDefaults(db, thread.projectId);
  const defaults = stored?.providerId === thread.providerId ? stored : null;
  const model = thread.modelOverride ?? thread.model ?? defaults?.model;
  if (model === undefined) return null;
  const permissionMode = permissionModeSchema.parse(
    thread.permissionMode ??
      parentPermissionMode(db, thread) ??
      defaults?.permissionMode ??
      "auto",
  );
  const ceiling = hostPermissionCeiling(db, thread.environmentHostId);
  const tier = thread.serviceTier ?? defaults?.serviceTier ?? "default";
  return {
    model,
    permissionMode:
      clampPermissionModeToCeiling({ ceiling, permissionMode }) ?? ceiling,
    reasoningLevel: reasoningLevelSchema.parse(
      thread.reasoningLevelOverride ??
        thread.reasoningLevel ??
        defaults?.reasoningLevel ??
        "medium",
    ),
    serviceTier: serviceTierSchema.parse(
      settings.allowFastServiceTier ? tier : "default",
    ),
    source: "client/turn/requested",
  };
}
