use axum::Json;
use axum::Router;
use axum::extract::{DefaultBodyLimit, Multipart, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::{HeaderMap, StatusCode};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value, json};

use crate::context::Ctx;
use crate::db::projects as store;
use crate::db::{RowValues, update_row};
use crate::domain::changes::ProjectChangeKind;
use crate::domain::project::{PERSONAL_PROJECT_ID, ProjectKind, ProjectResponse, ProjectSource};
use crate::environments::workspace::{branch_search, search_workspace_paths};
use crate::error::{ApiError, ApiResult, conflict, invalid_request, not_found, not_found_message};
use crate::http::api::{ApiJson, ApiPath, ApiQuery, ApiResponse};
use crate::http::range::{FileResponseOptions, file_response};
use crate::http::trust::Principal;
use crate::projects::attachments::{
    AttachmentUpload, UploadedPromptAttachment, attachment_mime_type, copy_attachments,
    resolve_attachment_path, store_attachment,
};
use crate::projects::remove::remove_project;
use crate::projects::workspace::{
    ProjectWorkspaceSelector, find_project_workspace, inspect_project_path,
    require_project_workspace,
};
use crate::providers::catalog::find_provider_definition;
use crate::runners::hosts::require_host;
use crate::threads::thread_display::list_projects_with_threads;

const ATTACHMENT_CACHE_CONTROL: &str = "private, immutable, max-age=31536000";
const ATTACHMENT_FIELD: &str = "file";
const INVALID_PROJECT_PATH_MESSAGE: &str = "Project path must be an absolute path.";
const PROJECT_PATH_ROOT_MESSAGE: &str =
    "Project path must point to a project directory, not the filesystem root.";
const UNSUPPORTED_NATIVE_WINDOWS_PROJECT_PATH_MESSAGE: &str = "Native Windows paths are not supported. Use a POSIX path like /home/me/repo or /mnt/c/Users/me/repo.";

type Created<T> = ApiResult<(StatusCode, Json<T>)>;

#[derive(Serialize)]
struct Ok {
    ok: bool,
}

const OK: Ok = Ok { ok: true };

fn normalize_project_path_input(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed == "/" { trimmed.to_owned() } else { trimmed.trim_end_matches('/').to_owned() }
}

fn is_native_windows_project_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    let drive_root = drive && path[2..].chars().all(|c| c == '/' || c == '\\');
    let drive_absolute = drive && matches!(bytes.get(2), Some(b'/' | b'\\'));
    let unc = path.strip_prefix("\\\\").is_some_and(|rest| {
        let mut parts = rest.splitn(2, ['/', '\\']);
        let server = parts.next().unwrap_or_default();
        let share = parts.next().unwrap_or_default().trim_start_matches(['/', '\\']);
        !server.is_empty() && !share.is_empty() && !share.starts_with(['/', '\\'])
    });
    drive_root || drive_absolute || unc
}

/// `localProjectPathRequestSchema`: trims, drops trailing slashes and validates.
fn project_path<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let raw = String::deserialize(deserializer)?;
    let path = normalize_project_path_input(&raw);
    let message =
        if path.is_empty() || (!is_native_windows_project_path(&path) && !path.starts_with('/')) {
            Some(INVALID_PROJECT_PATH_MESSAGE)
        } else if is_native_windows_project_path(&path) {
            Some(UNSUPPORTED_NATIVE_WINDOWS_PROJECT_PATH_MESSAGE)
        } else if path == "/" {
            Some(PROJECT_PATH_ROOT_MESSAGE)
        } else {
            None
        };
    match message {
        Some(message) => Err(serde::de::Error::custom(message)),
        None => Ok(path),
    }
}

fn optional_project_path<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    project_path(deserializer).map(Some)
}

fn non_empty<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.is_empty() {
        return Err(serde::de::Error::custom("String must contain at least 1 character(s)"));
    }
    Ok(value)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalPathSourceRequest {
    #[serde(deserialize_with = "non_empty")]
    host_id: String,
    #[serde(rename = "type")]
    _kind: LocalPathType,
    #[serde(deserialize_with = "project_path")]
    path: String,
}

