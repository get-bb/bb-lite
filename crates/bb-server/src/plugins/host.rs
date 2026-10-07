//! The plugin host: discovers, loads, reloads and unloads plugins, and
//! answers the thread engine's questions about them. The port of
//! `apps/server/src/plugins/host.ts` and `registry.ts`.
//!
//! The signatures below are the seam the rest of the server calls; the
//! bodies are filled in by the plugin-host port.

use std::path::Path;
use std::sync::Arc;

use base64::Engine;
use bb_core::{DynamicTool, ToolCallResponse};
use futures::future::BoxFuture;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::api::PluginResult;
use super::api::{
    MachineAccessProvider, MentionQuery, PluginHostDeps, ProviderEnvEntry, SettingDescriptors,
    ThreadContext,
};
use super::builtin::{BuiltinPlugin, BuiltinServer, builtin_plugins};
use super::bundle::{AppBundle, bundle_app, bundle_server_entry};
use super::instance::{PluginApi, PluginApiHost, PluginInstance, create_plugin_instance};
use super::manifest::{PluginManifest, read_external_plugin_entries, read_manifest};
use super::registry::{PluginRecord, PluginRegistry};
use crate::config::{ServerConfig, data_paths, loopback_url};
use crate::db::Db;
use crate::db::plugins::{is_plugin_enabled, set_plugin_enabled};
use crate::domain::changes::SystemChangeKind;
use crate::error::ApiResult;
use crate::log::Logger;
use crate::ws::hub::Hub;

pub struct PluginHostOptions {
    pub config: ServerConfig,
    pub db: Db,
    pub hub: Hub,
    pub log: Logger,
    /// `None` uses `builtin::builtin_plugins()`.
    pub builtins: Option<Vec<BuiltinPlugin>>,
}

/// Generates a thread title from the first message when no plugin offers an
/// inference service.
pub type TitleFallback =
    Arc<dyn Fn(String, CancellationToken) -> BoxFuture<'static, Option<String>> + Send + Sync>;

pub struct PluginSettingsView {
    pub schema: SettingDescriptors,
    pub values: IndexMap<String, Value>,
}

pub struct PluginHost {
    options: PluginHostOptions,
    registry: PluginRegistry,
    deps: Mutex<Option<PluginHostDeps>>,
    order: tokio::sync::Mutex<()>,
}

fn constant_time_eq(expected: &[u8], given: &[u8]) -> bool {
    expected.iter().zip(given).fold(0u8, |diff, (a, b)| diff | (a ^ b)) == 0
}

impl PluginHost {
    pub fn new(options: PluginHostOptions) -> Self {
        let registry = PluginRegistry::new(options.log.clone());
        Self { options, registry, deps: Mutex::new(None), order: tokio::sync::Mutex::new(()) }
    }

    /// Gives plugins their way back into the server; called once at startup, before `reload`.
    pub fn set_deps(&self, deps: PluginHostDeps) {
        *self.deps.lock() = Some(deps);
    }

    pub fn set_title_fallback(&self, fallback: Option<TitleFallback>) {
        *self.registry.title_fallback.lock() = fallback;
    }

    /// Rediscovers plugins and (re)loads one, or all with `None`.
    pub async fn reload(&self, id: Option<&str>) -> ApiResult<()> {
        self.discover().await;
        let targets: Vec<String> = match id {
            None => self.registry.records.lock().keys().cloned().collect(),
            Some(id) => vec![self.registry.record(id)?.manifest.id],
        };
        for target in targets {
            self.load(&target).await;
        }
        self.changed();
        Ok(())
    }

    pub async fn stop(&self) {
        let _turn = self.order.lock().await;
        let ids: Vec<String> = self.registry.records.lock().keys().cloned().collect();
        for id in ids.iter().rev() {
            self.unload(id).await;
        }
    }

    /// Returns the `InstalledPlugin` JSON.
    pub async fn set_enabled(&self, id: &str, enabled: bool) -> ApiResult<Value> {
        self.registry.record(id)?;
        set_plugin_enabled(&self.options.db, id, enabled)?;
        self.load(id).await;
        self.changed();
        Ok(self.describe(&self.registry.record(id)?))
    }

