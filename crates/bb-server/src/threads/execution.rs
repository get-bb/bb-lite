use bb_core::api::call_typed;
use bb_core::{
    ExecutionOptions, PermissionEscalation, PermissionMode, ProviderId, ReasoningLevel, ServiceTier,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::context::Ctx;
use crate::db::Db;
use crate::db::environments::get_environment;
use crate::db::hosts::{HostLookup, find_host};
use crate::db::projects::get_project_execution_defaults;
use crate::db::settings::get_app_settings;
use crate::db::threads::{ThreadRow, get_thread};
use crate::domain::host::clamp_permission_mode_to_ceiling;
use crate::error::{ApiError, ApiResult, invalid_request};
use crate::providers::settings::provider_options_for;

/// `ResolvedThreadExecutionOptions` without `source`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionTuple {
    pub model: String,
    pub reasoning_level: ReasoningLevel,
    pub permission_mode: PermissionMode,
    pub service_tier: ServiceTier,
}

/// `ResolvedThreadExecutionOptions`: the tuple plus where it came from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedExecution {
    #[serde(flatten)]
    pub execution: ExecutionTuple,
    pub source: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CallerExecutionInputSource {
    Explicit,
    ClientPreference,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionInputSources {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<CallerExecutionInputSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_level: Option<CallerExecutionInputSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<CallerExecutionInputSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<CallerExecutionInputSource>,
}

/// The execution fields a create or turn request may carry. When
/// `execution_input_sources` is present, only the fields it names are used.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_level: Option<ReasoningLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<ServiceTier>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_input_sources: Option<ExecutionInputSources>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreadTurnInitiator {
    User,
    Agent,
    System,
}

pub struct CreateExecutionArgs<'a> {
    pub request: &'a ExecutionRequest,
    pub project_id: &'a str,
    pub host_id: &'a str,
    pub parent: Option<&'a ThreadRow>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreatedExecution {
    pub provider_id: ProviderId,
    pub execution: ExecutionTuple,
}

#[derive(Clone, Debug, Default)]
struct Layer {
    model: Option<String>,
    reasoning_level: Option<ReasoningLevel>,
    permission_mode: Option<PermissionMode>,
    service_tier: Option<ServiceTier>,
}

const PROVIDER_IDS: [ProviderId; 3] = [ProviderId::Codex, ProviderId::ClaudeCode, ProviderId::Echo];

pub fn require_provider_id(value: &str) -> ApiResult<ProviderId> {
    if let Some(known) = PROVIDER_IDS.into_iter().find(|id| id.as_str() == value) {
        return Ok(known);
    }
    let names = PROVIDER_IDS.map(ProviderId::as_str).join(", ");
    Err(invalid_request(format!("Unknown provider \"{value}\". Use {names}.")))
}

fn named_fields(request: &ExecutionRequest) -> Layer {
    let sources = request.execution_input_sources.as_ref();
    let named = |pick: fn(&ExecutionInputSources) -> Option<CallerExecutionInputSource>| {
        sources.is_none_or(|sources| pick(sources).is_some())
    };
    Layer {
        model: request.model.clone().filter(|model| named(|s| s.model) && !model.is_empty()),
        reasoning_level: request.reasoning_level.filter(|_| named(|s| s.reasoning_level)),
        permission_mode: request.permission_mode.filter(|_| named(|s| s.permission_mode)),
        service_tier: request.service_tier.filter(|_| named(|s| s.service_tier)),
    }
}

fn thread_layer(thread: &ThreadRow) -> Layer {
    Layer {
        model: thread.model.clone(),
        reasoning_level: thread.reasoning_level.as_deref().and_then(ReasoningLevel::parse),
        permission_mode: thread.permission_mode.as_deref().and_then(PermissionMode::parse_input),
        service_tier: thread.service_tier.as_deref().and_then(ServiceTier::parse),
    }
}

