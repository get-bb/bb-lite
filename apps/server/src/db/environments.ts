import {
  environmentProviderSelectionSchema,
  resolveEnvironmentHostLifecycle,
  type Environment,
  type EnvironmentStatus,
  type WorkspaceProvisionType,
} from "@bb/domain";
import type { ListEnvironmentsQuery } from "@bb/server-contract";
import {
  decodeJson,
  insertRow,
  newId,
  updateRow,
  type Db,
  type RowValues,
  type SqlValue,
} from "./index.js";

type Derived =
  | "isGitRepo"
  | "isWorktree"
  | "lifecycle"
  | "hostLifecycle"
  | "environmentProviderSelection"
  | "managed"
  | "workspaceProvisionType";

interface EnvironmentRow extends Omit<Environment, Derived> {
  isGitRepo: number;
  isWorktree: number;
  environmentProviderSelection: string | null;
  providerOwnsPath: number;
  retireAt: number | null;
  teardownStatus: "running" | "failed" | "removed" | null;
  teardownAttempt: number;
  teardownMessage: string | null;
  hostPhase: string;
  hostDestroyedAt: number | null;
}

type Page = "limit" | "offset";
type EnvironmentFilter = Omit<ListEnvironmentsQuery, Page> &
  Partial<Record<Page, number>>;

export type EnvironmentPatch = {
  name?: string | null;
  path?: string | null;
  isGitRepo?: boolean;
  isWorktree?: boolean;
  branchName?: string | null;
  baseBranch?: string | null;
  defaultBranch?: string | null;
  mergeBaseBranch?: string | null;
  status?: EnvironmentStatus;
  statusMessage?: string | null;
  retireAt?: number | null;
  teardownStatus?: EnvironmentRow["teardownStatus"];
  teardownAttempt?: number;
  teardownMessage?: string | null;
};

export interface NewEnvironment {
  projectId: string;
  hostId: string;
  path: string | null;
  environmentProviderId: string;
  ownerThreadId: string | null;
  instanceKey: string | null;
}

export interface EnvironmentUse {
  attached: number;
  live: number;
}

const SELECT_ENVIRONMENTS = `SELECT e.id, e.name, e.project_id, e.host_id,
  e.path, e.is_git_repo, e.is_worktree, e.branch_name, e.base_branch,
  e.default_branch, e.merge_base_branch, e.status, e.environment_provider_id,
  e.environment_provider_selection, e.environment_provider_instance_key,
  e.provider_owns_path, e.retire_at, e.teardown_status, e.teardown_attempt,
  e.teardown_message, hosts.phase AS host_phase,
  hosts.destroyed_at AS host_destroyed_at, e.created_at, e.updated_at
  FROM environments e JOIN hosts ON hosts.id = e.host_id`;

const FILTER_COLUMNS = {
  projectId: "e.project_id",
  hostId: "e.host_id",
  environmentProviderId: "e.environment_provider_id",
  instanceKey: "e.environment_provider_instance_key",
  path: "e.path",
  status: "e.status",
} as const;

const PROVISION_TYPES: Record<string, WorkspaceProvisionType> = {
  "git-worktree": "managed-worktree",
  "personal-workspace": "personal",
  "project-checkout": "unmanaged",
};

function lifecycle(row: EnvironmentRow): Environment["lifecycle"] {
  const { retireAt, teardownStatus: status, teardownAttempt: attempt } = row;
  const message = row.teardownMessage ?? undefined;
  const teardown = status === null ? null : { status, attempt, message };
  if (row.status === "destroyed") {
    return { phase: "destroyed", retireAt, teardown };
  }
  if (teardown !== null) return { phase: "teardown", retireAt, teardown };
  const phase = retireAt === null ? "active" : "retiring";
  return { phase, retireAt, teardown };
}

