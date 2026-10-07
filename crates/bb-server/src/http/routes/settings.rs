use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, header};
use axum::routing::{get, put};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::context::Ctx;
use crate::db::projects::require_project;
use crate::db::settings::{self as store, APPEARANCE_SETTING, KEYBINDING_OVERRIDES_SETTING};
use crate::db::{Db, RevisionOutcome, RowValues, write_revision};
use crate::domain::changes::SystemChangeKind;
use crate::domain::settings::{
    AppKeybindingOverrides, AppSettings, AppTheme, UI_PREFERENCE_KEYS, UiPreferenceEntries,
    get_ui_preference_default, parse_app_theme, parse_partial_app_settings,
    parse_ui_preference_value, ui_preference_entries,
};
use crate::error::{ApiError, ApiResult, invalid_request};
use crate::http::api::{ApiJson, ApiPath, ApiResponse};
use crate::http::validate::{Kind, NON_EMPTY, check_object, invalid_type, req, unknown_key};
use crate::machine_environment::{
    MachineEnvironmentList, MachineEnvironmentReplace, ProjectMachineEnvironmentList,
    machine_environment_view, project_machine_environment_view, replace_machine_environment,
};
use crate::runners::hosts::public_server_url;
use crate::settings::keybindings::{
    AppDefaultKeybinding, AppKeybinding, DEFAULT_APP_KEYBINDINGS, apply_app_keybinding_overrides,
    parse_app_keybinding_overrides,
};

/// `BUILTIN_THEME_IDS`.
pub const BUILT_IN_THEME_IDS: [&str; 6] =
    ["default", "nord", "dracula", "solarized", "gruvbox", "catppuccin"];
const LEGACY_DIAGNOSTICS_KEY: &str = "showUnhandledProviderEvents";
const OPTIONAL_UPDATE_KEYS: [&str; 3] =
    ["allowFastServiceTier", "telemetryEnabled", "confirmThreadArchive"];
