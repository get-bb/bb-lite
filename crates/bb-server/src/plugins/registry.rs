//! The loaded plugins and the thread engine's queries over them.

use std::sync::Arc;

use bb_core::{DynamicTool, ToolCallResponse};
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::api::{
    AgentTool, AgentToolResult, MachineAccessProvider, MentionQuery, ProviderEnvEntry,
    ThreadContext, ToolFailure,
};
use super::builtin::BuiltinServer;
use super::bundle::AppBundle;
use super::host::TitleFallback;
use super::instance::PluginInstance;
use super::manifest::PluginManifest;
use crate::error::{ApiError, ApiResult, not_found_message};
use crate::log::Logger;

#[derive(Clone)]
pub struct PluginRecord {
    pub manifest: PluginManifest,
    pub server: BuiltinServer,
    pub external: bool,
    pub config_enabled: bool,
    pub instance: Option<Arc<PluginInstance>>,
    pub app: Option<AppBundle>,
    pub error: Option<String>,
    pub token: Option<String>,
}

impl PluginRecord {
    pub fn new(manifest: PluginManifest, server: BuiltinServer, external: bool) -> Self {
        Self {
            manifest,
            server,
            external,
            config_enabled: true,
            instance: None,
            app: None,
            error: None,
            token: None,
        }
    }
}

pub struct PluginRegistry {
    pub(crate) records: Mutex<IndexMap<String, PluginRecord>>,
    pub(crate) title_fallback: Mutex<Option<TitleFallback>>,
    log: Logger,
}

type Active = Vec<(String, Arc<PluginInstance>)>;

impl PluginRegistry {
    pub fn new(log: Logger) -> Self {
        Self { records: Mutex::new(IndexMap::new()), title_fallback: Mutex::new(None), log }
    }