function toEnvironment(row: EnvironmentRow): Environment {
  const { hostPhase: phase, hostDestroyedAt: destroyedAt } = row;
  const selection = row.environmentProviderSelection;
  const providerId = row.environmentProviderId;
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
    lifecycle: lifecycle(row),
    hostLifecycle: resolveEnvironmentHostLifecycle({
      destroyedAt,
      phase,
      teardownStatus: null,
    }),
    environmentProviderSelection:
      selection === null
        ? null
        : decodeJson(environmentProviderSelectionSchema, selection),
    environmentProviderInstanceKey: row.environmentProviderInstanceKey,
    managed: row.providerOwnsPath === 1,
    workspaceProvisionType: PROVISION_TYPES[providerId ?? ""] ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function findEnvironment(
  db: Db,
  where: string,
  ...values: SqlValue[]
): Environment | undefined {
  const sql = `${SELECT_ENVIRONMENTS} WHERE ${where}`;
  const row = db.get<EnvironmentRow>(sql, ...values);
  return row === undefined ? undefined : toEnvironment(row);
}

export function getEnvironment(db: Db, id: string): Environment | undefined {
  return findEnvironment(db, "e.id = ?", id);
}

export function listEnvironments(
  db: Db,
  filter: EnvironmentFilter = {},
): Environment[] {
  const conditions =
    filter.status === undefined ? ["e.status <> 'destroyed'"] : [];
  const values: SqlValue[] = [];
  for (const [key, column] of Object.entries(FILTER_COLUMNS)) {
    const value = filter[key as keyof typeof FILTER_COLUMNS];
    if (value === undefined) continue;
    conditions.push(`${column} = ?`);
    values.push(value);
  }
  const where = conditions.length === 0 ? "1" : conditions.join(" AND ");
  const sql = `${SELECT_ENVIRONMENTS} WHERE ${where}
    ORDER BY e.created_at, e.id LIMIT ? OFFSET ?`;
  values.push(filter.limit ?? -1, filter.offset ?? 0);
  return db.all<EnvironmentRow>(sql, ...values).map(toEnvironment);
}

export function insertEnvironment(db: Db, input: NewEnvironment): string {
  const id = newId("env");
  const { instanceKey, ...columns } = input;
  const managed = input.ownerThreadId !== null;
  const worktree = input.environmentProviderId === "git-worktree";
  insertRow(db, "environments", {
    id,
    ...columns,
    environmentProviderInstanceKey: instanceKey,
    providerOwnsPath: Number(managed),
    isGitRepo: Number(worktree),
    isWorktree: Number(worktree),
    status: managed ? "creating" : "provisioning",
    createdAt: db.now(),
    updatedAt: db.now(),
  });
  return id;
}

export function updateEnvironment(
  db: Db,
  id: string,
  patch: EnvironmentPatch,
): boolean {
  const columns: RowValues = {};
  for (const [key, value] of Object.entries(patch)) {
    columns[key] = typeof value === "boolean" ? Number(value) : value;
  }
  return updateRow(db, "environments", id, columns);
}

export function listEnvironmentThreadIds(
  db: Db,
  environmentId: string,
  scope: "attached" | "unarchived",
): string[] {
  const unarchived = scope === "unarchived" ? "AND archived_at IS NULL" : "";
  return db
    .all<{ id: string }>(
      `SELECT id FROM threads
       WHERE environment_id = ? AND deleted_at IS NULL ${unarchived}
       ORDER BY created_at, id`,
      environmentId,
    )
    .map((thread) => thread.id);
}

export function environmentUse(db: Db, environmentId: string): EnvironmentUse {
  const use = db.get<EnvironmentUse>(
    `SELECT COUNT(*) AS attached,
       COALESCE(SUM(t.archived_at IS NULL), 0) AS live
     FROM threads t JOIN environments e ON e.id = ?
     WHERE t.deleted_at IS NULL AND (t.environment_id = e.id
       OR (t.id = e.owner_thread_id AND t.environment_id IS NULL))`,
    environmentId,
  );
  return use ?? { attached: 0, live: 0 };
}

export function listRetirableEnvironmentIds(db: Db): string[] {
  return db
    .all<{ id: string }>(
      `SELECT id FROM environments
       WHERE provider_owns_path = 1 AND status <> 'destroyed'`,
    )
    .map((environment) => environment.id);
}

export function hasOtherLiveThread(
  db: Db,
  environmentId: string,
  threadId: string,
): boolean {
  const other = db.get(
    `SELECT 1 FROM threads
     WHERE environment_id = ? AND id <> ? AND deleted_at IS NULL
       AND archived_at IS NULL
       AND status IN ('starting', 'active', 'idle', 'stopping')`,
    environmentId,
    threadId,
  );
  return other !== undefined;
}
