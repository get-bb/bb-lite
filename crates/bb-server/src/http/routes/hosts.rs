use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Extension, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::routing::{get, post};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::context::Ctx;
use crate::db::RowValues;
use crate::db::hosts::{self as store, HostFilter, HostLookup, NewHost};
use crate::db::new_id;
use crate::domain::changes::HostChangeKind;
use crate::domain::host::{Host, HostType, MachinePhase, UpdateHostPermissionCeilingRequest};
use crate::error::{ApiError, ApiResult, error_message, invalid_request};
use crate::http::api::{ApiJson, ApiPath, ApiQuery, ApiResponse};
use crate::http::trust::{Principal, require_owner};
use crate::runners::enrollment::{self, JoinBlob, JoinRequest, JoinToken};
use crate::runners::hosts::{host_response, public_server_url, require_host};

const MANUAL_MACHINE_PROVIDER_ID: &str = "manual";
const MAX_NAME_CHARS: usize = 100;

type PendingJoins = Arc<Mutex<HashMap<String, JoinToken>>>;
type Created<T> = ApiResult<(StatusCode, axum::Json<T>)>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateMachineRequest {
    pub machine_provider_id: String,
    pub inputs: Option<Value>,
    #[serde(default)]
    pub key: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostListQuery {
    #[serde(default)]
    pub include_creating: Option<String>,
    #[serde(default, rename = "type")]
    pub host_type: Option<HostType>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateHostRequest {
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostOpenRequest {
    pub target_id: String,
    pub path: String,
    #[serde(default)]
    pub line: Option<u32>,
    #[serde(default)]
    pub column: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDetail {
    #[serde(flatten)]
    pub host: Host,
    pub connect_machine_id: Option<String>,
    pub thread_storage_root_path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCommand {
    pub command: String,
    pub expires_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostReconnectResponse {
    pub command: String,
    pub expires_at: i64,
    pub host_id: String,
}

#[derive(Debug, Serialize)]
pub struct OkResponse {
    pub ok: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JoinBody {
    #[serde(default)]
    host_name: Option<String>,
}

fn trimmed_name(name: &str) -> ApiResult<String> {
    let name = name.trim();
    let chars = name.chars().count();
    if chars == 0 || chars > MAX_NAME_CHARS {
        return Err(invalid_request("Invalid request body"));
    }
    Ok(name.to_owned())
}

fn request_origin(headers: &HeaderMap) -> String {
    let host = headers.get(header::HOST).and_then(|value| value.to_str().ok());
    format!("http://{}", host.unwrap_or("localhost"))
}

async fn command_for(
    ctx: &Ctx,
    headers: &HeaderMap,
    host_id: &str,
    token: &JoinToken,
) -> ApiResult<HostCommand> {
    let access = match ctx.plugins.machine_access() {
        Some(provider) => provider.grant(host_id).await.map_err(|error| {
            ApiError::new(502, "machine_access_unavailable", error_message(&error.message))
        })?,
        None => None,
    };
    let server_url = match &access {
        Some(access) => access.server_url.clone(),
        None => public_server_url(ctx)?.unwrap_or_else(|| request_origin(headers)),
    };
    let command = enrollment::join_command(&JoinBlob {
        server_url,
        host_id: host_id.to_owned(),
        join_token: token.join_token.clone(),
        headers: access.map(|access| access.headers),
    })?;
    Ok(HostCommand { command, expires_at: token.expires_at })
}

fn patch_host(ctx: &Ctx, host_id: &str, patch: &RowValues) -> ApiResult<Host> {
    let id = require_host(ctx, host_id)?.id;
    store::update_host(&ctx.db, &id, patch)?;
    ctx.hub.host(&id, vec![HostChangeKind::HostConnected]);
    Ok(host_response(ctx, &require_host(ctx, &id)?))
}

fn owner_runner(ctx: &Ctx, principal: &Principal, id: &str) -> ApiResult<bb_core::SharedRunner> {
    require_owner(principal, "Only the owner can open paths in local apps")?;
    ctx.runners.get(&require_host(ctx, id)?.id)
}

async fn create_host(
    State(ctx): State<Ctx>,
    Extension(pending): Extension<PendingJoins>,
    ApiJson(payload): ApiJson<CreateMachineRequest>,
) -> Created<Host> {
    if payload.machine_provider_id != MANUAL_MACHINE_PROVIDER_ID {
        return Err(ApiError::new(
            404,
            "machine_provider_not_found",
            format!(
                "Unknown machine provider '{}'. Only '{MANUAL_MACHINE_PROVIDER_ID}' machines can \
                 be added.",
                payload.machine_provider_id
            ),
        ));
    }
    let launch_key = payload.key.unwrap_or_else(random_uuid);
    if let Some(existing) = store::find_host(&ctx.db, HostLookup::LaunchKey, &launch_key)? {
        return Ok((StatusCode::CREATED, axum::Json(host_response(&ctx, &existing))));
    }
    let id = new_id("host");
    let suffix: String = id.chars().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect();
    store::insert_host(
        &ctx.db,
        &NewHost {
            id: id.clone(),
            name: format!("New machine {suffix}"),
            phase: MachinePhase::Creating,
            status_message: Some("Waiting for the enrollment command to run".to_owned()),
            launch_key: Some(launch_key),
        },
    )?;
    let token = enrollment::issue_join_token(&ctx.db, &id)?;
    pending.lock().insert(id.clone(), token);
    ctx.hub.host(&id, vec![HostChangeKind::HostConnected]);
    Ok((StatusCode::CREATED, axum::Json(host_response(&ctx, &require_host(&ctx, &id)?))))
}

async fn list_hosts(
    State(ctx): State<Ctx>,
    ApiQuery(query): ApiQuery<HostListQuery>,
) -> ApiResponse<Vec<Host>> {
    if let Some(flag) = query.include_creating.as_deref()
        && flag != "true"
        && flag != "false"
    {
        return Err(invalid_request("Invalid request query"));
    }
    let filter = HostFilter {
        include_creating: query.include_creating.as_deref() == Some("true"),
        host_type: query.host_type,
    };
    let rows = store::list_hosts(&ctx.db, filter)?;
    Ok(axum::Json(rows.iter().map(|row| host_response(&ctx, row)).collect()))
}

async fn show_host(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
) -> ApiResponse<HostDetail> {
    let host = require_host(&ctx, &id)?;
    Ok(axum::Json(HostDetail {
        host: host_response(&ctx, &host),
        connect_machine_id: host.connect_machine_id.clone(),
        thread_storage_root_path: host.thread_storage_root.clone(),
    }))
}

async fn enrollment_command(
    State(ctx): State<Ctx>,
    Extension(pending): Extension<PendingJoins>,
    principal: Principal,
    headers: HeaderMap,
    ApiPath(id): ApiPath<String>,
) -> ApiResponse<Option<HostCommand>> {
    require_owner(&principal, "Machine credentials cannot read enrollment commands")?;
    let host = require_host(&ctx, &id)?;
    let pending = pending.lock().get(&host.id).cloned();
    let usable = pending.filter(|pending| {
        host.phase == MachinePhase::Creating
            && host.join_token_hash.as_deref()
                == Some(enrollment::hash_token(&pending.join_token).as_str())
            && pending.expires_at > ctx.now()
    });
    match usable {
        Some(pending) => {
            Ok(axum::Json(Some(command_for(&ctx, &headers, &host.id, &pending).await?)))
        }
        None => Ok(axum::Json(None)),
    }
}

async fn reconnect_host(
    State(ctx): State<Ctx>,
    headers: HeaderMap,
    ApiPath(id): ApiPath<String>,
) -> Created<HostReconnectResponse> {
    let host = require_host(&ctx, &id)?;
    if host.id == ctx.config.host_id || host.phase != MachinePhase::Active {
        return Err(ApiError::new(
            409,
            "machine_reconnect_unavailable",
            "Only active machines other than the server's own can be reconnected",
        ));
    }
    if ctx.runners.is_connected(&host.id) {
        return Err(ApiError::new(
            409,
            "machine_reconnect_not_needed",
            "Machine is connected and doesn't need reconnecting",
        ));
    }
    let token = enrollment::issue_join_token(&ctx.db, &host.id)?;
    let HostCommand { command, expires_at } = command_for(&ctx, &headers, &host.id, &token).await?;
    let response = HostReconnectResponse { command, expires_at, host_id: host.id };
    Ok((StatusCode::CREATED, axum::Json(response)))
}

async fn rename_host(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    ApiJson(body): ApiJson<UpdateHostRequest>,
) -> ApiResponse<Host> {
    let name = trimmed_name(&body.name)?;
    Ok(axum::Json(patch_host(&ctx, &id, &crate::row! { "name" => name.as_str() })?))
}

async fn update_permission_ceiling(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    ApiJson(body): ApiJson<UpdateHostPermissionCeilingRequest>,
) -> ApiResponse<Host> {
    let patch = crate::row! { "maxPermissionMode" => body.max_permission_mode.as_str() };
    Ok(axum::Json(patch_host(&ctx, &id, &patch)?))
}

async fn remove_host(
    State(ctx): State<Ctx>,
    Extension(pending): Extension<PendingJoins>,
    ApiPath(id): ApiPath<String>,
) -> ApiResponse<OkResponse> {
    let host = require_host(&ctx, &id)?;
    let (id, connect_machine_id) = (host.id, host.connect_machine_id);
    if id == ctx.config.host_id {
        return Err(ApiError::new(
            400,
            "primary_host_removal_refused",
            "The server's own machine cannot be removed",
        ));
    }
    let was_connected = ctx.runners.is_connected(&id);
    store::destroy_host(&ctx.db, &id)?;
    pending.lock().remove(&id);
    ctx.runners.disconnect(&id, None);
    if !was_connected {
        ctx.hub.host(&id, vec![HostChangeKind::HostDisconnected]);
    }
    if let Some(provider) = ctx.plugins.machine_access()
        && let Err(error) = provider.revoke(&id, connect_machine_id.as_deref()).await
    {
        let fields = json!({ "hostId": id, "err": error.message });
        ctx.log.warn("Machine access was not revoked", fields);
    }
    Ok(axum::Json(OkResponse { ok: true }))
}

async fn open_targets(
    State(ctx): State<Ctx>,
    principal: Principal,
    ApiPath(id): ApiPath<String>,
) -> ApiResponse<Value> {
    let runner = owner_runner(&ctx, &principal, &id)?;
    Ok(axum::Json(runner.call("listOpenTargets", json!({})).await?))
}

async fn open_in_target(
    State(ctx): State<Ctx>,
    principal: Principal,
    ApiPath(id): ApiPath<String>,
    ApiJson(body): ApiJson<HostOpenRequest>,
) -> ApiResponse<OkResponse> {
    if body.target_id.is_empty()
        || body.path.is_empty()
        || body.line == Some(0)
        || body.column == Some(0)
    {
        return Err(invalid_request("Invalid request body"));
    }
    let runner = owner_runner(&ctx, &principal, &id)?;
    let params = json!({
        "targetId": body.target_id,
        "path": body.path,
        "line": body.line,
        "column": body.column,
    });
    runner.call("openInTarget", params).await?;
    Ok(axum::Json(OkResponse { ok: true }))
}

/// Machine management under the API prefix (`/hosts...`).
pub fn register_host_routes() -> Router<Ctx> {
    let pending: PendingJoins = Arc::default();
    Router::new()
        .route("/hosts", post(create_host).get(list_hosts))
        .route("/hosts/{id}", get(show_host).patch(rename_host).delete(remove_host))
        .route("/hosts/{id}/enrollment-command", get(enrollment_command))
        .route("/hosts/{id}/reconnect-commands", post(reconnect_host))
        .route("/hosts/{id}/permission-ceiling", axum::routing::patch(update_permission_ceiling))
        .route("/hosts/{id}/open-targets", get(open_targets))
        .route("/hosts/{id}/open", post(open_in_target))
        .layer(Extension(pending))
}

async fn join_runner(
    State(ctx): State<Ctx>,
    principal: Principal,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResponse<enrollment::RunnerCredential> {
    let raw: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
    let body: JoinBody =
        serde_json::from_value(raw).map_err(|_| invalid_request("Invalid runner join body"))?;
    let host_name = match body.host_name {
        Some(name) => {
            Some(trimmed_name(&name).map_err(|_| invalid_request("Invalid runner join body"))?)
        }
        None => None,
    };
    let authorization = headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok());
    let credential = enrollment::redeem_join_token(
        &ctx.db,
        JoinRequest { authorization, principal: &principal, host_name: host_name.as_deref() },
    )?;
    Ok(axum::Json(credential))
}

/// Runner endpoints under the internal prefix (`/runner/join`).
pub fn register_runner_routes() -> Router<Ctx> {
    Router::new().route("/runner/join", post(join_runner))
}

fn random_uuid() -> String {
    use rand::RngExt;
    let mut bytes: [u8; 16] = rand::rng().random();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex::encode(bytes);
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}