    pub fn record(&self, id: &str) -> ApiResult<PluginRecord> {
        self.records
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| not_found_message(format!("Unknown plugin \"{id}\"")))
    }

    pub fn running(&self, id: &str) -> ApiResult<Arc<PluginInstance>> {
        let record = self.record(id)?;
        if let Some(instance) = record.instance {
            return Ok(instance);
        }
        let reason = record.error.map(|error| format!(": {error}")).unwrap_or_default();
        let message = format!("Plugin \"{id}\" is not running{reason}");
        Err(ApiError::new(503, "plugin_unavailable", message))
    }

    fn active(&self) -> Active {
        self.records
            .lock()
            .iter()
            .filter_map(|(id, record)| Some((id.clone(), record.instance.clone()?)))
            .collect()
    }

    fn warn(&self, surface: &str, plugin_id: &str, error: &str) {
        let fields = json!({ "pluginId": plugin_id, "err": error });
        self.log.warn(&format!("Plugin {surface} failed"), fields);
    }

    async fn tools(instance: &PluginInstance, context: &ThreadContext) -> Vec<Arc<dyn AgentTool>> {
        let mut enabled = Vec::new();
        for tool in instance.tools() {
            if tool.enabled_for(context).await {
                enabled.push(tool);
            }
        }
        enabled
    }

    pub async fn instructions_for(&self, context: &ThreadContext) -> String {
        let mut parts: Vec<Option<String>> = Vec::new();
        for (id, instance) in self.active() {
            for tool in Self::tools(&instance, context).await {
                parts.push(tool.instructions());
            }
            for contribute in instance.instructions() {
                match contribute(context.clone()).await {
                    Ok(part) => parts.push(part),
                    Err(error) => self.warn("instructions", &id, &error.message),
                }
            }
        }
        let kept: Vec<String> =
            parts.into_iter().flatten().filter(|part| !part.trim().is_empty()).collect();
        kept.join("\n\n")
    }

    pub async fn tools_for(&self, context: &ThreadContext) -> Vec<DynamicTool> {
        let mut tools = Vec::new();
        for (_, instance) in self.active() {
            for tool in Self::tools(&instance, context).await {
                tools.push(DynamicTool {
                    name: tool.name(),
                    description: tool.description(),
                    input_schema: tool.input_schema(),
                    presentation: tool.presentation(),
                });
            }
        }
        tools
    }

    pub async fn call_tool(
        &self,
        name: &str,
        input: Value,
        context: ThreadContext,
        cancel: CancellationToken,
    ) -> ToolCallResponse {
        let mut found = None;
        'search: for (_, instance) in self.active() {
            for tool in Self::tools(&instance, &context).await {
                if tool.name() == name {
                    found = Some(tool);
                    break 'search;
                }
            }
        }
        let Some(tool) = found else {
            return ToolCallResponse::text(format!("Unknown tool \"{name}\""), false);
        };
        match tool.execute(input, context, cancel).await {
            Ok(AgentToolResult::Text(text)) => ToolCallResponse::text(text, true),
            Ok(AgentToolResult::Detailed { text, is_error }) => {
                ToolCallResponse::text(text, !is_error)
            }
            Err(ToolFailure::InvalidArguments(message)) => {
                ToolCallResponse::text(format!("Invalid arguments: {message}"), false)
            }
            Err(ToolFailure::Failed(message)) => {
                self.log.warn("Plugin tool failed", json!({ "tool": name, "err": message }));
                ToolCallResponse::text(format!("Tool failed: {message}"), false)
            }
        }
    }

    pub async fn contributed_env(
        &self,
        provider_id: &str,
        context: &ThreadContext,
    ) -> Vec<ProviderEnvEntry> {
        let mut entries = Vec::new();
        for (id, instance) in self.active() {
            for (contributor_provider_id, contribute) in instance.env() {
                if contributor_provider_id != provider_id {
                    continue;
                }
                match contribute(context.clone()).await {
                    Ok(added) => entries.extend(added),
                    Err(error) => self.warn("env", &id, &error.message),
                }
            }
        }
        entries
    }

    pub fn emit(&self, name: &str, payload: Value) {
        for (id, instance) in self.active() {
            for listener in instance.listeners(name) {
                let log = self.log.clone();
                let payload = payload.clone();
                let surface = format!("Plugin {name} handler failed");
                let id = id.clone();
                tokio::spawn(async move {
                    if let Err(error) = listener(payload).await {
                        log.warn(&surface, json!({ "pluginId": id, "err": error.message }));
                    }
                });
            }
        }
    }

    pub async fn search_mentions(&self, query: MentionQuery) -> Vec<Value> {
        let mut groups = Vec::new();
        let sources = if query.query.is_empty() { Vec::new() } else { self.active() };
        for (plugin_id, instance) in sources {
            for provider in instance.mention_providers() {
                if !provider.triggers().contains(&query.trigger) {
                    continue;
                }
                let found = match provider.search(query.clone()).await {
                    Ok(found) => found,
                    Err(error) => {
                        self.warn("mentions", &plugin_id, &error.message);
                        continue;
                    }
                };
                if found.is_empty() {
                    continue;
                }
                let provider_id = provider.id();
                let items: Vec<Value> = found
                    .into_iter()
                    .map(|item| {
                        json!({
                            "itemId": format!("{provider_id}:{}", item.id),
                            "title": item.title,
                            "subtitle": item.subtitle,
                            "icon": item.icon,
                        })
                    })
                    .collect();
                groups.push(json!({
                    "pluginId": plugin_id,
                    "providerId": provider_id,
                    "label": provider.label(),
                    "items": items,
                }));
            }
        }
        groups
    }

    pub async fn resolve_mention(&self, plugin_id: &str, item_id: &str) -> ApiResult<String> {
        let (provider_id, rest) = item_id.split_once(':').unwrap_or((item_id, ""));
        let provider = self
            .running(plugin_id)?
            .mention_providers()
            .into_iter()
            .find(|candidate| candidate.id() == provider_id)
            .ok_or_else(|| {
                not_found_message(format!("Unknown mention provider \"{provider_id}\""))
            })?;
        provider.resolve(rest).await.map_err(ApiError::internal)
    }

    pub async fn generate_title(&self, prompt: &str, cancel: CancellationToken) -> Option<String> {
        let services: Vec<_> = self
            .active()
            .into_iter()
            .flat_map(|(id, instance)| {
                instance.inference().into_iter().map(move |service| (id.clone(), service))
            })
            .collect();
        for (id, service) in &services {
            match service.complete(prompt, cancel.clone()).await {
                Ok(text) if !text.trim().is_empty() => return Some(text.trim().to_owned()),
                Ok(_) => {}
                Err(error) => self.warn("inference", id, &error.message),
            }
        }
        let fallback = self.title_fallback.lock().clone();
        match fallback {
            Some(fallback) if services.is_empty() => fallback(prompt.to_owned(), cancel).await,
            _ => None,
        }
    }

    pub fn public_url(&self) -> Option<String> {
        self.active().into_iter().find_map(|(_, instance)| instance.public_url())
    }

    pub fn machine_access(&self) -> Option<Arc<dyn MachineAccessProvider>> {
        self.active().into_iter().find_map(|(_, instance)| instance.machine_access())
    }

    pub fn skill_dirs(&self) -> Vec<String> {
        self.records
            .lock()
            .values()
            .filter(|record| record.instance.is_some())
            .flat_map(|record| record.manifest.skill_dirs.iter())
            .map(|dir| dir.to_string_lossy().into_owned())
            .collect()
    }

    pub fn contributions(&self) -> Value {
        let active = self.active();
        let cli_commands: Vec<Value> = active
            .iter()
            .filter_map(|(plugin_id, instance)| {
                let cli = instance.cli()?;
                let commands: Vec<Value> = cli
                    .commands()
                    .into_iter()
                    .map(|command| json!({ "name": command.name, "summary": command.summary }))
                    .collect();
                Some(json!({
                    "pluginId": plugin_id,
                    "name": cli.name(),
                    "summary": cli.summary(),
                    "commands": commands,
                }))
            })
            .collect();
        let mention_providers: Vec<Value> = active
            .iter()
            .flat_map(|(plugin_id, instance)| {
                instance.mention_providers().into_iter().map(move |provider| {
                    json!({
                        "pluginId": plugin_id,
                        "id": provider.id(),
                        "label": provider.label(),
                        "triggers": provider.triggers(),
                    })
                })
            })
            .collect();
        json!({ "cliCommands": cli_commands, "mentionProviders": mention_providers })
    }
}
