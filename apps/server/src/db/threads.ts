import {
  evaluateThreadLifecycleEvent,
  LOCAL_AGENT_TASK_TYPE,
  LOCAL_BASH_TASK_TYPE,
  LOCAL_SUBAGENT_TASK_TYPE,
  LOCAL_WORKFLOW_TASK_TYPE,
  type PermissionMode,
  type ReasoningLevel,
  type ServiceTier,
  type ThreadActivityState,
  type ThreadLifecycleEventType,
  type ThreadListEntry,
  type ThreadLifecycleNoopReason,
  type ThreadOriginKind,
  type ThreadRuntimeState,
  type ThreadStatus,
  type ThreadVisibility,
} from "@bb/domain";
import type { ThreadResponse } from "@bb/server-contract";
import { upsertSearchSegment } from "./events.js";
import { newId, type Db, type SqlValue } from "./index.js";
import { orderKeyBetween } from "./order-keys.js";

export interface ThreadRow {
  id: string;
  projectId: string;
  environmentId: string | null;
  providerId: string;
  providerThreadId: string | null;
  activeTurnId: string | null;
  model: string | null;
  reasoningLevel: ReasoningLevel | null;
  permissionMode: PermissionMode | null;
  serviceTier: ServiceTier | null;
  modelOverride: string | null;
  reasoningLevelOverride: ReasoningLevel | null;
  title: string | null;
  titleFallback: string | null;
  sectionId: string | null;
  status: ThreadStatus;
  startupContext: string | null;
  parentThreadId: string | null;
  lifecycleOwnerThreadId: string | null;
  sourceThreadId: string | null;
  originKind: ThreadOriginKind | null;
  originPluginId: string | null;
  visibility: ThreadVisibility;
  archivedAt: number | null;
  pinnedAt: number | null;
  pinSortKey: string | null;
  deletedAt: number | null;
  storageDeletedAt: number | null;
  lastReadAt: number | null;
  latestAttentionAt: number;
  createdAt: number;
  updatedAt: number;
}

export type NewThread = Pick<
  ThreadRow,
  | "projectId"
  | "providerId"
  | "model"
  | "reasoningLevel"
  | "permissionMode"
  | "serviceTier"
  | "title"
  | "titleFallback"
  | "sectionId"
  | "startupContext"
  | "parentThreadId"
  | "lifecycleOwnerThreadId"
  | "originPluginId"
  | "visibility"
> & { pinned: boolean };

export type ThreadPatch = Partial<
  Pick<
    ThreadRow,
    | "environmentId"
    | "providerThreadId"
    | "activeTurnId"
    | "model"
    | "reasoningLevel"
    | "permissionMode"
    | "serviceTier"
    | "modelOverride"
    | "reasoningLevelOverride"
    | "title"
    | "sectionId"
    | "startupContext"
    | "parentThreadId"
    | "visibility"
    | "archivedAt"
    | "pinnedAt"
    | "pinSortKey"
    | "deletedAt"
    | "storageDeletedAt"
    | "lastReadAt"
  >
>;

export type LifecycleOutcome =
  | { applied: true; from: ThreadStatus; thread: ThreadRow }
  | {
      applied: false;
      reason: "missing" | "cas-conflict" | ThreadLifecycleNoopReason;
    };

export const MAX_THREAD_HIERARCHY_DEPTH = 4;
const LIVE = "deleted_at IS NULL";

