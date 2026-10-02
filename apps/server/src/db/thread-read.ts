import {
  promptInputSchema,
  type EnvironmentStatus,
  type PromptHistoryEntry,
  type Thread,
} from "@bb/domain";
import type {
  ThreadCountQuery,
  ThreadCountResponse,
  ThreadListQuery,
} from "@bb/server-contract";
import { z } from "zod";
import type { Db, SqlValue } from "./index.js";
import type { ThreadRow } from "./threads.js";

export interface ThreadListRow extends ThreadRow {
  environmentBranchName: string | null;
  environmentHostId: string | null;
  environmentIsWorktree: number | null;
  environmentName: string | null;
  environmentPath: string | null;
  environmentProviderId: string | null;
  environmentStatus: EnvironmentStatus | null;
  hasPendingInteraction: number;
}

type MentionRow = Pick<Thread, "id" | "projectId" | "title" | "titleFallback">;

const THREAD_LIST_SELECT = `SELECT threads.*,
    e.branch_name AS environment_branch_name,
    e.host_id AS environment_host_id,
    e.is_worktree AS environment_is_worktree,
    e.name AS environment_name, e.path AS environment_path,
    e.environment_provider_id AS environment_provider_id,
    e.status AS environment_status,
    EXISTS (SELECT 1 FROM pending_interactions AS p
      WHERE p.thread_id = threads.id AND p.status = 'pending')
      AS has_pending_interaction
  FROM threads LEFT JOIN environments AS e ON e.id = threads.environment_id`;
const PINNED = "threads.pinned_at IS NOT NULL";
const ACTIVE_THREAD_ORDER = `threads.project_id, CASE WHEN ${PINNED} THEN 0
    ELSE 1 END, CASE WHEN ${PINNED} THEN threads.pin_sort_key END,
  CASE WHEN ${PINNED} THEN threads.id END, threads.created_at DESC,
  threads.id DESC`;
const IN_LIST = "IN (SELECT value FROM json_each(?))";
const storedPromptInputSchema = z.array(promptInputSchema).min(1);

export function findThreadListRow(
  db: Db,
  threadId: string,
): ThreadListRow | undefined {
  const sql = `${THREAD_LIST_SELECT} WHERE threads.id = ?`;
  return db.get<ThreadListRow>(sql, threadId);
}

function threadFilter(
  equal: Record<string, SqlValue | undefined>,
  nullness: Record<string, "true" | "false" | undefined>,
  hidden: "true" | "false" | undefined,
): { where: string; params: SqlValue[] } {
  const where = ["threads.deleted_at IS NULL"];
  const params: SqlValue[] = [];
  for (const [column, value] of Object.entries(equal)) {
    if (value === undefined) continue;
    where.push(`${column} = ?`);
    params.push(value);
  }
  for (const [column, wanted] of Object.entries(nullness)) {
    if (wanted === undefined) continue;
    where.push(`${column} IS ${wanted === "true" ? "NOT NULL" : "NULL"}`);
  }
  if (hidden !== "true") where.push("threads.visibility = 'visible'");
  return { where: where.join(" AND "), params };
}