fn resolve(
    db: &Db,
    host_id: Option<&str>,
    model: String,
    layers: &[Layer],
) -> ApiResult<ExecutionTuple> {
    let host = match host_id {
        Some(host_id) => find_host(db, HostLookup::Id, host_id)?,
        None => None,
    };
    let permission_mode =
        layers.iter().find_map(|layer| layer.permission_mode).unwrap_or(PermissionMode::Auto);
    let ceiling = host.map_or(PermissionMode::Full, |host| host.max_permission_mode);
    let fast = get_app_settings(db)?.allow_fast_service_tier;
    let service_tier = if fast { layers.iter().find_map(|layer| layer.service_tier) } else { None };
    Ok(ExecutionTuple {
        model,
        reasoning_level: layers
            .iter()
            .find_map(|layer| layer.reasoning_level)
            .unwrap_or(ReasoningLevel::Medium),
        permission_mode: clamp_permission_mode_to_ceiling(ceiling, permission_mode, None)
            .unwrap_or(permission_mode),
        service_tier: service_tier.unwrap_or(ServiceTier::Default),
    })
}

fn project_defaults(db: &Db, project_id: &str, provider_id: &str) -> ApiResult<Layer> {
    Ok(match get_project_execution_defaults(db, project_id)? {
        Some(stored) if stored.provider_id == provider_id => Layer {
            model: Some(stored.model),
            reasoning_level: Some(stored.reasoning_level),
            permission_mode: Some(stored.permission_mode),
            service_tier: Some(stored.service_tier),
        },
        _ => Layer::default(),
    })
}

/// The execution a turn on `thread` runs with, or `None` when no layer names a model.
pub fn find_turn_execution(
    db: &Db,
    thread: &ThreadRow,
    request: &ExecutionRequest,
) -> ApiResult<Option<ExecutionTuple>> {
    let asked = named_fields(request);
    let defaults = project_defaults(db, &thread.project_id, &thread.provider_id)?;
    let overrides = Layer {
        model: thread.model_override.clone(),
        reasoning_level: thread.reasoning_level_override.as_deref().and_then(ReasoningLevel::parse),
        ..Layer::default()
    };
    let parent = match &thread.parent_thread_id {
        Some(parent_id) => get_thread(db, parent_id)?,
        None => None,
    };
    let inherited = Layer {
        permission_mode: parent
            .filter(|parent| parent.archived_at.is_none() && parent.deleted_at.is_none())
            .and_then(|parent| {
                parent.permission_mode.as_deref().and_then(PermissionMode::parse_input)
            }),
        ..Layer::default()
    };
    let layers = [asked, overrides, thread_layer(thread), inherited, defaults];
    let model =
        layers.iter().find_map(|layer| layer.model.clone().filter(|model| !model.is_empty()));
    let Some(model) = model else { return Ok(None) };
    let environment = match &thread.environment_id {
        Some(environment_id) => get_environment(db, environment_id)?,
        None => None,
    };
    let host_id = environment.map(|environment| environment.host_id);
    resolve(db, host_id.as_deref(), model, &layers).map(Some)
}

