import {
  environmentSchema,
  hostSchema,
  PERSONAL_PROJECT_ID,
  pendingInteractionSchema,
  projectExecutionDefaultsSchema,
  promptInputSchema,
  resolveEnvironmentHostLifecycle,
  threadQueuedMessageSchema,
  threadSchema,
  type Environment,
  type EnvironmentStatus,
  type Host,
  type PendingInteraction,
  type ProjectExecutionDefaults,
  type PromptHistoryEntry,
  type Thread,
  type ThreadQueuedMessage,
} from "@bb/domain";
import type {
  ProjectResponse,
  ThreadCountQuery,
  ThreadCountResponse,
  ThreadListQuery,
  ThreadSectionResponse,
} from "@bb/server-contract";
import { z } from "zod";
import type { Db, SqlValue } from "./index.js";

export interface ThreadRow extends Thread {
  model: string | null;
  reasoningLevel: string | null;
  permissionMode: string | null;
  serviceTier: string | null;
  modelOverride: string | null;
  reasoningLevelOverride: string | null;
  pinSortKey: string | null;
}

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

export interface SidebarProject extends ProjectResponse {
  defaultExecutionOptions: ProjectExecutionDefaults | null;
}

type Row = Record<string, SqlValue>;
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
const LIVE_QUEUE_ROW = "claimed_at IS NULL AND claim_token IS NULL";
const MAX_THREAD_HIERARCHY_DEPTH = 4;
const WORKSPACE_PROVISION_TYPES: Record<string, string> = {
  "git-worktree": "managed-worktree",
  "personal-workspace": "personal",
  "project-checkout": "unmanaged",
};
const storedPromptInputSchema = z.array(promptInputSchema).min(1);

export function toThread(row: ThreadRow): Thread {
  return threadSchema.parse(row);
}

export function findPublicThread(
  db: Db,
  threadId: string,
): ThreadListRow | undefined {
  return db.get<ThreadListRow>(
    `${THREAD_LIST_SELECT}
     WHERE threads.id = ? AND threads.deleted_at IS NULL
       AND (SELECT deleted_at FROM projects
         WHERE projects.id = threads.project_id) IS NULL`,
    threadId,
  );
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

export function canThreadSpawnChild(db: Db, threadId: string): boolean {
  const row = db.get<{ depth: number }>(
    `WITH RECURSIVE ancestors (id, parent_id, depth) AS (
       SELECT id, parent_thread_id, 1 FROM threads WHERE id = ?
       UNION ALL
       SELECT threads.id, threads.parent_thread_id, ancestors.depth + 1
       FROM threads JOIN ancestors ON threads.id = ancestors.parent_id
       WHERE ancestors.depth <= ${MAX_THREAD_HIERARCHY_DEPTH})
     SELECT MAX(depth) AS depth FROM ancestors`,
    threadId,
  );
  return (row?.depth ?? 1) < MAX_THREAD_HIERARCHY_DEPTH;
}

export function listQueueCounts(db: Db, threadIds: readonly string[]) {
  return db.all<{ threadId: string; queued: number; failed: number }>(
    `SELECT thread_id, COUNT(id) AS queued, COUNT(failure_reason) AS failed
     FROM queued_thread_messages
     WHERE thread_id ${IN_LIST} AND ${LIVE_QUEUE_ROW}
     GROUP BY thread_id`,
    JSON.stringify(threadIds),
  );
}

function parseJson(stored: SqlValue | undefined): unknown {
  return typeof stored === "string" ? JSON.parse(stored) : null;
}

function queuedMessageAuthor(row: Row) {
  if (row.systemNotice !== null) {
    return { initiator: "system", senderThreadId: null };
  }
  if (row.senderThreadId !== null) return { initiator: "agent" };
  return {
    initiator: row.requestedByInitiator ?? "user",
    senderThreadId: row.requestedByThreadId,
  };
}

export function listQueuedMessages(
  db: Db,
  threadId: string,
): ThreadQueuedMessage[] {
  const rows = db.all<Row>(
    `SELECT * FROM queued_thread_messages
     WHERE thread_id = ? AND ${LIVE_QUEUE_ROW} ORDER BY sort_key, id`,
    threadId,
  );
  return rows.map((row) =>
    threadQueuedMessageSchema.parse({
      ...row,
      ...queuedMessageAuthor(row),
      content: parseJson(row.content),
      groupWithNext: row.groupWithNext === 1,
      waitingOn: parseJson(row.waitingOn),
      payload: { kind: "inline" },
      editable: true,
    }),
  );
}

function toPendingInteraction(row: Row): PendingInteraction {
  const { providerId, providerThreadId, providerRequestId } = row;
  const provider = { providerId, providerThreadId, providerRequestId };
  const { pluginId, rendererId } = row;
  const fromProvider = row.originKind === "provider";
  return pendingInteractionSchema.parse({
    ...row,
    ...(fromProvider ? {} : { providerId: undefined }),
    origin: fromProvider
      ? { kind: "provider", ...provider }
      : { kind: "plugin", pluginId, rendererId },
    payload: parseJson(row.payload),
    resolution: parseJson(row.resolution),
  });
}

export function listInteractions(
  db: Db,
  threadId: string,
  interactionId?: string,
): PendingInteraction[] {
  const rows = db.all<Row>(
    `SELECT * FROM pending_interactions
     WHERE thread_id = ? AND (id = ?
       OR (? IS NULL AND status IN ('pending', 'resolving')))
     ORDER BY created_at, id`,
    threadId,
    interactionId ?? null,
    interactionId ?? null,
  );
  return rows.map(toPendingInteraction);
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
    const input = storedPromptInputSchema.safeParse(parseJson(row.input));
    return input.success ? [{ ...row, input: input.data }] : [];
  });
}

