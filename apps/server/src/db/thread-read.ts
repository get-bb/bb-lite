import {
  PERSONAL_PROJECT_ID,
  pendingInteractionSchema,
  projectExecutionDefaultsSchema,
  promptInputSchema,
  resolveEnvironmentHostLifecycle,
  threadQueuedMessageSchema,
  type Environment,
  type EnvironmentStatus,
  type Host,
  type PendingInteraction,
  type PermissionMode,
  type ProjectExecutionDefaults,
  type ProjectKind,
  type ProjectSource,
  type PromptHistoryEntry,
  type Thread,
  type ThreadOriginKind,
  type ThreadQueuedMessage,
  type ThreadStatus,
  type ThreadVisibility,
} from "@bb/domain";
import type {
  ProjectResponse,
  ThreadCountGroupBy,
  ThreadCountResponse,
  ThreadSectionResponse,
} from "@bb/server-contract";
import { z } from "zod";
import type { Db, SqlValue } from "./index.js";

export interface ThreadRow {
  id: string;
  projectId: string;
  environmentId: string | null;
  providerId: string;
  providerThreadId: string | null;
  activeTurnId: string | null;
  model: string | null;
  reasoningLevel: string | null;
  permissionMode: string | null;
  serviceTier: string | null;
  modelOverride: string | null;
  reasoningLevelOverride: string | null;
  title: string | null;
  titleFallback: string | null;
  sectionId: string | null;
  status: ThreadStatus;
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
  lastReadAt: number | null;
  latestAttentionAt: number;
  createdAt: number;
  updatedAt: number;
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

export interface ThreadListFilters {
  projectId?: string;
  environmentId?: string;
  hostId?: string;
  parentThreadId?: string;
  sourceThreadId?: string;
  sectionId?: string;
  originKind?: string;
  originPluginId?: string;
  unsectioned?: boolean;
  includeHidden?: boolean;
  archived?: boolean;
  hasParent?: boolean;
  limit?: number;
  offset?: number;
}

export interface ThreadCountFilters {
  status?: string;
  hostId?: string;
  providerId?: string;
  projectId?: string;
  parentThreadId?: string | null;
  groupBy?: ThreadCountGroupBy;
  includeArchived: boolean;
  includeHidden: boolean;
}

interface ProjectRow {
  id: string;
  kind: ProjectKind;
  name: string;
  gitRemoteUrl: string | null;
  executionDefaults: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SidebarProject extends ProjectResponse {
  defaultExecutionOptions: ProjectExecutionDefaults | null;
}

interface HostRow {
  id: string;
  name: string;
  type: Host["type"];
  phase: Host["lifecycle"]["phase"];
  statusMessage: string | null;
  maxPermissionMode: PermissionMode;
  lastSeenAt: number | null;
  lastRejectedProtocolVersion: number | null;
  destroyedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

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
const IN_LIST = "(SELECT value FROM json_each(?))";
const LIVE_QUEUE_ROW = "claimed_at IS NULL AND claim_token IS NULL";
const MAX_THREAD_HIERARCHY_DEPTH = 4;
const RESTORABLE_ENVIRONMENT_PROVIDERS = new Set(["git-worktree"]);

export function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    projectId: row.projectId,
    environmentId: row.environmentId,
    providerId: row.providerId,
    title: row.title,
    titleFallback: row.titleFallback,
    sectionId: row.sectionId,
    status: row.status,
    parentThreadId: row.parentThreadId,
    sourceThreadId: row.sourceThreadId,
    lifecycleOwnerThreadId: row.lifecycleOwnerThreadId,
    originKind: row.originKind,
    originPluginId: row.originPluginId,
    visibility: row.visibility,
    archivedAt: row.archivedAt,
    pinnedAt: row.pinnedAt,
    deletedAt: row.deletedAt,
    lastReadAt: row.lastReadAt,
    latestAttentionAt: row.latestAttentionAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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

function nullness(wanted: boolean): string {
  return wanted ? "IS NOT NULL" : "IS NULL";
}

function equalities(
  columns: Record<string, SqlValue | undefined>,
  where: string[],
  params: SqlValue[],
): void {
  for (const [column, value] of Object.entries(columns)) {
    if (value === undefined) continue;
    where.push(`${column} = ?`);
    params.push(value);
  }
}

export function listThreadRows(
  db: Db,
  filters: ThreadListFilters,
): ThreadListRow[] {
  const where = ["threads.deleted_at IS NULL"];
  const params: SqlValue[] = [];
  equalities(
    {
      "threads.project_id": filters.projectId,
      "threads.environment_id": filters.environmentId,
      "e.host_id": filters.hostId,
      "threads.parent_thread_id": filters.parentThreadId,
      "threads.source_thread_id": filters.sourceThreadId,
      "threads.section_id": filters.sectionId,
      "threads.origin_kind": filters.originKind,
      "threads.origin_plugin_id": filters.originPluginId,
    },
    where,
    params,
  );
  const { archived, hasParent } = filters;
  if (filters.unsectioned === true) where.push("threads.section_id IS NULL");
  if (filters.includeHidden !== true) {
    where.push("threads.visibility = 'visible'");
  }
  if (archived !== undefined) {
    where.push(`threads.archived_at ${nullness(archived)}`);
  }
  if (hasParent !== undefined) {
    where.push(`threads.parent_thread_id ${nullness(hasParent)}`);
  }
  const order =
    archived === true
      ? "threads.archived_at DESC, threads.id DESC"
      : ACTIVE_THREAD_ORDER;
  return db.all<ThreadListRow>(
    `${THREAD_LIST_SELECT} WHERE ${where.join(" AND ")}
     ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...params,
    filters.limit ?? -1,
    filters.offset ?? 0,
  );
}

export function listThreadRowsByIds(
  db: Db,
  threadIds: readonly string[],
): ThreadListRow[] {
  return db.all<ThreadListRow>(
    `${THREAD_LIST_SELECT}
     WHERE threads.id IN ${IN_LIST} AND threads.deleted_at IS NULL`,
    JSON.stringify(threadIds),
  );
}

export function countThreads(
  db: Db,
  filters: ThreadCountFilters,
): ThreadCountResponse {
  const where = ["threads.deleted_at IS NULL"];
  const params: SqlValue[] = [];
  const { parentThreadId, groupBy } = filters;
  equalities(
    {
      "threads.status": filters.status,
      "threads.provider_id": filters.providerId,
      "threads.project_id": filters.projectId,
      "e.host_id": filters.hostId,
      "threads.parent_thread_id": parentThreadId ?? undefined,
    },
    where,
    params,
  );
  if (!filters.includeArchived) where.push("threads.archived_at IS NULL");
  if (!filters.includeHidden) where.push("threads.visibility = 'visible'");
  if (parentThreadId === null) where.push("threads.parent_thread_id IS NULL");
  const groupColumn = {
    host: "e.host_id",
    provider: "threads.provider_id",
    project: "threads.project_id",
  }[groupBy ?? "host"];
  const groups = db.all<{ key: string | null; count: number }>(
    `SELECT ${groupBy === undefined ? "NULL" : groupColumn} AS key,
       COUNT(*) AS count
     FROM threads LEFT JOIN environments AS e ON e.id = threads.environment_id
     WHERE ${where.join(" AND ")} GROUP BY 1`,
    ...params,
  );
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  return groupBy === undefined ? { total } : { total, groups };
}

export function threadChildSummary(db: Db, threadId: string) {
  const row = db.get<{ children: number; descendants: number }>(
    `WITH RECURSIVE tree (id, archived_at, deleted_at) AS (
       SELECT id, archived_at, deleted_at FROM threads
       WHERE deleted_at IS NULL AND (parent_thread_id = :threadId
         OR lifecycle_owner_thread_id = :threadId)
       UNION
       SELECT threads.id, threads.archived_at, threads.deleted_at
       FROM threads JOIN tree ON threads.parent_thread_id = tree.id
         OR threads.lifecycle_owner_thread_id = tree.id
       WHERE threads.deleted_at IS NULL)
     SELECT
       (SELECT COUNT(*) FROM threads WHERE parent_thread_id = :threadId
         AND deleted_at IS NULL) AS children,
       (SELECT COUNT(*) FROM tree WHERE id <> :threadId
         AND archived_at IS NULL AND deleted_at IS NULL) AS descendants`,
    { threadId },
  );
  return {
    nonDeletedChildCount: row?.children ?? 0,
    unarchivedDescendantCount: row?.descendants ?? 0,
  };
}

export function listThreadMentionRows(db: Db, threadIds: readonly string[]) {
  type MentionRow = Pick<
    ThreadRow,
    "id" | "projectId" | "title" | "titleFallback"
  >;
  return db.all<MentionRow>(
    `SELECT threads.id, threads.project_id, threads.title,
       threads.title_fallback
     FROM threads JOIN projects ON projects.id = threads.project_id
     WHERE threads.id IN ${IN_LIST} AND threads.deleted_at IS NULL
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

export function threadHierarchyDepth(db: Db, thread: ThreadRow): number {
  const seen = new Set<string>();
  let current: Pick<ThreadRow, "id" | "parentThreadId"> | undefined = thread;
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.parentThreadId === null) break;
    current = db.get<Pick<ThreadRow, "id" | "parentThreadId">>(
      "SELECT id, parent_thread_id FROM threads WHERE id = ?",
      current.parentThreadId,
    );
  }
  return seen.size;
}

export function canThreadSpawnChild(db: Db, thread: ThreadRow): boolean {
  return threadHierarchyDepth(db, thread) < MAX_THREAD_HIERARCHY_DEPTH;
}

export function listQueueCounts(db: Db, threadIds: readonly string[]) {
  return db.all<{ threadId: string; queued: number; failed: number }>(
    `SELECT thread_id, COUNT(id) AS queued, COUNT(failure_reason) AS failed
     FROM queued_thread_messages
     WHERE thread_id IN ${IN_LIST} AND ${LIVE_QUEUE_ROW}
     GROUP BY thread_id`,
    JSON.stringify(threadIds),
  );
}

interface QueuedMessageRow {
  id: string;
  threadId: string;
  content: string;
  senderThreadId: string | null;
  origin: string | null;
  originPluginId: string | null;
  requestedByInitiator: string | null;
  requestedByThreadId: string | null;
  systemNotice: string | null;
  model: string;
  reasoningLevel: string;
  permissionMode: string;
  serviceTier: string;
  groupWithNext: number;
  sendAt: number | null;
  waitingOn: string | null;
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

function queuedMessageAuthor(row: QueuedMessageRow) {
  if (row.systemNotice !== null) {
    return { initiator: "system", senderThreadId: null };
  }
  if (row.senderThreadId !== null) {
    return { initiator: "agent", senderThreadId: row.senderThreadId };
  }
  return {
    initiator: row.requestedByInitiator ?? "user",
    senderThreadId: row.requestedByThreadId,
  };
}

function toQueuedMessage(row: QueuedMessageRow): ThreadQueuedMessage {
  const { waitingOn, systemNotice: _notice, ...columns } = row;
  return threadQueuedMessageSchema.parse({
    ...columns,
    ...queuedMessageAuthor(row),
    content: JSON.parse(row.content),
    groupWithNext: row.groupWithNext === 1,
    waitingOn: waitingOn === null ? null : JSON.parse(waitingOn),
    payload: { kind: "inline" },
    editable: true,
  });
}

export function listQueuedMessages(
  db: Db,
  threadId: string,
): ThreadQueuedMessage[] {
  const rows = db.all<QueuedMessageRow>(
    `SELECT * FROM queued_thread_messages
     WHERE thread_id = ? AND ${LIVE_QUEUE_ROW} ORDER BY sort_key, id`,
    threadId,
  );
  return rows.map(toQueuedMessage);
}

interface InteractionRow {
  id: string;
  threadId: string;
  originKind: string;
  turnId: string | null;
  providerId: string | null;
  providerThreadId: string | null;
  providerRequestId: string | null;
  pluginId: string | null;
  rendererId: string | null;
  status: string;
  statusReason: string | null;
  payload: string;
  resolution: string | null;
  createdAt: number;
  expiresAt: number | null;
  resolvedAt: number | null;
}

function toPendingInteraction(row: InteractionRow): PendingInteraction {
  const { providerId, providerThreadId, providerRequestId } = row;
  const provider = { providerId, providerThreadId, providerRequestId };
  const { pluginId, rendererId } = row;
  return pendingInteractionSchema.parse({
    id: row.id,
    threadId: row.threadId,
    turnId: row.turnId,
    ...(row.originKind === "provider" ? provider : {}),
    origin:
      row.originKind === "provider"
        ? { kind: "provider", ...provider }
        : { kind: "plugin", pluginId, rendererId },
    status: row.status,
    statusReason: row.statusReason,
    payload: JSON.parse(row.payload),
    resolution: row.resolution === null ? null : JSON.parse(row.resolution),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    resolvedAt: row.resolvedAt,
  });
}

export function listOpenInteractions(
  db: Db,
  threadId: string,
): PendingInteraction[] {
  const rows = db.all<InteractionRow>(
    `SELECT * FROM pending_interactions
     WHERE thread_id = ? AND status IN ('pending', 'resolving')
     ORDER BY created_at, id`,
    threadId,
  );
  return rows.map(toPendingInteraction);
}

export function findInteraction(
  db: Db,
  threadId: string,
  interactionId: string,
): PendingInteraction | undefined {
  const row = db.get<InteractionRow>(
    "SELECT * FROM pending_interactions WHERE id = ? AND thread_id = ?",
    interactionId,
    threadId,
  );
  return row === undefined ? undefined : toPendingInteraction(row);
}

const storedPromptInputSchema = z.array(promptInputSchema).min(1);

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
  return rows.flatMap(({ id: entryId, createdAt, input }) => {
    const parsed = storedPromptInputSchema.safeParse(JSON.parse(input));
    return parsed.success
      ? [{ id: entryId, createdAt, input: parsed.data }]
      : [];
  });
}

function parseExecutionDefaults(
  stored: string | null,
): ProjectExecutionDefaults | null {
  if (stored === null) return null;
  const parsed = projectExecutionDefaultsSchema.safeParse(JSON.parse(stored));
  return parsed.success ? parsed.data : null;
}

export function getProjectExecutionDefaults(
  db: Db,
  projectId: string,
): ProjectExecutionDefaults | null | undefined {
  const row = db.get<{ executionDefaults: string | null }>(
    `SELECT execution_defaults FROM projects
     WHERE id = ? AND deleted_at IS NULL`,
    projectId,
  );
  return row && parseExecutionDefaults(row.executionDefaults);
}

function toSidebarProjects(db: Db, rows: ProjectRow[]): SidebarProject[] {
  type SourceRow = Omit<ProjectSource, "isDefault" | "type"> & {
    isDefault: number;
  };
  const sources = db.all<SourceRow>(
    `SELECT id, project_id, host_id, path, is_default, created_at, updated_at
     FROM project_sources WHERE project_id IN ${IN_LIST}
     ORDER BY created_at, id`,
    JSON.stringify(rows.map((row) => row.id)),
  );
  return rows.map(({ executionDefaults, ...project }) => ({
    ...project,
    sources: sources
      .filter((source) => source.projectId === project.id)
      .map((source) => ({
        ...source,
        type: "local_path" as const,
        isDefault: source.isDefault === 1,
      })),
    defaultExecutionOptions: parseExecutionDefaults(executionDefaults),
  }));
}

export function listSidebarProjects(db: Db): {
  projects: SidebarProject[];
  personalProject: SidebarProject;
} {
  const columns =
    "id, kind, name, git_remote_url, execution_defaults, created_at, updated_at";
  db.run(
    `INSERT INTO projects (id, kind, name, created_at, updated_at)
     VALUES (:id, 'personal', 'Personal', :now, :now)
     ON CONFLICT DO NOTHING`,
    { id: PERSONAL_PROJECT_ID, now: db.now() },
  );
  const rows = db.all<ProjectRow>(
    `SELECT ${columns} FROM projects WHERE deleted_at IS NULL
     ORDER BY kind = 'personal', sort_key, id`,
  );
  const projects = toSidebarProjects(db, rows);
  const personalProject = projects.pop();
  if (personalProject === undefined) throw new Error("No personal project");
  return { projects, personalProject };
}

export function listThreadSections(db: Db): ThreadSectionResponse[] {
  return db.all<ThreadSectionResponse>(
    `SELECT id, name, created_at, updated_at FROM thread_sections
     ORDER BY name, id`,
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

interface EnvironmentRow {
  id: string;
  name: string | null;
  projectId: string;
  hostId: string;
  path: string | null;
  isGitRepo: number;
  isWorktree: number;
  branchName: string | null;
  baseBranch: string | null;
  defaultBranch: string | null;
  mergeBaseBranch: string | null;
  environmentProviderId: string | null;
  environmentProviderSelection: string | null;
  environmentProviderInstanceKey: string | null;
  providerOwnsPath: number;
  status: EnvironmentStatus;
  retireAt: number | null;
  teardownStatus: "running" | "failed" | "removed" | null;
  teardownAttempt: number;
  teardownMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

const WORKSPACE_PROVISION_TYPES = {
  "git-worktree": "managed-worktree",
  "personal-workspace": "personal",
  "project-checkout": "unmanaged",
} as const;

function findHostRow(db: Db, hostId: string): HostRow | undefined {
  return db.get<HostRow>("SELECT * FROM hosts WHERE id = ?", hostId);
}

function environmentLifecyclePhase(row: EnvironmentRow) {
  if (row.status === "destroyed") return "destroyed";
  if (row.teardownStatus !== null) return "teardown";
  return row.retireAt === null ? "active" : "retiring";
}

export function findEnvironment(
  db: Db,
  environmentId: string,
): Environment | undefined {
  const row = db.get<EnvironmentRow>(
    "SELECT * FROM environments WHERE id = ?",
    environmentId,
  );
  if (row === undefined) return undefined;
  const { teardownStatus: status, teardownAttempt: attempt } = row;
  const message = row.teardownMessage ?? undefined;
  const selection = row.environmentProviderSelection;
  const providerId = row.environmentProviderId;
  const host = findHostRow(db, row.hostId);
  return {
    id: row.id,
    name: row.name,
    projectId: row.projectId,
    hostId: row.hostId,
    path: row.path,
    isGitRepo: row.isGitRepo === 1,
    isWorktree: row.isWorktree === 1,
    branchName: row.branchName,
    baseBranch: row.baseBranch,
    defaultBranch: row.defaultBranch,
    mergeBaseBranch: row.mergeBaseBranch,
    status: row.status,
    environmentProviderId: providerId,
    lifecycle: {
      phase: environmentLifecyclePhase(row),
      retireAt: row.retireAt,
      teardown:
        status === null
          ? null
          : { status, attempt, ...(message === undefined ? {} : { message }) },
    },
    hostLifecycle: resolveEnvironmentHostLifecycle(
      host === undefined ? null : { ...host, teardownStatus: null },
    ),
    environmentProviderSelection:
      selection === null ? null : JSON.parse(selection),
    environmentProviderInstanceKey: row.environmentProviderInstanceKey,
    managed: row.providerOwnsPath === 1,
    workspaceProvisionType:
      Object.entries(WORKSPACE_PROVISION_TYPES).find(
        ([id]) => id === providerId,
      )?.[1] ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function findHost(
  db: Db,
  hostId: string,
  connected: boolean,
): { host: Host; destroyed: boolean } | undefined {
  const row = findHostRow(db, hostId);
  if (row === undefined) return undefined;
  const host: Host = {
    id: row.id,
    name: row.name,
    type: row.type,
    status: connected ? "connected" : "disconnected",
    machineProviderId: null,
    lifecycle: {
      phase: row.phase,
      suspendedAt: null,
      message: row.statusMessage,
      pendingLog: "",
      teardown: null,
    },
    maxPermissionMode: row.maxPermissionMode,
    lastSeenAt: row.lastSeenAt,
    lastRejectedProtocolVersion: row.lastRejectedProtocolVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return { host, destroyed: row.destroyedAt !== null };
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

export function canRestoreEnvironment(db: Db, thread: ThreadListRow): boolean {
  const settled = thread.status === "idle" || thread.status === "error";
  if (thread.archivedAt !== null || !settled) return false;
  if (thread.environmentStatus !== "destroyed") return false;
  const environment = findEnvironment(db, thread.environmentId ?? "");
  return (
    environment !== undefined &&
    environment.environmentProviderSelection !== null &&
    environment.hostLifecycle === "active" &&
    RESTORABLE_ENVIRONMENT_PROVIDERS.has(
      environment.environmentProviderId ?? "",
    )
  );
}

export function hostPermissionCeiling(
  db: Db,
  hostId: string | null,
): PermissionMode {
  if (hostId === null) return "full";
  return findHostRow(db, hostId)?.maxPermissionMode ?? "full";
}
