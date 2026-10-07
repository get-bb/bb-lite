//! The plugin host: discovers, loads, reloads and unloads plugins, and
//! answers the thread engine's questions about them. The port of
//! `apps/server/src/plugins/host.ts` and `registry.ts`.
//!
//! The signatures below are the seam the rest of the server calls; the
//! bodies are filled in by the plugin-host port.

use std::sync::Arc;

use bb_core::{DynamicTool, ToolCallResponse};
use futures::future::BoxFuture;
use indexmap::IndexMap;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::api::{
    MachineAccessProvider, MentionQuery, PluginHostDeps, ProviderEnvEntry, SettingDescriptors,
    ThreadContext,
};
use super::builtin::BuiltinPlugin;
use super::instance::PluginInstance;
use crate::config::ServerConfig;
use crate::db::Db;
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
    #[allow(dead_code)]
    options: PluginHostOptions,
}

impl PluginHost {
    pub fn new(options: PluginHostOptions) -> Self {
        Self { options }
    }

    /// Gives plugins their way back into the server; called once at startup, before `reload`.
    pub fn set_deps(&self, _deps: PluginHostDeps) {
        todo!("plugin host port")
    }

    pub fn set_title_fallback(&self, _fallback: Option<TitleFallback>) {
        todo!("plugin host port")
    }

    /// Rediscovers plugins and (re)loads one, or all with `None`.
    pub async fn reload(&self, _id: Option<&str>) -> ApiResult<()> {
        todo!("plugin host port")
    }

    pub async fn stop(&self) {
        todo!("plugin host port")
    }

    /// Returns the `InstalledPlugin` JSON.
    pub async fn set_enabled(&self, _id: &str, _enabled: bool) -> ApiResult<Value> {
        todo!("plugin host port")
    }

    /// Every plugin as `InstalledPlugin` JSON.
    pub fn list(&self) -> Vec<Value> {
        todo!("plugin host port")
    }

    pub fn token(&self, _id: &str, _rotate: bool) -> ApiResult<String> {
        todo!("plugin host port")
    }

    pub fn accepts_token(&self, _id: &str, _presented: Option<&str>) -> bool {
        todo!("plugin host port")
    }

    /// Reads a plugin's settings, after applying `update` when given.
    pub async fn settings(
        &self,
        _id: &str,
        _update: Option<IndexMap<String, Value>>,
    ) -> ApiResult<PluginSettingsView> {
        todo!("plugin host port")
    }

    /// The running instance, or 404 for an unknown plugin and 503
    /// `plugin_unavailable` for one that is not running.
    pub fn running(&self, _id: &str) -> ApiResult<Arc<PluginInstance>> {
        todo!("plugin host port")
    }

    pub async fn instructions_for(&self, _context: &ThreadContext) -> String {
        todo!("plugin host port")
    }

    pub async fn tools_for(&self, _context: &ThreadContext) -> Vec<DynamicTool> {
        todo!("plugin host port")
    }

    pub async fn call_tool(
        &self,
        _name: &str,
        _input: Value,
        _context: ThreadContext,
        _cancel: CancellationToken,
    ) -> ToolCallResponse {
        todo!("plugin host port")
    }

    pub async fn contributed_env(
        &self,
        _provider_id: &str,
        _context: &ThreadContext,
    ) -> Vec<ProviderEnvEntry> {
        todo!("plugin host port")
    }

    /// Fires a plugin event (`PLUGIN_EVENT_NAMES`) at every listener without waiting.
    pub fn emit(&self, _name: &str, _payload: Value) {
        todo!("plugin host port")
    }

    /// `PluginMentionGroup` JSON per provider with matches.
    pub async fn search_mentions(&self, _query: MentionQuery) -> Vec<Value> {
        todo!("plugin host port")
    }

    pub async fn resolve_mention(&self, _plugin_id: &str, _item_id: &str) -> ApiResult<String> {
        todo!("plugin host port")
    }

    pub async fn generate_title(
        &self,
        _prompt: &str,
        _cancel: CancellationToken,
    ) -> Option<String> {
        todo!("plugin host port")
    }

    pub fn public_url(&self) -> Option<String> {
        todo!("plugin host port")
    }

    pub fn machine_access(&self) -> Option<Arc<dyn MachineAccessProvider>> {
        todo!("plugin host port")
    }

    pub fn skill_dirs(&self) -> Vec<String> {
        todo!("plugin host port")
    }

    /// The `PluginContributionsResponse` JSON.
    pub fn contributions(&self) -> Value {
        todo!("plugin host port")
    }
}