const DIAGNOSTICS_KEY: &str = "showDiagnosticEvents";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerAccessStatus {
    pub providers: Vec<Value>,
    pub default_provider_id: String,
    pub effective_url: Option<String>,
    pub url_source: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemConfigResponse {
    pub feature_flags: Value,
    pub server_access: ServerAccessStatus,
    pub general_settings: AppSettings,
    pub keybindings: Vec<AppKeybinding>,
    pub default_keybindings: Vec<AppDefaultKeybinding>,
    pub keybinding_overrides: AppKeybindingOverrides,
    pub appearance: AppTheme,
    pub server_url: String,
    pub primary_host_id: String,
    pub primary_host_platform: String,
    pub data_dir: String,
}

#[derive(Debug, Serialize)]
pub struct UiPreferencesResponse {
    pub preferences: UiPreferenceEntries,
}

#[derive(Debug, Serialize)]
pub struct UiPreferenceResponse {
    pub key: String,
    pub revision: i64,
    pub value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateUiPreferenceRequest {
    pub expected_revision: u32,
    #[serde(default)]
    pub value: Value,
}

#[derive(Debug, Deserialize)]
pub struct KeyPath {
    pub key: String,
}

#[derive(Debug, Deserialize)]
pub struct IdPath {
    pub id: String,
}

pub fn is_built_in_theme_id(id: &str) -> bool {
    BUILT_IN_THEME_IDS.contains(&id)
}

fn built_in_theme(selection: &AppTheme) -> AppTheme {
    let theme_id = if is_built_in_theme_id(&selection.theme_id) {
        selection.theme_id.clone()
    } else {
        AppTheme::default().theme_id
    };
    AppTheme { theme_id, favicon_color: selection.favicon_color }
}

fn server_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

fn require_ui_preference_key(key: &str) -> ApiResult<&str> {
    if get_ui_preference_default(key).is_some() {
        return Ok(key);
    }
    let message = format!(
        "Unknown UI preference '{key}'. Known preferences: {}.",
        UI_PREFERENCE_KEYS.join(", ")
    );
    Err(ApiError::new(404, "ui_preference_not_found", message))
}

fn read_ui_preferences(db: &Db) -> ApiResult<UiPreferenceEntries> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PreferenceRow {
        key: String,
        value_json: String,
        revision: i64,
    }
    let rows: Vec<PreferenceRow> =
        db.all("SELECT key, value_json, revision FROM ui_preferences", [])?;
    let stored = rows
        .into_iter()
        .map(|row| Ok((row.key, row.revision, serde_json::from_str(&row.value_json)?)))
        .collect::<ApiResult<Vec<(String, i64, Value)>>>()?;
    Ok(ui_preference_entries(&stored))
}

fn write_ui_preference(
    db: &Db,
    key: &str,
    value: &str,
    expected_revision: Option<i64>,
) -> ApiResult<i64> {
    let row = RowValues::new().set("key", key).set("valueJson", serde_json::to_string(value)?);
    let write = write_revision(db, "ui_preferences", "key", &row, expected_revision)?;
    if write.outcome == RevisionOutcome::Updated {
        return Ok(write.revision);
    }
    let error =
        ApiError::new(409, "ui_preference_conflict", "UI preference changed on another client");
    Err(error.details(json!({ "currentRevision": write.revision })))
}

fn parse_settings_update(payload: &Value) -> Option<Map<String, Value>> {
    let object = payload.as_object()?;
    let legacy = object.get(LEGACY_DIAGNOSTICS_KEY);
    if legacy.is_some_and(|value| !value.is_boolean()) {
        return None;
    }
    if !object.contains_key(DIAGNOSTICS_KEY) && legacy.is_none() {
        return None;
    }
    let required = serde_json::to_value(AppSettings::default()).ok()?;
    let missing = required.as_object()?.keys().any(|key| {
        key != DIAGNOSTICS_KEY
            && !OPTIONAL_UPDATE_KEYS.contains(&key.as_str())
            && !object.contains_key(key)
    });
    if missing {
        return None;
    }
    parse_partial_app_settings(payload)
}

fn request_origin(headers: &HeaderMap) -> String {
    let host = headers.get(header::HOST).and_then(|value| value.to_str().ok());
    format!("http://{}", host.unwrap_or("localhost"))
}

async fn system_config(
    State(ctx): State<Ctx>,
    headers: HeaderMap,
) -> ApiResponse<SystemConfigResponse> {
    let db = &ctx.db;
    let general_settings = store::get_app_settings(db)?;
    let keybinding_overrides = store::read_setting(db, &KEYBINDING_OVERRIDES_SETTING)?;
    let public_url = public_server_url(&ctx)?;
    let direct = json!({
        "id": "direct",
        "displayName": "Manual",
        "description": "Use your own domain or network address.",
        "pluginId": null,
        "availability": null,
    });
    Ok(Json(SystemConfigResponse {
        feature_flags: json!({ "placeholder": false, "timelineWindowEventBudget": 1_500 }),
        server_access: ServerAccessStatus {
            providers: vec![direct],
            default_provider_id: "direct".to_owned(),
            effective_url: public_url.clone(),
            url_source: public_url.as_ref().map(|_| "setting".to_owned()),
        },
        general_settings,
        keybindings: apply_app_keybinding_overrides(
            &DEFAULT_APP_KEYBINDINGS,
            &keybinding_overrides,
        ),
        default_keybindings: DEFAULT_APP_KEYBINDINGS.clone(),
        keybinding_overrides,
        appearance: built_in_theme(&store::read_setting(db, &APPEARANCE_SETTING)?),
        server_url: public_url.unwrap_or_else(|| request_origin(&headers)),
        primary_host_id: ctx.config.host_id.clone(),
        primary_host_platform: server_platform().to_owned(),
        data_dir: ctx.config.data_dir.to_string_lossy().into_owned(),
    }))
}

async fn update_general_settings(
    State(ctx): State<Ctx>,
    ApiJson(payload): ApiJson<Value>,
) -> ApiResponse<AppSettings> {
    // `appSettingsUpdateSchema` is a union; zod reports a failed union as `Invalid input`.
    let settings = parse_settings_update(&payload).ok_or_else(|| invalid_request("Invalid input"))?;
    let stored = store::get_app_settings(&ctx.db)?;
    let Value::Object(mut merged) = serde_json::to_value(stored)? else {
        return Err(ApiError::internal("App settings are not an object"));
    };
    merged.extend(settings);
    let updated: AppSettings = serde_json::from_value(Value::Object(merged))?;
    store::set_app_settings(&ctx.db, &updated)?;
    ctx.hub.system(vec![SystemChangeKind::ConfigChanged]);
    Ok(Json(updated))
}

async fn update_keyboard_settings(
    State(ctx): State<Ctx>,
    ApiJson(payload): ApiJson<Value>,
) -> ApiResponse<AppKeybindingOverrides> {
    if !payload.is_array() {
        return Err(invalid_request(invalid_type("array", &payload)));
    }
    let overrides = parse_app_keybinding_overrides(&payload).map_err(invalid_request)?;
    store::write_setting(&ctx.db, &KEYBINDING_OVERRIDES_SETTING, &overrides)?;
    ctx.hub.system(vec![SystemChangeKind::ConfigChanged]);
    Ok(Json(overrides))
}

const APP_THEME_FIELDS: &[crate::http::validate::Field] = &[
    req("themeId", NON_EMPTY),
    req(
        "faviconColor",
        Kind::Enum(&[
            "default", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink",
        ]),
    ),
];

async fn update_appearance(
    State(ctx): State<Ctx>,
    ApiJson(payload): ApiJson<Value>,
) -> ApiResponse<AppTheme> {
    check_object(&payload, APP_THEME_FIELDS, false).map_err(invalid_request)?;
    let selection = parse_app_theme(&payload).ok_or_else(|| invalid_request("Invalid input"))?;
    if !is_built_in_theme_id(&selection.theme_id) {
        let message = format!("Unknown theme '{}'.", selection.theme_id);
        return Err(ApiError::new(404, "theme_not_found", message));
    }
    store::write_setting(&ctx.db, &APPEARANCE_SETTING, &selection)?;
    ctx.hub.system(vec![SystemChangeKind::ConfigChanged]);
    Ok(Json(built_in_theme(&selection)))
}

async fn ui_preferences(State(ctx): State<Ctx>) -> ApiResponse<UiPreferencesResponse> {
    Ok(Json(UiPreferencesResponse { preferences: read_ui_preferences(&ctx.db)? }))
}

async fn update_ui_preference(
    State(ctx): State<Ctx>,
    ApiPath(path): ApiPath<KeyPath>,
    ApiJson(body): ApiJson<Value>,
) -> ApiResponse<UiPreferenceResponse> {
    let revision = Kind::Int { min: Some(0), max: None, positive: false };
    check_object(&body, &[req("expectedRevision", revision)], false).map_err(invalid_request)?;
    if body.get("value").is_none() {
        return Err(invalid_request("Required"));
    }
    if let Some(message) = body.as_object().and_then(|o| unknown_key(o, &["expectedRevision", "value"])) {
        return Err(invalid_request(message));
    }
    let payload: UpdateUiPreferenceRequest =
        serde_json::from_value(body).map_err(|error| invalid_request(crate::http::validate::from_serde_error(&error)))?;
    let key = require_ui_preference_key(&path.key)?;
    let value = parse_ui_preference_value(key, &payload.value).map_err(|message| {
        invalid_request(format!("Invalid value for UI preference '{key}': {message}"))
    })?;
    let expected = Some(i64::from(payload.expected_revision));
    let revision = write_ui_preference(&ctx.db, key, &value, expected)?;
    ctx.hub.system(vec![SystemChangeKind::UiPreferencesChanged]);
    Ok(Json(UiPreferenceResponse { key: key.to_owned(), revision, value }))
}

async fn reset_ui_preference(
    State(ctx): State<Ctx>,
    ApiPath(path): ApiPath<KeyPath>,
) -> ApiResponse<UiPreferenceResponse> {
    let key = require_ui_preference_key(&path.key)?;
    let value = get_ui_preference_default(key).unwrap_or_default().to_owned();
    let revision = write_ui_preference(&ctx.db, key, &value, None)?;
    ctx.hub.system(vec![SystemChangeKind::UiPreferencesChanged]);
    Ok(Json(UiPreferenceResponse { key: key.to_owned(), revision, value }))
}

async fn machine_environment(State(ctx): State<Ctx>) -> ApiResponse<MachineEnvironmentList> {
    Ok(Json(machine_environment_view(&ctx.db)?))
}

async fn replace_machine_environment_route(
    State(ctx): State<Ctx>,
    ApiJson(payload): ApiJson<MachineEnvironmentReplace>,
) -> ApiResponse<MachineEnvironmentList> {
    replace_machine_environment(&ctx, None, &payload).await?;
    ctx.hub.system(vec![SystemChangeKind::ConfigChanged]);
    Ok(Json(machine_environment_view(&ctx.db)?))
}

async fn project_machine_environment(
    State(ctx): State<Ctx>,
    ApiPath(path): ApiPath<IdPath>,
) -> ApiResponse<ProjectMachineEnvironmentList> {
    let project = require_project(&ctx.db, &path.id)?;
    Ok(Json(project_machine_environment_view(&ctx.db, &project.id)?))
}

async fn replace_project_machine_environment(
    State(ctx): State<Ctx>,
    ApiPath(path): ApiPath<IdPath>,
    ApiJson(payload): ApiJson<MachineEnvironmentReplace>,
) -> ApiResponse<ProjectMachineEnvironmentList> {
    let project = require_project(&ctx.db, &path.id)?;
    replace_machine_environment(&ctx, Some(&project.id), &payload).await?;
    ctx.hub.system(vec![SystemChangeKind::ConfigChanged]);
    Ok(Json(project_machine_environment_view(&ctx.db, &project.id)?))
}

/// The settings, preferences and machine environment routes, relative to `/api/v1`. The trust
/// guard already keeps machine credentials off `/settings`, `/system` and `machine-environment`.
pub fn register_settings_routes() -> Router<Ctx> {
    Router::new()
        .route("/system/config", get(system_config))
        .route("/settings/general", put(update_general_settings))
        .route("/settings/keyboard", put(update_keyboard_settings))
        .route("/settings/appearance", put(update_appearance))
        .route("/preferences/ui", get(ui_preferences))
        .route("/preferences/ui/{key}", put(update_ui_preference).delete(reset_ui_preference))
        .route(
            "/settings/machine-environment",
            get(machine_environment).put(replace_machine_environment_route),
        )
        .route(
            "/projects/{id}/machine-environment",
            get(project_machine_environment).put(replace_project_machine_environment),
        )
}