    /// Every plugin as `InstalledPlugin` JSON.
    pub fn list(&self) -> Vec<Value> {
        let records: Vec<PluginRecord> = self.registry.records.lock().values().cloned().collect();
        records.iter().map(|record| self.describe(record)).collect()
    }

    pub fn token(&self, id: &str, rotate: bool) -> ApiResult<String> {
        let mut records = self.registry.records.lock();
        let record = records
            .get_mut(id)
            .ok_or_else(|| crate::error::not_found_message(format!("Unknown plugin \"{id}\"")))?;
        match &record.token {
            Some(token) if !rotate => Ok(token.clone()),
            _ => {
                let bytes: [u8; 24] = rand::random();
                let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
                record.token = Some(token.clone());
                Ok(token)
            }
        }
    }

    pub fn accepts_token(&self, id: &str, presented: Option<&str>) -> bool {
        let expected = match self.registry.records.lock().get(id) {
            Some(record) => record.token.clone().unwrap_or_default(),
            None => return false,
        };
        let given = presented.unwrap_or("");
        let comparable = !expected.is_empty() && expected.len() == given.len();
        comparable && constant_time_eq(expected.as_bytes(), given.as_bytes())
    }

    /// Reads a plugin's settings, after applying `update` when given.
    pub async fn settings(
        &self,
        id: &str,
        update: Option<IndexMap<String, Value>>,
    ) -> ApiResult<PluginSettingsView> {
        if let Some(update) = update {
            let instance = self.running(id)?;
            instance.settings.write(&update).await?;
            if instance.needs_configuration().is_some() {
                self.load(id).await;
            }
            self.changed();
        }
        let settings = self.running(id)?.settings.clone();
        let values = settings.public_values().await?;
        Ok(PluginSettingsView { schema: settings.descriptors(), values })
    }

    /// The running instance, or 404 for an unknown plugin and 503
    /// `plugin_unavailable` for one that is not running.
    pub fn running(&self, id: &str) -> ApiResult<Arc<PluginInstance>> {
        self.registry.running(id)
    }

    /// The manifest of a discovered plugin, or 404.
    pub fn manifest(&self, id: &str) -> ApiResult<PluginManifest> {
        Ok(self.registry.record(id)?.manifest)
    }

    /// The bundled app of an external plugin, when it has one and is loaded.
    pub fn app_bundle(&self, id: &str) -> Option<AppBundle> {
        self.registry.records.lock().get(id)?.app.clone()
    }

    pub async fn instructions_for(&self, context: &ThreadContext) -> String {
        self.registry.instructions_for(context).await
    }

    pub async fn tools_for(&self, context: &ThreadContext) -> Vec<DynamicTool> {
        self.registry.tools_for(context).await
    }

    pub async fn call_tool(
        &self,
        name: &str,
        input: Value,
        context: ThreadContext,
        cancel: CancellationToken,
    ) -> ToolCallResponse {
        self.registry.call_tool(name, input, context, cancel).await
    }

    pub async fn contributed_env(
        &self,
        provider_id: &str,
        context: &ThreadContext,
    ) -> Vec<ProviderEnvEntry> {
        self.registry.contributed_env(provider_id, context).await
    }

    /// Fires a plugin event (`PLUGIN_EVENT_NAMES`) at every listener without waiting.
    pub fn emit(&self, name: &str, payload: Value) {
        self.registry.emit(name, payload)
    }

    /// `PluginMentionGroup` JSON per provider with matches.
    pub async fn search_mentions(&self, query: MentionQuery) -> Vec<Value> {
        self.registry.search_mentions(query).await
    }

    pub async fn resolve_mention(&self, plugin_id: &str, item_id: &str) -> ApiResult<String> {
        self.registry.resolve_mention(plugin_id, item_id).await
    }

    pub async fn generate_title(&self, prompt: &str, cancel: CancellationToken) -> Option<String> {
        self.registry.generate_title(prompt, cancel).await
    }

