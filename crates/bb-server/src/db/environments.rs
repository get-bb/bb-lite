use rusqlite::params_from_iter;
use rusqlite::types::Value as SqlValue;
use serde::{Deserialize, Serialize};

use crate::db::{Db, DbError, DbResult, OnConflict, RowValues, insert_row, new_id, update_row};
use crate::domain::environment::{
    Environment, EnvironmentHostState, EnvironmentLifecycle, EnvironmentLifecyclePhase,
    EnvironmentProviderSelection, EnvironmentStatus, EnvironmentTeardown, TeardownStatus,
    WorkspaceProvisionType, resolve_environment_host_lifecycle,
};
use crate::row;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentRow {
    id: String,
    name: Option<String>,
    project_id: String,
    host_id: String,
    path: Option<String>,
    is_git_repo: i64,
    is_worktree: i64,
    branch_name: Option<String>,
    base_branch: Option<String>,
    default_branch: Option<String>,
    merge_base_branch: Option<String>,
    status: EnvironmentStatus,
    environment_provider_id: Option<String>,
    environment_provider_selection: Option<String>,
    environment_provider_instance_key: Option<String>,
    provider_owns_path: i64,
    retire_at: Option<i64>,
    teardown_status: Option<TeardownStatus>,
    teardown_attempt: i64,
    teardown_message: Option<String>,
    host_phase: String,
    host_destroyed_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
}

