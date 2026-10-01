import {
  PERSONAL_PROJECT_ID,
  projectExecutionDefaultsSchema,
  type Project,
  type ProjectExecutionDefaults,
  type ProjectSource,
} from "@bb/domain";
import type { ProjectResponse } from "@bb/server-contract";
import { encodeJson, newId, type Db } from "./index.js";
import { orderKeyBetween } from "./order-keys.js";
import { updateRow } from "./update-row.js";

interface SourceRow extends Omit<ProjectSource, "isDefault"> {
  isDefault: number;
}

export interface LocalPathSource {
  hostId: string;
  path: string;
}

export type ReorderOutcome = "reordered" | "unchanged" | "stale" | "invalid";

export interface DeletedProject {
  projectId: string;
  threadIds: string[];
  environments: { id: string; hostId: string; path: string | null }[];
}

const PROJECT_COLUMNS =
  "id, kind, name, git_remote_url, created_at, updated_at";
const SOURCE_COLUMNS = `id, project_id, 'local_path' AS type, host_id, path,
  is_default, created_at, updated_at`;
const STANDARD = "kind = 'standard' AND deleted_at IS NULL";

function toSource(row: SourceRow): ProjectSource {
  return { ...row, isDefault: row.isDefault === 1 };
}

export function ensurePersonalProject(db: Db): void {
  db.run(
    `INSERT INTO projects (id, kind, name, created_at, updated_at)
     VALUES (?, 'personal', 'Personal', ?, ?) ON CONFLICT DO NOTHING`,
    PERSONAL_PROJECT_ID,
    db.now(),
    db.now(),
  );
}

export function listStandardProjects(db: Db): Project[] {
  return db.all<Project>(
    `SELECT ${PROJECT_COLUMNS} FROM projects WHERE ${STANDARD}
     ORDER BY sort_key, id`,
  );
}

export function getProject(db: Db, id: string): Project | undefined {
  return db.get<Project>(
    `SELECT ${PROJECT_COLUMNS} FROM projects
     WHERE id = ? AND deleted_at IS NULL`,
    id,
  );
}

function listProjectSources(db: Db): ProjectSource[] {
  return db
    .all<SourceRow>(
      `SELECT ${SOURCE_COLUMNS} FROM project_sources ORDER BY created_at, id`,
    )
    .map(toSource);
}

export function withSources(db: Db, projects: Project[]): ProjectResponse[] {
  const sources = listProjectSources(db);
  return projects.map((project) => ({
    ...project,
    sources: sources.filter((source) => source.projectId === project.id),
  }));
}

export function getProjectSource(
  db: Db,
  projectId: string,
  selector: { id: string } | { hostId: string },
): ProjectSource | undefined {
  const column = "id" in selector ? "id" : "host_id";
  const row = db.get<SourceRow>(
    `SELECT ${SOURCE_COLUMNS} FROM project_sources
     WHERE project_id = ? AND ${column} = ?`,
    projectId,
    "id" in selector ? selector.id : selector.hostId,
  );
  return row === undefined ? undefined : toSource(row);
}

export function getProjectExecutionDefaults(
  db: Db,
  projectId: string,
): ProjectExecutionDefaults | null {
  const row = db.get<{ executionDefaults: string | null }>(
    "SELECT execution_defaults FROM projects WHERE id = ?",
    projectId,
  );
  if (row === undefined || row.executionDefaults === null) return null;
  const stored = projectExecutionDefaultsSchema.safeParse(
    JSON.parse(row.executionDefaults),
  );
  return stored.success ? stored.data : null;
}

export function setProjectExecutionDefaults(
  db: Db,
  projectId: string,
  defaults: ProjectExecutionDefaults,
): void {
  const executionDefaults = encodeJson(defaults);
  updateRow(db, "projects", projectId, { executionDefaults });
}

function insertSource(
  db: Db,
  projectId: string,
  source: LocalPathSource,
  isDefault: boolean,
): string {
  const id = newId("src");
  db.run(
    `INSERT INTO project_sources
       (id, project_id, host_id, path, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    projectId,
    source.hostId,
    source.path,
    isDefault ? 1 : 0,
    db.now(),
    db.now(),
  );
  return id;
}

export function findOrCreateProject(
  db: Db,
  input: { name: string; source: LocalPathSource; gitRemoteUrl: string | null },
): { projectId: string; created: boolean } {
  return db.transaction(() => {
    const { hostId, path } = input.source;
    const existing = db.get<{ id: string }>(
      `SELECT projects.id FROM projects
       JOIN project_sources ON project_sources.project_id = projects.id
       WHERE ${STANDARD} AND host_id = ? AND path = ?
       ORDER BY sort_key, projects.id LIMIT 1`,
      hostId,
      path,
    );
    if (existing !== undefined) {
      return { projectId: existing.id, created: false };
    }
    const last = db.get<{ sortKey: string }>(
      `SELECT sort_key FROM projects WHERE ${STANDARD}
       ORDER BY sort_key DESC, id DESC LIMIT 1`,
    );
    const projectId = newId("proj");
    db.run(
      `INSERT INTO projects
         (id, name, git_remote_url, sort_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      projectId,
      input.name,
      input.gitRemoteUrl,
      orderKeyBetween(last?.sortKey ?? null, null),
      db.now(),
      db.now(),
    );
    insertSource(db, projectId, input.source, true);
    return { projectId, created: true };
  });
}