#[derive(Deserialize)]
enum LocalPathType {
    #[serde(rename = "local_path")]
    LocalPath,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum CreateSourceRequest {
    #[serde(rename = "local_path", rename_all = "camelCase")]
    LocalPath {
        #[serde(deserialize_with = "non_empty")]
        host_id: String,
        #[serde(deserialize_with = "project_path")]
        path: String,
    },
    #[serde(rename = "clone")]
    Clone(serde::de::IgnoredAny),
}

#[derive(Deserialize)]
struct CreateProjectRequest {
    #[serde(deserialize_with = "non_empty")]
    name: String,
    source: LocalPathSourceRequest,
}

#[derive(Deserialize)]
struct UpdateProjectRequest {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateSourceRequest {
    #[serde(rename = "type")]
    _kind: LocalPathType,
    #[serde(default, deserialize_with = "optional_project_path")]
    path: Option<String>,
    #[serde(default)]
    is_default: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CopyAttachmentsRequest {
    #[serde(deserialize_with = "non_empty")]
    source_project_id: String,
    paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListQuery {
    #[serde(default)]
    include_personal: Option<String>,
    #[serde(default)]
    include: Option<String>,
}

#[derive(Deserialize)]
struct AttachmentQuery {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandsQuery {
    #[serde(default)]
    host_id: Option<String>,
    #[serde(default)]
    environment_id: Option<String>,
    provider: String,
}

#[derive(Deserialize)]
struct IdPath {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourcePath {
    id: String,
    source_id: String,
}

fn project_response(ctx: &Ctx, project_id: &str) -> ApiResult<ProjectResponse> {
    let project = store::require_project(&ctx.db, project_id)?;
    store::with_sources(&ctx.db, vec![project])?.into_iter().next().ok_or_else(not_found)
}

fn require_source(ctx: &Ctx, project_id: &str, id: &str) -> ApiResult<ProjectSource> {
    store::get_project_source(&ctx.db, project_id, store::SourceSelector::Id(id))?
        .ok_or_else(|| ApiError::new(404, "invalid_request", "Project source not found"))
}

async fn git_remote_of(ctx: &Ctx, host_id: &str, path: &str) -> Option<String> {
    let inspection = inspect_project_path(ctx, host_id, path).await?;
    inspection.get("remoteUrl").and_then(Value::as_str).map(str::to_owned)
}

async fn record_git_remote(
    ctx: &Ctx,
    project_id: &str,
    host_id: &str,
    path: &str,
) -> ApiResult<()> {
    let Some(url) = git_remote_of(ctx, host_id, path).await else {
        return Ok(());
    };
    if store::set_git_remote_url_if_missing(&ctx.db, project_id, &url)? {
        ctx.hub.project(project_id, vec![ProjectChangeKind::ProjectUpdated]);
    }
    Ok(())
}

async fn list_projects(
    State(ctx): State<Ctx>,
    _principal: Principal,
    ApiQuery(query): ApiQuery<ListQuery>,
) -> ApiResult<Response> {
    let mut projects = Vec::new();
    if query.include_personal.as_deref() == Some("true") {
        projects.push(store::require_project(&ctx.db, PERSONAL_PROJECT_ID)?);
    }
    projects.extend(store::list_standard_projects(&ctx.db)?);
    let with_threads =
        query.include.as_deref().is_some_and(|include| include.split(',').any(|i| i == "threads"));
    if !with_threads {
        return Ok(Json(store::with_sources(&ctx.db, projects)?).into_response());
    }
    Ok(Json(list_projects_with_threads(&ctx, projects)?).into_response())
}

async fn create_project(
    State(ctx): State<Ctx>,
    _principal: Principal,
    ApiJson(payload): ApiJson<CreateProjectRequest>,
) -> Created<ProjectResponse> {
    let LocalPathSourceRequest { host_id, path, .. } = payload.source;
    require_host(&ctx, &host_id)?;
    let git_remote_url = git_remote_of(&ctx, &host_id, &path).await;
    let source = store::LocalPathSource { host_id, path };
    let input = store::NewProject { name: payload.name, source, git_remote_url };
    let found = store::find_or_create_project(&ctx.db, &input)?;
    if found.created {
        let changes =
            vec![ProjectChangeKind::ProjectCreated, ProjectChangeKind::ProjectSourcesChanged];
        ctx.hub.project(&found.project_id, changes);
    }
    Ok((StatusCode::CREATED, Json(project_response(&ctx, &found.project_id)?)))
}

async fn show_project(
    State(ctx): State<Ctx>,
    _principal: Principal,
    ApiPath(IdPath { id }): ApiPath<IdPath>,
) -> ApiResponse<ProjectResponse> {
    Ok(Json(project_response(&ctx, &id)?))
}

async fn update_project(
    State(ctx): State<Ctx>,
    _principal: Principal,
    ApiPath(IdPath { id }): ApiPath<IdPath>,
    ApiJson(payload): ApiJson<UpdateProjectRequest>,
) -> ApiResponse<ProjectResponse> {
    let name = match payload.name {
        Some(name) if name.is_empty() => {
            return Err(invalid_request("String must contain at least 1 character(s)"));
        }
        Some(name) => name,
        None => return Err(invalid_request("At least one field must be provided")),
    };
    let id = store::require_standard_project(&ctx.db, &id)?.id;
    update_row(&ctx.db, "projects", &id, &RowValues::new().set("name", name), true)?;
    ctx.hub.project(&id, vec![ProjectChangeKind::ProjectUpdated]);
    Ok(Json(project_response(&ctx, &id)?))
}

async fn delete_project(
    State(ctx): State<Ctx>,
    _principal: Principal,
    ApiPath(IdPath { id }): ApiPath<IdPath>,
) -> ApiResponse<Ok> {
    let project = store::require_project(&ctx.db, &id)?;
    if project.kind == ProjectKind::Personal {
        return Err(conflict("The personal project cannot be deleted"));
    }
    remove_project(&ctx, &project.id).await?;
    Ok(Json(OK))
}

async fn create_source(
    State(ctx): State<Ctx>,
    _principal: Principal,
    ApiPath(IdPath { id }): ApiPath<IdPath>,
    ApiJson(payload): ApiJson<CreateSourceRequest>,
) -> Created<ProjectSource> {
    let id = store::require_standard_project(&ctx.db, &id)?.id;
    let CreateSourceRequest::LocalPath { host_id, path } = payload else {
        return Err(invalid_request(
            "Cloning a project onto a machine is not available. Add the path of an existing \
             checkout instead.",
        ));
    };
    require_host(&ctx, &host_id)?;
    let input = store::LocalPathSource { host_id: host_id.clone(), path: path.clone() };
    let source = store::add_project_source(&ctx.db, &id, &input)?;
    ctx.hub.project(&id, vec![ProjectChangeKind::ProjectSourcesChanged]);
    record_git_remote(&ctx, &id, &host_id, &path).await?;
    Ok((StatusCode::CREATED, Json(source)))
}

async fn update_source(
    State(ctx): State<Ctx>,
    _principal: Principal,
    ApiPath(SourcePath { id, source_id }): ApiPath<SourcePath>,
    ApiJson(payload): ApiJson<UpdateSourceRequest>,
) -> ApiResponse<ProjectSource> {
    if payload.path.is_none() && payload.is_default.is_none() {
        return Err(invalid_request("At least one field besides type must be provided"));
    }
    if payload.is_default == Some(false) {
        return Err(invalid_request("Invalid literal value, expected true"));
    }
    let id = store::require_standard_project(&ctx.db, &id)?.id;
    let patch = store::ProjectSourcePatch {
        path: payload.path,
        is_default: payload.is_default == Some(true),
    };
    store::update_project_source(&ctx.db, &require_source(&ctx, &id, &source_id)?, &patch)?;
    ctx.hub.project(&id, vec![ProjectChangeKind::ProjectSourcesChanged]);
    let updated = require_source(&ctx, &id, &source_id)?;
    record_git_remote(&ctx, &id, &updated.host_id, &updated.path).await?;
    Ok(Json(updated))
}

async fn delete_source(
    State(ctx): State<Ctx>,
    _principal: Principal,
    ApiPath(SourcePath { id, source_id }): ApiPath<SourcePath>,
) -> ApiResponse<Ok> {
    let id = store::require_standard_project(&ctx.db, &id)?.id;
    store::delete_project_source(&ctx.db, &require_source(&ctx, &id, &source_id)?)?;
    ctx.hub.project(&id, vec![ProjectChangeKind::ProjectSourcesChanged]);
    Ok(Json(OK))
}

async fn read_upload(mut form: Multipart) -> ApiResult<AttachmentUpload> {
    let refusal = || {
        invalid_request(format!(
            "Attachment upload accepts exactly one multipart file field named \"{ATTACHMENT_FIELD}\""
        ))
    };
    let mut fields = 0;
    let mut upload = None;
    while let Some(field) =
        form.next_field().await.map_err(|err| invalid_request(err.body_text()))?
    {
        fields += 1;
        let is_file = field.name() == Some(ATTACHMENT_FIELD) && field.file_name().is_some();
        let name = field.file_name().unwrap_or_default().to_owned();
        let content_type = field.content_type().unwrap_or_default().to_owned();
        let bytes = field.bytes().await.map_err(|err| invalid_request(err.body_text()))?;
        if is_file && fields == 1 {
            upload = Some(AttachmentUpload { name, content_type, bytes: bytes.to_vec() });
        }
    }
    match upload {
        Some(upload) if fields == 1 => Ok(upload),
        _ => Err(refusal()),
    }
}

async fn upload_attachment(
    State(ctx): State<Ctx>,
    _principal: Principal,
    ApiPath(IdPath { id }): ApiPath<IdPath>,
    form: Result<Multipart, axum::extract::multipart::MultipartRejection>,
) -> Created<UploadedPromptAttachment> {
    let id = store::require_project(&ctx.db, &id)?.id;
    let form = form.map_err(|err| invalid_request(err.body_text()))?;
    let upload = read_upload(form).await?;
    if upload.name.trim().is_empty() {
        return Err(invalid_request("Attachment filename is required"));
    }
    Ok((StatusCode::CREATED, Json(store_attachment(&ctx, &id, upload).await?)))
}

async fn copy_project_attachments(
    State(ctx): State<Ctx>,
    _principal: Principal,
    ApiPath(IdPath { id }): ApiPath<IdPath>,
    ApiJson(payload): ApiJson<CopyAttachmentsRequest>,
) -> ApiResponse<Ok> {
    if payload.paths.is_empty() || payload.paths.len() > 100 {
        return Err(invalid_request("Attachment paths must contain between 1 and 100 items"));
    }
    if payload.paths.iter().any(String::is_empty) {
        return Err(invalid_request("String must contain at least 1 character(s)"));
    }
    let target = store::require_project(&ctx.db, &id)?;
    let source = store::require_project(&ctx.db, &payload.source_project_id)?;
    copy_attachments(&ctx, &source.id, &target.id, &payload.paths).await?;
    Ok(Json(OK))
}

async fn attachment_content(
    State(ctx): State<Ctx>,
    _principal: Principal,
    ApiPath(IdPath { id }): ApiPath<IdPath>,
    ApiQuery(query): ApiQuery<AttachmentQuery>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let id = store::require_project(&ctx.db, &id)?.id;
    let path = resolve_attachment_path(&ctx.config.data_dir, &id, &query.path)?;
    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    let content_type =
        attachment_mime_type(&path).unwrap_or_else(|| "application/octet-stream".to_owned());
    let options = FileResponseOptions {
        range: header("range"),
        if_none_match: header("if-none-match"),
        content_type: &content_type,
        cache_control: ATTACHMENT_CACHE_CONTROL,
    };
    file_response(&path, options).await.ok_or_else(|| not_found_message("Attachment not found"))
}

fn workspace_selector(query: &Map<String, Value>) -> ProjectWorkspaceSelector {
    let text = |key: &str| {
        query.get(key).and_then(Value::as_str).filter(|value| !value.is_empty()).map(str::to_owned)
    };
    ProjectWorkspaceSelector { host_id: text("hostId"), environment_id: text("environmentId") }
}

async fn workspace_paths(
    State(ctx): State<Ctx>,
    _principal: Principal,
    ApiPath(IdPath { id }): ApiPath<IdPath>,
    ApiQuery(query): ApiQuery<Map<String, Value>>,
) -> ApiResponse<Value> {
    let workspace = require_project_workspace(&ctx, &id, &workspace_selector(&query))?;
    let paths = serde_json::from_value(Value::Object(query.clone()))
        .map_err(|error| crate::error::invalid_request(error.to_string()))?;
    Ok(Json(search_workspace_paths(&ctx, &workspace.host_id, &workspace.path, &paths).await?))
}

async fn project_commands(
    State(ctx): State<Ctx>,
    _principal: Principal,
    ApiPath(IdPath { id }): ApiPath<IdPath>,
    ApiQuery(query): ApiQuery<CommandsQuery>,
) -> ApiResponse<Value> {
    let selector = ProjectWorkspaceSelector {
        host_id: query.host_id,
        environment_id: query.environment_id.filter(|value| !value.is_empty()),
    };
    let workspace = find_project_workspace(&ctx, &id, &selector)?;
    if find_provider_definition(&ctx.db, &query.provider).is_none() {
        return Ok(Json(json!({ "commands": [] })));
    }
    let params = json!({ "providerId": query.provider, "cwd": workspace.path });
    Ok(Json(ctx.runners.get(&workspace.host_id)?.call("listCommands", params).await?))
}

fn default_worktree_base_branch(source: &Value) -> Value {
    let default_branch = source.get("defaultBranch").cloned().unwrap_or(Value::Null);
    let origin = source.get("originDefaultBranch").cloned().unwrap_or(Value::Null);
    if origin.is_null() {
        return default_branch;
    }
    let relation = source.get("defaultBranchRelation").and_then(Value::as_str);
    let local_is_ahead =
        !default_branch.is_null() && relation != Some("equal") && relation != Some("local-behind");
    if local_is_ahead { default_branch } else { origin }
}

async fn project_branches(
    State(ctx): State<Ctx>,
    _principal: Principal,
    ApiPath(IdPath { id }): ApiPath<IdPath>,
    ApiQuery(query): ApiQuery<Map<String, Value>>,
) -> ApiResponse<Value> {
    store::require_standard_project(&ctx.db, &id)?;
    let selector = ProjectWorkspaceSelector {
        host_id: query.get("hostId").and_then(Value::as_str).map(str::to_owned),
        environment_id: None,
    };
    let workspace = require_project_workspace(&ctx, &id, &selector)?;
    let runner = ctx.runners.get(&workspace.host_id)?;
    let mut search = Map::new();
    search.insert("path".into(), json!(workspace.path));
    let text = |key: &str| query.get(key).and_then(Value::as_str);
    let branches =
        branch_search(text("query"), text("selectedBranch").map(str::to_owned), text("limit"))?;
    if let Value::Object(fields) = serde_json::to_value(branches)? {
        search.extend(fields);
    }
    let (source, branches) = tokio::try_join!(
        runner.call("inspectGitSource", json!({ "path": workspace.path })),
        runner.call("listBranches", Value::Object(search)),
    )?;
    let default_base = default_worktree_base_branch(&source);
    let mut response = source.as_object().cloned().unwrap_or_default();
    response.extend(branches.as_object().cloned().unwrap_or_default());
    response.insert("defaultWorktreeBaseBranch".into(), default_base);
    Ok(Json(Value::Object(response)))
}

pub fn register_project_routes() -> Router<Ctx> {
    Router::new()
        .route("/projects", get(list_projects).post(create_project))
        .route("/projects/{id}", get(show_project).patch(update_project).delete(delete_project))
        .route("/projects/{id}/sources", post(create_source))
        .route(
            "/projects/{id}/sources/{sourceId}",
            axum::routing::patch(update_source).delete(delete_source),
        )
        .route(
            "/projects/{id}/attachments",
            post(upload_attachment).layer(DefaultBodyLimit::disable()),
        )
        .route("/projects/{id}/attachments/copy", post(copy_project_attachments))
        .route("/projects/{id}/attachments/content", get(attachment_content))
        .route("/projects/{id}/paths", get(workspace_paths))
        .route("/projects/{id}/commands", get(project_commands))
        .route("/projects/{id}/branches", get(project_branches))
        .route("/projects/{id}/branch-options", get(project_branches))
}