function parseExecutionDefaults(
  stored: SqlValue | undefined,
): ProjectExecutionDefaults | null {
  const parsed = projectExecutionDefaultsSchema.safeParse(parseJson(stored));
  return parsed.success ? parsed.data : null;
}

export function getProjectExecutionDefaults(
  db: Db,
  projectId: string,
): ProjectExecutionDefaults | null | undefined {
  const row = db.get<Row>(
    `SELECT execution_defaults FROM projects
     WHERE id = ? AND deleted_at IS NULL`,
    projectId,
  );
  return row && parseExecutionDefaults(row.executionDefaults);
}

export function listSidebarProjects(db: Db): SidebarProject[] {
  db.run(
    `INSERT INTO projects (id, kind, name, created_at, updated_at)
     VALUES (:id, 'personal', 'Personal', :now, :now)
     ON CONFLICT DO NOTHING`,
    { id: PERSONAL_PROJECT_ID, now: db.now() },
  );
  type ProjectRow = Omit<ProjectResponse, "sources"> & Row;
  const projects = db.all<ProjectRow>(
    `SELECT id, kind, name, git_remote_url, execution_defaults, created_at,
       updated_at
     FROM projects WHERE deleted_at IS NULL
     ORDER BY kind = 'personal', sort_key, id`,
  );
  type SourceRow = Omit<ProjectResponse["sources"][number], "isDefault"> & Row;
  const sources = db.all<SourceRow>(
    `SELECT id, project_id, 'local_path' AS type, host_id, path, is_default,
       created_at, updated_at
     FROM project_sources ORDER BY created_at, id`,
  );
  return projects.map(({ executionDefaults, ...project }) => ({
    ...project,
    sources: sources
      .filter((source) => source.projectId === project.id)
      .map((source) => ({ ...source, isDefault: source.isDefault === 1 })),
    defaultExecutionOptions: parseExecutionDefaults(executionDefaults),
  }));
}

export function listThreadSections(db: Db): ThreadSectionResponse[] {
  return db.all<ThreadSectionResponse>(
    `SELECT id, name, created_at, updated_at FROM thread_sections
     ORDER BY name, id`,
  );
}

export function findEnvironment(
  db: Db,
  environmentId: string,
): Environment | undefined {
  const row = db.get<Row>(
    `SELECT e.*, h.phase AS host_phase, h.destroyed_at AS host_destroyed_at
     FROM environments AS e LEFT JOIN hosts AS h ON h.id = e.host_id
     WHERE e.id = ?`,
    environmentId,
  );
  if (row === undefined) return undefined;
  const { teardownStatus: status, teardownAttempt: attempt, retireAt } = row;
  const message = row.teardownMessage ?? undefined;
  const settled = status === null && retireAt === null ? "active" : "retiring";
  const pending = status === null ? settled : "teardown";
  const host = {
    phase: String(row.hostPhase),
    destroyedAt: Number(row.hostDestroyedAt ?? 0) || null,
    teardownStatus: null,
  };
  return environmentSchema.parse({
    ...row,
    isGitRepo: row.isGitRepo === 1,
    isWorktree: row.isWorktree === 1,
    managed: row.providerOwnsPath === 1,
    lifecycle: {
      phase: row.status === "destroyed" ? "destroyed" : pending,
      retireAt,
      teardown: status === null ? null : { status, attempt, message },
    },
    hostLifecycle: resolveEnvironmentHostLifecycle(
      row.hostPhase === null ? null : host,
    ),
    environmentProviderSelection: parseJson(row.environmentProviderSelection),
    workspaceProvisionType:
      WORKSPACE_PROVISION_TYPES[String(row.environmentProviderId)] ?? null,
  });
}

export function findHost(
  db: Db,
  hostId: string,
  connected: boolean,
): { host: Host; destroyed: boolean } | undefined {
  const row = db.get<Row>("SELECT * FROM hosts WHERE id = ?", hostId);
  if (row === undefined) return undefined;
  const lifecycle = {
    phase: row.phase,
    suspendedAt: null,
    message: row.statusMessage,
    pendingLog: "",
    teardown: null,
  };
  const status = connected ? "connected" : "disconnected";
  const shown = { ...row, status, machineProviderId: null, lifecycle };
  return { host: hostSchema.parse(shown), destroyed: row.destroyedAt !== null };
}

export function recordExists(
  db: Db,
  table: "projects" | "thread_sections",
  id: string,
): boolean {
  const live = table === "projects" ? "AND deleted_at IS NULL" : "";
  const sql = `SELECT 1 FROM ${table} WHERE id = ? ${live}`;
  return db.get(sql, id) !== undefined;
}
