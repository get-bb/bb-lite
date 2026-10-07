#![allow(clippy::result_large_err)]

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use axum::routing::{get, post};
use base64::Engine;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::context::Ctx;
use crate::environments::workspace::{
    PATH_LIST_EXCLUDED_NAMES, PATH_LIST_LIMIT_DEFAULT, ready_path, require_ready_environment,
    require_thread_environment,
};
use crate::error::{ApiResult, invalid_request};
use crate::http::api::{ApiJson, ApiPath, ApiQuery, ApiResponse};
use crate::http::compression::Uncompressed;
use crate::http::file_bytes::{
    FileBytes, file_changed, file_error, relative_file_segments, revision_ref, serve_file_bytes,
};
use crate::http::validate::{Field, Kind, NON_EMPTY, STR, check_object, opt, req};
use crate::runners::hosts::require_host;

const HOST_ROOT: &str = "/";
const FILE_PAYLOAD_MAX_BYTES: u64 = 512 * 1024;

#[derive(Debug, Default, Deserialize)]
pub struct HostDirectoryQuery {
    pub path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HostPathsExistRequest {
    pub paths: Vec<String>,
}

/// Where a raw file read starts: the machine, the root the path must stay under, the
/// relative segments and an optional git revision.
#[derive(Clone, Debug)]
pub struct FileBytesTarget {
    pub host_id: String,
    pub root_path: String,
    pub segments: Vec<String>,
    pub git_ref: Option<String>,
}

fn runner_host(ctx: &Ctx, host_id: Option<&str>) -> ApiResult<String> {
    Ok(require_host(ctx, host_id.unwrap_or(&ctx.config.host_id))?.id)
}

async fn call(ctx: &Ctx, host_id: Option<&str>, method: &str, params: Value) -> ApiResult<Value> {
    let host_id = runner_host(ctx, host_id)?;
    Ok(ctx.runners.get(&host_id)?.call(method, params).await?)
}

fn join_posix(root: &str, segments: &[String]) -> String {
    let mut path = root.trim_end_matches('/').to_owned();
    for segment in segments {
        path.push('/');
        path.push_str(segment);
    }
    if path.is_empty() { "/".to_owned() } else { path }
}

/// The bytes of `target` answering `method` with `request` headers (`Range`, `If-None-Match`).
pub async fn serve_target(
    ctx: &Ctx,
    method: &Method,
    request: &HeaderMap,
    target: FileBytesTarget,
) -> ApiResult<Response> {
    let runner = ctx.runners.get(&target.host_id)?;
    let path = join_posix(&target.root_path, &target.segments);
    let read = |offset: u64, length: u64, revision: Option<String>| {
        let mut params = json!({
            "path": path,
            "rootPath": target.root_path,
            "offset": offset,
            "length": length,
            "revision": revision,
        });
        if let Some(git_ref) = &target.git_ref {
            params["gitRef"] = git_ref.as_str().into();
        }
        let runner = runner.clone();
        async move { runner.call("readFileChunk", params).await.map_err(file_error) }
    };
    let head = read(0, 0, None).await?;
    let mut file = FileBytes {
        content: Bytes::new(),
        mime_type: head["mimeType"].as_str().map(str::to_owned),
        size_bytes: head["sizeBytes"].as_u64().unwrap_or(0),
        modified_at_ms: head["modifiedAtMs"].as_f64(),
        revision: head["revision"].as_str().unwrap_or_default().to_owned(),
    };
    let response = match serve_file_bytes(method, request, &file) {
        Ok(response) => response,
        Err(_) => {
            let mut content = Vec::new();
            while (content.len() as u64) < file.size_bytes {
                let offset = content.len() as u64;
                let length = FILE_PAYLOAD_MAX_BYTES.min(file.size_bytes - offset);
                let chunk = read(offset, length, Some(file.revision.clone())).await?;
                let data = chunk["dataBase64"].as_str().unwrap_or_default();
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .map_err(|_| file_changed())?;
                let intact = chunk["revision"].as_str() == Some(file.revision.as_str())
                    && bytes.len() as u64 == length;
                if !intact {
                    return Err(file_changed());
                }
                content.extend_from_slice(&bytes);
            }
            file.content = Bytes::from(content);
            serve_file_bytes(method, request, &file)?
        }
    };
    let mut response = response;
    response.extensions_mut().insert(Uncompressed);
    Ok(response)
}

async fn environment_file(
    State(ctx): State<Ctx>,
    method: Method,
    headers: HeaderMap,
    ApiPath((id, file_path)): ApiPath<(String, String)>,
) -> ApiResult<Response> {
    let environment = require_ready_environment(&ctx, &id)?;
    let target = FileBytesTarget {
        segments: relative_file_segments(&file_path)?,
        host_id: environment.host_id.clone(),
        root_path: ready_path(&environment).to_owned(),
        git_ref: None,
    };
    serve_target(&ctx, &method, &headers, target).await
}

async fn revision_file(
    State(ctx): State<Ctx>,
    method: Method,
    headers: HeaderMap,
    ApiPath((id, reference, file_path)): ApiPath<(String, String, String)>,
) -> ApiResult<Response> {
    let git_ref = revision_ref(&reference)?.to_owned();
    let environment = require_ready_environment(&ctx, &id)?;
    let target = FileBytesTarget {
        segments: relative_file_segments(&file_path)?,
        host_id: environment.host_id.clone(),
        root_path: ready_path(&environment).to_owned(),
        git_ref: Some(git_ref),
    };
    serve_target(&ctx, &method, &headers, target).await
}

async fn host_file(
    State(ctx): State<Ctx>,
    method: Method,
    headers: HeaderMap,
    ApiPath((id, file_path)): ApiPath<(String, String)>,
) -> ApiResult<Response> {
    let host_id = require_thread_environment(&ctx, &id)?.host_id;
    let segments = relative_file_segments(&file_path)?;
    let target = FileBytesTarget { host_id, root_path: HOST_ROOT.into(), segments, git_ref: None };
    serve_target(&ctx, &method, &headers, target).await
}

async fn host_directory(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    ApiQuery(query): ApiQuery<HostDirectoryQuery>,
) -> ApiResponse<Value> {
    let params = match query.path {
        Some(path) => json!({ "path": path }),
        None => json!({}),
    };
    Ok(Json(call(&ctx, Some(&id), "browseDirectory", params).await?))
}

async fn paths_exist(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    ApiJson(body): ApiJson<HostPathsExistRequest>,
) -> ApiResponse<Value> {
    let params = json!({ "paths": body.paths });
    Ok(Json(call(&ctx, Some(&id), "pathsExist", params).await?))
}

const FILE_LIST_LIMIT_MAX: i64 = 10_000;
const FILE_LIST_EXCLUDE_NAMES_MAX: usize = 100;
const FILE_LIST_EXCLUDE_NAME_MAX_LENGTH: usize = 255;

const FILE_READ: &[Field] =
    &[opt("hostId", NON_EMPTY), req("path", NON_EMPTY), opt("rootPath", NON_EMPTY)];

const FILE_WRITE: &[Field] = &[
    opt("hostId", NON_EMPTY),
    req("path", NON_EMPTY),
    opt("rootPath", NON_EMPTY),
    req("content", STR),
    opt("contentEncoding", Kind::Enum(&["utf8", "base64"])),
    opt("createParents", Kind::Bool),
    opt("expectedSha256", Kind::NullableStr { min: 0 }),
    opt("mode", Kind::Int { min: Some(0), max: Some(0o777), positive: false }),
];

const FILE_LIST: &[Field] = &[
    opt("hostId", NON_EMPTY),
    req("path", NON_EMPTY),
    opt("query", STR),
    opt("limit", Kind::Int { min: None, max: Some(FILE_LIST_LIMIT_MAX), positive: true }),
    opt("includeHidden", Kind::Bool),
    opt(
        "excludeNames",
        Kind::StrArray {
            min_items: 0,
            max_items: Some(FILE_LIST_EXCLUDE_NAMES_MAX),
            item_min: 1,
            item_max: Some(FILE_LIST_EXCLUDE_NAME_MAX_LENGTH),
        },
    ),
];

fn checked(body: Map<String, Value>, fields: &[Field]) -> ApiResult<Map<String, Value>> {
    let body = Value::Object(body);
    check_object(&body, fields, true).map_err(invalid_request)?;
    match body {
        Value::Object(map) => Ok(map),
        _ => Ok(Map::new()),
    }
}

fn split_host(mut body: Map<String, Value>) -> ApiResult<(Option<String>, Map<String, Value>)> {
    let host_id = match body.remove("hostId") {
        None => None,
        Some(Value::String(host_id)) if !host_id.is_empty() => Some(host_id),
        Some(_) => return Err(invalid_request("hostId must be a non-empty string")),
    };
    if !body.get("path").and_then(Value::as_str).is_some_and(|path| !path.is_empty()) {
        return Err(invalid_request("path is required"));
    }
    Ok((host_id, body))
}

async fn read_file(
    State(ctx): State<Ctx>,
    ApiJson(body): ApiJson<Map<String, Value>>,
) -> ApiResponse<Value> {
    let body = checked(body, FILE_READ)?;
    let (host_id, location) = split_host(body)?;
    Ok(Json(call(&ctx, host_id.as_deref(), "readFile", Value::Object(location)).await?))
}

async fn write_file(
    State(ctx): State<Ctx>,
    ApiJson(body): ApiJson<Map<String, Value>>,
) -> ApiResponse<Value> {
    let body = checked(body, FILE_WRITE)?;
    let (host_id, write) = split_host(body)?;
    Ok(Json(call(&ctx, host_id.as_deref(), "writeFile", Value::Object(write)).await?))
}

async fn list_files(
    State(ctx): State<Ctx>,
    ApiJson(body): ApiJson<Map<String, Value>>,
) -> ApiResponse<Value> {
    let body = checked(body, FILE_LIST)?;
    let (host_id, mut query) = split_host(body)?;
    let root_path = query.remove("path").unwrap_or_default();
    let mut search = Map::new();
    search.insert("limit".into(), PATH_LIST_LIMIT_DEFAULT.into());
    search.insert("includeHidden".into(), true.into());
    search.insert("excludeNames".into(), json!(PATH_LIST_EXCLUDED_NAMES));
    search.extend(query);
    search.insert("includeFiles".into(), true.into());
    search.insert("includeDirectories".into(), false.into());
    search.insert("rootPath".into(), root_path);
    let listed = call(&ctx, host_id.as_deref(), "listPaths", Value::Object(search)).await?;
    let files: Vec<Value> = listed["paths"]
        .as_array()
        .map(|paths| {
            paths
                .iter()
                .map(|entry| json!({ "path": entry["path"], "name": entry["name"] }))
                .collect()
        })
        .unwrap_or_default();
    Ok(Json(json!({ "files": files, "truncated": listed["truncated"] })))
}

pub fn register_file_routes() -> Router<Ctx> {
    Router::new()
        .route("/environments/{id}/files/{*file_path}", get(environment_file))
        .route("/environments/{id}/revisions/{ref}/files/{*file_path}", get(revision_file))
        .route("/threads/{id}/host-files/{*file_path}", get(host_file))
        .route("/hosts/{id}/directory", get(host_directory))
        .route("/hosts/{id}/paths/exist", post(paths_exist))
        .route("/files/read", post(read_file))
        .route("/files/write", post(write_file))
        .route("/files/list", post(list_files))
}