function snakeCase(key: string): string {
  return key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

export function getThread(db: Db, id: string): ThreadRow | undefined {
  return db.get<ThreadRow>("SELECT * FROM threads WHERE id = ?", id);
}

function nextPinSortKey(db: Db): string {
  const last = db.get<{ key: string | null }>(
    "SELECT MAX(pin_sort_key) AS key FROM threads WHERE pinned_at IS NOT NULL",
  );
  return orderKeyBetween(last?.key ?? null, null);
}

function syncTitleSearch(db: Db, thread: ThreadRow): void {
  upsertSearchSegment(db, thread.id, "title", "title", null, thread.title);
  const fallback = thread.titleFallback;
  const kind = "title_fallback";
  upsertSearchSegment(db, thread.id, kind, kind, null, fallback);
}

export function insertThread(db: Db, input: NewThread): ThreadRow {
  const { pinned, ...columns } = input;
  const now = db.now();
  const row: Record<string, SqlValue> = {
    ...columns,
    id: newId("thr"),
    status: "pending",
    pinnedAt: pinned ? now : null,
    pinSortKey: pinned ? nextPinSortKey(db) : null,
    lastReadAt: now,
    latestAttentionAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const keys = Object.keys(row);
  db.run(
    `INSERT INTO threads (${keys.map(snakeCase).join(", ")})
     VALUES (${keys.map((key) => `@${key}`).join(", ")})`,
    row,
  );
  const thread = getThread(db, String(row.id));
  if (thread === undefined) throw new Error("Thread insert was lost");
  syncTitleSearch(db, thread);
  return thread;
}

export function patchThread(
  db: Db,
  id: string,
  patch: ThreadPatch,
  touch = true,
): ThreadRow | undefined {
  const values: Record<string, SqlValue> = { ...patch, id };
  const assignments = Object.keys(patch).map(
    (key) => `${snakeCase(key)} = @${key}`,
  );
  if (touch) {
    assignments.push("updated_at = @updatedAt");
    values.updatedAt = db.now();
  }
  if (assignments.length > 0) {
    const sets = assignments.join(", ");
    db.run(`UPDATE threads SET ${sets} WHERE id = @id`, values);
  }
  const thread = getThread(db, id);
  if (thread !== undefined && "title" in patch) syncTitleSearch(db, thread);
  return thread;
}

function needsAttention(thread: ThreadRow, to: ThreadStatus): boolean {
  if (to === "error") return true;
  const finished = thread.status === "active" && to === "idle";
  return finished && thread.parentThreadId === null;
}

export function applyLifecycleEvent(
  db: Db,
  id: string,
  type: ThreadLifecycleEventType,
): LifecycleOutcome {
  const thread = getThread(db, id);
  if (thread === undefined) return { applied: false, reason: "missing" };
  const verdict = evaluateThreadLifecycleEvent({ event: { type }, thread });
  if ("noop" in verdict) return { applied: false, reason: verdict.noop };
  const { to } = verdict;
  const now = db.now();
  const settled = to === "idle" || to === "error";
  const started = to === "active" || (to === "idle" && thread.environmentId);
  const next: ThreadRow = {
    ...thread,
    status: to,
    updatedAt: now,
    latestAttentionAt: needsAttention(thread, to)
      ? now
      : thread.latestAttentionAt,
    activeTurnId: settled ? null : thread.activeTurnId,
    startupContext: started ? null : thread.startupContext,
  };
  const { changes } = db.run(
    `UPDATE threads
     SET status = ?, updated_at = ?, latest_attention_at = ?,
         active_turn_id = ?, startup_context = ?
     WHERE id = ? AND status = ?`,
    next.status,
    next.updatedAt,
    next.latestAttentionAt,
    next.activeTurnId,
    next.startupContext,
    id,
    thread.status,
  );
  if (changes === 0) return { applied: false, reason: "cas-conflict" };
  return { applied: true, from: thread.status, thread: next };
}

export function listChildThreads(db: Db, parentThreadId: string): ThreadRow[] {
  return db.all<ThreadRow>(
    `SELECT * FROM threads WHERE parent_thread_id = ? AND ${LIVE}`,
    parentThreadId,
  );
}

function listLifecycleDependents(db: Db, ownerThreadId: string): ThreadRow[] {
  return db.all<ThreadRow>(
    "SELECT * FROM threads WHERE lifecycle_owner_thread_id = ?",
    ownerThreadId,
  );
}

function collectTree(
  db: Db,
  root: ThreadRow,
  dependents: (thread: ThreadRow) => ThreadRow[],
): ThreadRow[] {
  const ordered: ThreadRow[] = [];
  const seen = new Set<string>();
  const visit = (thread: ThreadRow): void => {
    if (seen.has(thread.id)) return;
    seen.add(thread.id);
    for (const dependent of dependents(thread)) visit(dependent);
    ordered.push(thread);
  };
  visit(root);
  return ordered;
}

export function listArchiveTree(db: Db, root: ThreadRow): ThreadRow[] {
  return collectTree(db, root, (thread) => [
    ...listLifecycleDependents(db, thread.id),
    ...listChildThreads(db, thread.id),
  ]);
}

export function listLifecycleTree(db: Db, root: ThreadRow): ThreadRow[] {
  return collectTree(db, root, (thread) =>
    listLifecycleDependents(db, thread.id),
  );
}

export function ancestorDepth(db: Db, thread: ThreadRow): number {
  const seen = new Set<string>();
  let current: ThreadRow | undefined = thread;
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    current =
      current.parentThreadId === null
        ? undefined
        : getThread(db, current.parentThreadId);
  }
  return seen.size;
}

export function subtreeDepth(db: Db, thread: ThreadRow): number {
  const depths = listChildThreads(db, thread.id).map((child) =>
    subtreeDepth(db, child),
  );
  return 1 + Math.max(0, ...depths);
}

export function isAncestor(db: Db, ancestorId: string, thread: ThreadRow) {
  let current: ThreadRow | undefined = thread;
  for (let hops = 0; current !== undefined && hops < 64; hops += 1) {
    if (current.id === ancestorId) return true;
    current =
      current.parentThreadId === null
        ? undefined
        : getThread(db, current.parentThreadId);
  }
  return false;
}

export function listThreadsOnHost(
  db: Db,
  hostId: string,
  statuses: readonly ThreadStatus[],
): ThreadRow[] {
  const marks = statuses.map(() => "?").join(", ");
  return db.all<ThreadRow>(
    `SELECT t.* FROM threads t
     JOIN environments e ON e.id = t.environment_id
     WHERE e.host_id = ? AND t.status IN (${marks}) AND t.${LIVE}`,
    hostId,
    ...statuses,
  );
}

export function listStartingWithoutEnvironment(db: Db): ThreadRow[] {
  return db.all<ThreadRow>(
    `SELECT * FROM threads
     WHERE status = 'starting' AND environment_id IS NULL AND ${LIVE}`,
  );
}

export function listTombstonedThreads(db: Db): ThreadRow[] {
  return db.all<ThreadRow>(
    "SELECT * FROM threads WHERE deleted_at IS NOT NULL",
  );
}

export function listArchivedRunningThreads(
  db: Db,
  archivedBefore: number,
): ThreadRow[] {
  return db.all<ThreadRow>(
    `SELECT * FROM threads
     WHERE archived_at <= ? AND status IN ('starting', 'active') AND ${LIVE}`,
    archivedBefore,
  );
}

export function deleteThreadRow(db: Db, id: string): void {
  db.run("DELETE FROM threads WHERE id = ?", id);
}

export function pinThread(db: Db, id: string): ThreadRow | undefined {
  const thread = getThread(db, id);
  if (thread === undefined || thread.pinnedAt !== null) return thread;
  const pinSortKey = nextPinSortKey(db);
  return patchThread(db, id, { pinnedAt: db.now(), pinSortKey });
}

export type PinOrderOutcome = "reordered" | "not_pinned" | "stale_neighbor";

export function reorderPinnedThread(
  db: Db,
  id: string,
  previousThreadId: string | null,
  nextThreadId: string | null,
): PinOrderOutcome {
  const key = (threadId: string | null): string | null | undefined => {
    if (threadId === null) return null;
    const neighbor = getThread(db, threadId);
    if (threadId === id || neighbor?.pinSortKey == null) return undefined;
    return neighbor.pinSortKey;
  };
  if (getThread(db, id)?.pinnedAt == null) return "not_pinned";
  const previous = key(previousThreadId);
  const next = key(nextThreadId);
  if (previous === undefined || next === undefined) return "stale_neighbor";
  if (previous !== null && next !== null && previous >= next) {
    return "stale_neighbor";
  }
  patchThread(db, id, { pinSortKey: orderKeyBetween(previous, next) });
  return "reordered";
}

export function threadActivity(db: Db, threadId: string): ThreadActivityState {
  const rows = db.all<{ taskType: string | null; count: number }>(
    `WITH latest AS (
       SELECT item_id,
         MAX(CASE WHEN type != 'item/backgroundTask/completed'
             THEN sequence END) AS sequence,
         MAX(type = 'item/backgroundTask/completed') AS completed
       FROM events
       WHERE thread_id = ? AND item_kind = 'backgroundTask'
         AND type IN ('item/started', 'item/backgroundTask/progress',
                      'item/backgroundTask/completed')
       GROUP BY item_id
     )
     SELECT json_extract(e.data, '$.item.taskType') AS task_type,
            COUNT(*) AS count
     FROM latest JOIN events e
       ON e.thread_id = ? AND e.sequence = latest.sequence
     WHERE latest.completed = 0
       AND json_extract(e.data, '$.item.status') = 'pending'
       AND COALESCE(json_extract(e.data, '$.item.skipTranscript'), 0) = 0
     GROUP BY task_type`,
    threadId,
    threadId,
  );
  const count = (...taskTypes: string[]): number =>
    rows
      .filter((row) => taskTypes.includes(row.taskType ?? ""))
      .reduce((total, row) => total + row.count, 0);
  return {
    activeWorkflowCount: count(LOCAL_WORKFLOW_TASK_TYPE),
    activeBackgroundAgentCount: count(
      LOCAL_AGENT_TASK_TYPE,
      LOCAL_SUBAGENT_TASK_TYPE,
    ),
    activeBackgroundCommandCount: count(LOCAL_BASH_TASK_TYPE),
    activePlanModeCount: 0,
    activeGoalCount: 0,
  };
}

function toThreadWithRuntime(thread: ThreadRow, runtime: ThreadRuntimeState) {
  return {
    id: thread.id,
    projectId: thread.projectId,
    environmentId: thread.environmentId,
    providerId: thread.providerId,
    title: thread.title,
    titleFallback: thread.titleFallback,
    sectionId: thread.sectionId,
    status: thread.status,
    parentThreadId: thread.parentThreadId,
    lifecycleOwnerThreadId: thread.lifecycleOwnerThreadId,
    sourceThreadId: thread.sourceThreadId,
    originKind: thread.originKind,
    originPluginId: thread.originPluginId,
    visibility: thread.visibility,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    deletedAt: thread.deletedAt,
    lastReadAt: thread.lastReadAt,
    latestAttentionAt: thread.latestAttentionAt,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    runtime,
  };
}

function countRows(db: Db, sql: string, threadId: string): number {
  return db.get<{ count: number }>(sql, threadId)?.count ?? 0;
}

export function toThreadResponse(
  db: Db,
  thread: ThreadRow,
  runtime: ThreadRuntimeState,
): ThreadResponse {
  return {
    ...toThreadWithRuntime(thread, runtime),
    activeBackgroundAgentCount: threadActivity(db, thread.id)
      .activeBackgroundAgentCount,
    canRestoreEnvironment: false,
    canSpawnChild: ancestorDepth(db, thread) < MAX_THREAD_HIERARCHY_DEPTH,
    queuedMessageCount: countRows(
      db,
      "SELECT COUNT(*) AS count FROM queued_thread_messages WHERE thread_id = ?",
      thread.id,
    ),
  };
}

interface PinnedThreadRow extends ThreadRow {
  environmentHostId: string | null;
  environmentName: string | null;
  environmentBranchName: string | null;
  environmentPath: string | null;
  environmentProviderId: string | null;
  environmentIsWorktree: number | null;
}

export function listPinnedThreadEntries(
  db: Db,
  runtimeOf: (thread: ThreadRow, hostId: string | null) => ThreadRuntimeState,
): ThreadListEntry[] {
  const rows = db.all<PinnedThreadRow>(
    `SELECT t.*, e.host_id AS environment_host_id,
       e.name AS environment_name, e.branch_name AS environment_branch_name,
       e.path AS environment_path, e.environment_provider_id,
       e.is_worktree AS environment_is_worktree
     FROM threads t LEFT JOIN environments e ON e.id = t.environment_id
     WHERE t.pinned_at IS NOT NULL AND t.archived_at IS NULL AND t.${LIVE}
       AND t.visibility = 'visible' AND t.parent_thread_id IS NULL
     ORDER BY t.pin_sort_key`,
  );
  return rows.map((row) => {
    const failed = countRows(
      db,
      `SELECT COUNT(*) AS count FROM queued_thread_messages
       WHERE thread_id = ? AND failure_reason IS NOT NULL`,
      row.id,
    );
    const queued = countRows(
      db,
      "SELECT COUNT(*) AS count FROM queued_thread_messages WHERE thread_id = ?",
      row.id,
    );
    const pending = countRows(
      db,
      `SELECT COUNT(*) AS count FROM pending_interactions
       WHERE thread_id = ? AND status IN ('pending', 'resolving')`,
      row.id,
    );
    const worktree = row.environmentIsWorktree === 1;
    const managed = row.environmentProviderId === "git-worktree";
    return {
      ...toThreadWithRuntime(row, runtimeOf(row, row.environmentHostId)),
      activity: threadActivity(db, row.id),
      queuedWork: failed > 0 ? "failed" : queued > 0 ? "waiting" : "none",
      pinSortKey: row.pinSortKey,
      hasPendingInteraction: pending > 0,
      environmentHostId: row.environmentHostId,
      environmentName: row.environmentName,
      environmentBranchName: row.environmentBranchName,
      environmentPath: row.environmentPath,
      environmentProviderId: row.environmentProviderId,
      environmentIsWorktree:
        row.environmentIsWorktree === null ? null : worktree,
      environmentWorkspaceDisplayKind: managed
        ? "managed-worktree"
        : worktree
          ? "unmanaged-worktree"
          : "other",
    };
  });
}
