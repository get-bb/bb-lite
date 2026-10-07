//! `apps/server/src/http/routes/plugins.ts`: plugin management, settings,
//! RPC, the plugins' own HTTP routes, the CLI endpoint and app assets.

use std::convert::Infallible;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Extension, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use indexmap::IndexMap;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::context::Ctx;
use crate::error::{
    ApiError, ApiResult, error_message, invalid_request, not_found, not_found_message,
};
use crate::http::api::{ApiPath, ApiQuery, ApiResponse};
use crate::http::compression::Uncompressed;
use crate::http::trust::{Principal, require_owner};
use crate::plugins::api::{
    CliContext, CliResult, HttpAuth, MentionQuery, RpcErrorCode, RpcFailure,
};
use crate::plugins::host::PluginHost;
use crate::plugins::manifest::resolve_inside;

pub const CLI_KEEPALIVE: Duration = Duration::from_millis(10_000);
const IMMUTABLE: &str = "public, max-age=31536000, immutable";
const MANAGER_REFUSAL: &str = "Only the owner can manage plugins";
const MENTION_TRIGGERS: [&str; 5] = ["@", "#", "$", "!", "~"];

fn parse_json(text: &[u8]) -> ApiResult<Value> {
    let blank = std::str::from_utf8(text).map(|t| t.trim().is_empty()).unwrap_or(false);
    if blank {
        return Ok(Value::Null);
    }
    serde_json::from_slice(text).map_err(|_| invalid_request("The request body must be JSON"))
}