pub fn resolve_turn_execution(
    db: &Db,
    thread: &ThreadRow,
    request: &ExecutionRequest,
) -> ApiResult<ExecutionTuple> {
    if let Some(execution) = find_turn_execution(db, thread, request)? {
        return Ok(execution);
    }
    let message = format!("Thread {} has no stored execution model", thread.id);
    Err(ApiError::new(500, "internal_error", message))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListedProvider {
    provider_id: String,
    installed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListedModel {
    model: String,
    #[serde(default)]
    is_default: bool,
}

#[derive(Deserialize)]
struct ModelList {
    models: Vec<ListedModel>,
}

async fn first_installed_provider(ctx: &Ctx, host_id: &str) -> ApiResult<String> {
    let provider_order = get_app_settings(&ctx.db)?.provider_order;
    let rank = |provider_id: &str| {
        provider_order.iter().position(|id| id == provider_id).unwrap_or(provider_order.len())
    };
    let runner = ctx.runners.get(host_id)?;
    let providers: Vec<ListedProvider> =
        call_typed(&*runner, "listProviders", &Value::Null).await?;
    let mut installed: Vec<String> = providers
        .into_iter()
        .filter(|provider| provider.installed)
        .map(|provider| provider.provider_id)
        .collect();
    installed.sort_by_key(|provider_id| rank(provider_id));
    installed.into_iter().next().ok_or_else(|| {
        ApiError::new(
            409,
            "no_provider_available",
            "No agent provider is installed on this machine. Install Codex or Claude Code to \
             start a thread.",
        )
    })
}

async fn catalog_default_model(
    ctx: &Ctx,
    host_id: &str,
    provider_id: ProviderId,
) -> ApiResult<String> {
    let runner = ctx.runners.get(host_id)?;
    let params = json!({ "providerId": provider_id.as_str(), "cwd": null });
    let ModelList { models } = call_typed(&*runner, "listModels", &params).await?;
    let model = match models.iter().position(|candidate| candidate.is_default) {
        Some(index) => models.into_iter().nth(index),
        None => models.into_iter().next(),
    };
    model.map(|model| model.model).ok_or_else(|| {
        let message = format!(
            "The {} model catalog is empty, so no default model can be resolved. Pick a model \
             explicitly.",
            provider_id.as_str()
        );
        ApiError::new(503, "model_catalog_unavailable", message).retryable(true)
    })
}

pub async fn resolve_create_execution(
    ctx: &Ctx,
    args: CreateExecutionArgs<'_>,
) -> ApiResult<CreatedExecution> {
    let CreateExecutionArgs { request, project_id, host_id, parent } = args;
    let db = &ctx.db;
    let requested = match &request.provider_id {
        Some(provider_id) => Some(provider_id.clone()),
        None => get_project_execution_defaults(db, project_id)?.map(|stored| stored.provider_id),
    };
    let requested = match requested {
        Some(provider_id) => Some(provider_id),
        None => get_app_settings(db)?.default_provider_id,
    };
    let provider_id = match requested {
        Some(provider_id) => provider_id,
        None => first_installed_provider(ctx, host_id).await?,
    };
    let provider_id = require_provider_id(&provider_id)?;
    let asked = named_fields(request);
    let defaults = project_defaults(db, project_id, provider_id.as_str())?;
    let inherited = Layer {
        permission_mode: parent.and_then(|parent| {
            parent.permission_mode.as_deref().and_then(PermissionMode::parse_input)
        }),
        ..Layer::default()
    };
    let model = match asked.model.clone().or_else(|| defaults.model.clone()) {
        Some(model) => model,
        None => catalog_default_model(ctx, host_id, provider_id).await?,
    };
    let layers = [asked, inherited, defaults];
    let execution = resolve(db, Some(host_id), model, &layers)?;
    Ok(CreatedExecution { provider_id, execution })
}

pub fn recorded_execution(execution: ExecutionTuple) -> RecordedExecution {
    RecordedExecution { execution, source: "client/turn/requested".to_string() }
}

pub fn to_runner_options(
    db: &Db,
    provider_id: &str,
    execution: &ExecutionTuple,
    initiator: ThreadTurnInitiator,
) -> ApiResult<ExecutionOptions> {
    let permission_escalation = match initiator {
        ThreadTurnInitiator::User => PermissionEscalation::Ask,
        _ => PermissionEscalation::Deny,
    };
    Ok(ExecutionOptions {
        model: execution.model.clone(),
        reasoning_level: execution.reasoning_level,
        service_tier: execution.service_tier,
        permission_mode: execution.permission_mode,
        permission_escalation,
        provider_options: provider_options_for(db, provider_id)?,
    })
}