    pub fn public_url(&self) -> Option<String> {
        self.registry.public_url()
    }

    pub fn machine_access(&self) -> Option<Arc<dyn MachineAccessProvider>> {
        self.registry.machine_access()
    }

    pub fn skill_dirs(&self) -> Vec<String> {
        self.registry.skill_dirs()
    }

    /// The `PluginContributionsResponse` JSON.
    pub fn contributions(&self) -> Value {
        self.registry.contributions()
    }

    fn changed(&self) {
        self.options.hub.system(vec![SystemChangeKind::PluginsChanged]);
    }

    fn is_enabled(&self, record: &PluginRecord) -> bool {
        record.config_enabled
            && is_plugin_enabled(&self.options.db, &record.manifest.id).unwrap_or(true)
    }

    fn describe(&self, record: &PluginRecord) -> Value {
        let manifest = &record.manifest;
        let id = &manifest.id;
        let base = format!("/api/v1/plugins/{id}");
        let enabled = self.is_enabled(record);
        let disabled_by = (!record.config_enabled).then_some("Disabled in config.json");
        let instance = record.instance.as_ref();
        let waiting = instance.and_then(|instance| instance.needs_configuration());
        let settings = instance.map(|instance| instance.settings.descriptors()).unwrap_or_default();
        let cli_commands: Vec<Value> = instance
            .and_then(|instance| instance.cli())
            .map(|cli| vec![json!({ "name": cli.name(), "summary": cli.summary() })])
            .unwrap_or_default();
        let icon = manifest.icon.as_ref().map(|icon| match icon.strip_prefix("./") {
            Some(rest) => format!("{base}/assets/{rest}"),
            None => icon.clone(),
        });
        let status = match (enabled, instance, &waiting) {
            (false, _, _) => "disabled",
            (true, None, _) => "error",
            (true, Some(_), None) => "running",
            (true, Some(_), Some(_)) => "needs-configuration",
        };
        let status_message =
            if enabled { record.error.clone().or(waiting) } else { disabled_by.map(str::to_owned) };
        json!({
            "id": id,
            "name": manifest.name,
            "description": manifest.description,
            "icon": icon,
            "enabled": enabled,
            "status": status,
            "statusMessage": status_message,
            "hasSettings": !settings.is_empty(),
            "settings": settings,
            "app": Self::describe_app(record, &base),
            "cliCommands": cli_commands,
        })
    }

    fn describe_app(record: &PluginRecord, base: &str) -> Value {
        if record.manifest.app_entry.is_none() {
            return Value::Null;
        }
        if !record.external {
            return json!({ "kind": "builtin" });
        }
        let Some(app) = &record.app else { return Value::Null };
        let hash = &app.hash;
        let css_url = app.css.as_ref().map(|_| format!("{base}/app.css?h={hash}"));
        json!({
            "kind": "external",
            "jsUrl": format!("{base}/app.js?h={hash}"),
            "cssUrl": css_url,
            "hash": hash,
        })
    }

    async fn discover(&self) {
        let log = &self.options.log;
        let builtins = self.options.builtins.clone().unwrap_or_else(builtin_plugins);
        let mut candidates: Vec<(std::path::PathBuf, BuiltinServer, bool, bool)> = builtins
            .into_iter()
            .map(|builtin| (builtin.directory, builtin.server, false, true))
            .collect();
        let config_file = data_paths(&self.options.config.data_dir).config_file;
        match read_external_plugin_entries(&config_file).await {
            Ok(entries) => candidates.extend(
                entries
                    .into_iter()
                    .map(|entry| (entry.path.into(), BuiltinServer::None, true, entry.enabled)),
            ),
            Err(error) => log.error(
                "config.json is unreadable",
                json!({ "configFile": config_file, "err": error.message }),
            ),
        }
        let mut found: IndexMap<String, PluginRecord> = IndexMap::new();
        for (directory, server, external, config_enabled) in candidates {
            match read_manifest(&directory).await {
                Ok(manifest) => {
                    let known = self.registry.records.lock().get(&manifest.id).cloned();
                    let mut record = known.unwrap_or_else(|| {
                        PluginRecord::new(manifest.clone(), BuiltinServer::None, external)
                    });
                    record.server = server;
                    record.external = external;
                    record.config_enabled = config_enabled;
                    record.manifest = manifest;
                    found.insert(record.manifest.id.clone(), record);
                }
                Err(error) => log.error(
                    "Plugin manifest is unreadable",
                    json!({ "directory": directory, "err": error.message }),
                ),
            }
        }
        let gone: Vec<String> = self
            .registry
            .records
            .lock()
            .keys()
            .filter(|id| !found.contains_key(*id))
            .cloned()
            .collect();
        for id in gone {
            let _turn = self.order.lock().await;
            self.unload(&id).await;
        }
        let mut records = self.registry.records.lock();
        for (id, record) in found.iter_mut() {
            if let Some(current) = records.get(id) {
                record.instance = current.instance.clone();
                record.app = current.app.clone();
                record.error = current.error.clone();
                record.token = current.token.clone();
            }
        }
        *records = found;
    }