/// `ListEnvironmentsQuery` with numeric paging.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EnvironmentFilter {
    pub project_id: Option<String>,
    pub host_id: Option<String>,
    pub environment_provider_id: Option<String>,
    pub instance_key: Option<String>,
    pub path: Option<String>,
    pub status: Option<EnvironmentStatus>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// Fields left `None` are not written; `Some(None)` writes NULL.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EnvironmentPatch {
    pub name: Option<Option<String>>,
    pub path: Option<Option<String>>,
    pub is_git_repo: Option<bool>,
    pub is_worktree: Option<bool>,
    pub branch_name: Option<Option<String>>,
    pub base_branch: Option<Option<String>>,
    pub default_branch: Option<Option<String>>,
    pub merge_base_branch: Option<Option<String>>,
    pub status: Option<EnvironmentStatus>,
    pub status_message: Option<Option<String>>,
    pub retire_at: Option<Option<i64>>,
    pub teardown_status: Option<Option<TeardownStatus>>,
    pub teardown_attempt: Option<i64>,
    pub teardown_message: Option<Option<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewEnvironment {
    pub project_id: String,
    pub host_id: String,
    pub path: Option<String>,
    pub environment_provider_id: String,
    pub owner_thread_id: Option<String>,
    pub instance_key: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvironmentUse {
    pub attached: i64,
    pub live: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnvironmentThreadScope {
    Attached,
    Unarchived,
}

#[derive(Deserialize)]
struct IdRow {
    id: String,
}

const SELECT_ENVIRONMENTS: &str = "SELECT e.id, e.name, e.project_id, e.host_id,
  e.path, e.is_git_repo, e.is_worktree, e.branch_name, e.base_branch,
  e.default_branch, e.merge_base_branch, e.status, e.environment_provider_id,
  e.environment_provider_selection, e.environment_provider_instance_key,
  e.provider_owns_path, e.retire_at, e.teardown_status, e.teardown_attempt,
  e.teardown_message, hosts.phase AS host_phase,
  hosts.destroyed_at AS host_destroyed_at, e.created_at, e.updated_at
  FROM environments e JOIN hosts ON hosts.id = e.host_id";

fn provision_type(provider_id: Option<&str>) -> Option<WorkspaceProvisionType> {
    match provider_id.unwrap_or("") {
        "git-worktree" => Some(WorkspaceProvisionType::ManagedWorktree),
        "personal-workspace" => Some(WorkspaceProvisionType::Personal),
        "project-checkout" => Some(WorkspaceProvisionType::Unmanaged),
        _ => None,
    }
}

fn lifecycle(row: &EnvironmentRow) -> EnvironmentLifecycle {
    let retire_at = row.retire_at;
    let teardown = row.teardown_status.map(|status| EnvironmentTeardown {
        status,
        attempt: row.teardown_attempt,
        message: row.teardown_message.clone(),
    });
    let phase = if row.status == EnvironmentStatus::Destroyed {
        EnvironmentLifecyclePhase::Destroyed
    } else if teardown.is_some() {
        EnvironmentLifecyclePhase::Teardown
    } else if retire_at.is_none() {
        EnvironmentLifecyclePhase::Active
    } else {
        EnvironmentLifecyclePhase::Retiring
    };
    EnvironmentLifecycle { phase, retire_at, teardown }
}

fn decode_selection(text: &str) -> DbResult<EnvironmentProviderSelection> {
    let selection: EnvironmentProviderSelection = serde_json::from_str(text)?;
    if selection.is_valid() {
        return Ok(selection);
    }
    let invalid = <serde_json::Error as serde::de::Error>::custom(
        "environment provider selection has an empty id",
    );
    Err(DbError::Decode(invalid))
}

fn to_environment(row: EnvironmentRow) -> DbResult<Environment> {
    let lifecycle = lifecycle(&row);
    let host_lifecycle = resolve_environment_host_lifecycle(Some(EnvironmentHostState {
        destroyed_at: row.host_destroyed_at,
        phase: &row.host_phase,
        teardown_status: None,
    }));
    let selection = row.environment_provider_selection.as_deref().map(decode_selection);
    let workspace_provision_type = provision_type(row.environment_provider_id.as_deref());
    Ok(Environment {
        id: row.id,
        name: row.name,
        project_id: row.project_id,
        host_id: row.host_id,
        path: row.path,
        is_git_repo: row.is_git_repo == 1,
        is_worktree: row.is_worktree == 1,
        branch_name: row.branch_name,
        base_branch: row.base_branch,
        default_branch: row.default_branch,
        merge_base_branch: row.merge_base_branch,
        status: row.status,
        environment_provider_id: row.environment_provider_id,
        lifecycle,
        host_lifecycle,
        environment_provider_selection: selection.transpose()?,
        environment_provider_instance_key: row.environment_provider_instance_key,
        managed: row.provider_owns_path == 1,
        workspace_provision_type,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

/// `condition` is SQL over the `e` (environments) and `hosts` aliases.
pub fn find_environment(
    db: &Db,
    condition: &str,
    values: impl rusqlite::Params,
) -> DbResult<Option<Environment>> {
    let sql = format!("{SELECT_ENVIRONMENTS} WHERE {condition}");
    db.get::<EnvironmentRow>(&sql, values)?.map(to_environment).transpose()
}

pub fn get_environment(db: &Db, id: &str) -> DbResult<Option<Environment>> {
    find_environment(db, "e.id = ?", [id])
}

pub fn list_environments(db: &Db, filter: &EnvironmentFilter) -> DbResult<Vec<Environment>> {
    let mut conditions: Vec<String> = Vec::new();
    if filter.status.is_none() {
        conditions.push("e.status <> 'destroyed'".to_owned());
    }
    let mut values: Vec<SqlValue> = Vec::new();
    let columns = [
        ("e.project_id", filter.project_id.as_deref()),
        ("e.host_id", filter.host_id.as_deref()),
        ("e.environment_provider_id", filter.environment_provider_id.as_deref()),
        ("e.environment_provider_instance_key", filter.instance_key.as_deref()),
        ("e.path", filter.path.as_deref()),
        ("e.status", filter.status.map(EnvironmentStatus::as_str)),
    ];
    for (column, value) in columns {
        let Some(value) = value else { continue };
        conditions.push(format!("{column} = ?"));
        values.push(SqlValue::Text(value.to_owned()));
    }
    let condition = if conditions.is_empty() { "1".to_owned() } else { conditions.join(" AND ") };
    let sql = format!(
        "{SELECT_ENVIRONMENTS} WHERE {condition}
    ORDER BY e.created_at, e.id LIMIT ? OFFSET ?"
    );
    values.push(SqlValue::Integer(filter.limit.unwrap_or(-1)));
    values.push(SqlValue::Integer(filter.offset.unwrap_or(0)));
    let rows: Vec<EnvironmentRow> = db.all(&sql, params_from_iter(values))?;
    rows.into_iter().map(to_environment).collect()
}

pub fn insert_environment(db: &Db, input: &NewEnvironment) -> DbResult<String> {
    let id = new_id("env");
    let managed = input.owner_thread_id.is_some();
    let worktree = input.environment_provider_id == "git-worktree";
    let status = if managed { "creating" } else { "provisioning" };
    let values = row! {
        "id" => &id,
        "projectId" => &input.project_id,
        "hostId" => &input.host_id,
        "path" => input.path.clone(),
        "environmentProviderId" => &input.environment_provider_id,
        "ownerThreadId" => input.owner_thread_id.clone(),
        "environmentProviderInstanceKey" => input.instance_key.clone(),
        "providerOwnsPath" => i64::from(managed),
        "isGitRepo" => i64::from(worktree),
        "isWorktree" => i64::from(worktree),
        "status" => status,
        "createdAt" => db.now(),
        "updatedAt" => db.now(),
    };
    insert_row(db, "environments", &values, OnConflict::Fail)?;
    Ok(id)
}

pub fn update_environment(db: &Db, id: &str, patch: &EnvironmentPatch) -> DbResult<bool> {
    let columns = RowValues::new()
        .set_some("name", patch.name.clone())
        .set_some("path", patch.path.clone())
        .set_some("isGitRepo", patch.is_git_repo)
        .set_some("isWorktree", patch.is_worktree)
        .set_some("branchName", patch.branch_name.clone())
        .set_some("baseBranch", patch.base_branch.clone())
        .set_some("defaultBranch", patch.default_branch.clone())
        .set_some("mergeBaseBranch", patch.merge_base_branch.clone())
        .set_some("status", patch.status.map(EnvironmentStatus::as_str))
        .set_some("statusMessage", patch.status_message.clone())
        .set_some("retireAt", patch.retire_at)
        .set_some("teardownStatus", patch.teardown_status.map(|s| s.map(TeardownStatus::as_str)))
        .set_some("teardownAttempt", patch.teardown_attempt)
        .set_some("teardownMessage", patch.teardown_message.clone());
    update_row(db, "environments", id, &columns, true)
}

pub fn list_environment_thread_ids(
    db: &Db,
    environment_id: &str,
    scope: EnvironmentThreadScope,
) -> DbResult<Vec<String>> {
    let unarchived = match scope {
        EnvironmentThreadScope::Unarchived => "AND archived_at IS NULL",
        EnvironmentThreadScope::Attached => "",
    };
    let sql = format!(
        "SELECT id FROM threads
       WHERE environment_id = ? AND deleted_at IS NULL {unarchived}
       ORDER BY created_at, id"
    );
    let rows: Vec<IdRow> = db.all(&sql, [environment_id])?;
    Ok(rows.into_iter().map(|thread| thread.id).collect())
}

pub fn environment_use(db: &Db, environment_id: &str) -> DbResult<EnvironmentUse> {
    let found = db.get::<EnvironmentUse>(
        "SELECT COUNT(*) AS attached,
       COALESCE(SUM(t.archived_at IS NULL), 0) AS live
     FROM threads t JOIN environments e ON e.id = ?
     WHERE t.deleted_at IS NULL AND (t.environment_id = e.id
       OR (t.id = e.owner_thread_id AND t.environment_id IS NULL))",
        [environment_id],
    )?;
    Ok(found.unwrap_or_default())
}

pub fn list_retirable_environment_ids(db: &Db) -> DbResult<Vec<String>> {
    let rows: Vec<IdRow> = db.all(
        "SELECT id FROM environments
       WHERE provider_owns_path = 1 AND status <> 'destroyed'",
        [],
    )?;
    Ok(rows.into_iter().map(|environment| environment.id).collect())
}

pub fn has_other_live_thread(db: &Db, environment_id: &str, thread_id: &str) -> DbResult<bool> {
    let other = db.rows(
        "SELECT 1 FROM threads
     WHERE environment_id = ? AND id <> ? AND deleted_at IS NULL
       AND archived_at IS NULL
       AND status IN ('starting', 'active', 'idle', 'stopping')",
        [environment_id, thread_id],
    )?;
    Ok(!other.is_empty())
}