fn json_body<T: DeserializeOwned>(body: &[u8]) -> ApiResult<T> {
    let value = match parse_json(body)? {
        Value::Null => json!({}),
        value => value,
    };
    serde_json::from_value(value).map_err(|error| invalid_request(error_message(&error)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsUpdate {
    values: IndexMap<String, Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenRequest {
    #[serde(default)]
    rotate: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliRequest {
    argv: Vec<String>,
    cwd: Option<String>,
    thread_id: Option<String>,
    project_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MentionSearch {
    #[serde(default)]
    q: String,
    trigger: Option<String>,
    project_id: Option<String>,
    thread_id: Option<String>,
}

#[derive(Deserialize)]
struct ReloadQuery {
    id: Option<String>,
}

#[derive(Deserialize)]
struct AppFileQuery {
    h: Option<String>,
}

pub fn router() -> Router<Ctx> {
    Router::new()
        .route("/plugins", get(list))
        .route("/plugins/contributions", get(contributions))
        .route("/plugins/mentions/search", get(search_mentions))
        .route("/plugins/reload", post(reload))
        .route("/plugins/{id}/enable", post(enable))
        .route("/plugins/{id}/disable", post(disable))
        .route("/plugins/{id}/settings", get(read_settings).put(write_settings))
        .route("/plugins/{id}/token", post(mint_token))
        .route("/plugins/{id}/rpc/{method}", post(rpc))
        .route("/plugins/{id}/cli", post(cli))
        .route("/plugins/{id}/http", any(plugin_http))
        .route("/plugins/{id}/http/{*rest}", any(plugin_http))
        .route("/plugins/{id}/app.js", get(app_js))
        .route("/plugins/{id}/app.css", get(app_css))
        .route("/plugins/{id}/assets/{*path}", get(asset))
}

async fn list(State(ctx): State<Ctx>) -> ApiResponse<Value> {
    Ok(axum::Json(json!({ "plugins": ctx.plugins.list() })))
}

async fn contributions(State(ctx): State<Ctx>) -> ApiResponse<Value> {
    Ok(axum::Json(ctx.plugins.contributions()))
}

async fn search_mentions(
    State(ctx): State<Ctx>,
    query: Result<ApiQuery<MentionSearch>, ApiError>,
) -> ApiResponse<Value> {
    let refused = || invalid_request("Invalid mention search query");
    let ApiQuery(search) = query.map_err(|_| refused())?;
    let trigger = search.trigger.unwrap_or_else(|| "@".into());
    let blank = |v: &Option<String>| v.as_deref() == Some("");
    if !MENTION_TRIGGERS.contains(&trigger.as_str())
        || blank(&search.project_id)
        || blank(&search.thread_id)
    {
        return Err(refused());
    }
    let query = MentionQuery {
        trigger,
        query: search.q.trim().to_owned(),
        project_id: search.project_id,
        thread_id: search.thread_id,
    };
    let groups = ctx.plugins.search_mentions(query).await;
    Ok(axum::Json(json!({ "ok": true, "groups": groups })))
}

async fn reload(
    State(ctx): State<Ctx>,
    Extension(principal): Extension<Principal>,
    ApiQuery(query): ApiQuery<ReloadQuery>,
) -> ApiResponse<Value> {
    require_owner(&principal, MANAGER_REFUSAL)?;
    ctx.plugins.reload(query.id.as_deref()).await?;
    Ok(axum::Json(json!({ "ok": true, "plugins": ctx.plugins.list() })))
}

async fn set_enabled(
    ctx: Ctx,
    principal: Principal,
    id: String,
    enabled: bool,
) -> ApiResponse<Value> {
    require_owner(&principal, MANAGER_REFUSAL)?;
    let plugin = ctx.plugins.set_enabled(&id, enabled).await?;
    Ok(axum::Json(json!({ "ok": true, "plugin": plugin })))
}

async fn enable(
    State(ctx): State<Ctx>,
    Extension(principal): Extension<Principal>,
    ApiPath(id): ApiPath<String>,
) -> ApiResponse<Value> {
    set_enabled(ctx, principal, id, true).await
}

async fn disable(
    State(ctx): State<Ctx>,
    Extension(principal): Extension<Principal>,
    ApiPath(id): ApiPath<String>,
) -> ApiResponse<Value> {
    set_enabled(ctx, principal, id, false).await
}

async fn settings_body(
    plugins: &PluginHost,
    id: &str,
    update: Option<IndexMap<String, Value>>,
) -> ApiResponse<Value> {
    let view = plugins.settings(id, update).await?;
    Ok(axum::Json(json!({ "ok": true, "schema": view.schema, "values": view.values })))
}

async fn read_settings(State(ctx): State<Ctx>, ApiPath(id): ApiPath<String>) -> ApiResponse<Value> {
    settings_body(&ctx.plugins, &id, None).await
}

async fn write_settings(
    State(ctx): State<Ctx>,
    Extension(principal): Extension<Principal>,
    ApiPath(id): ApiPath<String>,
    body: Bytes,
) -> ApiResponse<Value> {
    require_owner(&principal, MANAGER_REFUSAL)?;
    let SettingsUpdate { values } = json_body(&body)?;
    settings_body(&ctx.plugins, &id, Some(values)).await
}

async fn mint_token(
    State(ctx): State<Ctx>,
    Extension(principal): Extension<Principal>,
    ApiPath(id): ApiPath<String>,
    body: Bytes,
) -> ApiResponse<Value> {
    require_owner(&principal, MANAGER_REFUSAL)?;
    let TokenRequest { rotate } = json_body(&body)?;
    let token = ctx.plugins.token(&id, rotate)?;
    Ok(axum::Json(json!({ "ok": true, "token": token })))
}

fn rpc_failure(status: u16, code: RpcErrorCode, message: String) -> (u16, RpcFailure) {
    (status, RpcFailure { code, message, issues: None })
}

async fn call_rpc(plugins: &PluginHost, id: &str, method: &str, body: &[u8]) -> (u16, Value) {
    let attempt = parse_json(body).and_then(|input| Ok((input, plugins.running(id)?)));
    let failure = match attempt {
        Err(error) => {
            let code = if error.status == 400 {
                RpcErrorCode::InvalidJson
            } else {
                RpcErrorCode::PluginUnavailable
            };
            rpc_failure(error.status, code, error.body.message)
        }
        Ok((input, instance)) => match instance.rpc(method) {
            None => rpc_failure(
                404,
                RpcErrorCode::UnknownMethod,
                format!("Plugin \"{id}\" has no rpc method \"{method}\""),
            ),
            Some(handler) => match handler.call(input).await {
                Ok(result) => return (200, json!({ "ok": true, "result": result })),
                Err(failure) => {
                    let status = if failure.code == RpcErrorCode::InvalidInput { 400 } else { 500 };
                    (status, failure)
                }
            },
        },
    };
    let (status, error) = failure;
    (status, json!({ "ok": false, "error": error }))
}

async fn rpc(
    State(ctx): State<Ctx>,
    ApiPath((id, method)): ApiPath<(String, String)>,
    body: Bytes,
) -> Response {
    let (status, body) = call_rpc(&ctx.plugins, &id, &method, &body).await;
    if status == 500 {
        let mut fields = json!({ "pluginId": id, "method": method });
        if let (Some(target), Some(extra)) = (fields.as_object_mut(), body.as_object()) {
            target.extend(extra.clone());
        }
        ctx.log.warn("Plugin rpc failed", fields);
    }
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut response = (status, axum::Json(body)).into_response();
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn run_cli(
    plugins: &PluginHost,
    id: &str,
    request: CliRequest,
    cancel: CancellationToken,
) -> CliResult {
    let instance = match plugins.running(id) {
        Ok(instance) => instance,
        Err(error) => return cli_failure(&error.body.message),
    };
    let Some(cli) = instance.cli() else {
        return cli_failure(&format!("Plugin \"{id}\" has no CLI command"));
    };
    let context = CliContext {
        cwd: request.cwd,
        thread_id: request.thread_id,
        project_id: request.project_id,
        cancel,
    };
    cli.run(request.argv, context).await
}

fn cli_failure(message: &str) -> CliResult {
    CliResult { exit_code: 1, stdout: String::new(), stderr: format!("{message}\n") }
}

/// Answers with a newline every [`CLI_KEEPALIVE`] while the command runs, then
/// its `{exitCode, stdout, stderr}` as one JSON object.
async fn cli(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let request: CliRequest = json_body(&body)?;
    if [&request.cwd, &request.thread_id, &request.project_id]
        .iter()
        .any(|value| value.as_deref() == Some(""))
    {
        return Err(invalid_request("Too small: expected string to have >=1 characters"));
    }
    let (sender, receiver) = mpsc::channel::<Bytes>(4);
    let cancel = CancellationToken::new();
    tokio::spawn(async move {
        let run = run_cli(&ctx.plugins, &id, request, cancel.clone());
        tokio::pin!(run);
        let start = tokio::time::Instant::now() + CLI_KEEPALIVE;
        let mut ticks = tokio::time::interval_at(start, CLI_KEEPALIVE);
        loop {
            tokio::select! {
                result = &mut run => {
                    let text = serde_json::to_string(&result).unwrap_or_default();
                    let _ = sender.send(Bytes::from(text)).await;
                    return;
                }
                _ = ticks.tick() => {
                    if sender.send(Bytes::from_static(b"\n")).await.is_err() {
                        cancel.cancel();
                    }
                }
                _ = sender.closed(), if !cancel.is_cancelled() => cancel.cancel(),
            }
        }
    });
    let stream = futures::stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|chunk| (Ok::<_, Infallible>(chunk), receiver))
    });
    let mut response = Response::new(Body::from_stream(stream));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response.extensions_mut().insert(Uncompressed);
    Ok(response)
}

fn query_param(request: &Request, name: &str) -> Option<String> {
    let query = request.uri().query()?;
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

async fn plugin_http(
    State(ctx): State<Ctx>,
    Extension(principal): Extension<Principal>,
    ApiPath(params): ApiPath<IndexMap<String, String>>,
    request: Request,
) -> ApiResult<Response> {
    let id = params.get("id").cloned().unwrap_or_default();
    let path = format!("/{}", params.get("rest").map(String::as_str).unwrap_or(""));
    let method = request.method().as_str().to_owned();
    let Some(route) = ctx.plugins.running(&id)?.route(&format!("{method} {path}")) else {
        return Err(not_found_message(format!(
            "Plugin \"{id}\" has no {method} route for \"{path}\""
        )));
    };
    if route.auth == HttpAuth::Local {
        require_owner(&principal, "This plugin route is owner-only")?;
    }
    let token = request
        .headers()
        .get("x-bb-plugin-token")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .or_else(|| query_param(&request, "token"));
    if route.auth == HttpAuth::Token && !ctx.plugins.accepts_token(&id, token.as_deref()) {
        return Err(ApiError::new(401, "invalid_plugin_token", "Missing or invalid plugin token"));
    }
    let mut response = route.handler.handle(request).await;
    response.extensions_mut().insert(Uncompressed);
    Ok(response)
}

fn file_response(
    content: impl Into<Body>,
    content_type: &'static str,
    cache: &'static str,
) -> Response {
    let mut response = Response::new(content.into());
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    response
}

async fn app_file(
    ctx: &Ctx,
    id: &str,
    file: &str,
    fresh_hash: Option<String>,
) -> ApiResult<Response> {
    ctx.plugins.manifest(id)?;
    let bundle = ctx.plugins.app_bundle(id);
    let (content, content_type) = match (&bundle, file) {
        (Some(bundle), "app.js") => (Some(bundle.js.clone()), "text/javascript; charset=utf-8"),
        (Some(bundle), _) => (bundle.css.clone(), "text/css; charset=utf-8"),
        (None, _) => (None, ""),
    };
    let Some(content) = content else {
        return Err(not_found_message(format!("Plugin \"{id}\" has no {file}")));
    };
    let fresh = fresh_hash.is_some() && fresh_hash == bundle.map(|bundle| bundle.hash);
    Ok(file_response(content, content_type, if fresh { IMMUTABLE } else { "no-cache" }))
}

async fn app_js(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    ApiQuery(query): ApiQuery<AppFileQuery>,
) -> ApiResult<Response> {
    app_file(&ctx, &id, "app.js", query.h).await
}

async fn app_css(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    ApiQuery(query): ApiQuery<AppFileQuery>,
) -> ApiResult<Response> {
    app_file(&ctx, &id, "app.css", query.h).await
}

fn image_type(path: &str) -> Option<&'static str> {
    let extension = path.rsplit_once('.')?.1.to_ascii_lowercase();
    match extension.as_str() {
        "svg" => Some("image/svg+xml"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

async fn asset(
    State(ctx): State<Ctx>,
    ApiPath((id, path)): ApiPath<(String, String)>,
) -> ApiResult<Response> {
    let directory = ctx.plugins.manifest(&id)?.directory;
    let content_type = image_type(&path).ok_or_else(not_found)?;
    let file = resolve_inside(&directory, &path).ok_or_else(not_found)?;
    let content = tokio::fs::read(file).await.map_err(|_| not_found())?;
    Ok(file_response(content, content_type, "no-cache"))
}