    async fn load(&self, id: &str) {
        let _turn = self.order.lock().await;
        self.start(id).await;
    }

    async fn start(&self, id: &str) {
        self.unload(id).await;
        let Ok(record) = self.registry.record(id) else { return };
        if !self.is_enabled(&record) {
            return;
        }
        let log = &self.options.log;
        let Some(deps) = self.deps.lock().clone() else {
            self.set_error(id, "The plugin host has not started".to_owned());
            return;
        };
        let config = &self.options.config;
        let host = PluginApiHost {
            db: self.options.db.clone(),
            hub: self.options.hub.clone(),
            log: log.clone(),
            data_dir: config.data_dir.clone(),
            server_url: loopback_url(config),
            deps,
        };
        let (instance, api) = match create_plugin_instance(&host, id) {
            Ok(created) => created,
            Err(error) => {
                log.error(
                    "Plugin failed to load",
                    json!({ "pluginId": id, "err": error.to_string() }),
                );
                self.set_error(id, error.to_string());
                return;
            }
        };
        let cache_dir = data_paths(&config.data_dir).plugins.join(id).join(".cache");
        match self.run_entry(&record, api, &cache_dir).await {
            Ok(app) => {
                let attached = match self.registry.records.lock().get_mut(id) {
                    Some(current) => {
                        current.app = app;
                        current.instance = Some(instance.clone());
                        true
                    }
                    None => false,
                };
                if attached {
                    instance.start_services();
                } else {
                    instance.dispose().await;
                }
            }
            Err(error) => {
                instance.dispose().await;
                log.error("Plugin failed to load", json!({ "pluginId": id, "err": error.message }));
                self.set_error(id, error.message);
            }
        }
    }

    async fn run_entry(
        &self,
        record: &PluginRecord,
        api: PluginApi,
        cache_dir: &Path,
    ) -> PluginResult<Option<AppBundle>> {
        let manifest = &record.manifest;
        if record.external {
            let app = match &manifest.app_entry {
                Some(entry) => Some(bundle_app(entry, cache_dir).await?),
                None => None,
            };
            if let Some(entry) = &manifest.server_entry {
                let code = bundle_server_entry(entry, cache_dir).await?;
                super::js::start_js_plugin(&code, api).await?;
            }
            return Ok(app);
        }
        match &record.server {
            BuiltinServer::None => {}
            BuiltinServer::Native(plugin) => plugin.start(api).await?,
            BuiltinServer::Js(source) => super::js::start_js_plugin(source, api).await?,
        }
        Ok(None)
    }

    fn set_error(&self, id: &str, message: String) {
        if let Some(record) = self.registry.records.lock().get_mut(id) {
            record.error = Some(message);
        }
    }

    async fn unload(&self, id: &str) {
        let instance = match self.registry.records.lock().get_mut(id) {
            Some(record) => {
                record.app = None;
                record.error = None;
                record.instance.take()
            }
            None => None,
        };
        if let Some(instance) = instance {
            instance.dispose().await;
        }
    }
}
