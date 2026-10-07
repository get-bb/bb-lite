#![allow(clippy::result_large_err)]

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::{Db, DbResult, OnConflict, insert_row, new_id, params, update_row};
use crate::domain::project::{
    PERSONAL_PROJECT_ID, Project, ProjectExecutionDefaults, ProjectKind, ProjectResponse,
    ProjectSource, ProjectSourceType,
};
use crate::error::{ApiError, ApiResult, conflict};
use crate::row;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceRow {
    id: String,
    project_id: String,
    #[serde(rename = "type")]
    source_type: ProjectSourceType,
    host_id: String,
    path: String,
    #[serde(deserialize_with = "crate::db::int_bool::deserialize")]
    is_default: bool,
    created_at: i64,
    updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPathSource {
    pub host_id: String,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedEnvironment {
    pub id: String,
    pub host_id: String,
    pub path: Option<String>,
    pub provider_owns_path: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedProject {
    pub project_id: String,
    pub thread_ids: Vec<String>,
    pub environments: Vec<DeletedEnvironment>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceSelector<'a> {
    Id(&'a str),
    HostId(&'a str),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewProject {
    pub name: String,
    pub source: LocalPathSource,
    pub git_remote_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundProject {
    pub project_id: String,
    pub created: bool,
}

/// `{ path?: string; isDefault?: true }`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProjectSourcePatch {
    pub path: Option<String>,
    pub is_default: bool,
}

#[derive(Deserialize)]
struct IdRow {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SortKeyRow {
    sort_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionDefaultsRow {
    execution_defaults: Option<String>,
}

const PROJECT_COLUMNS: &str = "id, kind, name, git_remote_url, created_at, updated_at";
const SOURCE_COLUMNS: &str = "id, project_id, 'local_path' AS type, host_id, path,
  is_default, created_at, updated_at";
const STANDARD: &str = "kind = 'standard' AND deleted_at IS NULL";

fn to_source(row: SourceRow) -> ProjectSource {
    ProjectSource {
        id: row.id,
        project_id: row.project_id,
        source_type: row.source_type,
        host_id: row.host_id,
        path: row.path,
        is_default: row.is_default,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn not_found() -> ApiError {
    ApiError::new(404, "project_not_found", "Project not found")
}

pub fn ensure_personal_project(db: &Db) -> DbResult<()> {
    let row = row! {
        "id" => PERSONAL_PROJECT_ID,
        "kind" => "personal",
        "name" => "Personal",
        "createdAt" => db.now(),
        "updatedAt" => db.now(),
    };
    insert_row(db, "projects", &row, OnConflict::Ignore)
}

pub fn list_standard_projects(db: &Db) -> DbResult<Vec<Project>> {
    db.all(
        &format!(
            "SELECT {PROJECT_COLUMNS} FROM projects WHERE {STANDARD}
     ORDER BY sort_key, id"
        ),
        [],
    )
}

pub fn require_project(db: &Db, id: &str) -> ApiResult<Project> {
    let project = db.get::<Project>(
        &format!(
            "SELECT {PROJECT_COLUMNS} FROM projects
     WHERE id = ? AND deleted_at IS NULL"
        ),
        [id],
    )?;
    project.ok_or_else(not_found)
}

pub fn require_standard_project(db: &Db, id: &str) -> ApiResult<Project> {
    let project = require_project(db, id)?;
    if project.kind == ProjectKind::Standard {
        return Ok(project);
    }
    Err(not_found())
}

fn list_project_sources(db: &Db) -> DbResult<Vec<ProjectSource>> {
    let sql = format!("SELECT {SOURCE_COLUMNS} FROM project_sources ORDER BY created_at, id");
    let rows: Vec<SourceRow> = db.all(&sql, [])?;
    Ok(rows.into_iter().map(to_source).collect())
}

pub fn with_sources(db: &Db, projects: Vec<Project>) -> DbResult<Vec<ProjectResponse>> {
    let sources = list_project_sources(db)?;
    Ok(projects
        .into_iter()
        .map(|project| {
            let sources =
                sources.iter().filter(|source| source.project_id == project.id).cloned().collect();
            ProjectResponse { project, sources }
        })
        .collect())
}

pub fn get_project_source(
    db: &Db,
    project_id: &str,
    selector: SourceSelector<'_>,
) -> DbResult<Option<ProjectSource>> {
    let (column, value) = match selector {
        SourceSelector::Id(id) => ("id", id),
        SourceSelector::HostId(host_id) => ("host_id", host_id),
    };
    let sql = format!(
        "SELECT {SOURCE_COLUMNS} FROM project_sources
     WHERE project_id = ? AND {column} = ?"
    );
    let row = db.get::<SourceRow>(&sql, [project_id, value])?;
    Ok(row.map(to_source))
}

/// Malformed JSON is an error, as `JSON.parse` throws; JSON that does not
/// match the schema reads as `None`.
pub fn get_project_execution_defaults(
    db: &Db,
    project_id: &str,
) -> DbResult<Option<ProjectExecutionDefaults>> {
    let row = db.get::<ExecutionDefaultsRow>(
        "SELECT execution_defaults FROM projects WHERE id = ?",
        [project_id],
    )?;
    let Some(text) = row.and_then(|row| row.execution_defaults) else {
        return Ok(None);
    };
    let value: Value = serde_json::from_str(&text)?;
    let stored = serde_json::from_value::<ProjectExecutionDefaults>(value).ok();
    Ok(stored.filter(ProjectExecutionDefaults::is_valid))
}

pub fn set_project_execution_defaults(
    db: &Db,
    project_id: &str,
    defaults: &ProjectExecutionDefaults,
) -> DbResult<()> {
    let execution_defaults = serde_json::to_string(defaults)?;
    update_row(
        db,
        "projects",
        project_id,
        &row! { "executionDefaults" => execution_defaults },
        true,
    )?;
    Ok(())
}

fn insert_source(
    db: &Db,
    project_id: &str,
    source: &LocalPathSource,
    is_default: bool,
) -> DbResult<String> {
    let id = new_id("src");
    let row = row! {
        "id" => &id,
        "projectId" => project_id,
        "hostId" => &source.host_id,
        "path" => &source.path,
        "isDefault" => i64::from(is_default),
        "createdAt" => db.now(),
        "updatedAt" => db.now(),
    };
    insert_row(db, "project_sources", &row, OnConflict::Fail)?;
    Ok(id)
}

pub fn find_or_create_project(db: &Db, input: &NewProject) -> ApiResult<FoundProject> {
    db.transaction(|| {
        let LocalPathSource { host_id, path } = &input.source;
        let existing = db.get::<IdRow>(
            &format!(
                "SELECT projects.id FROM projects
       JOIN project_sources ON project_sources.project_id = projects.id
       WHERE {STANDARD} AND host_id = ? AND path = ?
       ORDER BY sort_key, projects.id LIMIT 1"
            ),
            [host_id, path],
        )?;
        if let Some(existing) = existing {
            return Ok(FoundProject { project_id: existing.id, created: false });
        }
        let last = db.get::<SortKeyRow>(
            &format!(
                "SELECT sort_key FROM projects WHERE {STANDARD}
       ORDER BY sort_key DESC, id DESC LIMIT 1"
            ),
            [],
        )?;
        let project_id = new_id("proj");
        let previous = last.as_ref().map(|row| row.sort_key.as_str());
        let sort_key =
            super::order_keys::order_key_between(previous, None).map_err(ApiError::internal)?;
        let row = row! {
            "id" => &project_id,
            "name" => &input.name,
            "gitRemoteUrl" => input.git_remote_url.clone(),
            "sortKey" => sort_key,
            "createdAt" => db.now(),
            "updatedAt" => db.now(),
        };
        insert_row(db, "projects", &row, OnConflict::Fail)?;
        insert_source(db, &project_id, &input.source, true)?;
        Ok(FoundProject { project_id, created: true })
    })
}

pub fn set_git_remote_url_if_missing(db: &Db, id: &str, git_remote_url: &str) -> DbResult<bool> {
    let changes = db.run(
        "UPDATE projects SET git_remote_url = ?, updated_at = ?
     WHERE id = ? AND git_remote_url IS NULL",
        params![git_remote_url, db.now(), id],
    )?;
    Ok(changes > 0)
}

pub fn delete_project(db: &Db, project_id: &str) -> DbResult<DeletedProject> {
    db.transaction(|| {
        let threads: Vec<IdRow> =
            db.all("SELECT id FROM threads WHERE project_id = ?", [project_id])?;
        let environments: Vec<DeletedEnvironment> = db.all(
            "SELECT id, host_id, path, provider_owns_path FROM environments
       WHERE project_id = ?",
            [project_id],
        )?;
        db.run("DELETE FROM projects WHERE id = ?", [project_id])?;
        let thread_ids = threads.into_iter().map(|thread| thread.id).collect();
        Ok(DeletedProject { project_id: project_id.to_owned(), thread_ids, environments })
    })
}

pub fn add_project_source(
    db: &Db,
    project_id: &str,
    source: &LocalPathSource,
) -> ApiResult<ProjectSource> {
    db.transaction(|| {
        if get_project_source(db, project_id, SourceSelector::HostId(&source.host_id))?.is_some() {
            let message = "Project already has a source on this host";
            return Err(ApiError::new(409, "project_source_host_conflict", message));
        }
        let first = db
            .rows("SELECT 1 FROM project_sources WHERE project_id = ? LIMIT 1", [project_id])?
            .is_empty();
        let id = insert_source(db, project_id, source, first)?;
        let added = get_project_source(db, project_id, SourceSelector::Id(&id))?;
        added.ok_or_else(|| ApiError::internal("Source insert was lost"))
    })
}

pub fn update_project_source(
    db: &Db,
    source: &ProjectSource,
    patch: &ProjectSourcePatch,
) -> DbResult<()> {
    db.transaction(|| {
        if patch.is_default {
            db.run(
                "UPDATE project_sources SET is_default = 0 WHERE project_id = ?",
                [&source.project_id],
            )?;
        }
        let is_default = patch.is_default.then_some(1_i64);
        let values = crate::db::RowValues::new()
            .set_some("path", patch.path.clone())
            .set_some("isDefault", is_default);
        update_row(db, "project_sources", &source.id, &values, true)?;
        Ok(())
    })
}

pub fn delete_project_source(db: &Db, source: &ProjectSource) -> ApiResult<()> {
    db.transaction(|| {
        let remaining: Vec<IdRow> = db.all(
            "SELECT id FROM project_sources WHERE project_id = ? AND id <> ?
       ORDER BY created_at, id",
            [&source.project_id, &source.id],
        )?;
        let Some(replacement) = remaining.into_iter().next() else {
            return Err(conflict("Cannot delete the last source of a project"));
        };
        db.run("DELETE FROM project_sources WHERE id = ?", [&source.id])?;
        if source.is_default {
            update_row(
                db,
                "project_sources",
                &replacement.id,
                &row! { "isDefault" => 1_i64 },
                true,
            )?;
        }
        Ok(())
    })
}
