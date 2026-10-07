use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Weak};

use bb_core::ReasoningLevel;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::config::data_paths;
use crate::context::{Ctx, ServerContext};
use crate::db::Db;
use crate::db::settings::get_app_settings;
use crate::domain::changes::HostChangeKind;
use crate::error::{ApiError, ApiResult, invalid_request};
use crate::providers::catalog::list_enabled_providers;
use crate::runners::hosts::{require_host, resolve_lookup_host_id};
use crate::runners::registry::Registration;

const FRESH_MS: i64 = 10 * 60_000;
const FAILURE_TTL_MS: i64 = 30_000;
const FAILURE_DETAIL_MAX_LENGTH: usize = 300;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelLoadError {
    pub provider_id: String,
    pub code: String,
    pub detail: Option<String>,
}

/// `Pick<SystemExecutionOptionsResponse, "models" | "selectedOnlyModels" | "modelLoadError">`;
/// models are `AvailableModel` JSON.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedModels {
    pub models: Vec<Value>,
    pub selected_only_models: Vec<Value>,
    pub model_load_error: Option<ModelLoadError>,
}

/// What model listing needs from an enabled provider definition: its id, its public `info`
/// and the reasoning efforts of its levels (`reasoningEffortsForLevels`).
#[derive(Clone, Debug, PartialEq)]
pub struct EnabledProvider {
    pub id: String,
    pub info: Value,
    pub supported_reasoning_efforts: Vec<Value>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionOptionsQuery {
    #[serde(default)]
    pub host_id: Option<String>,
    #[serde(default)]
    pub environment_id: Option<String>,
    #[serde(default)]
    pub provider_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionOptionsResponse {
    pub providers: Vec<Value>,
    pub permission_ceiling: Value,
    #[serde(flatten)]
    pub loaded: LoadedModels,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomModel {
    pub provider_id: String,
    pub model: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Set in the environment of sessions that run this model.
    #[serde(default)]
    pub env: IndexMap<String, String>,
    /// Removed from the environment of sessions that run this model.
    #[serde(default)]
    pub unset_env: Vec<String>,
}

#[derive(Default)]
struct Entry {
    models: Option<Value>,
    loaded_at: i64,
    failure: Option<ModelLoadError>,
    pending: Option<Shared<BoxFuture<'static, ()>>>,
}

type Entries = Arc<Mutex<HashMap<(String, String), Entry>>>;

/// Per-machine, per-provider `listModels` cache. Entries of a machine are dropped when it
/// (re)connects.
pub struct ModelCatalog {
    entries: Entries,
    _connected: Mutex<Registration>,
}

pub fn model_load_error(provider_id: &str, error: &ApiError) -> ModelLoadError {
    let known = error.code();
    let detail = error.to_string().split_whitespace().collect::<Vec<_>>().join(" ");
    let code =
        if known == "missing_executable" || known == "auth_required" { known } else { "failed" };
    let detail: String = detail.chars().take(FAILURE_DETAIL_MAX_LENGTH).collect();
    ModelLoadError {
        provider_id: provider_id.to_owned(),
        code: code.to_owned(),
        detail: (!detail.is_empty()).then_some(detail),
    }
}

impl ModelCatalog {
    pub fn new(ctx: &Ctx) -> Self {
        let entries: Entries = Arc::default();
        let held = entries.clone();
        let connected = ctx.runners.on_connected(Arc::new(move |host_id: &str| {
            held.lock().retain(|(host, _), _| host != host_id);
        }));
        Self { entries, _connected: Mutex::new(connected) }
    }

    pub async fn read(&self, ctx: &Ctx, host_id: &str, provider_id: &str) -> LoadedModels {
        let key = (host_id.to_owned(), provider_id.to_owned());
        let (wait, background) = {
            let mut entries = self.entries.lock();
            let entry = entries.entry(key.clone()).or_default();
            let age = ctx.now() - entry.loaded_at;
            let stale_failure = entry.failure.is_none() || age >= FAILURE_TTL_MS;
            if entry.models.is_none() && stale_failure {
                (Some(self.refresh(entry, ctx, &key)), None)
            } else if entry.models.is_some() && age >= FRESH_MS {
                (None, Some(self.refresh(entry, ctx, &key)))
            } else {
                (None, None)
            }
        };
        if let Some(wait) = wait {
            wait.await;
        }
        if let Some(background) = background {
            tokio::spawn(background);
        }
        let entries = self.entries.lock();
        let entry = entries.get(&key);
        let models = entry.and_then(|entry| entry.models.clone());
        let list = |field: &str| {
            let found = models.as_ref().and_then(|models| models.get(field));
            found.and_then(Value::as_array).cloned().unwrap_or_default()
        };
        LoadedModels {
            models: list("models"),
            selected_only_models: list("selectedOnlyModels"),
            model_load_error: match models {
                Some(_) => None,
                None => entry.and_then(|entry| entry.failure.clone()),
            },
        }
    }

    fn refresh(
        &self,
        entry: &mut Entry,
        ctx: &Ctx,
        key: &(String, String),
    ) -> Shared<BoxFuture<'static, ()>> {
        if let Some(pending) = &entry.pending {
            return pending.clone();
        }
        let (entries, ctx, key) = (self.entries.clone(), ctx.clone(), key.clone());
        let load = async move {
            let (host_id, provider_id) = &key;
            let params = json!({ "providerId": provider_id, "cwd": null });
            let result = match ctx.runners.get(host_id) {
                Ok(runner) => runner.call("listModels", params).await.map_err(ApiError::from),
                Err(error) => Err(error),
            };
            let mut all = entries.lock();
            let Some(entry) = all.get_mut(&key) else { return };
            let previous = entry.models.clone();
            match result {
                Ok(models) => {
                    entry.models = Some(models);
                    entry.failure = None;
                }
                Err(error) => entry.failure = Some(model_load_error(provider_id, &error)),
            }
            entry.loaded_at = ctx.now();
            entry.pending = None;
            let changed = previous != entry.models;
            drop(all);
            if previous.is_some() && changed {
                ctx.hub.host(host_id, vec![HostChangeKind::ProviderModelCatalogChanged]);
            }
        };
        let pending = load.boxed().shared();
        entry.pending = Some(pending.clone());
        pending
    }
}

/// The custom models offered in pickers: none in streamer mode.
pub async fn read_custom_models(ctx: &Ctx) -> Vec<CustomModel> {
    if get_app_settings(&ctx.db).map(|settings| settings.streamer_mode).unwrap_or(false) {
        return Vec::new();
    }
    read_custom_model_config(ctx).await
}

/// `customModels` of the data directory's `config.json`; an invalid file counts as empty.
pub async fn read_custom_model_config(ctx: &Ctx) -> Vec<CustomModel> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Config {
        #[serde(default)]
        custom_models: Vec<CustomModel>,
    }
    let path = data_paths(&ctx.config.data_dir).config_file;
    let Ok(text) = tokio::fs::read_to_string(&path).await else {
        return Vec::new();
    };
    let parsed = serde_json::from_str::<Config>(&text).map_err(|err| err.to_string());
    let valid = parsed.and_then(|config| {
        let empty = config.custom_models.iter().any(|custom| {
            custom.provider_id.is_empty()
                || custom.model.is_empty()
                || custom.display_name.as_deref() == Some("")
                || custom.description.as_deref() == Some("")
                || custom.unset_env.iter().any(String::is_empty)
        });
        if empty { Err("String must contain at least 1 character(s)".into()) } else { Ok(config) }
    });
    match valid {
        Ok(config) => config.custom_models,
        Err(err) => {
            let fields = json!({ "err": err, "path": path.display().to_string() });
            ctx.log.warn("Ignoring customModels: config.json is invalid", fields);
            Vec::new()
        }
    }
}

pub fn with_custom_models(
    loaded: LoadedModels,
    provider: &EnabledProvider,
    custom_models: &[CustomModel],
) -> LoadedModels {
    let LoadedModels { mut models, mut selected_only_models, model_load_error } = loaded;
    let same =
        |known: &Value, model: &str| known.get("model").and_then(Value::as_str) == Some(model);
    for custom in custom_models {
        let model = custom.model.as_str();
        if custom.provider_id != provider.id || models.iter().any(|known| same(known, model)) {
            continue;
        }
        let promoted = selected_only_models.iter().position(|known| same(known, model));
        let added = match promoted {
            Some(index) => selected_only_models.remove(index),
            None => json!({
                "id": model,
                "model": model,
                "displayName": custom.display_name.as_deref().unwrap_or(model),
                "description":
                    custom.description.as_deref().unwrap_or("Custom model from config.json"),
                "supportedReasoningEfforts": provider.supported_reasoning_efforts,
                "defaultReasoningEffort": "medium",
                "isDefault": false,
            }),
        };
        models.push(added);
    }
    LoadedModels { models, selected_only_models, model_load_error }
}

/// `resolveExecutionOptions` over the enabled providers (`listEnabledProviders`); `known`
/// tells whether a provider id exists at all (`findProviderDefinition`).
pub async fn resolve_execution_options(
    ctx: &Ctx,
    catalog: &ModelCatalog,
    query: &ExecutionOptionsQuery,
    enabled: &[EnabledProvider],
    known: impl Fn(&str) -> bool,
) -> ApiResult<ExecutionOptionsResponse> {
    let host_id =
        resolve_lookup_host_id(ctx, query.host_id.as_deref(), query.environment_id.as_deref())?;
    let permission_ceiling =
        serde_json::to_value(require_host(ctx, &host_id)?.max_permission_mode)?;
    let providers = enabled.iter().map(|provider| provider.info.clone()).collect();
    if let Some(provider_id) = &query.provider_id
        && !known(provider_id)
    {
        return Err(invalid_request(format!("Unsupported provider {provider_id}")));
    }
    let provider = match &query.provider_id {
        None => enabled.first(),
        Some(id) => enabled.iter().find(|provider| &provider.id == id),
    };
    let Some(provider) = provider else {
        let loaded =
            LoadedModels { models: vec![], selected_only_models: vec![], model_load_error: None };
        return Ok(ExecutionOptionsResponse { providers, permission_ceiling, loaded });
    };
    let loaded = catalog.read(ctx, &host_id, &provider.id).await;
    let custom_models = read_custom_models(ctx).await;
    let loaded = with_custom_models(loaded, provider, &custom_models);
    Ok(ExecutionOptionsResponse { providers, permission_ceiling, loaded })
}

type CatalogRegistry = Mutex<Vec<(Weak<ServerContext>, Arc<ModelCatalog>)>>;

static CATALOGS: LazyLock<CatalogRegistry> = LazyLock::new(Mutex::default);

/// The server's one `ModelCatalog` (`modelCatalog`), created on first use and dropped with the
/// server context.
pub fn model_catalog(ctx: &Ctx) -> Arc<ModelCatalog> {
    let key = Arc::downgrade(ctx);
    let mut catalogs = CATALOGS.lock();
    catalogs.retain(|(owner, _)| owner.strong_count() > 0);
    if let Some((_, catalog)) = catalogs.iter().find(|(owner, _)| owner.ptr_eq(&key)) {
        return catalog.clone();
    }
    let catalog = Arc::new(ModelCatalog::new(ctx));
    catalogs.push((key, catalog.clone()));
    catalog
}

const REASONING_DESCRIPTIONS: [(ReasoningLevel, &str); 8] = [
    (ReasoningLevel::None, "No extended thinking"),
    (ReasoningLevel::Low, "Low reasoning effort"),
    (ReasoningLevel::Medium, "Medium reasoning effort"),
    (ReasoningLevel::High, "High reasoning effort"),
    (ReasoningLevel::Xhigh, "Extra high reasoning effort"),
    (
        ReasoningLevel::Ultracode,
        "Extra high reasoning effort plus multi-agent workflow orchestration",
    ),
    (ReasoningLevel::Max, "Maximum reasoning effort"),
    (ReasoningLevel::Ultra, "Maximum reasoning with automatic task delegation"),
];

/// `reasoningEffortsForLevels`.
pub fn reasoning_efforts_for_levels(levels: &[ReasoningLevel]) -> Vec<Value> {
    levels
        .iter()
        .map(|level| {
            let description = REASONING_DESCRIPTIONS
                .iter()
                .find(|(known, _)| known == level)
                .map_or("", |(_, text)| text);
            json!({ "reasoningEffort": level, "description": description })
        })
        .collect()
}

/// The enabled providers as model listing sees them (`listEnabledProviders`).
pub fn enabled_providers(db: &Db) -> ApiResult<Vec<EnabledProvider>> {
    let providers = list_enabled_providers(db)?;
    providers
        .into_iter()
        .map(|provider| {
            Ok(EnabledProvider {
                id: provider.id.as_str().to_owned(),
                info: serde_json::to_value(&provider.info)?,
                supported_reasoning_efforts: reasoning_efforts_for_levels(
                    &provider.reasoning_levels,
                ),
            })
        })
        .collect()
}