export function listThreadRows(
  db: Db,
  query: ThreadListQuery,
): ThreadListRow[] {
  const { where, params } = threadFilter(
    {
      "threads.project_id": query.projectId,
      "threads.environment_id": query.environmentId,
      "e.host_id": query.hostId,
      "threads.parent_thread_id": query.parentThreadId,
      "threads.source_thread_id": query.sourceThreadId,
      "threads.section_id": query.sectionId,
      "threads.origin_kind": query.originKind,
      "threads.origin_plugin_id": query.originPluginId,
    },
    {
      "threads.archived_at": query.archived,
      "threads.parent_thread_id": query.hasParent,
      "threads.section_id": query.unsectioned === "true" ? "false" : undefined,
    },
    query.includeHidden,
  );
  const order =
    query.archived === "true"
      ? "threads.archived_at DESC, threads.id DESC"
      : ACTIVE_THREAD_ORDER;
  return db.all<ThreadListRow>(
    `${THREAD_LIST_SELECT} WHERE ${where}
     ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...params,
    Number(query.limit ?? -1),
    Number(query.offset ?? 0),
  );
}

export function listThreadRowsByIds(
  db: Db,
  threadIds: readonly string[],
): ThreadListRow[] {
  return db.all<ThreadListRow>(
    `${THREAD_LIST_SELECT}
     WHERE threads.id ${IN_LIST} AND threads.deleted_at IS NULL`,
    JSON.stringify(threadIds),
  );
}

export function listSidebarThreadRows(db: Db): ThreadListRow[] {
  return db.all<ThreadListRow>(
    `${THREAD_LIST_SELECT}
     WHERE threads.deleted_at IS NULL AND threads.archived_at IS NULL
       AND threads.visibility = 'visible'
     ORDER BY ${ACTIVE_THREAD_ORDER}`,
  );
}

export function countThreads(
  db: Db,
  query: ThreadCountQuery,
  rootsOnly: boolean,
): ThreadCountResponse {
  const { where, params } = threadFilter(
    {
      "threads.status": query.status,
      "threads.provider_id": query.providerId,
      "threads.project_id": query.projectId,
      "e.host_id": query.hostId,
      "threads.parent_thread_id": rootsOnly ? undefined : query.parentThreadId,
    },
    {
      "threads.archived_at":
        query.includeArchived === "true" ? undefined : "false",
      "threads.parent_thread_id": rootsOnly ? "false" : undefined,
    },
    query.includeHidden,
  );
  const { groupBy } = query;
  const groupColumn = {
    host: "e.host_id",
    provider: "threads.provider_id",
    project: "threads.project_id",
  }[groupBy ?? "host"];
  const groups = db.all<{ key: string | null; count: number }>(
    `SELECT ${groupBy === undefined ? "NULL" : groupColumn} AS key,
       COUNT(*) AS count
     FROM threads LEFT JOIN environments AS e ON e.id = threads.environment_id
     WHERE ${where} GROUP BY 1`,
    ...params,
  );
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  return groupBy === undefined ? { total } : { total, groups };
}

export function threadChildSummary(db: Db, threadId: string) {
  const row = db.get<{ children: number; descendants: number }>(
    `WITH RECURSIVE tree (id, archived_at) AS (
       SELECT id, archived_at FROM threads
       WHERE deleted_at IS NULL AND (parent_thread_id = :threadId
         OR lifecycle_owner_thread_id = :threadId)
       UNION
       SELECT threads.id, threads.archived_at
       FROM threads JOIN tree ON threads.parent_thread_id = tree.id
         OR threads.lifecycle_owner_thread_id = tree.id
       WHERE threads.deleted_at IS NULL)
     SELECT
       (SELECT COUNT(*) FROM threads WHERE parent_thread_id = :threadId
         AND deleted_at IS NULL) AS children,
       (SELECT COUNT(*) FROM tree WHERE id <> :threadId
         AND archived_at IS NULL) AS descendants`,
    { threadId },
  );
  return {
    nonDeletedChildCount: row?.children ?? 0,
    unarchivedDescendantCount: row?.descendants ?? 0,
  };
}

export function listThreadMentionRows(
  db: Db,
  threadIds: readonly string[],
): MentionRow[] {
  return db.all<MentionRow>(
    `SELECT threads.id, threads.project_id, threads.title,
       threads.title_fallback
     FROM threads JOIN projects ON projects.id = threads.project_id
     WHERE threads.id ${IN_LIST} AND threads.deleted_at IS NULL
       AND projects.deleted_at IS NULL`,
    JSON.stringify(threadIds),
  );
}

export function hasThreadAttention(db: Db): boolean {
  const row = db.get(
    `SELECT 1 FROM threads
     WHERE deleted_at IS NULL AND archived_at IS NULL
       AND visibility = 'visible'
       AND (last_read_at IS NULL OR last_read_at < latest_attention_at
         OR EXISTS (SELECT 1 FROM pending_interactions AS p
           WHERE p.thread_id = threads.id AND p.status = 'pending'))
     LIMIT 1`,
  );
  return row !== undefined;
}

export function listQueueCounts(db: Db, threadIds: readonly string[]) {
  return db.all<{ threadId: string; queued: number; failed: number }>(
    `SELECT thread_id, COUNT(id) AS queued, COUNT(failure_reason) AS failed
     FROM queued_thread_messages
     WHERE thread_id ${IN_LIST} GROUP BY thread_id`,
    JSON.stringify(threadIds),
  );
}

export function listPromptHistoryEntries(
  db: Db,
  scope: { projectId: string } | { threadId: string },
  limit: number,
): PromptHistoryEntry[] {
  const [where, id] =
    "projectId" in scope
      ? [
          `h.project_id = ? AND h.scope = 'project' AND (SELECT deleted_at
             FROM threads WHERE threads.id = h.thread_id) IS NULL`,
          scope.projectId,
        ]
      : ["h.thread_id = ? AND h.scope = 'thread'", scope.threadId];
  const rows = db.all<{ id: string; createdAt: number; input: string }>(
    `SELECT h.id, h.created_at, h.input FROM prompt_history_entries AS h
     WHERE ${where}
     ORDER BY h.created_at DESC, h.request_sequence DESC, h.id DESC LIMIT ?`,
    id,
    limit,
  );
  return rows.flatMap((row) => {
    const input = storedPromptInputSchema.safeParse(JSON.parse(row.input));
    return input.success ? [{ ...row, input: input.data }] : [];
  });
}
