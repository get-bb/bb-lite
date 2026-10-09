import * as domain from "@bb/domain";
import { threadNotFound } from "../http/errors.js";
import { upsertSearchSegment } from "./events.js";
import {
  insertRow,
  newId,
  updateRow,
  type Db,
  type SqlValue,
} from "./index.js";
import { nextPinSortKey, setThreadUserState } from "./thread-user-state.js";

export interface ThreadRow extends domain.Thread {
  providerThreadId: string | null;
  activeTurnId: string | null;
  model: string | null;
  reasoningLevel: domain.ReasoningLevel | null;
  permissionMode: domain.PermissionMode | null;
  serviceTier: domain.ServiceTier | null;
  modelOverride: string | null;
  reasoningLevelOverride: domain.ReasoningLevel | null;
  startupContext: string | null;
  lastActorUserId: string | null;
  pinSortKey: string | null;
  storageDeletedAt: number | null;
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
  | "createdByUserId"
  | "startupContext"
  | "parentThreadId"
  | "lifecycleOwnerThreadId"
  | "originPluginId"
  | "visibility"
> &
  Partial<Pick<ThreadRow, "originKind" | "sourceThreadId">> & {
    pinned: boolean;
    viewerId: string;
  };

type Unpatchable =
  | "id"
  | "projectId"
  | "status"
  | "createdAt"
  | "updatedAt"
  | "lastReadAt"
  | "pinnedAt"
  | "pinSortKey"
  | "sectionId";
export type ThreadPatch = Partial<Omit<ThreadRow, Unpatchable>>;

export type LifecycleOutcome =
  | { applied: true; from: domain.ThreadStatus; thread: ThreadRow }
  | {
      applied: false;
      reason: "missing" | "cas-conflict" | domain.ThreadLifecycleNoopReason;
    };

export const MAX_THREAD_HIERARCHY_DEPTH = 4;
const LIVE = "deleted_at IS NULL";

export function getThread(db: Db, id: string): ThreadRow | undefined {
  return db.get<ThreadRow>("SELECT * FROM threads WHERE id = ?", id);
}

export function requireThread(db: Db, id: string): ThreadRow {
  const thread = getThread(db, id);
  if (thread !== undefined && thread.deletedAt === null) return thread;
  throw threadNotFound();
}

function syncTitleSearch(db: Db, thread: ThreadRow) {
  upsertSearchSegment(db, thread.id, "title", "title", null, thread.title);
  const fallback = thread.titleFallback;
  const kind = "title_fallback";
  upsertSearchSegment(db, thread.id, kind, kind, null, fallback);
}

export function insertThread(db: Db, input: NewThread): ThreadRow {
  const { pinned, viewerId, sectionId, ...columns } = input;
  const now = db.now();
  const id = newId("thr");
  insertRow(db, "threads", {
    ...columns,
    id,
    status: "pending",
    lastActorUserId: columns.createdByUserId,
    lastReadAt: now,
    latestAttentionAt: now,
    createdAt: now,
    updatedAt: now,
  });
  setThreadUserState(db, id, viewerId, {
    lastReadAt: now,
    pinnedAt: pinned ? now : null,
    pinSortKey: pinned ? nextPinSortKey(db, viewerId) : null,
    sectionId,
  });
  const thread = getThread(db, id);
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
  const changes = touch || Object.keys(patch).length > 0;
  if (changes) updateRow(db, "threads", id, patch, touch);
  const thread = getThread(db, id);
  if (thread === undefined) throw new Error(`Thread ${id} does not exist`);
  if ("title" in patch) syncTitleSearch(db, thread);
  return thread;
}

function needsAttention(thread: ThreadRow, to: domain.ThreadStatus) {
  if (to === "error") return true;
  const finished = thread.status === "active" && to === "idle";
  return finished && thread.parentThreadId === null;
}

export function applyLifecycleEvent(
  db: Db,
  id: string,
  type: domain.ThreadLifecycleEventType,
): LifecycleOutcome {
  const thread = getThread(db, id);
  if (thread === undefined) return { applied: false, reason: "missing" };
  const verdict = domain.evaluateThreadLifecycleEvent({
    event: { type },
    thread,
  });
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

function select(db: Db, where: string, ...params: SqlValue[]) {
  return db.all<ThreadRow>(`SELECT * FROM threads WHERE ${where}`, ...params);
}

export function listChildThreads(db: Db, parentThreadId: string) {
  return select(db, `parent_thread_id = ? AND ${LIVE}`, parentThreadId);
}

export function listArchiveTree(db: Db, root: ThreadRow): ThreadRow[] {
  const ordered: ThreadRow[] = [];
  const seen = new Set<string>();
  const visit = (thread: ThreadRow) => {
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
  ...statuses: domain.ThreadStatus[]
): ThreadRow[] {
  const marks = statuses.map(() => "?").join(", ");
  const onHost = "(SELECT id FROM environments WHERE host_id = ?)";
  const where = `environment_id IN ${onHost} AND status IN (${marks})`;
  return select(db, `${where} AND ${LIVE}`, hostId, ...statuses);
}

export function listStartingThreads(db: Db): ThreadRow[] {
  return select(db, `status = 'starting' AND ${LIVE}`);
}

export function listTombstonedThreads(db: Db): ThreadRow[] {
  return select(db, "deleted_at IS NOT NULL");
}

export function listExpiredArchives(db: Db, archivedBefore: number) {
  const terminals = `SELECT thread_id FROM terminal_sessions
    WHERE status <> 'exited' AND thread_id IS NOT NULL`;
  const busy = `status IN ('starting', 'active') OR id IN (${terminals})`;
  const where = `archived_at <= ? AND (${busy}) AND ${LIVE}`;
  return select(db, where, archivedBefore);
}

export function deleteThreadRow(db: Db, id: string): void {
  db.run("DELETE FROM threads WHERE id = ?", id);
}
