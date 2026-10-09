import {
  promptInputSchema,
  type EnvironmentStatus,
  type PromptHistoryEntry,
  type PromptInput,
  type Thread,
} from "@bb/domain";
import type { ThreadListQuery } from "@bb/server-contract";
import { z } from "zod";
import { viewerId } from "../auth/actor.js";
import type { Db, SqlValue } from "./index.js";
import { VIEWER_LAST_READ_AT } from "./thread-user-state.js";
import type { ThreadRow } from "./threads.js";

export interface ThreadListRow extends ThreadRow {
  environmentBranchName: string | null;
  environmentHostId: string | null;
  environmentIsWorktree: number | null;
  environmentName: string | null;
  environmentPath: string | null;
  environmentProviderId: string | null;
  environmentStatus: EnvironmentStatus | null;
  environmentWorkspaceProvisionType: string | null;
  hasPendingInteraction: number;
}

type MentionRow = Pick<Thread, "id" | "projectId" | "title" | "titleFallback">;

const THREAD_LIST_SELECT = `WITH viewer (id) AS (SELECT ?)
  SELECT threads.*,
    ${VIEWER_LAST_READ_AT} AS last_read_at,
    s.pinned_at AS pinned_at, s.pin_sort_key AS pin_sort_key,
    s.section_id AS section_id,
    e.branch_name AS environment_branch_name,
    e.host_id AS environment_host_id,
    e.is_worktree AS environment_is_worktree,
    e.name AS environment_name, e.path AS environment_path,
    e.environment_provider_id AS environment_provider_id,
    e.status AS environment_status,
    e.workspace_provision_type AS environment_workspace_provision_type,
    EXISTS (SELECT 1 FROM pending_interactions AS p
      WHERE p.thread_id = threads.id AND p.status = 'pending')
      AS has_pending_interaction
  FROM threads
  LEFT JOIN thread_user_state AS s ON s.thread_id = threads.id
    AND s.user_id = (SELECT id FROM viewer)
  LEFT JOIN environments AS e ON e.id = threads.environment_id`;
const PINNED = "s.pinned_at IS NOT NULL";
const ACTIVE_THREAD_ORDER = `threads.project_id, CASE WHEN ${PINNED} THEN 0
    ELSE 1 END, CASE WHEN ${PINNED} THEN s.pin_sort_key END,
  CASE WHEN ${PINNED} THEN threads.id END, threads.created_at DESC,
  threads.id DESC`;
const IN_LIST = "IN (SELECT value FROM json_each(?))";
const storedPromptInputSchema = z.array(promptInputSchema).min(1);

export function findThreadListRow(
  db: Db,
  threadId: string,
): ThreadListRow | undefined {
  const sql = `${THREAD_LIST_SELECT} WHERE threads.id = ?`;
  return db.get<ThreadListRow>(sql, viewerId(), threadId);
}

function threadFilter(
  equal: Record<string, SqlValue | undefined>,
  nullness: Record<string, boolean | undefined>,
  hidden: boolean | undefined,
) {
  const where = ["threads.deleted_at IS NULL"];
  const params: SqlValue[] = [];
  for (const [column, value] of Object.entries(equal)) {
    if (value === undefined) continue;
    where.push(`${column} = ?`);
    params.push(value);
  }
  for (const [column, wanted] of Object.entries(nullness)) {
    if (wanted === undefined) continue;
    where.push(`${column} IS ${wanted ? "NOT NULL" : "NULL"}`);
  }
  if (hidden !== true) where.push("threads.visibility = 'visible'");
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
      "s.section_id": query.sectionId,
      "threads.origin_kind": query.originKind,
      "threads.origin_plugin_id": query.originPluginId,
    },
    {
      "threads.archived_at": query.archived,
      "threads.parent_thread_id": query.hasParent,
      "s.section_id": query.unsectioned === true ? false : undefined,
    },
    query.includeHidden,
  );
  const order =
    query.archived === true
      ? "threads.archived_at DESC, threads.id DESC"
      : ACTIVE_THREAD_ORDER;
  return db.all<ThreadListRow>(
    `${THREAD_LIST_SELECT} WHERE ${where}
     ORDER BY ${order} LIMIT ? OFFSET ?`,
    viewerId(),
    ...params,
    query.limit ?? -1,
    query.offset ?? 0,
  );
}

export function listThreadRowsByIds(
  db: Db,
  threadIds: readonly string[],
): ThreadListRow[] {
  return db.all<ThreadListRow>(
    `${THREAD_LIST_SELECT}
     WHERE threads.id ${IN_LIST} AND threads.deleted_at IS NULL`,
    viewerId(),
    JSON.stringify(threadIds),
  );
}

export function listSidebarThreadRows(db: Db): ThreadListRow[] {
  return db.all<ThreadListRow>(
    `${THREAD_LIST_SELECT}
     WHERE threads.deleted_at IS NULL AND threads.archived_at IS NULL
       AND threads.visibility = 'visible'
     ORDER BY ${ACTIVE_THREAD_ORDER}`,
    viewerId(),
  );
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
  const mine = "h.user_id = ?";
  const rows = db.all<{ id: string; createdAt: number; input: string }>(
    `SELECT h.id, h.created_at, h.input FROM prompt_history_entries AS h
     WHERE ${where} AND ${mine}
     ORDER BY h.created_at DESC, h.request_sequence DESC, h.id DESC LIMIT ?`,
    id,
    viewerId(),
    limit,
  );
  return rows.flatMap((row) => {
    const input = storedPromptInputSchema.safeParse(JSON.parse(row.input));
    return input.success ? [{ ...row, input: input.data }] : [];
  });
}

export interface RecentPromptRow {
  id: string;
  projectId: string;
  threadId: string;
  scope: "project" | "thread";
  createdAt: number;
  input: PromptInput[];
}

export function listRecentPrompts(
  db: Db,
  query: {
    projectId?: string;
    before?: { createdAt: number; id: string };
    limit: number;
  },
): RecentPromptRow[] {
  const { projectId = null, before = null, limit } = query;
  const at = before?.createdAt ?? null;
  const rows = db.all<Omit<RecentPromptRow, "input"> & { input: string }>(
    `SELECT h.id, h.project_id, h.thread_id, h.scope, h.created_at, h.input
     FROM prompt_history_entries AS h JOIN threads AS t ON t.id = h.thread_id
     WHERE t.deleted_at IS NULL AND h.user_id = ?
       AND (? IS NULL OR h.project_id = ?)
       AND (? IS NULL OR h.created_at < ? OR (h.created_at = ? AND h.id < ?))
     ORDER BY h.created_at DESC, h.id DESC LIMIT ?`,
    viewerId(),
    projectId,
    projectId,
    at,
    at,
    at,
    before?.id ?? null,
    limit,
  );
  return rows.flatMap((row) => {
    const input = storedPromptInputSchema.safeParse(JSON.parse(row.input));
    return input.success ? [{ ...row, input: input.data }] : [];
  });
}
