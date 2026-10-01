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
import { ApiError } from "../http/errors.js";
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
  Omit<ThreadRow, "id" | "projectId" | "status" | "createdAt" | "updatedAt">
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

export function nextPinSortKey(db: Db): string {
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
): ThreadRow {
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
  if (thread === undefined) throw new Error(`Thread ${id} does not exist`);
  if ("title" in patch) syncTitleSearch(db, thread);
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

function select(db: Db, where: string, ...params: SqlValue[]): ThreadRow[] {
  return db.all<ThreadRow>(`SELECT * FROM threads WHERE ${where}`, ...params);
}

export function listChildThreads(db: Db, parentThreadId: string) {
  return select(db, `parent_thread_id = ? AND ${LIVE}`, parentThreadId);
}

export function listArchiveTree(db: Db, root: ThreadRow): ThreadRow[] {
  const ordered: ThreadRow[] = [];
  const seen = new Set<string>();
  const visit = (thread: ThreadRow): void => {
    if (seen.has(thread.id)) return;
    seen.add(thread.id);
    select(db, "lifecycle_owner_thread_id = ?", thread.id).forEach(visit);
    listChildThreads(db, thread.id).forEach(visit);
    ordered.push(thread);
  };
  visit(root);
  return ordered;
}

export function ancestry(db: Db, thread: ThreadRow): string[] {
  const ids: string[] = [];
  let current: ThreadRow | undefined = thread;
  while (current !== undefined && !ids.includes(current.id)) {
    ids.push(current.id);
    const parentId: string | null = current.parentThreadId;
    current = parentId === null ? undefined : getThread(db, parentId);
  }
  return ids;
}

export function subtreeDepth(db: Db, thread: ThreadRow): number {
  const depths = listChildThreads(db, thread.id).map((child) =>
    subtreeDepth(db, child),
  );
  return 1 + Math.max(0, ...depths);
}

export function listThreadsOnHost(
  db: Db,
  hostId: string,
  ...statuses: ThreadStatus[]
): ThreadRow[] {
  const marks = statuses.map(() => "?").join(", ");
  const onHost = "(SELECT id FROM environments WHERE host_id = ?)";
  const where = `environment_id IN ${onHost} AND status IN (${marks})`;
  return select(db, `${where} AND ${LIVE}`, hostId, ...statuses);
}

export function listStartingWithoutEnvironment(db: Db): ThreadRow[] {
  const where = "status = 'starting' AND environment_id IS NULL";
  return select(db, `${where} AND ${LIVE}`);
}

export function listTombstonedThreads(db: Db): ThreadRow[] {
  return select(db, "deleted_at IS NOT NULL");
}

export function listArchivedRunningThreads(db: Db, archivedBefore: number) {
  const where = "archived_at <= ? AND status IN ('starting', 'active')";
  return select(db, `${where} AND ${LIVE}`, archivedBefore);
}

export function deleteThreadRow(db: Db, id: string): void {
  db.run("DELETE FROM threads WHERE id = ?", id);
}

export function reorderPinnedThread(
  db: Db,
  id: string,
  previousThreadId: string | null,
  nextThreadId: string | null,
): void {
  const stale = new ApiError(409, "invalid_request", "Pinned order changed");
  const keyOf = (threadId: string | null): string | null => {
    if (threadId === null) return null;
    const key = getThread(db, threadId)?.pinSortKey ?? null;
    if (threadId === id || key === null) throw stale;
    return key;
  };
  if (getThread(db, id)?.pinnedAt == null) {
    throw new ApiError(409, "invalid_request", "Thread is not pinned");
  }
  const previous = keyOf(previousThreadId);
  const next = keyOf(nextThreadId);
  if (previous !== null && next !== null && previous >= next) throw stale;
  patchThread(db, id, { pinSortKey: orderKeyBetween(previous, next) });
}

export function threadActivity(db: Db, threadId: string): ThreadActivityState {
  const agents = `'${LOCAL_AGENT_TASK_TYPE}', '${LOCAL_SUBAGENT_TASK_TYPE}'`;
  const row = db.get<Record<"workflows" | "agents" | "commands", number>>(
    `WITH latest AS (
       SELECT MAX(CASE WHEN type != 'item/backgroundTask/completed'
                  THEN sequence END) AS sequence,
              MAX(type = 'item/backgroundTask/completed') AS completed
       FROM events
       WHERE thread_id = ? AND item_kind = 'backgroundTask'
         AND type IN ('item/started', 'item/backgroundTask/progress',
                      'item/backgroundTask/completed')
       GROUP BY item_id
     ), running AS (
       SELECT json_extract(e.data, '$.item.taskType') AS task
       FROM latest JOIN events e
         ON e.thread_id = ? AND e.sequence = latest.sequence
       WHERE latest.completed = 0
         AND json_extract(e.data, '$.item.status') = 'pending'
         AND COALESCE(json_extract(e.data, '$.item.skipTranscript'), 0) = 0
     )
     SELECT COALESCE(SUM(task = '${LOCAL_WORKFLOW_TASK_TYPE}'), 0) AS workflows,
            COALESCE(SUM(task IN (${agents})), 0) AS agents,
            COALESCE(SUM(task = '${LOCAL_BASH_TASK_TYPE}'), 0) AS commands
     FROM running`,
    threadId,
    threadId,
  );
  return {
    activeWorkflowCount: row?.workflows ?? 0,
    activeBackgroundAgentCount: row?.agents ?? 0,
    activeBackgroundCommandCount: row?.commands ?? 0,
    activePlanModeCount: 0,
    activeGoalCount: 0,
  };
}

function toThreadWithRuntime<Row extends ThreadRow>(
  thread: Row,
  runtime: ThreadRuntimeState,
) {
  const {
    providerThreadId,
    activeTurnId,
    model,
    reasoningLevel,
    permissionMode,
    serviceTier,
    modelOverride,
    reasoningLevelOverride,
    startupContext,
    storageDeletedAt,
    ...shared
  } = thread;
  return { ...shared, runtime };
}

const QUEUED_COUNT = `(SELECT COUNT(*) FROM queued_thread_messages q
  WHERE q.thread_id = t.id)`;

interface ListedThreadRow extends ThreadRow {
  queued: number;
  failed: number;
  pending: number;
  environmentHostId: string | null;
  environmentName: string | null;
  environmentBranchName: string | null;
  environmentPath: string | null;
  environmentProviderId: string | null;
  environmentIsWorktree: number | null;
}

function listThreadRows(db: Db, where: string, ...params: string[]) {
  return db.all<ListedThreadRow>(
    `SELECT t.*, ${QUEUED_COUNT} AS queued,
       (SELECT COUNT(*) FROM queued_thread_messages q
        WHERE q.thread_id = t.id AND q.failure_reason IS NOT NULL) AS failed,
       (SELECT COUNT(*) FROM pending_interactions p WHERE p.thread_id = t.id
        AND p.status IN ('pending', 'resolving')) AS pending,
       e.host_id AS environment_host_id, e.name AS environment_name,
       e.branch_name AS environment_branch_name,
       e.path AS environment_path, e.environment_provider_id,
       e.is_worktree AS environment_is_worktree
     FROM threads t LEFT JOIN environments e ON e.id = t.environment_id
     WHERE ${where}`,
    ...params,
  );
}

export function toThreadResponse(
  db: Db,
  thread: ThreadRow,
  runtime: ThreadRuntimeState,
): ThreadResponse {
  const [listed] = listThreadRows(db, "t.id = ?", thread.id);
  const { pinSortKey, ...shared } = toThreadWithRuntime(thread, runtime);
  return {
    ...shared,
    activeBackgroundAgentCount: threadActivity(db, thread.id)
      .activeBackgroundAgentCount,
    canRestoreEnvironment: false,
    canSpawnChild: ancestry(db, thread).length < MAX_THREAD_HIERARCHY_DEPTH,
    queuedMessageCount: listed?.queued ?? 0,
  };
}

export function listPinnedThreadEntries(
  db: Db,
  runtimeOf: (thread: ThreadRow, hostId: string | null) => ThreadRuntimeState,
): ThreadListEntry[] {
  const rows = listThreadRows(
    db,
    `t.pinned_at IS NOT NULL AND t.archived_at IS NULL AND t.${LIVE}
     AND t.visibility = 'visible' AND t.parent_thread_id IS NULL
     ORDER BY t.pin_sort_key`,
  );
  return rows.map(({ queued, failed, pending, ...row }) => {
    const worktree = row.environmentIsWorktree === 1;
    const managed = row.environmentProviderId === "git-worktree";
    const displayKind = worktree ? "unmanaged-worktree" : "other";
    return {
      ...toThreadWithRuntime(row, runtimeOf(row, row.environmentHostId)),
      activity: threadActivity(db, row.id),
      queuedWork: failed > 0 ? "failed" : queued > 0 ? "waiting" : "none",
      hasPendingInteraction: pending > 0,
      environmentIsWorktree: row.environmentHostId === null ? null : worktree,
      environmentWorkspaceDisplayKind: managed
        ? "managed-worktree"
        : displayKind,
    };
  });
}
