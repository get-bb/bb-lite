#![allow(clippy::result_large_err)]

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::routing::{get, post};
use bb_core::RunnerErrorCode;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::context::Ctx;
use crate::db::environments::{
    EnvironmentFilter, EnvironmentPatch, EnvironmentThreadScope, list_environment_thread_ids,
    list_environments, update_environment,
};
use crate::domain::changes::EnvironmentChangeKind;
use crate::domain::environment::{Environment, EnvironmentStatus};
use crate::environments::manager;
use crate::environments::workspace::{
    EnvironmentPathsQuery, WorkspaceMetadata, WorkspaceSubject, branch_search, call_runner,
    read_git_workspace, ready_path, record_workspace_metadata, require_environment,
    require_ready_environment, search_workspace_paths, workspace_failure,
};
use crate::error::{ApiError, ApiResult, conflict, invalid_request};
use crate::http::api::{ApiJson, ApiPath, ApiQuery, ApiResponse};
use crate::threads::engine::ops;

const COMMIT_MESSAGE: &str = "bb: automated commit";
const ENVIRONMENT_NAME_MAX_CHARS: usize = 80;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListEnvironmentsQuery {
    pub project_id: Option<String>,
    pub environment_provider_id: Option<String>,
    pub host_id: Option<String>,
    pub instance_key: Option<String>,
    pub path: Option<String>,
    pub status: Option<EnvironmentStatus>,
    pub limit: Option<String>,
    pub offset: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentStatusQuery {
    pub merge_base_branch: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentDiffQuery {
    pub target: String,
    pub merge_base_branch: Option<String>,
    pub sha: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentDiffBranchesQuery {
    pub query: Option<String>,
    pub selected_branch: Option<String>,
    pub limit: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentDiffPatchRequest {
    pub target: Value,
    pub paths: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum EnvironmentActionRequest {
    Commit,
}

fn diff_target(query: &EnvironmentDiffQuery) -> ApiResult<Value> {
    let required = |value: &Option<String>, name: &str| {
        value.clone().ok_or_else(|| invalid_request(format!("{name} is required")))
    };
    Ok(match query.target.as_str() {
        "uncommitted" => json!({ "type": "uncommitted" }),
        "commit" => json!({ "type": "commit", "sha": required(&query.sha, "sha")? }),
        "branch_committed" | "all" => {
            let merge_base_branch = query
                .merge_base_branch
                .clone()
                .ok_or_else(|| invalid_request("A merge base branch is required"))?;
            json!({ "type": query.target, "mergeBaseBranch": merge_base_branch })
        }
        _ => return Err(invalid_request("Invalid diff target")),
    })
}

fn page_bound(value: Option<&str>, minimum: i64, name: &str) -> ApiResult<Option<i64>> {
    let Some(text) = value else { return Ok(None) };
    match text.parse::<i64>() {
        Ok(number) if number >= minimum => Ok(Some(number)),
        _ => Err(invalid_request(format!("{name} must be at least {minimum}"))),
    }
}

async fn list(
    State(ctx): State<Ctx>,
    ApiQuery(query): ApiQuery<ListEnvironmentsQuery>,
) -> ApiResponse<Vec<Environment>> {
    let filter = EnvironmentFilter {
        limit: page_bound(query.limit.as_deref(), 1, "limit")?,
        offset: page_bound(query.offset.as_deref(), 0, "offset")?,
        project_id: query.project_id,
        host_id: query.host_id,
        environment_provider_id: query.environment_provider_id,
        instance_key: query.instance_key,
        path: query.path,
        status: query.status,
    };
    Ok(Json(list_environments(&ctx.db, &filter)?))
}

async fn show(State(ctx): State<Ctx>, ApiPath(id): ApiPath<String>) -> ApiResponse<Environment> {
    Ok(Json(require_environment(&ctx, &id)?))
}

fn nullable_text(value: &Value, name: &str) -> ApiResult<Option<String>> {
    match value {
        Value::Null => Ok(None),
        Value::String(text) => Ok(Some(text.clone())),
        _ => Err(invalid_request(format!("{name} must be a string or null"))),
    }
}

async fn update(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    ApiJson(payload): ApiJson<Map<String, Value>>,
) -> ApiResponse<Environment> {
    let mut patch = EnvironmentPatch::default();
    if let Some(value) = payload.get("mergeBaseBranch") {
        let branch = nullable_text(value, "mergeBaseBranch")?;
        if branch.as_deref().is_some_and(str::is_empty) {
            return Err(invalid_request("mergeBaseBranch must not be empty"));
        }
        patch.merge_base_branch = Some(branch);
    }
    if let Some(value) = payload.get("name") {
        let name = nullable_text(value, "name")?.map(|name| name.trim().to_owned());
        let chars = name.as_deref().map(|name| name.chars().count());
        if chars.is_some_and(|count| count == 0 || count > ENVIRONMENT_NAME_MAX_CHARS) {
            return Err(invalid_request("name must be between 1 and 80 characters"));
        }
        patch.name = Some(name);
    }
    if patch.merge_base_branch.is_none() && patch.name.is_none() {
        return Err(invalid_request("At least one field must be provided"));
    }
    let id = require_environment(&ctx, &id)?.id;
    update_environment(&ctx.db, &id, &patch)?;
    ctx.hub.environment(&id, vec![EnvironmentChangeKind::MetadataChanged]);
    Ok(Json(require_environment(&ctx, &id)?))
}

async fn remove(State(ctx): State<Ctx>, ApiPath(id): ApiPath<String>) -> ApiResponse<Value> {
    let id = require_environment(&ctx, &id)?.id;
    if !list_environment_thread_ids(&ctx.db, &id, EnvironmentThreadScope::Unarchived)?.is_empty() {
        return Err(conflict("Environment still has live threads"));
    }
    manager::remove(&ctx, &id).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn archive_threads(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
) -> ApiResponse<Value> {
    let id = require_environment(&ctx, &id)?.id;
    let archived_thread_ids =
        list_environment_thread_ids(&ctx.db, &id, EnvironmentThreadScope::Unarchived)?;
    for thread_id in &archived_thread_ids {
        ops::archive(&ctx, thread_id).await?;
    }
    Ok(Json(json!({ "ok": true, "archivedThreadIds": archived_thread_ids })))
}

async fn status(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    ApiQuery(query): ApiQuery<EnvironmentStatusQuery>,
) -> ApiResponse<Value> {
    let read = read_git_workspace(&ctx, &id, WorkspaceSubject::Status, |runner, found| {
        let ctx = ctx.clone();
        async move {
            let mut params = json!({ "path": ready_path(&found) });
            if let Some(branch) = query.merge_base_branch {
                params["mergeBaseBranch"] = branch.into();
            }
            let workspace = runner.call("gitStatus", params).await?;
            let branch = &workspace["branch"];
            let default_branch =
                branch["defaultBranch"].as_str().filter(|name| !name.is_empty()).map(str::to_owned);
            let observed = WorkspaceMetadata {
                branch_name: Some(branch["currentBranch"].as_str().map(str::to_owned)),
                default_branch: Some(default_branch),
                ..Default::default()
            };
            record_workspace_metadata(&ctx, &found, &observed)?;
            Ok(json!({ "workspace": workspace }))
        }
    });
    Ok(Json(read.await?))
}

async fn diff_files(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    ApiQuery(query): ApiQuery<EnvironmentDiffQuery>,
) -> ApiResponse<Value> {
    let target = diff_target(&query)?;
    let read = read_git_workspace(&ctx, &id, WorkspaceSubject::Diff, |runner, found| async move {
        let params = json!({ "path": ready_path(&found), "target": target });
        Ok(runner.call("gitDiffFiles", params).await?)
    });
    Ok(Json(read.await?))
}

async fn diff_patch(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    ApiJson(body): ApiJson<EnvironmentDiffPatchRequest>,
) -> ApiResponse<Value> {
    let read = read_git_workspace(&ctx, &id, WorkspaceSubject::Diff, |runner, found| async move {
        let mut params = json!({ "path": ready_path(&found), "target": body.target });
        if let Some(paths) = body.paths {
            params["paths"] = paths;
        }
        Ok(runner.call("gitDiffPatch", params).await?)
    });
    Ok(Json(read.await?))
}

async fn diff_file(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    ApiQuery(file): ApiQuery<Map<String, Value>>,
) -> ApiResponse<Value> {
    if !matches!(file.get("side").and_then(Value::as_str), Some("old" | "new")) {
        return Err(invalid_request(r#"Invalid option: expected one of "old"|"new""#));
    }
    let environment = require_ready_environment(&ctx, &id)?;
    let params = json!({ "path": ready_path(&environment), "file": file });
    let read = call_runner(&ctx, &environment.host_id, "gitDiffFile", params).await?;
    let mut body = json!({
        "path": read["path"],
        "content": read["content"],
        "contentEncoding": read["contentEncoding"],
        "sizeBytes": read["sizeBytes"],
    });
    if let Some(mime_type) = read.get("mimeType").filter(|value| !value.is_null()) {
        body["mimeType"] = mime_type.clone();
    }
    Ok(Json(body))
}

async fn diff_branches(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    ApiQuery(query): ApiQuery<EnvironmentDiffBranchesQuery>,
) -> ApiResponse<Value> {
    let environment = require_ready_environment(&ctx, &id)?;
    let search =
        branch_search(query.query.as_deref(), query.selected_branch, query.limit.as_deref())?;
    let mut params = json!({ "path": ready_path(&environment) });
    if let (Value::Object(target), Value::Object(fields)) =
        (&mut params, serde_json::to_value(search)?)
    {
        target.extend(fields);
    }
    Ok(Json(call_runner(&ctx, &environment.host_id, "listBranches", params).await?))
}

async fn paths(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    ApiQuery(query): ApiQuery<EnvironmentPathsQuery>,
) -> ApiResponse<Value> {
    let environment = require_ready_environment(&ctx, &id)?;
    let path = ready_path(&environment);
    Ok(Json(search_workspace_paths(&ctx, &environment.host_id, path, &query).await?))
}

async fn actions(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    ApiJson(_action): ApiJson<EnvironmentActionRequest>,
) -> ApiResponse<Value> {
    let environment = require_ready_environment(&ctx, &id)?;
    let path = ready_path(&environment);
    let params = json!({ "path": path, "message": COMMIT_MESSAGE });
    match call_runner(&ctx, &environment.host_id, "gitCommit", params).await {
        Ok(commit) => {
            ctx.hub.environment(
                &environment.id,
                vec![
                    EnvironmentChangeKind::WorkStatusChanged,
                    EnvironmentChangeKind::GitRefsChanged,
                ],
            );
            let sha = commit["commitSha"].as_str().unwrap_or_default();
            let mut body = json!({
                "ok": true,
                "action": "commit",
                "message": format!("Created commit {sha}"),
            });
            if let (Value::Object(target), Value::Object(fields)) = (&mut body, commit) {
                target.extend(fields);
            }
            Ok(Json(body))
        }
        Err(error) if error.runner_code() == Some(RunnerErrorCode::NoChanges) => {
            Err(ApiError::new(409, "no_changes", "No uncommitted changes to commit"))
        }
        Err(error) => {
            let Some(failure) = workspace_failure(path, &error) else { return Err(error) };
            let message = failure.message.clone();
            let details = json!({ "kind": "workspace_unavailable", "failure": failure });
            Err(ApiError::new(409, "workspace_unavailable", message).details(details))
        }
    }
}

pub fn register_environment_routes() -> Router<Ctx> {
    Router::new()
        .route("/environments", get(list))
        .route("/environments/{id}", get(show).patch(update).delete(remove))
        .route("/environments/{id}/status", get(status))
        .route("/environments/{id}/diff/files", get(diff_files))
        .route("/environments/{id}/diff/patch", post(diff_patch))
        .route("/environments/{id}/diff/file", get(diff_file))
        .route("/environments/{id}/diff/branches", get(diff_branches))
        .route("/environments/{id}/paths", get(paths))
        .route("/environments/{id}/actions", post(actions))
        .route("/environments/{id}/archive-threads", post(archive_threads))
}