export function renameProject(db: Db, id: string, name: string): void {
  updateRow(db, "projects", id, { name });
}

export function setGitRemoteUrlIfMissing(
  db: Db,
  id: string,
  gitRemoteUrl: string,
): boolean {
  const { changes } = db.run(
    `UPDATE projects SET git_remote_url = ?, updated_at = ?
     WHERE id = ? AND git_remote_url IS NULL`,
    gitRemoteUrl,
    db.now(),
    id,
  );
  return changes > 0;
}

export function reorderProject(
  db: Db,
  id: string,
  neighbours: {
    previousProjectId: string | null;
    nextProjectId: string | null;
  },
): ReorderOutcome {
  return db.transaction((): ReorderOutcome => {
    const ordered = db.all<{ id: string; sortKey: string }>(
      `SELECT id, sort_key FROM projects WHERE ${STANDARD}
       ORDER BY sort_key, id`,
    );
    const { previousProjectId, nextProjectId } = neighbours;
    const index = ordered.findIndex((project) => project.id === id);
    const before = ordered.find((project) => project.id === previousProjectId);
    const after = ordered.find((project) => project.id === nextProjectId);
    const missing =
      (previousProjectId !== null && before === undefined) ||
      (nextProjectId !== null && after === undefined);
    if (missing || previousProjectId === id || nextProjectId === id) {
      return "stale";
    }
    if (before && after && before.sortKey >= after.sortKey) return "invalid";
    if (
      (ordered[index - 1]?.id ?? null) === previousProjectId &&
      (ordered[index + 1]?.id ?? null) === nextProjectId
    ) {
      return "unchanged";
    }
    const sortKey = orderKeyBetween(
      before?.sortKey ?? null,
      after?.sortKey ?? null,
    );
    updateRow(db, "projects", id, { sortKey });
    return "reordered";
  });
}

export function deleteProject(db: Db, projectId: string): DeletedProject {
  return db.transaction(() => {
    const threads = db.all<{ id: string }>(
      "SELECT id FROM threads WHERE project_id = ?",
      projectId,
    );
    const environments = db.all<DeletedProject["environments"][number]>(
      "SELECT id, host_id, path FROM environments WHERE project_id = ?",
      projectId,
    );
    db.run("DELETE FROM projects WHERE id = ?", projectId);
    const threadIds = threads.map((thread) => thread.id);
    return { projectId, threadIds, environments };
  });
}

export function addProjectSource(
  db: Db,
  projectId: string,
  source: LocalPathSource,
): ProjectSource | undefined {
  return db.transaction(() => {
    if (getProjectSource(db, projectId, { hostId: source.hostId })) {
      return undefined;
    }
    const first =
      db.get(
        "SELECT 1 FROM project_sources WHERE project_id = ? LIMIT 1",
        projectId,
      ) === undefined;
    const id = insertSource(db, projectId, source, first);
    return getProjectSource(db, projectId, { id });
  });
}

export function updateProjectSource(
  db: Db,
  source: ProjectSource,
  patch: { path?: string; isDefault?: true },
): void {
  db.transaction(() => {
    if (patch.isDefault) {
      db.run(
        "UPDATE project_sources SET is_default = 0 WHERE project_id = ?",
        source.projectId,
      );
    }
    const isDefault = patch.isDefault ? 1 : undefined;
    updateRow(db, "project_sources", source.id, {
      path: patch.path,
      isDefault,
    });
  });
}

export function deleteProjectSource(
  db: Db,
  source: ProjectSource,
): "deleted" | "last-source" {
  return db.transaction(() => {
    const remaining = db.all<{ id: string }>(
      `SELECT id FROM project_sources WHERE project_id = ? AND id <> ?
       ORDER BY created_at, id`,
      source.projectId,
      source.id,
    );
    const [replacement] = remaining;
    if (replacement === undefined) return "last-source";
    db.run("DELETE FROM project_sources WHERE id = ?", source.id);
    if (source.isDefault) {
      updateRow(db, "project_sources", replacement.id, { isDefault: 1 });
    }
    return "deleted";
  });
}
