#![allow(clippy::result_large_err)]

use std::future::Future;

use bb_core::{RunnerErrorCode, SharedRunner};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::context::Ctx;
use crate::db::environments::{EnvironmentPatch, get_environment, update_environment};
use crate::db::threads::require_thread;
use crate::domain::changes::EnvironmentChangeKind;
use crate::domain::environment::{
    Environment, EnvironmentStatus, WorkspaceResolutionFailure, WorkspaceResolutionFailureCode,
};
use crate::error::{ApiError, ApiResult, invalid_request};

pub const BRANCH_LIST_LIMIT_MAX: u64 = 1_000;
pub const FILE_LIST_LIMIT_MAX: u64 = 10_000;
pub const BRANCH_LIST_LIMIT_DEFAULT: u64 = 50;
pub const PATH_LIST_LIMIT_DEFAULT: u64 = 1_000;
pub const PATH_LIST_EXCLUDED_NAMES: [&str; 10] = [
    "node_modules",
    ".pnpm-store",
    ".claude/worktrees",
    ".venv",
    "venv",
    ".turbo",
    ".next",
    ".cache",
    "__pycache__",
    ".DS_Store",
];

/// Which git read `read_git_workspace` serves, for the not-applicable message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkspaceSubject {
    Status,
    Diff,
}

impl WorkspaceSubject {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Diff => "diff",
        }
    }
}

/// The `Pick<Environment, ...>` fields a workspace read observed; `None` was not observed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WorkspaceMetadata {
    pub branch_name: Option<Option<String>>,
    pub default_branch: Option<Option<String>>,
    pub is_git_repo: Option<bool>,
    pub is_worktree: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentPathsQuery {
    pub query: Option<String>,
    pub limit: Option<String>,
    pub include_files: Option<String>,
    pub include_directories: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSearch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_branch: Option<String>,
    pub limit: u64,
}

pub fn require_environment(ctx: &Ctx, environment_id: &str) -> ApiResult<Environment> {
    get_environment(&ctx.db, environment_id)?
        .ok_or_else(|| ApiError::new(404, "environment_not_found", "Environment not found"))
}

/// The environment, refused unless it is ready; its `path` is then `Some` and non-empty.
pub fn require_ready_environment(ctx: &Ctx, environment_id: &str) -> ApiResult<Environment> {
    let environment = require_environment(ctx, environment_id)?;
    let has_path = environment.path.as_deref().is_some_and(|path| !path.is_empty());
    if environment.status == EnvironmentStatus::Ready && has_path {
        return Ok(environment);
    }
    let details = json!({ "environmentStatus": environment.status, "hasPath": has_path });
    Err(ApiError::new(409, "environment_not_ready", "Environment unavailable").details(details))
}

/// The path of an environment `require_ready_environment` returned.
pub fn ready_path(environment: &Environment) -> &str {
    environment.path.as_deref().unwrap_or_default()
}

pub fn require_thread_environment(ctx: &Ctx, thread_id: &str) -> ApiResult<Environment> {
    let thread = require_thread(&ctx.db, thread_id)?;
    if let Some(environment_id) = thread.environment_id.as_deref() {
        return require_environment(ctx, environment_id);
    }
    let details = json!({ "reason": "never_attached", "environmentStatus": null });
    let message = "Thread has no environment";
    Err(ApiError::new(409, "thread_environment_unavailable", message).details(details))
}

/// The failure a status or diff read reports instead of erroring, if `error` is one.
pub fn workspace_failure(
    workspace_path: &str,
    error: &ApiError,
) -> Option<WorkspaceResolutionFailure> {
    let runner_code = error.runner_code();
    let offline =
        error.code() == "host_unavailable" || runner_code == Some(RunnerErrorCode::Unavailable);
    let code = if offline {
        WorkspaceResolutionFailureCode::Unknown
    } else {
        match runner_code? {
            RunnerErrorCode::PathNotFound => WorkspaceResolutionFailureCode::PathNotFound,
            RunnerErrorCode::NotGitRepo => WorkspaceResolutionFailureCode::NotGitRepo,
            RunnerErrorCode::PermissionDenied => WorkspaceResolutionFailureCode::PermissionDenied,
            _ => return None,
        }
    };
    Some(WorkspaceResolutionFailure {
        code,
        workspace_path: workspace_path.to_owned(),
        message: error.body.message.clone(),
    })
}

/// Calls `method` on the environment's machine.
pub async fn call_runner(
    ctx: &Ctx,
    host_id: &str,
    method: &str,
    params: Value,
) -> ApiResult<Value> {
    let runner = ctx.runners.get(host_id)?;
    Ok(runner.call(method, params).await?)
}

