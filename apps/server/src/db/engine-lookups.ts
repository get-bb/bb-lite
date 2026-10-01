import {
  projectExecutionDefaultsSchema,
  type EnvironmentStatus,
  type PermissionMode,
  type ProjectExecutionDefaults,
} from "@bb/domain";
import { encodeJson, newId, type Db } from "./index.js";

export interface EnvironmentRow {
  id: string;
  name: string | null;
  projectId: string;
  hostId: string;
  path: string | null;
  branchName: string | null;
  isWorktree: number;
  environmentProviderId: string | null;
  status: EnvironmentStatus;
}

export interface HostRow {
  id: string;
  name: string;
  maxPermissionMode: PermissionMode;
  lastInstanceId: string | null;
}

export interface ProjectRow {
  id: string;
  kind: "standard" | "personal";
  executionDefaults: string | null;
  deletedAt: number | null;
}

const ENVIRONMENT_COLUMNS = `id, name, project_id, host_id, path, branch_name,
  is_worktree, environment_provider_id, status`;

export function getEnvironmentRow(
  db: Db,
  id: string,
): EnvironmentRow | undefined {
  return db.get<EnvironmentRow>(
    `SELECT ${ENVIRONMENT_COLUMNS} FROM environments WHERE id = ?`,
    id,
  );
}

export function findEnvironmentByPath(
  db: Db,
  projectId: string,
  hostId: string,
  path: string,
): EnvironmentRow | undefined {
  return db.get<EnvironmentRow>(
    `SELECT ${ENVIRONMENT_COLUMNS} FROM environments
     WHERE project_id = ? AND host_id = ? AND path = ? AND status != 'destroyed'`,
    projectId,
    hostId,
    path,
  );
}

export interface NewReadyEnvironment {
  projectId: string;
  hostId: string;
  path: string;
  environmentProviderId: string;
}

export function insertReadyEnvironment(
  db: Db,
  input: NewReadyEnvironment,
): EnvironmentRow {
  const id = newId("env");
  const now = db.now();
  db.run(
    `INSERT INTO environments
       (id, project_id, host_id, path, environment_provider_id, status,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ready', ?, ?)`,
    id,
    input.projectId,
    input.hostId,
    input.path,
    input.environmentProviderId,
    now,
    now,
  );
  const row = getEnvironmentRow(db, id);
  if (row === undefined) throw new Error("Environment insert was lost");
  return row;
}

export function getHostRow(db: Db, id: string): HostRow | undefined {
  return db.get<HostRow>(
    `SELECT id, name, max_permission_mode, last_instance_id
     FROM hosts WHERE id = ? AND destroyed_at IS NULL`,
    id,
  );
}

export function recordHostInstance(
  db: Db,
  hostId: string,
  instanceId: string,
): void {
  db.run(
    "UPDATE hosts SET last_instance_id = ?, last_seen_at = ? WHERE id = ?",
    instanceId,
    db.now(),
    hostId,
  );
}

export function getProjectRow(db: Db, id: string): ProjectRow | undefined {
  return db.get<ProjectRow>(
    "SELECT id, kind, execution_defaults, deleted_at FROM projects WHERE id = ?",
    id,
  );
}

export function projectSourcePath(
  db: Db,
  projectId: string,
  hostId: string,
): string | undefined {
  return db.get<{ path: string }>(
    "SELECT path FROM project_sources WHERE project_id = ? AND host_id = ?",
    projectId,
    hostId,
  )?.path;
}

export function threadSectionExists(db: Db, id: string): boolean {
  const row = db.get("SELECT 1 FROM thread_sections WHERE id = ?", id);
  return row !== undefined;
}

export function readProjectExecutionDefaults(
  db: Db,
  projectId: string,
): ProjectExecutionDefaults | null {
  const stored = getProjectRow(db, projectId)?.executionDefaults ?? null;
  if (stored === null) return null;
  const parsed = projectExecutionDefaultsSchema.safeParse(JSON.parse(stored));
  return parsed.success ? parsed.data : null;
}

export function writeProjectExecutionDefaults(
  db: Db,
  projectId: string,
  defaults: ProjectExecutionDefaults,
): void {
  db.run(
    "UPDATE projects SET execution_defaults = ?, updated_at = ? WHERE id = ?",
    encodeJson(defaults),
    db.now(),
    projectId,
  );
}
