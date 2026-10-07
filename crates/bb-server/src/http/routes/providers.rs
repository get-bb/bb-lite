use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::context::Ctx;
use crate::domain::changes::SystemChangeKind;
use crate::error::{ApiError, ApiResult, invalid_request};
use crate::http::api::{ApiJson, ApiPath, ApiQuery, ApiResponse};
use crate::providers::catalog::{
    ProviderInfo, SystemProviderCatalogEntry, find_provider_definition, list_enabled_providers,
    list_provider_catalog, set_provider_enabled,
};
use crate::providers::environment_providers::{
    SystemEnvironmentProvider, SystemEnvironmentProvidersQuery, list_environment_providers,
};
use crate::providers::models::{
    ExecutionOptionsQuery, ExecutionOptionsResponse,
};
use crate::providers::settings::{
    PROVIDERS_WITH_SETTINGS, ProviderSettingsView, provider_settings_view, update_provider_settings,
};

const IMMUTABLE: &str = "public, max-age=31536000, immutable";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderCapabilityFilter {
    Usage,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemProvidersQuery {
    #[serde(default)]
    pub host_id: Option<String>,
    #[serde(default)]
    pub environment_id: Option<String>,
    #[serde(default)]
    pub capability: Option<ProviderCapabilityFilter>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SystemProviderEnabledRequest {
    pub enabled: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ProviderLogoQuery {
    #[serde(default)]
    pub h: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SystemEnvironmentProvidersResponse {
    pub providers: Vec<SystemEnvironmentProvider>,
}

fn require_non_empty(field: &str, value: Option<&String>) -> ApiResult<()> {
    match value {
        Some(value) if value.is_empty() => {
            Err(invalid_request(format!("{field}: String must contain at least 1 character(s)")))
        }
        _ => Ok(()),
    }
}

fn reject_multiple_workspace_selectors(
    host_id: Option<&String>,
    environment_id: Option<&String>,
) -> ApiResult<()> {
    require_non_empty("hostId", host_id)?;
    require_non_empty("environmentId", environment_id)?;
    if host_id.is_some() && environment_id.is_some() {
        return Err(invalid_request("hostId and environmentId are mutually exclusive"));
    }
    Ok(())
}

async fn list_providers(
    State(ctx): State<Ctx>,
    ApiQuery(query): ApiQuery<SystemProvidersQuery>,
) -> ApiResponse<Vec<ProviderInfo>> {
    reject_multiple_workspace_selectors(query.host_id.as_ref(), query.environment_id.as_ref())?;
    let usage_only = query.capability == Some(ProviderCapabilityFilter::Usage);
    let providers = list_enabled_providers(&ctx.db)?
        .into_iter()
        .map(|provider| provider.info)
        .filter(|info| !usage_only || info.maintenance.usage)
        .collect();
    Ok(Json(providers))
}

async fn provider_catalog(State(ctx): State<Ctx>) -> ApiResponse<Vec<SystemProviderCatalogEntry>> {
    Ok(Json(list_provider_catalog(&ctx.db)?))
}

async fn provider_enabled(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    ApiJson(payload): ApiJson<SystemProviderEnabledRequest>,
) -> ApiResponse<Vec<SystemProviderCatalogEntry>> {
    if find_provider_definition(&ctx.db, &id).is_none() {
        return Err(ApiError::new(
            404,
            "provider_not_found",
            format!("Unknown provider \"{id}\"."),
        ));
    }
    set_provider_enabled(&ctx.db, &id, payload.enabled)?;
    ctx.hub.system(vec![SystemChangeKind::ConfigChanged]);
    Ok(Json(list_provider_catalog(&ctx.db)?))
}

async fn provider_logo(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    ApiQuery(query): ApiQuery<ProviderLogoQuery>,
) -> ApiResult<Response> {
    let Some(logo) = find_provider_definition(&ctx.db, &id).and_then(|provider| provider.logo)
    else {
        let message = format!("Provider '{id}' has no logo.");
        return Err(ApiError::new(404, "provider_logo_not_found", message));
    };
    let pinned = query.h.as_deref() == Some(logo.hash.as_str());
    let headers = [
        (header::CACHE_CONTROL, if pinned { IMMUTABLE } else { "no-cache" }),
        (header::CONTENT_TYPE, "image/svg+xml"),
    ];
    Ok((headers, logo.content).into_response())
}

async fn execution_options(
    State(ctx): State<Ctx>,
    ApiQuery(query): ApiQuery<ExecutionOptionsQuery>,
) -> ApiResponse<ExecutionOptionsResponse> {
    reject_multiple_workspace_selectors(query.host_id.as_ref(), query.environment_id.as_ref())?;
    require_non_empty("providerId", query.provider_id.as_ref())?;
    let _ = (&ctx, &query);
    todo!("server assembly: call providers::models::resolve_execution_options with the model catalog")
}

async fn environment_providers(
    State(ctx): State<Ctx>,
    ApiQuery(query): ApiQuery<SystemEnvironmentProvidersQuery>,
) -> ApiResponse<SystemEnvironmentProvidersResponse> {
    require_non_empty("projectId", query.project_id.as_ref())?;
    require_non_empty("hostId", query.host_id.as_ref())?;
    if query.host_id.is_some() && query.project_id.is_none() {
        return Err(invalid_request("hostId: hostId requires projectId"));
    }
    let providers = list_environment_providers(&ctx, query).await?;
    Ok(Json(SystemEnvironmentProvidersResponse { providers }))
}

fn settings_update_values(body: &[u8]) -> Option<Map<String, Value>> {
    let Value::Object(mut raw) = serde_json::from_slice(body).ok()? else {
        return None;
    };
    let Some(Value::Object(values)) = raw.remove("values") else {
        return None;
    };
    raw.is_empty().then_some(values)
}

async fn show_provider_settings(ctx: Ctx, id: &str) -> ApiResponse<ProviderSettingsView> {
    Ok(Json(provider_settings_view(&ctx.db, id)?))
}

async fn save_provider_settings(
    ctx: Ctx,
    id: &str,
    body: Bytes,
) -> ApiResponse<ProviderSettingsView> {
    let Some(values) = settings_update_values(&body) else {
        return Err(invalid_request("Expected { values: Record<string, unknown> }"));
    };
    update_provider_settings(&ctx.db, id, &values)?;
    ctx.hub.system(vec![SystemChangeKind::ConfigChanged]);
    Ok(Json(provider_settings_view(&ctx.db, id)?))
}

/// The `system` provider routes and `/plugins/provider-<id>/settings` for every provider
/// with settings, relative to `/api/v1`.
pub fn provider_routes() -> Router<Ctx> {
    let mut router = Router::new()
        .route("/system/providers", get(list_providers))
        .route("/system/providers/catalog", get(provider_catalog))
        .route("/system/providers/{id}/enabled", put(provider_enabled))
        .route("/system/providers/{id}/logo", get(provider_logo))
        .route("/system/execution-options", get(execution_options))
        .route("/system/environment-providers", get(environment_providers));
    for id in PROVIDERS_WITH_SETTINGS {
        let show = get(move |State(ctx): State<Ctx>| show_provider_settings(ctx, id));
        let save = show
            .put(move |State(ctx): State<Ctx>, body: Bytes| save_provider_settings(ctx, id, body));
        router = router.route(&format!("/plugins/provider-{id}/settings"), save);
    }
    router
}