/// Runs `read` against a ready git environment: `{outcome: "available", ...result}`,
/// `not_applicable` for a non-git environment, `unavailable` for a reported failure.
pub async fn read_git_workspace<F, Fut>(
    ctx: &Ctx,
    environment_id: &str,
    subject: WorkspaceSubject,
    read: F,
) -> ApiResult<Value>
where
    F: FnOnce(SharedRunner, Environment) -> Fut,
    Fut: Future<Output = ApiResult<Value>>,
{
    let environment = require_ready_environment(ctx, environment_id)?;
    if !environment.is_git_repo {
        let message =
            format!("Workspace {} is not available for non-git environments", subject.as_str());
        return Ok(json!({
            "outcome": "not_applicable",
            "reason": "non_git_environment",
            "message": message,
        }));
    }
    let path = ready_path(&environment).to_owned();
    let result = match ctx.runners.get(&environment.host_id) {
        Ok(runner) => read(runner, environment).await,
        Err(error) => Err(error),
    };
    match result {
        Ok(value) => {
            let mut available = Map::new();
            available.insert("outcome".into(), "available".into());
            if let Value::Object(fields) = value {
                available.extend(fields);
            }
            Ok(Value::Object(available))
        }
        Err(error) => match workspace_failure(&path, &error) {
            Some(failure) => Ok(json!({ "outcome": "unavailable", "failure": failure })),
            None => Err(error),
        },
    }
}

/// Stores what a workspace read observed when it differs, notifying `metadata-changed`.
pub fn record_workspace_metadata(
    ctx: &Ctx,
    environment: &Environment,
    observed: &WorkspaceMetadata,
) -> ApiResult<()> {
    let differs = observed.branch_name.as_ref().is_some_and(|v| *v != environment.branch_name)
        || observed.default_branch.as_ref().is_some_and(|v| *v != environment.default_branch)
        || observed.is_git_repo.is_some_and(|v| v != environment.is_git_repo)
        || observed.is_worktree.is_some_and(|v| v != environment.is_worktree);
    if !differs {
        return Ok(());
    }
    let patch = EnvironmentPatch {
        branch_name: observed.branch_name.clone(),
        default_branch: observed.default_branch.clone(),
        is_git_repo: observed.is_git_repo,
        is_worktree: observed.is_worktree,
        ..Default::default()
    };
    update_environment(&ctx.db, &environment.id, &patch)?;
    ctx.hub.environment(&environment.id, vec![EnvironmentChangeKind::MetadataChanged]);
    Ok(())
}

/// Re-reads the git metadata of a ready environment's path through `inspectPath`.
pub async fn refresh_workspace_metadata(ctx: &Ctx, environment: &Environment) -> ApiResult<()> {
    let params = json!({ "path": ready_path(environment) });
    let found = call_runner(ctx, &environment.host_id, "inspectPath", params).await?;
    if found.get("exists").and_then(Value::as_bool) != Some(true) {
        return Ok(());
    }
    let text = |key: &str| found.get(key).map(|value| value.as_str().map(str::to_owned));
    let observed = WorkspaceMetadata {
        branch_name: text("branchName"),
        default_branch: text("defaultBranch"),
        is_git_repo: found.get("isGitRepo").and_then(Value::as_bool),
        is_worktree: found.get("isWorktree").and_then(Value::as_bool),
    };
    record_workspace_metadata(ctx, environment, &observed)
}

fn bounded_limit(value: Option<&str>, fallback: u64, max: u64) -> ApiResult<u64> {
    let limit = match value {
        None => fallback,
        Some(text) => text.trim().parse::<u64>().unwrap_or(0),
    };
    let limit = limit.min(max);
    if limit == 0 {
        return Err(invalid_request("limit must be a positive integer"));
    }
    Ok(limit)
}

pub fn branch_search(
    query: Option<&str>,
    selected_branch: Option<String>,
    limit: Option<&str>,
) -> ApiResult<BranchSearch> {
    let query = query.map(str::trim).filter(|query| !query.is_empty()).map(str::to_owned);
    let limit = bounded_limit(limit, BRANCH_LIST_LIMIT_DEFAULT, BRANCH_LIST_LIMIT_MAX)?;
    Ok(BranchSearch { query, selected_branch, limit })
}

/// `listPaths` under `root_path` on `host_id` with the workspace defaults.
pub async fn search_workspace_paths(
    ctx: &Ctx,
    host_id: &str,
    root_path: &str,
    query: &EnvironmentPathsQuery,
) -> ApiResult<Value> {
    let include_files = query.include_files.as_deref() == Some("true");
    let include_directories = query.include_directories.as_deref() == Some("true");
    if !include_files && !include_directories {
        return Err(invalid_request("At least one path kind must be included"));
    }
    let limit =
        bounded_limit(query.limit.as_deref(), PATH_LIST_LIMIT_DEFAULT, FILE_LIST_LIMIT_MAX)?;
    let mut params = Map::new();
    params.insert("rootPath".into(), root_path.into());
    if let Some(text) = &query.query {
        params.insert("query".into(), text.as_str().into());
    }
    params.insert("limit".into(), limit.into());
    params.insert("includeFiles".into(), include_files.into());
    params.insert("includeDirectories".into(), include_directories.into());
    params.insert("includeHidden".into(), true.into());
    params.insert("excludeNames".into(), json!(PATH_LIST_EXCLUDED_NAMES));
    call_runner(ctx, host_id, "listPaths", Value::Object(params)).await
}

pub fn branch_search(_query: &serde_json::Map<String, serde_json::Value>) -> serde_json::Value {
    todo!("environments/workspace port")
}

pub async fn search_workspace_paths(
    _ctx: &Ctx,
    _host_id: &str,
    _path: &str,
    _query: &serde_json::Map<String, serde_json::Value>,
) -> ApiResult<serde_json::Value> {
    todo!("environments/workspace port")
}
